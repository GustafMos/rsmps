/**
 * The evaluator. Pull-based and lazy: asking for one output evaluates only the
 * nodes upstream of it, and every node result is cached by a signature built
 * from its type, resolved params and the signatures of its inputs. A node is
 * re-rendered per frame only if it (or something upstream) actually read the clock.
 */
import { Registry, canConnect, paramBundles, paramMotion, paramSocketType } from './define';
import { Gpu } from './gpu/gpu';
import { clampProxy, proxySize } from './lib/proxy-size';
import { stableStringify } from './lib/stable-json';
import { deriveProcessStatus, isServable, placeholderCard, PLACEHOLDER_STEPS, processDataPresent, processResultOf, type ProcessStatus } from './process';
import { defOf, flattenGraph, groupData, groupDefOf, GROUP_TYPE, hasGroups, localId, nodeAtPath, PATH_SEP, resolveFlatTarget, storedCount, type FlatView } from './group';
import type {
  AnyNodeDef,
  CanvasInfo,
  Edge,
  GraphDoc,
  ColdStore,
  Host,
  ImageValue,
  MaskValue,
  MaterialValue,
  MotionValue,
  SdfValue,
  NodeGpu,
  NodeInstance,
  ParamDef,
  ProcessArray,
  ProcessView,
  TimeInfo,
  Value,
} from './types';

export interface EvalRequest {
  graph: GraphDoc;
  /** Node whose output is wanted. `port` defaults to its first output (or first input for output-category nodes). */
  node: string;
  port?: string;
  /** Seconds. Snapped to the project frame grid. */
  seconds?: number;
  /** Batch item index. */
  item?: number;
  itemCount?: number;
  /** 1 = full resolution; 0.5 = half-resolution proxy for smooth playback. Effects scale automatically. */
  proxy?: number;
  quality?: 'preview' | 'final';
  /**
   * Render with this frame size instead of the project canvas (full-resolution texels). Lets one graph be
   * rendered as landscape, portrait, square… without editing it: generators lay out for the new frame and
   * unit-pixel lengths keep the same look.
   */
  canvas?: { width: number; height: number };
}

export interface EvalResult {
  value: Value | null;
  /** Node id → message for nodes that failed or are misconfigured. */
  errors: Map<string, string>;
  /** Milliseconds spent rendering per node in this call (cache hits absent). */
  timings: Map<string, number>;
}

interface Entry {
  key: string;
  /** Node that produced it. */
  node: string;
  /** Time-varying: the node (or something upstream) read the clock, so the entry belongs to one frame. */
  tv: boolean;
  outputs: Record<string, Value | null>;
  bytes: number;
  lastUsed: number;
  /** Milliseconds the render took (0 for restored entries): decides whether the result is worth keeping in the RAM tier. */
  renderMs: number;
}

/** What the RAM tier remembers about an entry whose pixels sit in the ColdStore. */
interface ColdMeta {
  node: string;
  renderMs: number;
  bytes: number;
  lastUsed: number;
  outputs: Record<string, { t: 'null' } | { t: 'value'; v: Value } | { t: 'tex'; kind: 'image' | 'mask'; unit: number; slot: number }>;
  slots: { width: number; height: number }[];
}

/** Counters of the RAM tier: does it pay off? `promoteMs` (restore time) against `savedMs` (the render time it avoided). */
export interface ColdStats {
  entries: number;
  demoted: number;
  skippedDemote: number;
  promoted: number;
  promoteMs: number;
  savedMs: number;
  misses: number;
  /** Demoted entries that were evicted from the store before they were needed again. */
  lost: number;
}

/**
 * The cheap CPU part (regions, numbers) of an expensive per-frame analysis node (`cpu: true`: detect, track...), kept for many frames.
 * The full entry holds the node's textures and is limited to a couple of frames per node; this one weighs nothing, so a Track node
 * that looks back over 100+ frames finds every earlier detection here instead of re-running the readback for each of them.
 * Keyed by structure + frame (see `liteKeyOf`), so it can be looked up WITHOUT evaluating the node's inputs.
 */
interface LiteEntry {
  node: string;
  outputs: Record<string, Value | null>;
  lastUsed: number;
}

interface NodeResult {
  key: string;
  /** Time-varying (see Entry.tv). */
  tv?: boolean;
  outputs: Record<string, Value | null>;
}

interface Scope {
  graph: GraphDoc;
  nodes: Map<string, NodeInstance>;
  inbound: Map<string, Edge[]>;
  seconds: number;
  frame: number;
  item: number;
  itemCount: number;
  proxy: number;
  quality: 'preview' | 'final';
  canvas: CanvasInfo;
  memo: Map<string, Promise<NodeResult | null>>;
  stack: Set<string>;
  errors: Map<string, string>;
  timings: Map<string, number>;
  /** Frame size at proxy 1 (what a baked sequence is made at). */
  fullCanvas: { width: number; height: number };
  /** structSig results for this evaluation (the graph does not change during one), shared with the sub-scopes of `pull`. */
  sigMemo: Map<string, string>;
  /** Same for the proxy-independent ("full") signatures process nodes compare their stored result with. */
  fullSigMemo: Map<string, string>;
  /** The frame at proxy 1 (unrounded; what `proxySize` scales). */
  frame0: { width: number; height: number };
  /** Scopes of one evaluation by proxy factor, so `ctx.pull(input, { proxy })` from two places shares one memo. Includes the root scope itself. */
  proxies: Map<number, Scope>;
  /** The node and output port this evaluation was asked for (feeds `ctx.wants`). */
  rootNode?: string;
  rootPort?: string;
  /** The document as the caller gave it (with groups); `graph` is its flattened form. */
  root?: GraphDoc;
  /** Static node results seen in this evaluation (memo key, cache key): kept for the per-node fast path once the evaluation ended without errors. Shared with sub-scopes. */
  staticNew?: [string, string][];
}

/** Node and inbound-wire maps of a graph, built once per graph object (the cache-hit path then does no O(nodes) work to start). */
const indexMemo = new WeakMap<GraphDoc, { nodes: Map<string, NodeInstance>; inbound: Map<string, Edge[]> }>();
function graphIndex(graph: GraphDoc): { nodes: Map<string, NodeInstance>; inbound: Map<string, Edge[]> } {
  const hit = indexMemo.get(graph);
  if (hit) return hit;
  const inbound = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    const list = inbound.get(e.to.node);
    if (list) list.push(e);
    else inbound.set(e.to.node, [e]);
  }
  const idx = { nodes: new Map(graph.nodes.map((n) => [n.id, n])), inbound };
  indexMemo.set(graph, idx);
  return idx;
}

/** What, besides the frame, decides an evaluation's result (the fast path's key). */
function fastKeyOf(req: EvalRequest): string {
  return `${req.node}|${req.port ?? ''}|${req.item ?? 0}/${req.itemCount ?? 1}|${clampProxy(req.proxy ?? 1)}|${req.quality ?? 'preview'}|${req.canvas ? `${req.canvas.width}x${req.canvas.height}` : ''}`;
}

/** A graph with a process node may change its result without changing (process state, progress): no fast path for it. Memoised per graph. */
const processMemo = new WeakMap<GraphDoc, boolean>();
function hasProcessNodes(graph: GraphDoc, registry: Registry): boolean {
  let v = processMemo.get(graph);
  if (v === undefined) {
    v = graph.nodes.some((n) => !!defOf(registry, n)?.process);
    processMemo.set(graph, v);
  }
  return v;
}

function hash(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

function isTextured(v: unknown): v is ImageValue | MaskValue {
  return !!v && typeof v === 'object' && 'texture' in (v as object);
}

/** Sockets whose values are GPU textures; every other output (regions, numbers, colours...) is a small CPU value. */
const isTextureSocket = (type: string): boolean => type === 'image' || type === 'mask';

/** Signature of a value for cache keys: textures are identified by the key of the node that made them. */
/** GPU textures a value keeps alive: an image's own, or the pictures inside a material. */
function texturesOf(v: unknown): GPUTexture[] {
  if (isTextured(v)) return [v.texture];
  if (v && typeof v === 'object' && (v as { kind?: string }).kind === 'material') {
    const out: GPUTexture[] = [];
    for (const m of Object.values((v as MaterialValue).maps)) if (m && !out.includes(m.texture)) out.push(m.texture);
    return out;
  }
  if (v && typeof v === 'object' && (v as { kind?: string }).kind === 'sdf') {
    const pic = (v as SdfValue).picture;
    return pic ? [pic.texture] : [];
  }
  return [];
}

function valueSig(v: Value | Value[] | null, sourceKey: string): string {
  if (v === null) return 'null';
  if (!Array.isArray(v) && (v as { kind?: string }).kind === 'material') return `m:${sourceKey}`;
  // an SDF scene is plain numbers (resolved per frame) plus at most one picture: the numbers are the identity, the picture is the producing node's key
  if (!Array.isArray(v) && (v as { kind?: string }).kind === 'sdf') {
    const { picture, ...rest } = v as SdfValue;
    return `s:${stableStringify(rest)}${picture ? `|${sourceKey}` : ''}`;
  }
  if (Array.isArray(v) && v.length && isTextured(v[0])) return sourceKey;
  if (isTextured(v)) return sourceKey;
  return stableStringify(v);
}

export function defaultParams(def: AnyNodeDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(def.params as Record<string, ParamDef>)) {
    out[key] = structuredClone(p.default);
  }
  return out;
}

function coerceParam(p: ParamDef, value: unknown): unknown {
  // A node saved before this param existed (see `ParamBase.absent`).
  const raw = value === undefined && p.absent !== undefined ? p.absent : value;
  switch (p.type) {
    case 'number': {
      let n = typeof raw === 'number' && Number.isFinite(raw) ? raw : p.default;
      if (p.min !== undefined) n = Math.max(p.min, n);
      if (p.max !== undefined) n = Math.min(p.max, n);
      return p.integer ? Math.round(n) : n;
    }
    case 'bool':
      return typeof raw === 'boolean' ? raw : p.default;
    case 'enum':
      return p.options.some((o) => o.value === raw) ? raw : p.default;
    case 'color':
      return Array.isArray(raw) && raw.length === 4 ? raw : p.default;
    case 'vec2':
      return Array.isArray(raw) && raw.length === 2 ? raw : p.default;
    case 'string':
    case 'device':
      return typeof raw === 'string' ? raw : p.default;
    case 'palette':
    case 'assets':
      return Array.isArray(raw) ? raw : p.default;
    case 'curve':
      return raw && typeof raw === 'object' && Array.isArray((raw as { keys?: unknown }).keys) ? raw : p.default;
    default:
      return raw === undefined ? p.default : raw;
  }
}

/** A vector wire on a vec2 param: x and y, held to the param's min / max like a wired number. */
function vec2FromVector(p: Extract<ParamDef, { type: 'vec2' }>, wired: unknown): [number, number] {
  const pick = (i: number): number => {
    let n = Array.isArray(wired) && typeof wired[i] === 'number' && Number.isFinite(wired[i]) ? (wired[i] as number) : p.default[i];
    if (p.min !== undefined) n = Math.max(p.min, n);
    if (p.max !== undefined) n = Math.min(p.max, n);
    return n;
  };
  return [pick(0), pick(1)];
}

/** A node's params as `render` would see them before unit conversion: defaults applied, values clamped, unknown keys dropped. */
export function resolveNodeParams(def: AnyNodeDef, params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(def.params as Record<string, ParamDef>)) out[key] = coerceParam(p, params[key]);
  return out;
}

export class Engine {
  readonly gpu: Gpu;
  readonly registry: Registry;
  host: Host;
  /** Cache budget for node results, in bytes of texture memory. */
  cacheBudget = 384 * 1024 * 1024;

  private cache = new Map<string, Entry>();
  private cacheBytes = 0;
  /** What a node read last time under a given static signature: decides whether time/item enter its key. */
  private reads = new Map<string, { time: boolean; item: boolean; path?: boolean }>();
  private lite = new Map<string, LiteEntry>();
  /** `usesPrevious` nodes: "<structure>@<frame>" -> cache key of that frame's result (see RenderCtx.previous). Bounded. */
  private selfIndex = new Map<string, string>();
  static readonly SELF_INDEX_MAX = 512;
  /** Upper bound of CPU-only analysis results kept (see LiteEntry). */
  static readonly LITE_MAX = 6000;
  private tick = 0;
  /** How many time-varying entries a node may keep (default 2). Raised for nodes whose output a downstream node `pull`s at other times. */
  private pullAllow = new Map<string, { n: number; tick: number }>();
  /** Time-varying entries kept per node by default: the current frame and the one before (playback rarely revisits a frame). */
  static readonly TIMED_KEEP = 2;
  /** Upper bound for a node that is pulled over a span of frames (echo, trails, retime). */
  static readonly TIMED_KEEP_MAX = 16;

  /** System-RAM tier (injected by the IO layer). */
  private cold: ColdStore | null = null;
  private coldIndex = new Map<string, ColdMeta>();
  private coldMinMs = 4;
  private demoteInFlight = 0;
  /** Smoothed cost of restoring one MB (ms): an entry is only demoted when recomputing costs clearly more. */
  private promoteMsPerMB = 0.8;
  private coldCounters: ColdStats = { entries: 0, demoted: 0, skippedDemote: 0, promoted: 0, promoteMs: 0, savedMs: 0, misses: 0, lost: 0 };

  /** Install (or remove) the RAM tier. Expensive static results that the LRU would evict are read back into it and uploaded again on the next use. */
  setColdStore(store: ColdStore | null, opts: { minRenderMs?: number } = {}): void {
    this.cold = store;
    if (opts.minRenderMs !== undefined) this.coldMinMs = opts.minRenderMs;
    if (!store) this.coldIndex.clear();
  }

  coldStats(): ColdStats {
    return { ...this.coldCounters, entries: this.coldIndex.size };
  }

  constructor(gpu: Gpu, registry: Registry, host: Host) {
    this.gpu = gpu;
    this.registry = registry;
    this.host = host;
  }

  /** Set by the UI: when it returns true the evaluation stops at the next node ("Pause rendering"). Never aborts a 'final' (export) pass unless the hook says so. */
  shouldAbort: ((quality: 'preview' | 'final') => boolean) | null = null;

  private queue: Promise<unknown> = Promise.resolve();

  /** Evaluations never overlap: calls are queued, so callers need no locking of their own. */
  evaluate(req: EvalRequest): Promise<EvalResult> {
    const run = this.queue.then(() => this.evaluateNow(req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async evaluateNow(req: EvalRequest): Promise<EvalResult> {
    await this.gpu.throttle(); // never more than a couple of frames of GPU work in flight (export would otherwise queue unbounded)
    this.tick++;
    this.gpu.advance();
    this.evictTimed();
    this.evict();
    // Structural fast path: the same document object asked for the same thing, and last time everything it depends on was static (no
    // clock, no item, no process state): the result is the same for every frame, so nothing upstream is walked at all.
    const fastReq = fastKeyOf(req);
    const fast = this.staticRoot;
    if (fast && fast.graph === req.graph && fast.req === fastReq) {
      const entry = this.cache.get(fast.entry);
      if (entry) {
        entry.lastUsed = this.tick;
        this.gpu.fence();
        return { value: entry.outputs[fast.port] ?? null, errors: new Map(), timings: new Map() };
      }
    }
    const root = req.graph;
    const project = root.project;
    const proxy = clampProxy(req.proxy ?? 1);
    const frame = Math.max(0, Math.round((req.seconds ?? 0) * project.fps));
    const frame0 = req.canvas ?? project;
    const { width: cw, height: ch } = proxySize(frame0, proxy);
    const fullCanvas = { width: Math.max(1, Math.round(frame0.width)), height: Math.max(1, Math.round(frame0.height)) };
    const makeScope = (graph: GraphDoc): Scope => {
      const idx = graphIndex(graph);
      const scope: Scope = {
        graph,
        nodes: idx.nodes,
        inbound: idx.inbound,
        seconds: frame / project.fps,
        frame,
        item: req.item ?? 0,
        itemCount: req.itemCount ?? 1,
        proxy,
        quality: req.quality ?? 'preview',
        canvas: { width: cw, height: ch, unit: this.unitFor(graph, cw, ch, proxy) },
        memo: new Map(),
        stack: new Set(),
        errors: new Map(),
        timings: new Map(),
        fullCanvas,
        sigMemo: new Map(),
        fullSigMemo: new Map(),
        frame0: { width: frame0.width, height: frame0.height },
        proxies: new Map(),
        root,
        staticNew: [],
      };
      scope.proxies.set(proxy, scope);
      return scope;
    };

    // Groups: evaluate the flattened document (docs/ENGINE.md, "Group nodes"). A document without groups is used as it is (one lookup).
    let view: FlatView | null = null;
    let graph = root;
    let counted = false;
    const pre = { errors: new Map<string, string>(), timings: new Map<string, number>() };
    if (hasGroups(root)) {
      view = this.flatView(root, req.canvas, req.item ?? 0);
      const opaque = this.opaqueOf(view);
      // Repeat groups whose count is wired: evaluate the count, then unroll that many passes (bounded rounds: counts may depend on counts).
      const counts = new Map<string, number>();
      for (let round = 0; round < 8 && view.dynamic.length; round++) {
        const sc = makeScope(view.graph);
        for (const d of view.dynamic) {
          let n = storedCount(groupData(nodeAtPath(root, d.path) ?? { params: {} }));
          if (d.source) {
            const r = await this.evalNode(d.source.node, sc, true);
            const v = r?.outputs[d.source.port];
            if (typeof v === 'number' && Number.isFinite(v)) n = Math.max(1, Math.round(v));
          }
          counts.set(d.path, n);
        }
        sc.errors.forEach((v, k) => pre.errors.set(k, v));
        sc.timings.forEach((v, k) => pre.timings.set(k, (pre.timings.get(k) ?? 0) + v));
        view = flattenGraph(root, { opaque, counts: new Map(counts) });
        counted = true;
      }
      graph = view.graph;
    }
    const scope = makeScope(graph);
    pre.errors.forEach((v, k) => scope.errors.set(k, v));
    pre.timings.forEach((v, k) => scope.timings.set(k, v));

    let target: { node: string; port: string | undefined } | null = { node: req.node, port: req.port };
    if (view) target = resolveFlatTarget(view, req.node, req.port, () => undefined);
    const node = target && target.node ? scope.nodes.get(target.node) : undefined;
    let made: { result: NodeResult; port: string } | null = null;
    scope.rootNode = node?.id;
    scope.rootPort = target?.port ?? (node ? (defOf(this.registry, node)?.previewOutput ?? Object.keys(defOf(this.registry, node)?.outputs ?? {})[0]) : undefined);
    let value: Value | null = null;
    if (!node) {
      // A group output with nothing wired to it inside is simply empty.
      if (!target || target.node !== '') scope.errors.set(req.node, 'Node not found');
    } else {
      const def = defOf(this.registry, node);
      const result = await this.evalNode(node.id, scope);
      if (def && result) {
        const port = target?.port ?? def.previewOutput ?? Object.keys(def.outputs)[0];
        value = port ? (result.outputs[port] ?? null) : null;
        if (port) made = { result, port };
        // Output-category nodes have no outputs: hand back what arrives on their first input.
        if (!port) {
          const firstIn = Object.keys(def.inputs)[0];
          const edge = firstIn ? (scope.inbound.get(node.id) ?? []).find((e) => e.to.port === firstIn) : undefined;
          if (edge) {
            const up = await this.evalNode(edge.from.node, scope);
            value = up?.outputs[edge.from.port] ?? null;
            if (up) made = { result: up, port: edge.from.port };
          }
        }
      }
    }
    this.staticRoot = null;
    // (a wired Repeat count is evaluated outside the final scope: its time dependence is not in `tv`, so no fast path then)
    if (made && !counted && !made.result.tv && !scope.errors.size && this.cache.has(made.result.key) && !hasProcessNodes(graph, this.registry)) {
      this.staticRoot = { graph: req.graph, req: fastReq, entry: made.result.key, port: made.port };
    }
    // Per-node fast path: remember which node results were static in a clean evaluation of this document (see `staticNodes`).
    if (scope.staticNew?.length && !scope.errors.size && !hasProcessNodes(graph, this.registry)) {
      let m = this.staticNodes.get(graph);
      if (!m) this.staticNodes.set(graph, (m = new Map()));
      for (const [k, v] of scope.staticNew) m.set(k, v);
    }
    if (view) this.liftGroupErrors(view, scope.errors);
    this.gpu.fence();
    return { value, errors: scope.errors, timings: scope.timings };
  }

  /* ------------------------------------------------------------------------------------------------------------------------------ */
  /* Groups                                                                                                                         */
  /* ------------------------------------------------------------------------------------------------------------------------------ */

  /**
   * The document as the engine evaluates it: flattened, with every baked group that may serve its stored outputs kept as one node
   * (Repeat counts that are wired stay unresolved here). The same view the export gate, the process runtime and `processStatus` use, so
   * they all agree with the render path. A document without groups is returned as it is.
   */
  flatView(graph: GraphDoc, canvas?: { width: number; height: number }, item = 0): FlatView {
    const full = flattenGraph(graph);
    if (!full.grouped || !full.baked.length) return full;
    const frame0 = canvas ?? graph.project;
    const opaque = new Set<string>();
    for (const path of full.baked) {
      if (path.split(PATH_SEP).some((p) => p.startsWith('~'))) continue; // a group inside a Repeat pass is never served from a bake
      const st = this.groupStatus(graph, path, canvas);
      if (!st || st.state !== 'done' || !st.result) continue;
      const meta = st.result.meta as { canvas?: string; item?: number | null };
      if (meta.canvas && meta.canvas !== `${Math.round(frame0.width)}x${Math.round(frame0.height)}`) continue; // another frame size: lay out again, live
      if (typeof meta.item === 'number' && meta.item !== item) continue; // baked for one batch item only
      opaque.add(path);
    }
    // Inside an opaque group nothing is evaluated: only the outermost opaque groups matter.
    for (const p of [...opaque]) for (const q of opaque) if (p !== q && p.startsWith(q + PATH_SEP)) opaque.delete(p);
    return opaque.size ? flattenGraph(graph, { opaque }) : full;
  }

  private opaqueOf(view: FlatView): Set<string> {
    return new Set(view.opaque);
  }

  /** Errors inside a group also show on the group (and on every group around it); passes of a Repeat show on the Repeat. */
  private liftGroupErrors(view: FlatView, errors: Map<string, string>): void {
    view.errors.forEach((msg, path) => errors.has(path) || errors.set(path, msg));
    const reverse = new Map<string, string>();
    view.alias.forEach((flat, logical) => reverse.set(flat, logical));
    for (const [id, msg] of [...errors]) {
      if (!id.includes(PATH_SEP)) continue;
      const logical = reverse.get(id);
      if (logical && !errors.has(logical)) errors.set(logical, msg);
      const parts = id.split(PATH_SEP);
      for (let i = parts.length - 1; i > 0; i--) {
        const anc = parts.slice(0, i).filter((p) => !p.startsWith('~')).join(PATH_SEP);
        if (!anc || anc === id) continue;
        if (!errors.has(anc)) errors.set(anc, `Inside: ${msg}`);
      }
    }
  }

  private sigScopes = new WeakMap<GraphDoc, Map<string, Scope>>();

  /** A signature-only scope of a graph at a frame size, kept per (graph object, size): its structural memo survives between calls. */
  private sigScope(graph: GraphDoc, canvas?: { width: number; height: number }): Scope {
    const frame0 = canvas ?? graph.project;
    const key = `${Math.round(frame0.width)}x${Math.round(frame0.height)}`;
    let m = this.sigScopes.get(graph);
    const hit = m?.get(key);
    if (hit) return hit;
    const s = this.miniScope(graph, canvas);
    if (!m) {
      m = new Map();
      this.sigScopes.set(graph, m);
    }
    m.set(key, s);
    return s;
  }

  /**
   * The signature of a group's bake: the structure of everything that feeds each of its outputs in the fully expanded document (inner
   * nodes, inner params, exposed values, outer inputs, project settings, frame size). Taken on the expanded document, so baking a group
   * before it does not make this one stale (the baked picture is the same).
   */
  groupSignature(graph: GraphDoc, path: string, canvas?: { width: number; height: number }): string {
    const full = flattenGraph(graph);
    const node = nodeAtPath(graph, path);
    if (!node || node.type !== GROUP_TYPE) return '';
    const scope = this.sigScope(full.graph, canvas);
    const parts = groupData(node).outputs.map((o) => {
      const ref = full.outputs.get(`${path}:${o.id}`);
      return `${o.id}=${ref ? `${ref.port}:${this.structSig(ref.node, scope, new Set(), true, scope.fullSigMemo)}` : ref === null ? 'none' : 'unexpanded'}`;
    });
    return hash(`group|${parts.join('|')}`);
  }

  /** Process status of a group (its bake), by path. */
  private groupStatus(graph: GraphDoc, path: string, canvas?: { width: number; height: number }): ProcessStatus | null {
    const node = nodeAtPath(graph, path);
    if (!node || node.type !== GROUP_TYPE) return null;
    const handle = processResultOf(node, groupDefOf(node));
    return deriveProcessStatus({
      handle,
      hasData: !handle || processDataPresent(handle, this.host),
      current: this.groupSignature(graph, path, canvas),
      live: this.host.processLive?.(path) ?? null,
      standIn: 'bypass',
    });
  }

  /**
   * The signature a Cache / Bake node sees for `ctx.inputSignature`, computed without evaluating anything: structure of everything
   * upstream of an output port (types, stored params, wiring, project settings, frame size). `canvas` = the frame size at proxy 1
   * (default: the project canvas). `node` may be a path inside groups, or a group (its output `port`).
   */
  signatureOf(graph: GraphDoc, node: string, port: string, canvas?: { width: number; height: number }): string {
    let g = graph;
    let id = node;
    let p = port;
    if (hasGroups(graph)) {
      const view = this.flatView(graph, canvas);
      g = view.graph;
      const t = resolveFlatTarget(view, node, port, () => undefined);
      if (!t || !t.node) return '';
      id = t.node;
      p = t.port ?? port;
    }
    const scope = this.miniScope(g, canvas);
    return `${p}:${this.structSig(id, scope, new Set(), true)}`;
  }

  private miniScope(graph: GraphDoc, canvas?: { width: number; height: number }): Scope {
    const idx = graphIndex(graph);
    const frame0 = canvas ?? graph.project;
    const fullCanvas = { width: Math.max(1, Math.round(frame0.width)), height: Math.max(1, Math.round(frame0.height)) };
    return { graph, nodes: idx.nodes, inbound: idx.inbound, canvas: fullCanvas, fullCanvas, sigMemo: new Map(), fullSigMemo: new Map(), root: graph } as unknown as Scope;
  }

  /**
   * Process mode: the state of a node's process for this graph (never evaluates anything). Null for a node without `process`.
   * Same function the render path uses for the cache key, so the UI, the export gate and the scheduler all agree with the engine.
   * `nodeId` may be a path inside groups; a group's own process is its bake.
   */
  processStatus(graph: GraphDoc, nodeId: string, canvas?: { width: number; height: number }): ProcessStatus | null {
    if (hasGroups(graph)) {
      const target = nodeAtPath(graph, nodeId);
      if (target?.type === GROUP_TYPE) return this.groupStatus(graph, nodeId, canvas);
      const view = this.flatView(graph, canvas);
      const scope = this.miniScope(view.graph, canvas);
      (scope as { root?: GraphDoc }).root = graph;
      const node = scope.nodes.get(view.alias.get(nodeId) ?? nodeId);
      const def = defOf(this.registry, node);
      if (!node || !def?.process) return null;
      return this.processStatusFor(node, def, scope);
    }
    const scope = this.miniScope(graph, canvas);
    const node = scope.nodes.get(nodeId);
    const def = node && this.registry.get(node.type);
    if (!node || !def?.process) return null;
    return this.processStatusFor(node, def, scope);
  }

  /** The signature a finished process of this node must carry (`ProcessDef.signature`), or null for a node without `process`. */
  processSignature(graph: GraphDoc, nodeId: string, canvas?: { width: number; height: number }): string | null {
    return this.processStatus(graph, nodeId, canvas)?.current ?? null;
  }

  private processStatusFor(node: NodeInstance, def: AnyNodeDef, scope: Scope): ProcessStatus {
    // A baked group kept as one node: its status is that of its bake (signature of the expanded document).
    if (node.type === GROUP_TYPE) return this.groupStatus(scope.root ?? scope.graph, node.id, scope.fullCanvas) ?? deriveProcessStatus({ handle: null, hasData: true, current: '', live: null, standIn: 'bypass' });
    const pdef = def.process!;
    const edges = scope.inbound.get(node.id) ?? [];
    const memo = scope.fullSigMemo;
    const sigs: Record<string, string> = {};
    for (const name of Object.keys(def.inputs)) {
      sigs[name] = edges
        .filter((e) => e.to.port === name)
        .map((e) => `${e.from.port}:${this.structSig(e.from.node, scope, new Set(), true, memo)}`)
        .join(',');
    }
    const params: Record<string, unknown> = {};
    for (const [key, p] of Object.entries(def.params as Record<string, ParamDef>)) params[key] = coerceParam(p, node.params[key]);
    const handle = processResultOf(node, def);
    return deriveProcessStatus({
      handle,
      hasData: !handle || processDataPresent(handle, this.host),
      current: pdef.signature(params as never, sigs),
      live: this.host.processLive?.(node.id) ?? null,
      standIn: pdef.standIn,
    });
  }

  private processJson = new Map<string, unknown>();

  /** `ctx.process` of a node render. */
  private processView(
    def: AnyNodeDef,
    status: ProcessStatus,
    scope: Scope,
    inputs: Record<string, Value | Value[] | null>,
    ctx: { gpu: NodeGpu; pull(input: string, at?: { seconds: number; wire?: number }): Promise<Value | null> },
  ): ProcessView {
    const pdef = def.process!;
    const host = this.host;
    const fps = scope.graph.project.fps;
    const item = (name: string) => status.result?.items[name];
    const bytes = async (name: string): Promise<ArrayBuffer | null> => {
      const it = item(name);
      return it && it.kind !== 'sequence' ? ((await host.assetBytes?.(it.id)) ?? null) : null;
    };
    return {
      state: status.state,
      result: status.result,
      servable: isServable(status, pdef.standIn),
      frame: async (name, index, maxSide = 0) => {
        const it = item(name);
        if (!it || it.kind !== 'sequence') return null;
        return host.assetFrame(it.id, index / (it.fps || fps), maxSide);
      },
      bytes,
      json: async <T,>(name: string) => {
        const it = item(name);
        if (!it) return null;
        const k = `${it.id}@${status.result?.createdAt}:${it.bytes}`;
        if (this.processJson.has(k)) return this.processJson.get(k) as T;
        const b = await bytes(name);
        let v: unknown = null;
        if (b) {
          try {
            v = JSON.parse(new TextDecoder().decode(b));
          } catch {
            v = null;
          }
        }
        if (this.processJson.size > 64) this.processJson.delete(this.processJson.keys().next().value as string);
        this.processJson.set(k, v);
        return v as T | null;
      },
      array: async (name) => {
        const it = item(name);
        const b = it && it.kind === 'array' ? await bytes(name) : null;
        if (!it || !b) return null;
        const ctor = { f32: Float32Array, f64: Float64Array, i32: Int32Array, u32: Uint32Array, i16: Int16Array, u16: Uint16Array, i8: Int8Array, u8: Uint8Array }[it.dtype ?? 'u8'];
        return new ctor(b.slice(0)) as ProcessArray;
      },
      standIn: async () => {
        const out: Record<string, Value | null> = {};
        const outNames = Object.keys(def.outputs);
        if (pdef.standIn === 'placeholder') {
          const port = outNames.find((o) => def.outputs[o].type === 'image');
          if (port) {
            const fraction = status.state === 'running' ? Math.min(PLACEHOLDER_STEPS, Math.floor((status.live?.progress ?? 0) * PLACEHOLDER_STEPS)) / PLACEHOLDER_STEPS : null;
            out[port] = placeholderCard(ctx.gpu, host, scope.canvas, pdef.title, fraction);
          }
          return out;
        }
        for (const [name, idef] of Object.entries(def.inputs as Record<string, { type: string; multi?: boolean; lazy?: boolean }>)) {
          const o = outNames.find((n) => def.outputs[n].type === idef.type && !(n in out));
          if (!o) continue;
          let v = inputs[name];
          if (idef.lazy || (v === null && !idef.multi)) v = await ctx.pull(name);
          out[o] = Array.isArray(v) ? (v[0] ?? null) : v;
        }
        return out;
      },
    };
  }

  /**
   * The scope of this evaluation at another proxy factor (`ctx.pull(input, { proxy })`). Own memo and signature memo (both depend on the
   * canvas), everything else shared; one scope per factor per evaluation. Cache keys already contain canvas size and unit, so a result made at
   * factor X is found by anyone who asks for X again, in this evaluation or a later one.
   */
  private scopeAt(scope: Scope, proxy: number): Scope {
    const p = clampProxy(proxy);
    const known = scope.proxies.get(p);
    if (known) return known;
    const { width, height } = proxySize(scope.frame0, p);
    const made: Scope = { ...scope, proxy: p, canvas: { width, height, unit: this.unitFor(scope.graph, width, height, p) }, memo: new Map(), sigMemo: new Map() };
    scope.proxies.set(p, made);
    return made;
  }

  /** Texels per unit pixel for an image of this size. */
  unitFor(graph: GraphDoc, width: number, height: number, proxy: number): number {
    const p = graph.project;
    if (p.lengthMode === 'absolute') return proxy;
    return Math.min(width, height) / Math.max(1, p.referenceSide);
  }

  /** See the structural fast path in `evaluateNow`. Reset whenever the cache is (assets changed, device lost). */
  private staticRoot: { graph: GraphDoc; req: string; entry: string; port: string } | null = null;

  /**
   * Per-node form of the same idea, for ANIMATED graphs: per document object (immutable in the editor), the cache key of every node whose result
   * was static (no clock, no item beyond the key, no process state) the last time a whole evaluation of that document finished without errors,
   * by (node, item, quality, canvas, proxy, lite). A static node found here whose entry is still cached is returned as it is: nothing upstream of it
   * is walked, hashed or looked up, so a frame costs O(time-varying nodes + their direct static inputs) instead of O(every upstream node).
   * Never used with process nodes in the document (their state is part of every key), for nodes with optional outputs (what is wanted depends on
   * the evaluation's target) or for results that are not in the cache (bypass, empty). A different document object has no entries; `clear` and
   * `forgetAll` (assets changed, device lost) drop them all, like the cache itself.
   */
  private staticNodes = new WeakMap<GraphDoc, Map<string, string>>();
  /** Cache hits served by the per-node fast path (tests and the debug overlay). */
  staticNodeHits = 0;

  /** Drop every cached result (e.g. after assets changed on disk). */
  clear(opts: { demote?: boolean } = {}): void {
    this.staticRoot = null;
    this.staticNodes = new WeakMap();
    for (const entry of this.cache.values()) {
      if (opts.demote && this.demote(entry)) continue;
      this.releaseEntry(entry);
    }
    this.cache.clear();
    this.cacheBytes = 0;
    this.reads.clear();
    // Pixels in the RAM tier (and the weightless analysis results) stay valid when the cache is only cleared to save memory, not when content changed.
    if (!opts.demote) {
      this.dropCold();
      this.lite.clear();
    }
  }

  private dropCold(): void {
    if (this.cold) for (const [key, meta] of this.coldIndex) meta.slots.forEach((_, i) => this.cold!.delete(`${key}#${i}`));
    this.coldIndex.clear();
  }

  /* ------------------------------ RAM tier (cold) ------------------------------ */

  private coldEligible(entry: Entry): { textures: GPUTexture[]; slots: { width: number; height: number }[] } | null {
    if (!this.cold || entry.tv || entry.renderMs < Math.max(this.coldMinMs, (entry.bytes / 1048576) * this.promoteMsPerMB * 1.5)) return null;
    const textures: GPUTexture[] = [];
    const slots: { width: number; height: number }[] = [];
    for (const v of Object.values(entry.outputs)) {
      if (v === null || !isTextured(v)) continue;
      if (v.texture.format !== 'rgba8unorm') return null; // intermediates in rgba16float are not worth the readback
      if (!textures.includes(v.texture)) {
        textures.push(v.texture);
        slots.push({ width: v.texture.width, height: v.texture.height });
      }
    }
    return textures.length > 0 && textures.length <= 3 ? { textures, slots } : null;
  }

  /**
   * An entry that is about to be evicted but was expensive to make: read its pixels back into the RAM tier (asynchronously, off
   * the evaluation path) and release the GPU copy afterwards. Returns true when the readback now owns the entry's textures.
   */
  private demote(entry: Entry): boolean {
    const store = this.cold;
    const plan = this.coldEligible(entry);
    if (!store || !plan) return false;
    const known = this.coldIndex.get(entry.key);
    if (known && store.has(`${entry.key}#0`)) {
      known.lastUsed = this.tick; // already in the RAM tier from an earlier demotion
      return false;
    }
    if (this.demoteInFlight >= 2) {
      this.coldCounters.skippedDemote++;
      return false;
    }
    this.demoteInFlight++;
    const key = entry.key;
    const outputs: ColdMeta['outputs'] = {};
    for (const [port, v] of Object.entries(entry.outputs)) {
      if (v === null) outputs[port] = { t: 'null' };
      else if (isTextured(v)) outputs[port] = { t: 'tex', kind: (v as { kind: 'image' | 'mask' }).kind, unit: (v as ImageValue).unit, slot: plan.textures.indexOf(v.texture) };
      else outputs[port] = { t: 'value', v };
    }
    for (const t of plan.textures) this.gpu.retain(t); // the readback owns them until it has finished
    this.releaseEntry(entry);
    void (async () => {
      try {
        let ok = true;
        for (let i = 0; i < plan.textures.length && ok; i++) {
          const t = plan.textures[i];
          const raw = await this.gpu.readRaw({ texture: t, width: t.width, height: t.height });
          ok = await store.put(`${key}#${i}`, { data: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), width: t.width, height: t.height });
        }
        if (ok) {
          this.coldIndex.set(key, { node: entry.node, renderMs: entry.renderMs, bytes: entry.bytes, lastUsed: this.tick, outputs, slots: plan.slots });
          this.coldCounters.demoted++;
          while (this.coldIndex.size > 2000) {
            const oldest = this.coldIndex.keys().next().value as string;
            this.coldIndex.get(oldest)!.slots.forEach((_, i) => store.delete(`${oldest}#${i}`));
            this.coldIndex.delete(oldest);
          }
        } else plan.textures.forEach((_, i) => store.delete(`${key}#${i}`));
      } catch {
        /* the readback is an optimisation only */
      } finally {
        for (const t of plan.textures) this.gpu.release(t);
        this.demoteInFlight--;
      }
    })();
    return true;
  }

  /** Bring a demoted result back onto the GPU. Null when it is not in the RAM tier (or was evicted from it). */
  private async promote(key: string, node: string): Promise<NodeResult | null> {
    const meta = this.coldIndex.get(key);
    const store = this.cold;
    if (!meta || !store) return null;
    const started = performance.now();
    const pixels: { data: Uint8Array; width: number; height: number }[] = [];
    for (let i = 0; i < meta.slots.length; i++) {
      const p = await store.get(`${key}#${i}`);
      if (!p) {
        this.coldIndex.delete(key);
        meta.slots.forEach((_, j) => store.delete(`${key}#${j}`));
        this.coldCounters.lost++;
        this.coldCounters.misses++;
        return null;
      }
      pixels.push(p);
    }
    const outputs: Record<string, Value | null> = {};
    const retained = new Set<GPUTexture>();
    this.gpu.begin('promote');
    try {
      const uploaded = pixels.map((p) => this.gpu.upload(p.data, p.width, p.height, 1, false).texture);
      for (const [port, o] of Object.entries(meta.outputs)) {
        if (o.t === 'null') outputs[port] = null;
        else if (o.t === 'value') outputs[port] = o.v;
        else {
          const slot = meta.slots[o.slot];
          outputs[port] = { kind: o.kind, texture: uploaded[o.slot], width: slot.width, height: slot.height, unit: o.unit } as ImageValue;
        }
      }
      for (const t of uploaded) {
        if (!retained.has(t)) {
          retained.add(t);
          this.gpu.retain(t);
        }
      }
    } finally {
      this.gpu.end();
    }
    const old = this.cache.get(key);
    if (old) {
      this.releaseEntry(old);
      this.cacheBytes -= old.bytes;
    }
    this.cache.set(key, { key, node: meta.node || node, tv: false, outputs, bytes: meta.bytes, lastUsed: this.tick, renderMs: meta.renderMs });
    this.cacheBytes += meta.bytes;
    meta.lastUsed = this.tick;
    const ms = performance.now() - started;
    this.promoteMsPerMB = this.promoteMsPerMB * 0.8 + (ms / Math.max(0.25, meta.bytes / 1048576)) * 0.2;
    this.coldCounters.promoted++;
    this.coldCounters.promoteMs += ms;
    this.coldCounters.savedMs += meta.renderMs;
    return { key, outputs, tv: false };
  }

  /**
   * `lite`: the caller only reads outputs that are not textures (regions, numbers), so a weightless LiteEntry is as good as a full
   * result and the node's inputs need not be evaluated at all.
   */
  private evalNode(id: string, scope: Scope, lite = false): Promise<NodeResult | null> {
    const memoKey = `${id}@${scope.frame}${lite ? '~' : ''}`;
    const existing = scope.memo.get(memoKey);
    if (existing) return existing;
    const known = this.staticNodes.get(scope.graph);
    const sKey = scope.staticNew ? `${id}|${scope.item}/${scope.itemCount}|${scope.quality}|${scope.canvas.width}x${scope.canvas.height}|${scope.fullCanvas.width}x${scope.fullCanvas.height}|${scope.proxy}|${lite ? 1 : 0}` : '';
    if (known && sKey) {
      const entry = this.cache.get(known.get(sKey) ?? '');
      if (entry && !entry.tv) {
        entry.lastUsed = this.tick;
        this.staticNodeHits++;
        const hit = Promise.resolve<NodeResult | null>({ key: entry.key, outputs: entry.outputs, tv: false });
        scope.memo.set(memoKey, hit);
        return hit;
      }
    }
    const promise = this.evalNodeInner(id, scope, lite).then(
      (r) => {
        if (sKey && r && !r.tv && this.cache.has(r.key) && !this.staticOptional(scope, id)) scope.staticNew!.push([sKey, r.key]);
        return r;
      },
      (err) => {
        scope.errors.set(id, err instanceof Error ? err.message : String(err));
        return null;
      },
    );
    scope.memo.set(memoKey, promise);
    return promise;
  }

  /** Nodes with optional outputs (and process nodes) are never taken by the per-node fast path: what they produce depends on the evaluation's target / their process state. */
  private staticOptional(scope: Scope, id: string): boolean {
    const def = defOf(this.registry, scope.nodes.get(id));
    return !def || !!def.optionalOutputs?.length || !!def.process;
  }

  /** Key of a node's CPU-only results: everything that decides them (structure upstream, frame, item, quality), no evaluation needed. */
  private liteKeyOf(id: string, scope: Scope): string {
    return `${this.structSig(id, scope, new Set(), false, scope.sigMemo)}|${scope.frame}|${scope.item}/${scope.itemCount}|${scope.quality}`;
  }

  private liteCapable(def: AnyNodeDef): boolean {
    return def.cpu === true && Object.values(def.outputs as Record<string, { type: string }>).some((o) => !isTextureSocket(o.type));
  }

  private async evalNodeInner(id: string, scope: Scope, lite = false): Promise<NodeResult | null> {
    const node = scope.nodes.get(id);
    if (!node) return null;
    const def = defOf(this.registry, node);
    if (!def) {
      scope.errors.set(id, `Unknown node type "${node.type}" (missing plugin?)`);
      return null;
    }
    if (!def.render) return null; // stream-domain only node: nothing to do per frame
    if (this.shouldAbort?.(scope.quality)) throw new Error('Rendering is paused');
    const stackKey = `${id}@${scope.frame}`;
    if (scope.stack.has(stackKey)) throw new Error('Cycle in graph');
    scope.stack.add(stackKey);

    try {
      // Process mode: where this node's process stands is part of every key below. Nodes without `process` skip all of it.
      const pstat = def.process && !node.bypass ? this.processStatusFor(node, def, scope) : null;
      const psig = pstat ? `|p:${pstat.key}` : '';

      // 0. Analysis nodes: a weightless result for this frame may exist already; then nothing upstream needs to run.
      let liteKey = '';
      if (!node.bypass && this.liteCapable(def)) {
        liteKey = this.liteKeyOf(id, scope) + psig;
        const hit = lite ? this.lite.get(liteKey) : undefined;
        if (hit) {
          hit.lastUsed = this.tick;
          return { key: `lite:${liteKey}`, outputs: hit.outputs, tv: true };
        }
      }

      // 1. Gather inputs (sockets and param sockets) from upstream.
      const edges = scope.inbound.get(id) ?? [];
      const inputs: Record<string, Value | Value[] | null> = {};
      const sigs: string[] = [];
      const wiredParams: Record<string, Value> = {};
      let tvIn = false;
      const tvPorts = new Set<string>();
      const lazyWired = new Set<string>();
      for (const [name, idef] of Object.entries(def.inputs as Record<string, { type: string; multi?: boolean }>)) {
        inputs[name] = idef.multi ? [] : null;
      }
      for (const edge of edges) {
        const lazyDef = def.inputs[edge.to.port] as { lazy?: boolean } | undefined;
        if (lazyDef?.lazy) {
          // Not evaluated here. Identity = structure of everything upstream, so edits invalidate but frames do not.
          sigs.push(`${edge.to.port}=lazy:${this.structSig(edge.from.node, scope, new Set())}:${edge.from.port}:${scope.item}:${scope.proxy}`);
          lazyWired.add(edge.to.port);
          continue;
        }
        const upDef = defOf(this.registry, scope.nodes.get(edge.from.node));
        const fromType = upDef?.outputs[edge.from.port]?.type;
        const up = await this.evalNode(edge.from.node, scope, !!fromType && !isTextureSocket(fromType));
        if (up?.tv) {
          tvIn = true;
          tvPorts.add(edge.to.port);
        }
        const value = up?.outputs[edge.from.port] ?? null;
        const port = edge.to.port;
        const idef = def.inputs[port];
        if (idef) {
          if (!fromType || !canConnect(fromType, idef.type)) continue;
          let v = value;
          if (v && fromType === 'mask' && idef.type === 'image') v = { ...(v as MaskValue), kind: 'image' };
          if (idef.multi) {
            if (v !== null) (inputs[port] as Value[]).push(v);
          } else inputs[port] = v;
          sigs.push(`${port}=${valueSig(v, `${up?.key}:${edge.from.port}`)}`);
        } else if (paramSocketType(def, port) && value !== null && fromType === paramSocketType(def, port)) {
          wiredParams[port] = value;
        }
      }
      // Bundled param sockets: a vector wire fills in its member params, except those that have a wire of their own (that wire wins,
      // even while it carries nothing). From here on the members are ordinary wired numbers: clamping, rounding and px follow below.
      for (const b of paramBundles(def)) {
        const vec = wiredParams[b.port];
        if (vec === undefined) continue;
        delete wiredParams[b.port];
        b.members.forEach((key, i) => {
          if (edges.some((e) => e.to.port === key)) return;
          const n = (vec as number[])[i];
          if (typeof n === 'number') wiredParams[key] = n;
          if (tvPorts.has(b.port)) tvPorts.add(key);
        });
      }

      // The Motion socket (one wire for position and rotation): fills in what no other wire decides. A wire on the single param or on a
      // vector bundle that holds the param wins over it, even while that wire carries nothing.
      const motion = paramMotion(def);
      if (motion) {
        const mv = wiredParams[motion.port] as unknown as MotionValue | undefined;
        delete wiredParams[motion.port];
        if (mv && typeof mv === 'object') {
          const taken = (key: string) => edges.some((e) => e.to.port === key || !!paramBundles(def).find((b) => b.port === e.to.port && b.members.includes(key)));
          const set = (key: string, n: unknown) => {
            if (typeof n !== 'number' || !Number.isFinite(n) || taken(key)) return;
            wiredParams[key] = n;
            if (tvPorts.has(motion.port)) tvPorts.add(key);
          };
          motion.pos.forEach((k, i) => set(k, mv.pos?.[i]));
          motion.rot.forEach((k, i) => set(k, mv.rot?.[i]));
          if (motion.scale) set(motion.scale, mv.scale);
        }
      }

      // 2. Bypass: pass the first input through to the first output of a compatible type.
      if (node.bypass) {
        const outputs: Record<string, Value | null> = {};
        const outNames = Object.keys(def.outputs);
        for (const [name, idef] of Object.entries(def.inputs as Record<string, { type: string; multi?: boolean }>)) {
          const out = outNames.find((o) => def.outputs[o].type === idef.type && !(o in outputs));
          const v = inputs[name];
          if (out) outputs[out] = Array.isArray(v) ? (v[0] ?? null) : v;
        }
        return { key: hash(`bypass|${sortByPort(sigs).join('|')}`), outputs, tv: tvIn };
      }

      // 3. Required inputs missing → the node produces nothing.
      for (const [name, idef] of Object.entries(def.inputs as Record<string, { required?: boolean; multi?: boolean }>)) {
        const v = inputs[name];
        if (lazyWired.has(name)) continue;
        if (idef.required && (v === null || (Array.isArray(v) && v.length === 0))) return { key: `empty:${id}`, outputs: {}, tv: tvIn };
      }

      // 4. Resolve params. 'px' lengths become texels of the reference image (first image/mask input, else the canvas).
      let ref: { unit: number } = scope.canvas;
      for (const name of Object.keys(def.inputs)) {
        const v = inputs[name];
        const first = Array.isArray(v) ? v[0] : v;
        if (isTextured(first)) {
          ref = first;
          break;
        }
      }
      const raw: Record<string, unknown> = {};
      const params: Record<string, unknown> = {};
      for (const [key, p] of Object.entries(def.params as Record<string, ParamDef>)) {
        const wired = wiredParams[key];
        let v: unknown;
        if (wired === undefined) v = coerceParam(p, node.params[key]);
        else if (p.type === 'palette') v = (wired as { colors: unknown }).colors;
        else if (p.type === 'vec2') v = vec2FromVector(p, wired);
        else v = coerceParam(p, wired);
        raw[key] = v;
        if (p.type === 'number' && p.unit === 'px') v = (v as number) * ref.unit;
        else if (p.type === 'vec2' && p.unit === 'px') v = [(v as number[])[0] * ref.unit, (v as number[])[1] * ref.unit];
        params[key] = v;
      }

      // 5. Cache lookup.
      // Outputs that are only produced when used (depth maps): which of them are wanted is part of the identity.
      const optional = def.optionalOutputs ?? [];
      const wantedSet = new Set(optional.filter((o) => (scope.rootNode === id && scope.rootPort === o) || scope.graph.edges.some((e) => e.from.node === id && e.from.port === o)));
      const wantedSig = optional.length ? `|w${[...wantedSet].sort().join(',')}` : '';
      const staticSig = hash(
        `${def.id}|${stableStringify(raw)}|${sortByPort(sigs).join('|')}|u${ref.unit}|c${scope.canvas.width}x${scope.canvas.height}|${scope.quality}${wantedSig}${psig}`,
      );
      const readsKey = `${id}|${staticSig}`;
      const known = this.reads.get(readsKey);
      const fullKey = (r: { time: boolean; item: boolean; path?: boolean }) =>
        staticSig + (r.path ? `^${id}` : '') + (r.time ? `@${scope.frame}/${scope.graph.project.fps}/${scope.graph.project.duration}/${scope.graph.project.loop}` : '') + (r.item ? `#${scope.item}/${scope.itemCount}` : '');
      if (known) {
        // Most recently used last: the pruning in evict() then drops what no frame asks for any more, never the static nodes in use.
        this.reads.delete(readsKey);
        this.reads.set(readsKey, known);
        const hit = this.cache.get(fullKey(known));
        if (hit) {
          hit.lastUsed = this.tick;
          return { key: hit.key, outputs: hit.outputs, tv: hit.tv };
        }
        const restored = await this.promote(fullKey(known), id);
        if (restored) return restored;
      }

      // 6. Render.
      const used = { time: false, item: false, path: false };
      const project = scope.graph.project;
      const totalFrames = Math.max(1, Math.round(project.duration * project.fps));
      const time: TimeInfo = {
        get seconds() { used.time = true; return scope.seconds; },
        get frame() { used.time = true; return scope.frame; },
        get fps() { return project.fps; },
        get duration() { used.time = true; return project.duration; },
        // Loop on: 0..1 over the project, wrapping. Loop off: the same over the project, and it runs on past 1 when time runs on past the
        // end (the player's "run on" mode for live recording), so nothing jumps back and stepped randomness keeps finding new values.
        get phase() { used.time = true; return project.loop || scope.frame < 0 ? (((scope.frame % totalFrames) + totalFrames) % totalFrames) / totalFrames : scope.frame / totalFrames; },
        get loop() { used.time = true; return project.loop; },
      };
      const itemInfo = {
        get index() { used.item = true; return scope.item; },
        get count() { used.item = true; return scope.itemCount; },
      };
      const started = performance.now();
      const pulled: GPUTexture[] = [];
      let selfBase: string | null = null;
      const selfBaseOf = () =>
        (selfBase ??= `${this.structSig(id, scope, new Set(), false, new Map(), def.previousKey)}|u${ref.unit}|${scope.canvas.width}x${scope.canvas.height}|${scope.quality}|${scope.item}/${scope.itemCount}`);
      const ctx = {
        inputVaries: (input: string) => tvPorts.has(input),
        previous: (opts?: { wrap?: boolean; carry?: boolean }) => {
          if (!def.usesPrevious) return null;
          used.time = true;
          // frame 0 of a loop has a previous one only when the node asks (`wrap`): the last frame of the loop.
          const before = scope.frame >= 1 ? scope.frame - 1 : opts?.wrap && project.loop && totalFrames > 1 ? totalFrames - 1 : -1;
          if (before < 0) return null;
          const hit = this.cache.get(this.selfIndex.get(`${selfBaseOf()}@${before}`) ?? '');
          const v = hit ? (opts?.carry ? hit.outputs.carry : Object.entries(hit.outputs).find(([k, x]) => k !== 'carry' && isTextured(x))?.[1]) : null;
          if (!hit || !v || !isTextured(v) || v.kind !== 'image') return null;
          hit.lastUsed = this.tick;
          this.gpu.retain(v.texture);
          pulled.push(v.texture);
          return v;
        },
        params,
        in: inputs,
        gpu: this.gpu.facade(),
        time,
        canvas: scope.canvas,
        item: itemInfo,
        host: this.host,
        quality: scope.quality,
        // Seed base: the id the node has in its own level, so grouping a node never changes its look (docs/ENGINE.md, "Group nodes").
        nodeId: localId(id),
        get path() {
          used.path = true;
          return id;
        },
        proxy: scope.proxy,
        wants: (output: string) => !optional.includes(output) || wantedSet.has(output),
        unitFor: (w: number, h: number) => this.unitFor(scope.graph, w, h, scope.proxy),
        canvasAt: (proxy: number) => this.scopeAt(scope, proxy).canvas,
        px: (unitPixels: number, r?: { unit: number }) => unitPixels * (r ?? ref).unit,
        inputSignature: (input: string) => {
          const edge = edges.find((e) => e.to.port === input);
          return edge ? `${edge.from.port}:${this.structSig(edge.from.node, scope, new Set(), true)}` : '';
        },
        pull: async (input: string, at?: { seconds?: number; wire?: number; proxy?: number }) => {
          const edge = edges.filter((e) => e.to.port === input)[at?.wire ?? 0];
          if (!edge) return null;
          // No `at` = current frame. That only makes this node time-dependent when what it pulled varies with time: a static
          // upstream gives the same picture on every frame, so a pass-through node (Cache / Bake) stays cacheable.
          // `at.proxy` = evaluate the input at another ABSOLUTE proxy factor (docs/ENGINE.md, Pending rules): same graph, canvas / unit / sources at that factor.
          const timed = at?.seconds !== undefined;
          const frame = Math.max(0, Math.round((timed ? at!.seconds! : scope.seconds) * project.fps));
          const base = at?.proxy === undefined ? scope : this.scopeAt(scope, at.proxy);
          const sub: Scope = { ...base, frame, seconds: frame / project.fps };
          if (frame !== scope.frame) this.widenAllowance(edge.from.node, Math.abs(scope.frame - frame) + 1);
          const pulledType = defOf(this.registry, scope.nodes.get(edge.from.node))?.outputs[edge.from.port]?.type;
          const up = await this.evalNode(edge.from.node, sub, !!pulledType && !isTextureSocket(pulledType));
          if (up?.tv) tvPorts.add(input);
          if (!timed && up?.tv) used.time = true;
          const v = up?.outputs[edge.from.port] ?? null;
          if (isTextured(v)) {
            this.gpu.retain(v.texture);
            pulled.push(v.texture);
          }
          return v;
        },
      };
      if (pstat) (ctx as { process?: ProcessView }).process = this.processView(def, pstat, scope, inputs, ctx as never);
      let outputs: Record<string, Value | null>;
      const retained = new Set<GPUTexture>();
      this.gpu.begin(`${def.id}:${id}`);
      try {
        outputs = ((await def.render(ctx as never)) ?? {}) as Record<string, Value | null>;
        this.checkOutputs(def, outputs);
        if (def.maskable) this.applyMask(def, inputs, outputs, params.mix as number);
        await this.gpu.checkErrors();
        for (const v of Object.values(outputs)) {
          for (const tex of texturesOf(v)) {
            if (!retained.has(tex)) {
              retained.add(tex);
              this.gpu.retain(tex);
            }
          }
        }
      } finally {
        pulled.forEach((t) => this.gpu.release(t));
        this.gpu.end();
      }
      const renderMs = performance.now() - started;
      scope.timings.set(id, (scope.timings.get(id) ?? 0) + renderMs);

      // 7. Store.
      this.reads.set(readsKey, used);
      const key = fullKey(used);
      let bytes = 0;
      for (const tex of retained) bytes += tex.width * tex.height * (tex.format === 'rgba8unorm' ? 4 : 8);
      const old = this.cache.get(key);
      if (old) {
        this.releaseEntry(old);
        this.cacheBytes -= old.bytes;
      }
      const tv = used.time || tvIn;
      this.cache.set(key, { key, node: id, tv, outputs, bytes, lastUsed: this.tick, renderMs });
      this.cacheBytes += bytes;
      if (def.usesPrevious && used.time) {
        const idx = `${selfBaseOf()}@${scope.frame}`;
        this.selfIndex.delete(idx);
        this.selfIndex.set(idx, key);
        if (this.selfIndex.size > Engine.SELF_INDEX_MAX) this.selfIndex.delete(this.selfIndex.keys().next().value as string);
      }
      if (liteKey && tv) {
        const cpuOnly: Record<string, Value | null> = {};
        for (const [port, v] of Object.entries(outputs)) if (!isTextured(v) && !(Array.isArray(v) && v.length && isTextured(v[0]))) cpuOnly[port] = v;
        this.lite.set(liteKey, { node: id, outputs: cpuOnly, lastUsed: this.tick });
      }
      return { key, outputs, tv };
    } finally {
      scope.stack.delete(stackKey);
    }
  }

  /** Hash of a node and everything upstream of it (types, stored params, wiring): changes only when the graph is edited. */
  private structSig(id: string, scope: Scope, seen: Set<string>, full = false, memo: Map<string, string> = new Map(), onlyParams?: string[]): string {
    const done = memo.get(id);
    if (done) return done;
    if (seen.has(id)) return 'cycle';
    seen.add(id);
    const node = scope.nodes.get(id);
    if (!node) {
      seen.delete(id);
      return 'missing';
    }
    const ins = (scope.inbound.get(id) ?? [])
      .map((e) => `${e.to.port}<${e.from.port}:${this.structSig(e.from.node, scope, seen, full, memo)}`)
      .sort()
      .join(',');
    const p = scope.graph.project;
    // Media a node reads: a replaced file under the same id (different size or length) changes the signature too.
    let media = '';
    const def = defOf(this.registry, node);
    if (def) {
      for (const [key, pd] of Object.entries(def.params as Record<string, ParamDef>)) {
        const v = node.params[key];
        if (pd.type === 'assets' && Array.isArray(v)) {
          for (const a of v) {
            const info = typeof a === 'string' ? this.host.assetInfo(a) : null;
            media += info ? `|${info.width}x${info.height}x${info.duration}x${info.fps}` : '|?';
          }
        }
      }
    }
    // `full`: independent of the playback proxy, so a signature taken while playing equals one taken while paused.
    const c = full ? scope.fullCanvas : scope.canvas;
    const sig = hash(`${node.type}|${stableStringify(onlyParams ? Object.fromEntries(Object.entries(node.params).filter(([k]) => onlyParams.includes(k))) : node.params)}${media}|${node.bypass ? 1 : 0}|${ins}|${c.width}x${c.height}|${p.fps}|${p.duration}|${p.loop}|${p.lengthMode}|${p.referenceSide}`);
    seen.delete(id);
    memo.set(id, sig);
    return sig;
  }

  /** Fusion-style effect mask + mix, applied by the kernel for `maskable` nodes. */
  private applyMask(def: AnyNodeDef, inputs: Record<string, Value | Value[] | null>, outputs: Record<string, Value | null>, mix: number): void {
    const mask = inputs.mask as MaskValue | null;
    if (!mask && mix >= 1) return;
    const outName = Object.keys(def.outputs).find((o) => def.outputs[o].type === 'image');
    const inName = Object.keys(def.inputs).find((i) => def.inputs[i].type === 'image');
    if (!outName || !inName) return;
    const out = outputs[outName] as ImageValue | null;
    const src = inputs[inName] as ImageValue | null;
    if (!out || !src) return;
    // An effect that returned a smaller image (Pixelate's art grid) is crisp-upscaled to the source size by the nearest
    // sampling below, and the result is stamped with the grid cell (art-grid rule, docs/ENGINE.md 28).
    const same = out.width === src.width && out.height === src.height;
    if (!same && (out.width > src.width || out.height > src.height)) return;
    const textures: Record<string, { texture: GPUTexture }> = { ta: src, tb: out };
    if (mask) textures.m = mask;
    const blended = this.gpu.pass({
      label: 'effect-mask',
      size: same ? out : src,
      textures,
      uniforms: { mix },
      wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = textureSampleLevel(ta, smpNearest, uv, 0.0);
  let b = textureSampleLevel(tb, smpNearest, uv, 0.0);
  ${mask ? 'let k = u.mix * textureSampleLevel(m, smp, uv, 0.0).r;' : 'let k = u.mix;'}
  return mix(a, b, k);
}`,
    });
    const cell = same ? out.cell : src.height / out.height;
    outputs[outName] = cell !== undefined && cell > 1 ? { ...blended, cell } : blended;
  }

  private checkOutputs(def: AnyNodeDef, outputs: Record<string, Value | null>): void {
    for (const [name, v] of Object.entries(outputs)) {
      const odef = def.outputs[name] ?? (name === 'carry' && def.usesPrevious ? { type: 'image' as const } : undefined); // `carry`: see NodeDef.usesPrevious
      if (!odef) throw new Error(`render() returned unknown output "${name}"`);
      if (v === null || v === undefined) continue;
      // plain arrays: a vector has three numbers, a colour four
      const kind = typeof v === 'number' ? 'number' : Array.isArray(v) ? (v.length === 3 ? 'vector' : 'color') : (v as { kind: string }).kind;
      if (kind !== odef.type) throw new Error(`output "${name}" should be ${odef.type} but render() returned ${kind}`);
    }
  }

  private releaseEntry(entry: Entry): void {
    const seen = new Set<GPUTexture>();
    for (const v of Object.values(entry.outputs)) {
      for (const tex of texturesOf(v)) {
        if (!seen.has(tex)) {
          seen.add(tex);
          this.gpu.release(tex);
        }
      }
    }
  }

  /**
   * Time-varying entries are keyed by frame and rarely used twice during playback (the player keeps the final frames itself).
   * Keep only the newest few per node, evicting the older ones at the start of the next evaluation (never mid-evaluation).
   */
  private evictTimed(): void {
    const groups = new Map<string, Entry[]>();
    for (const e of this.cache.values()) {
      if (!e.tv) continue;
      const list = groups.get(e.node);
      if (list) list.push(e);
      else groups.set(e.node, [e]);
    }
    for (const [node, list] of groups) {
      const allow = this.timedAllowance(node);
      if (list.length <= allow) continue;
      list.sort((a, b) => b.lastUsed - a.lastUsed);
      for (const e of list.slice(allow)) {
        this.cache.delete(e.key);
        this.cacheBytes -= e.bytes;
        this.releaseEntry(e);
      }
    }
  }

  private timedAllowance(node: string): number {
    const a = this.pullAllow.get(node);
    if (a && this.tick - a.tick <= 60) return a.n;
    return Engine.TIMED_KEEP;
  }

  /** A downstream node pulled `node` over `span` frames: keep that many of its recent frames. */
  private widenAllowance(node: string, span: number): void {
    const want = Math.min(Engine.TIMED_KEEP_MAX, Math.max(Engine.TIMED_KEEP, span + 1));
    const cur = this.pullAllow.get(node);
    const keep = cur && this.tick - cur.tick <= 60 ? Math.max(cur.n, want) : want;
    this.pullAllow.set(node, { n: keep, tick: this.tick });
  }

  /** Drop every cached result without touching the GPU: used after a device loss, when all textures are already invalid. */
  forgetAll(): void {
    this.staticRoot = null;
    this.staticNodes = new WeakMap();
    this.cache.clear();
    this.cacheBytes = 0;
    this.reads.clear();
    this.lite.clear();
    this.selfIndex.clear();
    this.pullAllow.clear();
    this.dropCold(); // the key space is gone with the cache
  }

  /** Bytes of texture memory held by cached node results. */
  get cachedBytes(): number {
    return this.cacheBytes;
  }

  /**
   * Eviction, run only between evaluations so nothing in use is ever freed. What goes first is what is cheapest to get back per byte
   * it frees: value = render time x (a time-keyed entry is rarely asked for again, the player keeps the finished frames) / (1 + age),
   * divided by its size. An expensive static result (a heavy generator everything downstream uses) therefore outlives cheap or
   * per-frame ones. The entries the previous evaluation used (the picture on screen and everything it was made from) are not
   * candidates in the first pass; they are only touched when nothing else gets the cache under its hard budget.
   * RAM spill (`demote`) is tried before an expensive entry is dropped.
   */
  private evict(): void {
    if (this.lite.size > Engine.LITE_MAX) {
      const byAge = [...this.lite.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      for (const [k] of byAge.slice(0, Math.ceil(Engine.LITE_MAX * 0.25))) this.lite.delete(k);
    }
    if (this.reads.size > 20000) {
      // Oldest first (insertion order, refreshed on use): never forgets what static nodes in use need.
      let drop = 5000;
      for (const k of this.reads.keys()) {
        if (drop-- <= 0) break;
        this.reads.delete(k);
      }
    }
    if (this.cacheBytes <= this.cacheBudget && this.cache.size < 4000) return;
    const value = (e: Entry): number => ((e.renderMs + 0.5) * (e.tv ? 0.25 : 1)) / (1 + (this.tick - e.lastUsed) / 8) / (e.bytes / 1048576 + 0.1);
    const entries = [...this.cache.values()].sort((a, b) => value(a) - value(b) || a.lastUsed - b.lastUsed);
    const working = this.tick - 1;
    const drop = (entry: Entry) => {
      this.cache.delete(entry.key);
      this.cacheBytes -= entry.bytes;
      if (!this.demote(entry)) this.releaseEntry(entry);
    };
    for (const entry of entries) {
      if (this.cacheBytes <= this.cacheBudget * 0.7 && this.cache.size < 3000) break;
      if (entry.lastUsed >= working) continue;
      drop(entry);
    }
    if (this.cacheBytes > this.cacheBudget || this.cache.size >= 4000) {
      for (const entry of entries) {
        if (this.cacheBytes <= this.cacheBudget * 0.7 && this.cache.size < 3000) break;
        if (this.cache.get(entry.key) === entry) drop(entry);
      }
    }
  }
}

/** Order input signatures by port name only, keeping wire order within a port (layer order of multi inputs matters). */
function sortByPort(sigs: string[]): string[] {
  const port = (s: string) => s.slice(0, s.indexOf('='));
  return [...sigs].sort((a, b) => (port(a) < port(b) ? -1 : port(a) > port(b) ? 1 : 0));
}
