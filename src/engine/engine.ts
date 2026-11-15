/**
 * The evaluator. Pull-based and lazy: asking for one output evaluates only the
 * nodes upstream of it, and every node result is cached by a signature built
 * from its type, resolved params and the signatures of its inputs. A node is
 * re-rendered per frame only if it (or something upstream) actually read the clock.
 */
import { Registry, canConnect, paramSocketType } from './define';
import { Gpu } from './gpu/gpu';
import type {
  AnyNodeDef,
  CanvasInfo,
  Edge,
  GraphDoc,
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
  outputs: Record<string, Value | null>;
  bytes: number;
  lastUsed: number;
}

interface NodeResult {
  key: string;
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

/** Signature of a value for cache keys: textures are identified by the key of the node that made them. */
function valueSig(v: Value | Value[] | null, sourceKey: string): string {
  if (v === null) return 'null';
  if (Array.isArray(v) && v.length && isTextured(v[0])) return sourceKey;
  if (isTextured(v)) return sourceKey;
  return JSON.stringify(v);
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
    default:
      return raw === undefined ? p.default : raw;
  }
}

export class Engine {
  readonly gpu: Gpu;
  readonly registry: Registry;
  host: Host;
  /** Cache budget for node results, in bytes of texture memory. */
  cacheBudget = 768 * 1024 * 1024;

  private cache = new Map<string, Entry>();
  private cacheBytes = 0;
  /** What a node read last time under a given static signature: decides whether time/item enter its key. */
  private reads = new Map<string, { time: boolean; item: boolean }>();
  private tick = 0;

  constructor(gpu: Gpu, registry: Registry, host: Host) {
    this.gpu = gpu;
    this.registry = registry;
    this.host = host;
  }

  private queue: Promise<unknown> = Promise.resolve();

  /** Evaluations never overlap: calls are queued, so callers need no locking of their own. */
  evaluate(req: EvalRequest): Promise<EvalResult> {
    const run = this.queue.then(() => this.evaluateNow(req));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async evaluateNow(req: EvalRequest): Promise<EvalResult> {
    this.tick++;
    this.evict();
    const { graph } = req;
    const project = graph.project;
    const proxy = Math.min(1, Math.max(0.05, req.proxy ?? 1));
    const frame = Math.max(0, Math.round((req.seconds ?? 0) * project.fps));
    const cw = Math.max(1, Math.round(project.width * proxy));
    const ch = Math.max(1, Math.round(project.height * proxy));
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
    return { value, errors: scope.errors, timings: scope.timings };
  }

  /** Texels per unit pixel for an image of this size. */
  unitFor(graph: GraphDoc, width: number, height: number, proxy: number): number {
    const p = graph.project;
    if (p.lengthMode === 'absolute') return proxy;
    return Math.min(width, height) / Math.max(1, p.referenceSide);
  }

  /** Drop every cached result (e.g. after assets changed on disk). */
  clear(): void {
    for (const entry of this.cache.values()) this.releaseEntry(entry);
    this.cache.clear();
    this.cacheBytes = 0;
    this.reads.clear();
  }

  private evalNode(id: string, scope: Scope): Promise<NodeResult | null> {
    const memoKey = `${id}@${scope.frame}`;
    const existing = scope.memo.get(memoKey);
    if (existing) return existing;
    const promise = this.evalNodeInner(id, scope).catch((err) => {
      scope.errors.set(id, err instanceof Error ? err.message : String(err));
      return null;
    });
    scope.memo.set(memoKey, promise);
    return promise;
  }

  private async evalNodeInner(id: string, scope: Scope): Promise<NodeResult | null> {
    const node = scope.nodes.get(id);
    if (!node) return null;
    const def = this.registry.get(node.type);
    if (!def) {
      scope.errors.set(id, `Unknown node type "${node.type}" (missing plugin?)`);
      return null;
    }
    if (!def.render) return null; // stream-domain only node: nothing to do per frame
    const stackKey = `${id}@${scope.frame}`;
    if (scope.stack.has(stackKey)) throw new Error('Cycle in graph');
    scope.stack.add(stackKey);

    try {
      // 1. Gather inputs (sockets and param sockets) from upstream.
      const edges = scope.inbound.get(id) ?? [];
      const inputs: Record<string, Value | Value[] | null> = {};
      const sigs: string[] = [];
      const wiredParams: Record<string, Value> = {};
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
        const up = await this.evalNode(edge.from.node, scope);
        const value = up?.outputs[edge.from.port] ?? null;
        const upDef = this.registry.get(scope.nodes.get(edge.from.node)?.type ?? '');
        const fromType = upDef?.outputs[edge.from.port]?.type;
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
        return { key: hash(`bypass|${sigs.sort().join('|')}`), outputs };
      }

      // 3. Required inputs missing → the node produces nothing.
      for (const [name, idef] of Object.entries(def.inputs as Record<string, { required?: boolean; multi?: boolean }>)) {
        const v = inputs[name];
        if (lazyWired.has(name)) continue;
        if (idef.required && (v === null || (Array.isArray(v) && v.length === 0))) return { key: `empty:${id}`, outputs: {} };
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
        `${def.id}|${JSON.stringify(raw)}|${sigs.sort().join('|')}|u${ref.unit}|c${scope.canvas.width}x${scope.canvas.height}|${scope.quality}`,
      );
      const readsKey = `${id}|${staticSig}`;
      const known = this.reads.get(readsKey);
      const fullKey = (r: { time: boolean; item: boolean }) =>
        staticSig + (r.time ? `@${scope.frame}/${scope.graph.project.fps}/${scope.graph.project.duration}/${scope.graph.project.loop}` : '') + (r.item ? `#${scope.item}/${scope.itemCount}` : '');
      if (known) {
        const hit = this.cache.get(fullKey(known));
        if (hit) {
          hit.lastUsed = this.tick;
          return { key: hit.key, outputs: hit.outputs };
        }
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
        pull: async (input: string, at?: { seconds: number }) => {
          const edge = edges.find((e) => e.to.port === input);
          if (!edge) return null;
          // No `at` = current frame, which makes the node time-dependent (through the clock getter).
          const frame = Math.max(0, Math.round((at ? at.seconds : time.seconds) * project.fps));
          const sub: Scope = { ...scope, frame, seconds: frame / project.fps };
          const up = await this.evalNode(edge.from.node, sub);
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
      this.gpu.begin();
      try {
        outputs = ((await def.render(ctx as never)) ?? {}) as Record<string, Value | null>;
        this.checkOutputs(def, outputs);
        if (def.maskable) this.applyMask(def, inputs, outputs, params.mix as number);
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
      scope.timings.set(id, (scope.timings.get(id) ?? 0) + performance.now() - started);

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
      this.cache.set(key, { key, outputs, bytes, lastUsed: this.tick });
      this.cacheBytes += bytes;
      return { key, outputs };
    } finally {
      scope.stack.delete(stackKey);
    }
  }

  /** Hash of a node and everything upstream of it (types, stored params, wiring): changes only when the graph is edited. */
  private structSig(id: string, scope: Scope, seen: Set<string>): string {
    if (seen.has(id)) return 'cycle';
    seen.add(id);
    const node = scope.nodes.get(id);
    if (!node) return 'missing';
    const ins = (scope.inbound.get(id) ?? [])
      .map((e) => `${e.to.port}<${e.from.port}:${this.structSig(e.from.node, scope, seen)}`)
      .sort()
      .join(',');
    const p = scope.graph.project;
    return hash(`${node.type}|${JSON.stringify(node.params)}|${node.bypass ? 1 : 0}|${ins}|${p.width}x${p.height}|${p.fps}|${p.duration}|${p.loop}|${p.lengthMode}|${p.referenceSide}`);
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
    if (!out || !src || out.width !== src.width || out.height !== src.height) return;
    const textures: Record<string, { texture: GPUTexture }> = { ta: src, tb: out };
    if (mask) textures.m = mask;
    outputs[outName] = this.gpu.pass({
      label: 'effect-mask',
      size: out,
      textures,
      uniforms: { mix },
      wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = textureSampleLevel(ta, smpNearest, uv, 0.0);
  let b = textureSampleLevel(tb, smpNearest, uv, 0.0);
  ${mask ? 'let k = u.mix * textureSampleLevel(m, smp, uv, 0.0).r;' : 'let k = u.mix;'}
  return mix(a, b, k);
}`,
    });
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

  /** LRU eviction. Runs only between evaluations, so nothing in use is ever freed. */
  private evict(): void {
    if (this.cacheBytes <= this.cacheBudget && this.cache.size < 4000) return;
    const entries = [...this.cache.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of entries) {
      if (this.cacheBytes <= this.cacheBudget * 0.7 && this.cache.size < 3000) break;
      this.cache.delete(entry.key);
      this.cacheBytes -= entry.bytes;
      this.releaseEntry(entry);
    }
    if (this.reads.size > 20000) this.reads.clear();
  }
}
