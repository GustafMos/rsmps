/**
 * The evaluator. Pull-based and lazy: asking for one output evaluates only the
 * nodes upstream of it, and every node result is cached by a signature built
 * from its type, resolved params and the signatures of its inputs. A node is
 * re-rendered per frame only if it (or something upstream) actually read the clock.
 */
import { Registry, canConnect, paramSocketType } from './define';
import { Gpu } from './gpu/gpu';
import { stableStringify } from './lib/stable-json';
import type {
  AnyNodeDef,
  CanvasInfo,
  Edge,
  GraphDoc,
  ColdStore,
  Host,
  ImageValue,
  MaskValue,
  NodeInstance,
  ParamDef,
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
function valueSig(v: Value | Value[] | null, sourceKey: string): string {
  if (v === null) return 'null';
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

function coerceParam(p: ParamDef, raw: unknown): unknown {
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

export class Engine {
  readonly gpu: Gpu;
  readonly registry: Registry;
  host: Host;
  /** Cache budget for node results, in bytes of texture memory. */
  cacheBudget = 384 * 1024 * 1024;

  private cache = new Map<string, Entry>();
  private cacheBytes = 0;
  /** What a node read last time under a given static signature: decides whether time/item enter its key. */
  private reads = new Map<string, { time: boolean; item: boolean }>();
  private lite = new Map<string, LiteEntry>();
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
    const { graph } = req;
    const project = graph.project;
    const proxy = Math.min(1, Math.max(0.05, req.proxy ?? 1));
    const frame = Math.max(0, Math.round((req.seconds ?? 0) * project.fps));
    const frame0 = req.canvas ?? project;
    const cw = Math.max(1, Math.round(frame0.width * proxy));
    const ch = Math.max(1, Math.round(frame0.height * proxy));
    const inbound = new Map<string, Edge[]>();
    for (const e of graph.edges) {
      const list = inbound.get(e.to.node);
      if (list) list.push(e);
      else inbound.set(e.to.node, [e]);
    }
    const scope: Scope = {
      graph,
      nodes: new Map(graph.nodes.map((n) => [n.id, n])),
      inbound,
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
      fullCanvas: { width: Math.max(1, Math.round(frame0.width)), height: Math.max(1, Math.round(frame0.height)) },
      sigMemo: new Map(),
    };

    const node = scope.nodes.get(req.node);
    let value: Value | null = null;
    if (!node) {
      scope.errors.set(req.node, 'Node not found');
    } else {
      const def = this.registry.get(node.type);
      const result = await this.evalNode(node.id, scope);
      if (def && result) {
        const port = req.port ?? Object.keys(def.outputs)[0];
        value = port ? (result.outputs[port] ?? null) : null;
        // Output-category nodes have no outputs: hand back what arrives on their first input.
        if (!port) {
          const firstIn = Object.keys(def.inputs)[0];
          const edge = firstIn ? (inbound.get(node.id) ?? []).find((e) => e.to.port === firstIn) : undefined;
          if (edge) {
            const up = await this.evalNode(edge.from.node, scope);
            value = up?.outputs[edge.from.port] ?? null;
          }
        }
      }
    }
    this.gpu.fence();
    return { value, errors: scope.errors, timings: scope.timings };
  }

  /**
   * The signature a Cache / Bake node sees for `ctx.inputSignature`, computed without evaluating anything: structure of everything
   * upstream of an output port (types, stored params, wiring, project settings, frame size). `canvas` = the frame size at proxy 1
   * (default: the project canvas).
   */
  signatureOf(graph: GraphDoc, node: string, port: string, canvas?: { width: number; height: number }): string {
    const inbound = new Map<string, Edge[]>();
    for (const e of graph.edges) {
      const list = inbound.get(e.to.node);
      if (list) list.push(e);
      else inbound.set(e.to.node, [e]);
    }
    const frame0 = canvas ?? graph.project;
    const fullCanvas = { width: Math.max(1, Math.round(frame0.width)), height: Math.max(1, Math.round(frame0.height)) };
    const scope = { graph, nodes: new Map(graph.nodes.map((n) => [n.id, n])), inbound, canvas: fullCanvas, fullCanvas, sigMemo: new Map() } as unknown as Scope;
    return `${port}:${this.structSig(node, scope, new Set(), true)}`;
  }

  /** Texels per unit pixel for an image of this size. */
  unitFor(graph: GraphDoc, width: number, height: number, proxy: number): number {
    const p = graph.project;
    if (p.lengthMode === 'absolute') return proxy;
    return Math.min(width, height) / Math.max(1, p.referenceSide);
  }

  /** Drop every cached result (e.g. after assets changed on disk). */
  clear(opts: { demote?: boolean } = {}): void {
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
    const promise = this.evalNodeInner(id, scope, lite).catch((err) => {
      scope.errors.set(id, err instanceof Error ? err.message : String(err));
      return null;
    });
    scope.memo.set(memoKey, promise);
    return promise;
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
    const def = this.registry.get(node.type);
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
      // 0. Analysis nodes: a weightless result for this frame may exist already; then nothing upstream needs to run.
      let liteKey = '';
      if (!node.bypass && this.liteCapable(def)) {
        liteKey = this.liteKeyOf(id, scope);
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
        const upDef = this.registry.get(scope.nodes.get(edge.from.node)?.type ?? '');
        const fromType = upDef?.outputs[edge.from.port]?.type;
        const up = await this.evalNode(edge.from.node, scope, !!fromType && !isTextureSocket(fromType));
        if (up?.tv) tvIn = true;
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
        else v = coerceParam(p, wired);
        raw[key] = v;
        if (p.type === 'number' && p.unit === 'px') v = (v as number) * ref.unit;
        else if (p.type === 'vec2' && p.unit === 'px') v = [(v as number[])[0] * ref.unit, (v as number[])[1] * ref.unit];
        params[key] = v;
      }

      // 5. Cache lookup.
      const staticSig = hash(
        `${def.id}|${stableStringify(raw)}|${sortByPort(sigs).join('|')}|u${ref.unit}|c${scope.canvas.width}x${scope.canvas.height}|${scope.quality}`,
      );
      const readsKey = `${id}|${staticSig}`;
      const known = this.reads.get(readsKey);
      const fullKey = (r: { time: boolean; item: boolean }) =>
        staticSig + (r.time ? `@${scope.frame}/${scope.graph.project.fps}/${scope.graph.project.duration}/${scope.graph.project.loop}` : '') + (r.item ? `#${scope.item}/${scope.itemCount}` : '');
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
      const used = { time: false, item: false };
      const project = scope.graph.project;
      const totalFrames = Math.max(1, Math.round(project.duration * project.fps));
      const time: TimeInfo = {
        get seconds() { used.time = true; return scope.seconds; },
        get frame() { used.time = true; return scope.frame; },
        get fps() { return project.fps; },
        get duration() { used.time = true; return project.duration; },
        get phase() { used.time = true; return (((scope.frame % totalFrames) + totalFrames) % totalFrames) / totalFrames; },
        get loop() { used.time = true; return project.loop; },
      };
      const itemInfo = {
        get index() { used.item = true; return scope.item; },
        get count() { used.item = true; return scope.itemCount; },
      };
      const started = performance.now();
      const pulled: GPUTexture[] = [];
      const ctx = {
        params,
        in: inputs,
        gpu: this.gpu.facade(),
        time,
        canvas: scope.canvas,
        item: itemInfo,
        host: this.host,
        quality: scope.quality,
        nodeId: id,
        proxy: scope.proxy,
        unitFor: (w: number, h: number) => this.unitFor(scope.graph, w, h, scope.proxy),
        px: (unitPixels: number, r?: { unit: number }) => unitPixels * (r ?? ref).unit,
        inputSignature: (input: string) => {
          const edge = edges.find((e) => e.to.port === input);
          return edge ? `${edge.from.port}:${this.structSig(edge.from.node, scope, new Set(), true)}` : '';
        },
        pull: async (input: string, at?: { seconds: number; wire?: number }) => {
          const edge = edges.filter((e) => e.to.port === input)[at?.wire ?? 0];
          if (!edge) return null;
          // No `at` = current frame. That only makes this node time-dependent when what it pulled varies with time: a static
          // upstream gives the same picture on every frame, so a pass-through node (Cache / Bake) stays cacheable.
          const frame = Math.max(0, Math.round((at ? at.seconds : scope.seconds) * project.fps));
          const sub: Scope = { ...scope, frame, seconds: frame / project.fps };
          if (frame !== scope.frame) this.widenAllowance(edge.from.node, Math.abs(scope.frame - frame) + 1);
          const pulledType = this.registry.get(scope.nodes.get(edge.from.node)?.type ?? '')?.outputs[edge.from.port]?.type;
          const up = await this.evalNode(edge.from.node, sub, !!pulledType && !isTextureSocket(pulledType));
          if (!at && up?.tv) used.time = true;
          const v = up?.outputs[edge.from.port] ?? null;
          if (isTextured(v)) {
            this.gpu.retain(v.texture);
            pulled.push(v.texture);
          }
          return v;
        },
      };
      let outputs: Record<string, Value | null>;
      const retained = new Set<GPUTexture>();
      this.gpu.begin(`${def.id}:${id}`);
      try {
        outputs = ((await def.render(ctx as never)) ?? {}) as Record<string, Value | null>;
        this.checkOutputs(def, outputs);
        if (def.maskable) this.applyMask(def, inputs, outputs, params.mix as number);
        await this.gpu.checkErrors();
        for (const v of Object.values(outputs)) {
          if (isTextured(v) && !retained.has(v.texture)) {
            retained.add(v.texture);
            this.gpu.retain(v.texture);
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
  private structSig(id: string, scope: Scope, seen: Set<string>, full = false, memo: Map<string, string> = new Map()): string {
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
    const def = this.registry.get(node.type);
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
    const sig = hash(`${node.type}|${stableStringify(node.params)}${media}|${node.bypass ? 1 : 0}|${ins}|${c.width}x${c.height}|${p.fps}|${p.duration}|${p.loop}|${p.lengthMode}|${p.referenceSide}`);
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
      const odef = def.outputs[name];
      if (!odef) throw new Error(`render() returned unknown output "${name}"`);
      if (v === null || v === undefined) continue;
      const kind = typeof v === 'number' ? 'number' : Array.isArray(v) ? 'color' : (v as { kind: string }).kind;
      if (kind !== odef.type) throw new Error(`output "${name}" should be ${odef.type} but render() returned ${kind}`);
    }
  }

  private releaseEntry(entry: Entry): void {
    const seen = new Set<GPUTexture>();
    for (const v of Object.values(entry.outputs)) {
      if (isTextured(v) && !seen.has(v.texture)) {
        seen.add(v.texture);
        this.gpu.release(v.texture);
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
    this.cache.clear();
    this.cacheBytes = 0;
    this.reads.clear();
    this.lite.clear();
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
