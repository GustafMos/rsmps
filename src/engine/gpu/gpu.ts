/**
 * The single GPU context of the engine: one device, a texture pool, caches and the full-screen pass helper nodes use.
 * Nothing here knows about graphs.
 *
 * Memory rules (each one exists because of a measured problem, see docs/ENGINE.md "GPU memory"):
 *  - EVERYTHING the app allocates on the device is created through this class (`createBuffer`, `createTexture`, `scratch`,
 *    `acquire`, ...) so `stats()` can account for it. `src/engine/gpu/ledger.test.ts` fails when a file creates a raw
 *    buffer or texture.
 *  - Nothing relies on garbage collection: buffers and textures are destroyed explicitly or pooled; views, bind groups and
 *    pipelines (which cannot be destroyed) are cached and bounded instead of created per pass.
 *  - Every pool has a byte cap and an age sweep; the least recently used goes first.
 */
import type { ImageValue, MaskValue, NodeGpu, PassOptions, UniformValue } from '../types';
import { PASS_PRELUDE, PRELUDE } from './prelude';

type Format = 'rgba8unorm' | 'rgba16float';

const VERTEX = /* wgsl */ `
struct VSOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> VSOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VSOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f(p[i].x * 0.5 + 0.5, 0.5 - p[i].y * 0.5);
  return o;
}
@fragment fn fs_main(in: VSOut) -> @location(0) vec4f { return fx(in.uv, in.pos.xy); }
`;

interface UniformLayout {
  wgsl: string;
  size: number;
  fields: { name: string; offset: number; count: number }[];
}

function layoutUniforms(uniforms: Record<string, UniformValue>): UniformLayout {
  const fields: UniformLayout['fields'] = [];
  const lines: string[] = [];
  let offset = 0;
  const add = (name: string, count: number) => {
    const align = count === 1 ? 4 : count === 2 ? 8 : 16;
    const size = count === 3 ? 12 : count * 4;
    offset = Math.ceil(offset / align) * align;
    fields.push({ name, offset, count });
    lines.push(`  ${name}: ${count === 1 ? 'f32' : `vec${count}f`},`);
    offset += size;
  };
  add('size', 2);
  for (const [name, value] of Object.entries(uniforms)) {
    if (name === 'size') throw new Error('uniform name "size" is reserved (output size)');
    const count = typeof value === 'number' || typeof value === 'boolean' ? 1 : value.length;
    if (count < 1 || count > 4) throw new Error(`uniform "${name}" must be a number, bool or array of 2-4 numbers`);
    add(name, count);
  }
  return { wgsl: `struct U {\n${lines.join('\n')}\n};`, size: Math.ceil(offset / 16) * 16, fields };
}

/** Root-scope size at which a leak warning is printed (dev only). */
const ROOT_SCOPE_WARN = 48;

const BYTES_PER_TEXEL: Record<string, number> = {
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  rgba16float: 8,
  rgba32float: 16,
  r8unorm: 1,
  r16float: 2,
  r32float: 4,
  rg32float: 8,
  depth24plus: 4,
  'depth24plus-stencil8': 4,
  depth32float: 4,
};

/** Bytes of a texture (every sample counts: a 4x multisampled 1080p target is 4x the memory). */
export function textureBytes(width: number, height: number, format: string, sampleCount = 1, layers = 1): number {
  return width * height * layers * (BYTES_PER_TEXEL[format] ?? 4) * sampleCount;
}

/** Buffer sizes are rounded up to eighths of a power of two (at most 12.5% waste) so near-equal requests share a buffer. */
export function bucketSize(n: number): number {
  if (n <= 256) return 256;
  const p = 2 ** Math.floor(Math.log2(n));
  const step = p / 8;
  return Math.ceil(n / step) * step;
}

export interface CategoryStats {
  count: number;
  bytes: number;
  peakCount: number;
  peakBytes: number;
  created: number;
  destroyed: number;
}

export interface GpuStats {
  /** Bytes in pooled textures, in use + idle. (Compatibility: see `totalBytes` for everything.) */
  allocatedBytes: number;
  idleBytes: number;
  idleTextures: number;
  retainedTextures: number;
  rootScope: number;
  /** Every byte this app has live on the device: pooled textures, scratch textures, buffers of every kind. */
  totalBytes: number;
  peakBytes: number;
  /** Per category (`pooled-texture`, `scratch-texture`, `texture`, `uniform-buffer`, `scratch-buffer`, `readback-buffer`, `vertex-buffer`, ...). */
  categories: Record<string, CategoryStats>;
  /** Idle scratch buffers/textures waiting for reuse. */
  scratchIdleBytes: number;
  /** Distinct idle sizes in the texture pool. */
  idleSizes: number;
  /** Objects created minus destroyed, and creation counters. Views, bind groups and pipelines cannot be destroyed: they are cached and bounded. */
  objects: {
    liveTextures: number;
    liveBuffers: number;
    buffersCreated: number;
    texturesCreated: number;
    viewsCreated: number;
    liveViews: number;
    bindGroupsCreated: number;
    liveBindGroups: number;
    pipelinesCreated: number;
    livePipelines: number;
    shaderModulesCreated: number;
    samplersCreated: number;
    submits: number;
  };
  caches: { bindGroupHits: number; bindGroupMisses: number; viewHits: number; pipelineHits: number; pipelineEvictions: number; dataTextureHits: number; scratchHits: number; scratchMisses: number };
  /** The node render that held the most texture bytes at once (diagnostic: a multi-pass node that forgot `recycle`). */
  worstScope: { label: string; bytes: number; textures: number };
  /** Number of distinct shader variants compiled per pass label (a label with many variants bakes numbers into WGSL). */
  pipelineVariants: Record<string, number>;
}

/** Limits of the pools. The memory governor adjusts `idleBytes`. */
export interface GpuLimits {
  /** Idle pooled textures kept for reuse. */
  idleBytes: number;
  /** Distinct idle texture sizes kept. */
  idleSizes: number;
  /** Share of `idleBytes` that rgba16float textures may use while idle. */
  idle16Share: number;
  /** Idle scratch buffers / textures kept. */
  scratchBytes: number;
  /** Evaluations an idle scratch item or texture size survives without use. */
  maxAge: number;
  pipelines: number;
  bindGroups: number;
  dataTextures: number;
}

interface Scope {
  set: Set<GPUTexture>;
  label: string;
  bytes: number;
}

interface PipelineEntry {
  id: number;
  pipeline: GPURenderPipeline;
  layout: GPUBindGroupLayout;
}

interface ScratchItem<T> {
  obj: T;
  tick: number;
  bytes: number;
}

export class Gpu {
  /** The current device. Replaced (never the Gpu object) by `replaceDevice` after a device loss. */
  device: GPUDevice;
  readonly limits: GpuLimits = {
    idleBytes: 384 * 1024 * 1024,
    idleSizes: 16,
    idle16Share: 0.25,
    scratchBytes: 192 * 1024 * 1024,
    maxAge: 240,
    pipelines: 320,
    bindGroups: 1536,
    dataTextures: 96,
  };

  private pool = new Map<string, GPUTexture[]>();
  private pooled = new Set<GPUTexture>();
  private refs = new Map<GPUTexture, number>();
  /** Stack of scopes; each holds textures handed out inside it (recycled at `end()` if nobody retained them). */
  private fresh: Scope[] = [{ set: new Set(), label: 'root', bytes: 0 }];
  private pipelines = new Map<string, PipelineEntry>();
  private pipelineSeq = 0;
  private computePipelines = new Map<string, GPUComputePipeline>();
  private linear!: GPUSampler;
  private nearest!: GPUSampler;
  private blitPipelines = new Map<string, { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout }>();
  private pendingErrors: Promise<string | null>[] = [];
  private layouts = new Map<string, UniformLayout>();
  private variantCodes = new Map<string, Set<string>>();

  /* accounting */
  private cats = new Map<string, CategoryStats>();
  private ledger = new Map<object, { cat: string; bytes: number }>();
  private total = 0;
  private totalPeak = 0;
  private counters = {
    buffersCreated: 0,
    texturesCreated: 0,
    viewsCreated: 0,
    bindGroupsCreated: 0,
    pipelinesCreated: 0,
    shaderModulesCreated: 0,
    samplersCreated: 0,
    submits: 0,
    bindGroupHits: 0,
    bindGroupMisses: 0,
    viewHits: 0,
    pipelineHits: 0,
    pipelineEvictions: 0,
    dataTextureHits: 0,
    scratchHits: 0,
    scratchMisses: 0,
  };
  private worst = { label: '', bytes: 0, textures: 0 };

  /* caches that must be dropped when a texture dies */
  private views = new WeakMap<GPUTexture, GPUTextureView>();
  private liveViews = 0;
  private texIds = new WeakMap<object, number>();
  private texSeq = 0;
  private bindGroups = new Map<string, GPUBindGroup>();
  private bgByTexture = new Map<number, Set<string>>();
  private uniformData = new Map<number, Float32Array>();
  private dataTextures = new Map<string, { texture: GPUTexture; tick: number }>();

  /* scratch pools */
  private scratchFree = new Map<string, ScratchItem<GPUBuffer>[]>();
  private scratchTexFree = new Map<string, ScratchItem<GPUTexture>[]>();
  private scratchUsed = new Set<GPUBuffer | GPUTexture>();
  private scratchKey = new WeakMap<GPUBuffer | GPUTexture, string>();

  /* work throttle */
  private fences: Promise<void>[] = [];

  /** Resolve shader compilation results gathered since the last call; throws the first error. Cheap when nothing was compiled. */
  async checkErrors(): Promise<void> {
    if (this.pendingErrors.length === 0) return;
    const results = await Promise.all(this.pendingErrors.splice(0));
    const first = results.find((r) => r);
    if (first) throw new Error(first);
  }

  /** Everything this app has live on the device, in bytes (pooled and scratch textures, every buffer). */
  get allocatedBytes(): number {
    return this.total;
  }

  constructor(device: GPUDevice) {
    this.device = device;
    this.makeSamplers();
  }

  private makeSamplers(): void {
    this.linear = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.nearest = this.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.counters.samplersCreated += 2;
  }

  /**
   * After a device loss: adopt a new device. Every texture, pipeline and sampler of the old one is invalid and is forgotten
   * (nothing is destroyed or recycled); holders must drop their texture handles. The Gpu object itself stays the same, so engine,
   * library and player keep working with it.
   */
  replaceDevice(device: GPUDevice): void {
    // The old device's memory goes away with the device; best effort explicit destroy so nothing waits for GC.
    try {
      this.device.destroy();
    } catch {
      /* already lost */
    }
    this.device = device;
    this.pool.clear();
    this.pooled.clear();
    this.refs.clear();
    this.fresh = [{ set: new Set(), label: 'root', bytes: 0 }];
    this.pipelines.clear();
    this.computePipelines.clear();
    this.blitPipelines.clear();
    this.pendingErrors = [];
    this.keyUse.clear();
    this.views = new WeakMap();
    this.liveViews = 0;
    this.bindGroups.clear();
    this.bgByTexture.clear();
    this.dataTextures.clear();
    this.scratchFree.clear();
    this.scratchTexFree.clear();
    this.scratchUsed.clear();
    this.fences = [];
    this.ledger.clear();
    this.cats.forEach((c) => {
      c.count = 0;
      c.bytes = 0;
    });
    this.total = 0;
    this.makeSamplers();
  }

  /* ------------------------------- accounting ------------------------------- */

  private cat(name: string): CategoryStats {
    let c = this.cats.get(name);
    if (!c) {
      c = { count: 0, bytes: 0, peakCount: 0, peakBytes: 0, created: 0, destroyed: 0 };
      this.cats.set(name, c);
    }
    return c;
  }

  private track(obj: object, category: string, bytes: number): void {
    this.ledger.set(obj, { cat: category, bytes });
    const c = this.cat(category);
    c.count++;
    c.created++;
    c.bytes += bytes;
    c.peakCount = Math.max(c.peakCount, c.count);
    c.peakBytes = Math.max(c.peakBytes, c.bytes);
    this.total += bytes;
    this.totalPeak = Math.max(this.totalPeak, this.total);
  }

  private untrack(obj: object): void {
    const e = this.ledger.get(obj);
    if (!e) return;
    this.ledger.delete(obj);
    const c = this.cat(e.cat);
    c.count--;
    c.destroyed++;
    c.bytes -= e.bytes;
    this.total -= e.bytes;
  }

  /** Create a buffer that this app owns for a while (vertex/index data, long-lived storage). Counted in `stats()`. Free with `destroyBuffer`. */
  createBuffer(desc: GPUBufferDescriptor, category = 'buffer'): GPUBuffer {
    const buf = this.device.createBuffer(desc);
    this.counters.buffersCreated++;
    this.track(buf, category, desc.size);
    return buf;
  }

  destroyBuffer(buf: GPUBuffer): void {
    this.forgetTexture(buf);
    this.untrack(buf);
    this.scratchUsed.delete(buf);
    buf.destroy();
  }

  /** Create a texture outside the pool (the pool recycles by size; use this for textures that live a long time). Free with `destroyTexture`. */
  createTexture(desc: GPUTextureDescriptor, category = 'texture'): GPUTexture {
    const tex = this.device.createTexture(desc);
    this.counters.texturesCreated++;
    const [w, h = 1, l = 1] = Array.isArray(desc.size) ? (desc.size as number[]) : [(desc.size as GPUExtent3DDictStrict).width, (desc.size as GPUExtent3DDictStrict).height ?? 1, (desc.size as GPUExtent3DDictStrict).depthOrArrayLayers ?? 1];
    this.track(tex, category, textureBytes(w, h, desc.format, desc.sampleCount ?? 1, l));
    return tex;
  }

  destroyTexture(tex: GPUTexture): void {
    this.forgetTexture(tex);
    this.untrack(tex);
    this.scratchUsed.delete(tex);
    tex.destroy();
  }

  /** Drop everything cached about a texture that is going away: its view and every bind group that names it. */
  private forgetTexture(tex: GPUTexture | GPUBuffer): void {
    if (this.views.delete(tex as GPUTexture)) this.liveViews--;
    const id = this.texIds.get(tex);
    if (id === undefined) return;
    const keys = this.bgByTexture.get(id);
    if (keys) {
      for (const k of keys) this.bindGroups.delete(k);
      this.bgByTexture.delete(id);
    }
  }

  private texId(tex: GPUTexture | GPUBuffer): number {
    let id = this.texIds.get(tex);
    if (id === undefined) {
      id = ++this.texSeq;
      this.texIds.set(tex, id);
    }
    return id;
  }

  /** Cached default view of a texture. */
  view(tex: GPUTexture): GPUTextureView {
    let v = this.views.get(tex);
    if (v) {
      this.counters.viewHits++;
      return v;
    }
    v = tex.createView();
    this.counters.viewsCreated++;
    this.liveViews++;
    this.views.set(tex, v);
    return v;
  }

  /* ---------------------------- texture lifetime ------------------------ */

  acquire(width: number, height: number, format: Format = 'rgba8unorm'): GPUTexture {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const key = `${w}x${h}:${format}`;
    let tex = this.pool.get(key)?.pop();
    if (!tex) {
      tex = this.device.createTexture({
        size: [w, h],
        format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.STORAGE_BINDING,
      });
      this.counters.texturesCreated++;
      this.track(tex, 'pooled-texture', textureBytes(w, h, format));
      this.pooled.add(tex);
    }
    this.keyUse.set(key, this.useTick);
    const scope = this.fresh[this.fresh.length - 1];
    if (!scope.set.has(tex)) {
      scope.set.add(tex);
      scope.bytes += textureBytes(w, h, format);
    }
    if (this.fresh.length === 1 && scope.set.size === ROOT_SCOPE_WARN && !this.warnedRoot && import.meta.env?.DEV) {
      this.warnedRoot = true;
      console.warn('GPU textures are being acquired outside gpu.scoped()/a node render and never retained: they will never be recycled (leak). See Gpu.scoped.');
    }
    return tex;
  }

  private warnedRoot = false;
  /** Pool key -> `useTick` of its last acquire (for idle sweeping). */
  private keyUse = new Map<string, number>();
  private useTick = 0;

  retain(tex: GPUTexture): void {
    if (!this.pooled.has(tex)) return;
    this.refs.set(tex, (this.refs.get(tex) ?? 0) + 1);
    this.fresh[0].set.delete(tex); // an owner exists now: the root scope no longer needs to track it
  }

  release(tex: GPUTexture): void {
    if (!this.pooled.has(tex)) return;
    const n = (this.refs.get(tex) ?? 0) - 1;
    if (n > 0) {
      this.refs.set(tex, n);
      return;
    }
    this.refs.delete(tex);
    this.recycle(tex);
  }

  /** Return an unretained temporary to the pool right now (multi-pass loops). No-op for retained or foreign textures. */
  recycleNow(tex: GPUTexture): void {
    if (!this.pooled.has(tex) || this.refs.has(tex)) return;
    this.recycle(tex);
  }

  /** Open a temp-texture scope (the kernel wraps every node render in begin/end). `label` names the scope in `stats().worstScope`. */
  begin(label = 'scope'): void {
    this.fresh.push({ set: new Set(), label, bytes: 0 });
  }

  /**
   * Run `fn` in its own temp-texture scope. Every texture acquired inside (`pass`, `alloc`, `upload`, ...) that is not
   * RETAINED when `fn` returns goes back to the pool. Use it around any GPU work done outside a node render (export, display,
   * snapshots): retain what must outlive the scope INSIDE `fn`, and release it later. Without a scope such textures land in the
   * root scope, which is never collected.
   */
  scoped<T>(fn: () => T): T {
    this.begin();
    try {
      return fn();
    } finally {
      this.end();
    }
  }

  /** Like `scoped` for async work. Only use it when nothing else acquires textures while `fn` awaits (scopes are a stack). */
  async scopedAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.begin();
    try {
      return await fn();
    } finally {
      this.end();
    }
  }

  /** Memory and ownership counters for diagnostics and tests. `rootScope` should stay near 0. */
  stats(): GpuStats {
    let idleBytes = 0;
    let idleTextures = 0;
    let idleSizes = 0;
    for (const list of this.pool.values()) {
      if (list.length) idleSizes++;
      for (const t of list) {
        idleBytes += textureBytes(t.width, t.height, t.format);
        idleTextures++;
      }
    }
    let scratchIdle = 0;
    for (const l of this.scratchFree.values()) for (const i of l) scratchIdle += i.bytes;
    for (const l of this.scratchTexFree.values()) for (const i of l) scratchIdle += i.bytes;
    const categories: Record<string, CategoryStats> = {};
    for (const [k, v] of this.cats) categories[k] = { ...v };
    let liveTextures = 0;
    let liveBuffers = 0;
    for (const [k, v] of this.cats) {
      if (/texture/.test(k)) liveTextures += v.count;
      else liveBuffers += v.count;
    }
    const pipelineVariants: Record<string, number> = {};
    for (const [label, set] of this.variantCodes) pipelineVariants[label] = set.size;
    const c = this.counters;
    return {
      allocatedBytes: this.total,
      idleBytes,
      idleTextures,
      retainedTextures: this.refs.size,
      rootScope: this.fresh[0].set.size,
      totalBytes: this.total,
      peakBytes: this.totalPeak,
      categories,
      scratchIdleBytes: scratchIdle,
      idleSizes,
      objects: {
        liveTextures,
        liveBuffers,
        buffersCreated: c.buffersCreated,
        texturesCreated: c.texturesCreated,
        viewsCreated: c.viewsCreated,
        liveViews: this.liveViews,
        bindGroupsCreated: c.bindGroupsCreated,
        liveBindGroups: this.bindGroups.size,
        pipelinesCreated: c.pipelinesCreated,
        livePipelines: this.pipelines.size + this.computePipelines.size + this.blitPipelines.size,
        shaderModulesCreated: c.shaderModulesCreated,
        samplersCreated: c.samplersCreated,
        submits: c.submits,
      },
      caches: {
        bindGroupHits: c.bindGroupHits,
        bindGroupMisses: c.bindGroupMisses,
        viewHits: c.viewHits,
        pipelineHits: c.pipelineHits,
        pipelineEvictions: c.pipelineEvictions,
        dataTextureHits: c.dataTextureHits,
        scratchHits: c.scratchHits,
        scratchMisses: c.scratchMisses,
      },
      worstScope: { ...this.worst },
      pipelineVariants,
    };
  }

  /** Close the scope: every texture acquired inside it that nobody retained goes back to the pool. */
  end(): void {
    const scope = this.fresh.length > 1 ? this.fresh.pop()! : this.fresh[0];
    if (this.fresh.length >= 1 && scope !== this.fresh[0] && scope.bytes > this.worst.bytes) {
      this.worst = { label: scope.label, bytes: scope.bytes, textures: scope.set.size };
    }
    for (const tex of scope.set) {
      if (!this.refs.has(tex)) this.recycle(tex);
    }
    scope.set.clear();
    scope.bytes = 0;
  }

  private recycle(tex: GPUTexture): void {
    this.fresh[0].set.delete(tex);
    // A texture that trim() already destroyed can still be named by an open scope: never put it back into the pool
    // (it would be handed out again and every pass using it would be silently dropped).
    if (!this.pooled.has(tex)) return;
    const key = `${tex.width}x${tex.height}:${tex.format}`;
    const list = this.pool.get(key) ?? [];
    if (!list.includes(tex)) list.push(tex);
    this.pool.set(key, list);
  }

  /** Destroy idle pooled textures and scratch items (call when memory is tight or sizes changed a lot). Never during an evaluation. */
  trim(): void {
    this.dropDataTextures(); // first: they go back to the pool, then the pool is emptied
    for (const list of this.pool.values()) for (const tex of list) this.destroyIdle(tex);
    this.pool.clear();
    this.trimScratch(0);
  }

  private destroyIdle(tex: GPUTexture): void {
    this.forgetTexture(tex);
    this.untrack(tex);
    this.pooled.delete(tex);
    this.fresh[0].set.delete(tex);
    tex.destroy();
  }

  /** Called once per evaluation: ages the pools and enforces their caps (a safe point: nothing is mid-render). */
  advance(): void {
    this.useTick++;
    this.sweep();
    this.enforceCaps();
  }

  /** Destroy idle textures of sizes not acquired for `maxAge` evaluations (a resolution that is no longer in use). Safe between evaluations. */
  sweep(maxAge = this.limits.maxAge): void {
    for (const [key, list] of [...this.pool]) {
      if (list.length === 0 || this.useTick - (this.keyUse.get(key) ?? 0) <= maxAge) continue;
      for (const tex of list) this.destroyIdle(tex);
      this.pool.delete(key);
    }
    // idle scratch that has not been used for a long time
    for (const [key, list] of [...this.scratchFree]) {
      const keep = list.filter((i) => this.useTick - i.tick <= maxAge);
      for (const i of list) if (!keep.includes(i)) this.destroyBuffer(i.obj);
      if (keep.length) this.scratchFree.set(key, keep);
      else this.scratchFree.delete(key);
    }
    for (const [key, list] of [...this.scratchTexFree]) {
      const keep = list.filter((i) => this.useTick - i.tick <= maxAge);
      for (const i of list) if (!keep.includes(i)) this.destroyTexture(i.obj);
      if (keep.length) this.scratchTexFree.set(key, keep);
      else this.scratchTexFree.delete(key);
    }
  }

  private idleSize(): { bytes: number; bytes16: number; sizes: number } {
    let bytes = 0;
    let bytes16 = 0;
    let sizes = 0;
    for (const list of this.pool.values()) {
      if (list.length) sizes++;
      for (const t of list) {
        const b = textureBytes(t.width, t.height, t.format);
        bytes += b;
        if (t.format === 'rgba16float') bytes16 += b;
      }
    }
    return { bytes, bytes16, sizes };
  }

  /** Strict caps: distinct idle sizes, total idle bytes, idle rgba16float bytes. The least recently used size goes first. */
  private enforceCaps(): void {
    const lim = this.limits;
    let { bytes, bytes16, sizes } = this.idleSize();
    if (bytes <= lim.idleBytes && sizes <= lim.idleSizes && bytes16 <= lim.idleBytes * lim.idle16Share) {
      this.trimScratch(lim.scratchBytes);
      this.trimDataTextures();
      return;
    }
    const keys = [...this.pool.keys()].sort((a, b) => (this.keyUse.get(a) ?? 0) - (this.keyUse.get(b) ?? 0));
    const over = () => bytes > lim.idleBytes || sizes > lim.idleSizes || bytes16 > lim.idleBytes * lim.idle16Share;
    for (const key of keys) {
      if (!over()) break;
      const list = this.pool.get(key);
      if (!list || list.length === 0) continue;
      const is16 = key.endsWith('rgba16float');
      // A size that only breaks the rgba16float share must be a 16-bit size.
      if (!is16 && bytes <= lim.idleBytes && sizes <= lim.idleSizes) continue;
      while (list.length && over()) {
        const tex = list.pop()!;
        const b = textureBytes(tex.width, tex.height, tex.format);
        bytes -= b;
        if (is16) bytes16 -= b;
        this.destroyIdle(tex);
      }
      if (list.length === 0) {
        this.pool.delete(key);
        sizes--;
      }
    }
    this.trimScratch(lim.scratchBytes);
    this.trimDataTextures();
  }

  /** Destroy idle textures, least recently used sizes first, until the idle pool holds at most `maxBytes`. Safe between evaluations. */
  trimIdleTo(maxBytes: number): void {
    let { bytes: idle } = this.idleSize();
    if (idle > maxBytes) {
      const keys = [...this.pool.keys()].sort((a, b) => (this.keyUse.get(a) ?? 0) - (this.keyUse.get(b) ?? 0));
      for (const key of keys) {
        const list = this.pool.get(key)!;
        while (list.length && idle > maxBytes) {
          const tex = list.pop()!;
          idle -= textureBytes(tex.width, tex.height, tex.format);
          this.destroyIdle(tex);
        }
        if (list.length === 0) this.pool.delete(key);
        if (idle <= maxBytes) break;
      }
    }
    this.trimScratch(maxBytes);
  }

  /** Bytes of idle pooled textures plus idle scratch (what a trim could give back). */
  get idleTotalBytes(): number {
    let b = this.idleSize().bytes;
    for (const l of this.scratchFree.values()) for (const i of l) b += i.bytes;
    for (const l of this.scratchTexFree.values()) for (const i of l) b += i.bytes;
    return b;
  }

  /* ---------------------------- scratch buffers ---------------------------- */

  /**
   * A pooled buffer of at least `size` bytes. Give it back with `releaseScratch` (it stays allocated for reuse and is trimmed by
   * the idle cap / age sweep). Reuse is safe without any fence: queue operations are ordered, so a later `writeBuffer` or
   * submit can never overtake work that is still reading the previous contents.
   */
  scratch(size: number, usage: number, label = 'scratch', opts: { clear?: boolean } = {}): GPUBuffer {
    const bytes = bucketSize(Math.max(4, Math.ceil(size / 4) * 4));
    const u = usage | GPUBufferUsage.COPY_DST;
    const key = `${bytes}:${u}`;
    const free = this.scratchFree.get(key);
    let buf: GPUBuffer;
    const hit = free?.pop();
    if (hit) {
      buf = hit.obj;
      this.counters.scratchHits++;
    } else {
      this.counters.scratchMisses++;
      const cat = u & GPUBufferUsage.UNIFORM ? 'uniform-buffer' : u & GPUBufferUsage.MAP_READ ? 'readback-buffer' : 'scratch-buffer';
      buf = this.device.createBuffer({ label, size: bytes, usage: u });
      this.counters.buffersCreated++;
      this.track(buf, cat, bytes);
      this.scratchKey.set(buf, key);
    }
    this.scratchUsed.add(buf);
    if (opts.clear && hit && !(u & GPUBufferUsage.MAP_READ)) {
      const enc = this.device.createCommandEncoder();
      enc.clearBuffer(buf);
      this.device.queue.submit([enc.finish()]);
      this.counters.submits++;
    }
    return buf;
  }

  releaseScratch(buf: GPUBuffer): void {
    if (!this.scratchUsed.delete(buf)) return;
    const key = this.scratchKey.get(buf);
    if (!key) return;
    const list = this.scratchFree.get(key) ?? [];
    list.push({ obj: buf, tick: this.useTick, bytes: buf.size });
    this.scratchFree.set(key, list);
  }

  /** Pooled attachment texture (multisampled colour, depth). Not part of the recycle-by-scope pool: give it back explicitly. */
  scratchTexture(desc: { width: number; height: number; format: GPUTextureFormat; usage: number; sampleCount?: number; label?: string }): GPUTexture {
    const w = Math.max(1, Math.round(desc.width));
    const h = Math.max(1, Math.round(desc.height));
    const samples = desc.sampleCount ?? 1;
    const key = `${w}x${h}:${desc.format}:${desc.usage}:${samples}`;
    const hit = this.scratchTexFree.get(key)?.pop();
    let tex: GPUTexture;
    if (hit) {
      tex = hit.obj;
      this.counters.scratchHits++;
    } else {
      this.counters.scratchMisses++;
      tex = this.device.createTexture({ label: desc.label, size: [w, h], format: desc.format, usage: desc.usage, sampleCount: samples });
      this.counters.texturesCreated++;
      this.track(tex, 'scratch-texture', textureBytes(w, h, desc.format, samples));
      this.scratchKey.set(tex, key);
    }
    this.scratchUsed.add(tex);
    return tex;
  }

  releaseScratchTexture(tex: GPUTexture): void {
    if (!this.scratchUsed.delete(tex)) return;
    const key = this.scratchKey.get(tex);
    if (!key) return;
    const list = this.scratchTexFree.get(key) ?? [];
    list.push({ obj: tex, tick: this.useTick, bytes: this.ledger.get(tex)?.bytes ?? 0 });
    this.scratchTexFree.set(key, list);
  }

  /** Destroy idle scratch items, oldest first, until at most `maxBytes` remain idle. */
  private trimScratch(maxBytes: number): void {
    const items: { tick: number; bytes: number; destroy: () => void; list: ScratchItem<never>[]; ref: ScratchItem<never> }[] = [];
    let idle = 0;
    for (const list of this.scratchFree.values()) {
      for (const i of list) {
        idle += i.bytes;
        items.push({ tick: i.tick, bytes: i.bytes, destroy: () => this.destroyBuffer(i.obj), list: list as never, ref: i as never });
      }
    }
    for (const list of this.scratchTexFree.values()) {
      for (const i of list) {
        idle += i.bytes;
        items.push({ tick: i.tick, bytes: i.bytes, destroy: () => this.destroyTexture(i.obj), list: list as never, ref: i as never });
      }
    }
    if (idle <= maxBytes) return;
    items.sort((a, b) => a.tick - b.tick);
    for (const it of items) {
      if (idle <= maxBytes) break;
      it.destroy();
      it.list.splice(it.list.indexOf(it.ref), 1);
      idle -= it.bytes;
    }
  }

  /* ------------------------------ work throttle ----------------------------- */

  /** Remember that everything submitted so far is one frame's worth of work (call at the end of an evaluation). */
  fence(): void {
    const p: Promise<void> = this.device.queue
      .onSubmittedWorkDone()
      .catch(() => undefined)
      .then(() => {
        const i = this.fences.indexOf(p);
        if (i >= 0) this.fences.splice(i, 1);
      });
    this.fences.push(p);
  }

  /** Wait until at most `maxQueued` frames of GPU work are outstanding, so a fast CPU loop (export) cannot queue unbounded work and memory. */
  async throttle(maxQueued = 2): Promise<void> {
    while (this.fences.length > maxQueued) await this.fences[0];
  }

  /** Frames of GPU work submitted but not yet finished. */
  get queuedFrames(): number {
    return this.fences.length;
  }

  /* ------------------------------- passes ------------------------------- */

  private layoutFor(uniforms: Record<string, UniformValue>): { key: string; layout: UniformLayout } {
    let key = '';
    for (const name in uniforms) {
      const v = uniforms[name];
      key += `${name}:${typeof v === 'number' || typeof v === 'boolean' ? 1 : v.length},`;
    }
    let layout = this.layouts.get(key);
    if (!layout) {
      layout = layoutUniforms(uniforms);
      this.layouts.set(key, layout);
    }
    return { key, layout };
  }

  private passPipeline(options: PassOptions, names: string[], format: Format, layout: UniformLayout, layoutKey: string): PipelineEntry {
    const cacheKey = `${format}|${names.join(',')}|${layoutKey}|${options.wgsl}`;
    let entry = this.pipelines.get(cacheKey);
    if (entry) {
      this.counters.pipelineHits++;
      // refresh LRU position
      this.pipelines.delete(cacheKey);
      this.pipelines.set(cacheKey, entry);
      return entry;
    }
    const decls = names.map((n, i) => `@group(0) @binding(${3 + i}) var ${n}: texture_2d<f32>;`).join('\n');
    const code = `${layout.wgsl}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var smpNearest: sampler;
${decls}
${PRELUDE}
${PASS_PRELUDE}
${options.wgsl}
${VERTEX}`;
    const bgl = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ...names.map((_, i) => ({
          binding: 3 + i,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' as const },
        })),
      ],
    });
    // Shader mistakes (including WGSL reserved words used as names) otherwise fail silently with a blank image.
    this.device.pushErrorScope('validation');
    const module = this.device.createShaderModule({ label: options.label, code });
    this.counters.shaderModulesCreated++;
    const pipeline = this.device.createRenderPipeline({
      label: options.label,
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.counters.pipelinesCreated++;
    const label = options.label ?? 'pass';
    this.pendingErrors.push(
      this.device.popErrorScope().then((err) => (err ? `Shader "${label}" failed to compile: ${err.message.split(/\r?\n/).slice(0, 6).join(' ')}` : null)),
    );
    let variants = this.variantCodes.get(label);
    if (!variants) this.variantCodes.set(label, (variants = new Set()));
    if (variants.size < 64) variants.add(options.wgsl);
    entry = { id: ++this.pipelineSeq, pipeline, layout: bgl };
    this.pipelines.set(cacheKey, entry);
    // Pipelines cannot be destroyed: bound the cache so distinct shaders (numbers baked into WGSL) cannot grow it for ever.
    while (this.pipelines.size > this.limits.pipelines) {
      const oldest = this.pipelines.keys().next().value as string;
      this.pipelines.delete(oldest);
      this.counters.pipelineEvictions++;
    }
    return entry;
  }

  pass(options: PassOptions): ImageValue {
    const format: Format = options.format ?? 'rgba8unorm';
    const width = Math.max(1, Math.round(options.size.width));
    const height = Math.max(1, Math.round(options.size.height));
    const textures = options.textures ?? {};
    const names: string[] = [];
    for (const n in textures) if (textures[n]) names.push(n);
    const uniforms = options.uniforms ?? {};
    const { key: layoutKey, layout } = this.layoutFor(uniforms);
    const entry = this.passPipeline(options, names, format, layout, layoutKey);

    // Uniforms: one pooled buffer per size bucket, rewritten for every pass. Safe because queue operations are ordered:
    // the next writeBuffer runs after the previous submit's commands have finished reading it.
    let data = this.uniformData.get(layout.size);
    if (!data) this.uniformData.set(layout.size, (data = new Float32Array(layout.size / 4)));
    data.fill(0);
    for (const f of layout.fields) {
      const v = f.name === 'size' ? undefined : uniforms[f.name];
      const base = f.offset / 4;
      if (f.name === 'size') {
        data[base] = width;
        data[base + 1] = height;
      } else if (typeof v === 'number') data[base] = v;
      else if (typeof v === 'boolean') data[base] = v ? 1 : 0;
      else if (v) for (let i = 0; i < f.count; i++) data[base + i] = v[i];
    }
    const ubo = this.scratch(layout.size, GPUBufferUsage.UNIFORM, 'pass-uniforms');
    this.device.queue.writeBuffer(ubo, 0, data as unknown as BufferSource, 0, layout.size / 4);

    const target = this.acquire(width, height, format);
    let bgKey = `${entry.id}|${this.texId(ubo)}`;
    for (const n of names) {
      const tex = textures[n]!.texture;
      if (tex === target) throw new Error(`pass "${options.label ?? ''}": texture "${n}" cannot be both input and output`);
      bgKey += `|${this.texId(tex)}`;
    }
    let bindGroup = this.bindGroups.get(bgKey);
    if (bindGroup) {
      this.counters.bindGroupHits++;
      this.bindGroups.delete(bgKey);
      this.bindGroups.set(bgKey, bindGroup);
    } else {
      this.counters.bindGroupMisses++;
      bindGroup = this.device.createBindGroup({
        layout: entry.layout,
        entries: [
          { binding: 0, resource: { buffer: ubo, size: layout.size } },
          { binding: 1, resource: this.linear },
          { binding: 2, resource: this.nearest },
          ...names.map((n, i) => ({ binding: 3 + i, resource: this.view(textures[n]!.texture) })),
        ],
      });
      this.counters.bindGroupsCreated++;
      this.cacheBindGroup(bgKey, bindGroup, [ubo, ...names.map((n) => textures[n]!.texture)]);
    }

    const encoder = this.device.createCommandEncoder();
    const rp = encoder.beginRenderPass({
      colorAttachments: [{ view: this.view(target), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    });
    rp.setPipeline(entry.pipeline);
    rp.setBindGroup(0, bindGroup);
    rp.draw(3);
    rp.end();
    this.device.queue.submit([encoder.finish()]);
    this.counters.submits++;
    this.releaseScratch(ubo);

    return { kind: 'image', texture: target, width, height, unit: options.size.unit ?? 1 };
  }

  private cacheBindGroup(key: string, group: GPUBindGroup, texs: (GPUTexture | GPUBuffer)[]): void {
    this.bindGroups.set(key, group);
    for (const t of texs) {
      const id = this.texId(t);
      let set = this.bgByTexture.get(id);
      if (!set) this.bgByTexture.set(id, (set = new Set()));
      set.add(key);
    }
    while (this.bindGroups.size > this.limits.bindGroups) {
      const oldest = this.bindGroups.keys().next().value as string;
      this.bindGroups.delete(oldest);
    }
  }

  passMask(options: PassOptions): MaskValue {
    return { ...this.pass(options), kind: 'mask' };
  }

  alloc(width: number, height: number, unit: number, format: Format = 'rgba8unorm'): ImageValue {
    const texture = this.acquire(width, height, format);
    return { kind: 'image', texture, width: texture.width, height: texture.height, unit };
  }

  upload(data: Uint8Array | Uint8ClampedArray, width: number, height: number, unit: number, straight = true): ImageValue {
    let bytes: Uint8Array | Uint8ClampedArray = data;
    if (straight) {
      const out = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a === 255) {
          out[i] = data[i];
          out[i + 1] = data[i + 1];
          out[i + 2] = data[i + 2];
        } else {
          out[i] = Math.round((data[i] * a) / 255);
          out[i + 1] = Math.round((data[i + 1] * a) / 255);
          out[i + 2] = Math.round((data[i + 2] * a) / 255);
        }
        out[i + 3] = a;
      }
      bytes = out;
    }
    const texture = this.acquire(width, height, 'rgba8unorm');
    this.device.queue.writeTexture({ texture }, bytes as BufferSource, { bytesPerRow: width * 4, rowsPerImage: height }, [width, height]);
    return { kind: 'image', texture, width, height, unit };
  }

  async read(image: { texture: GPUTexture; width: number; height: number }, straight = true): Promise<Uint8ClampedArray> {
    const raw = await this.readRaw(image);
    if (straight) {
      for (let i = 0; i < raw.length; i += 4) {
        const a = raw[i + 3];
        if (a !== 0 && a !== 255) {
          raw[i] = Math.round((raw[i] * 255) / a);
          raw[i + 1] = Math.round((raw[i + 1] * 255) / a);
          raw[i + 2] = Math.round((raw[i + 2] * 255) / a);
        }
      }
    }
    return raw;
  }

  /** Premultiplied RGBA8 of an image (rgba16float is converted on the GPU). Uses a pooled staging buffer. */
  async readRaw(image: { texture: GPUTexture; width: number; height: number }): Promise<Uint8ClampedArray> {
    const { width, height } = image;
    let texture = image.texture;
    if (texture.format !== 'rgba8unorm') {
      texture = this.pass({
        label: 'read-convert',
        size: { width, height },
        textures: { src: { texture } },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smpNearest, uv, 0.0); }',
      }).texture;
    }
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const buffer = this.scratch(bytesPerRow * height, GPUBufferUsage.MAP_READ, 'readback');
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
    this.device.queue.submit([encoder.finish()]);
    this.counters.submits++;
    if (texture !== image.texture) {
      // The conversion copy is queued: later passes are ordered after it, so the temporary can be reused right away.
      this.retain(texture);
      this.release(texture);
    }
    try {
      await buffer.mapAsync(GPUMapMode.READ, 0, bytesPerRow * height);
      const mapped = new Uint8Array(buffer.getMappedRange(0, bytesPerRow * height));
      const out = new Uint8ClampedArray(width * height * 4);
      if (bytesPerRow === width * 4) out.set(mapped.subarray(0, width * height * 4));
      else for (let y = 0; y < height; y++) out.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
      buffer.unmap();
      return out;
    } finally {
      this.releaseScratch(buffer);
    }
  }

  /**
   * Small lookup texture from float data. Cached by content: palettes and kernels are identical from frame to frame, so
   * they are uploaded once (and kept until the cache cap or a trim drops them) instead of once per render.
   */
  dataTexture(data: Float32Array, width: number, height: number): { texture: GPUTexture } {
    if (data.length !== width * height * 4) throw new Error('dataTexture: need width*height*4 floats');
    const u32 = new Uint32Array(data.buffer, data.byteOffset, data.length);
    let h1 = 2166136261;
    let h2 = 0x9e3779b1;
    for (let i = 0; i < u32.length; i++) {
      h1 = Math.imul(h1 ^ u32[i], 16777619);
      h2 = Math.imul(h2 + u32[i], 0x85ebca6b) ^ (h2 >>> 13);
    }
    const key = `${width}x${height}:${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}:${data.length}`;
    const hit = this.dataTextures.get(key);
    if (hit && this.pooled.has(hit.texture)) {
      this.counters.dataTextureHits++;
      hit.tick = this.useTick;
      this.dataTextures.delete(key);
      this.dataTextures.set(key, hit);
      return { texture: hit.texture };
    }
    const half = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) half[i] = toHalf(data[i]);
    const texture = this.acquire(width, height, 'rgba16float');
    this.device.queue.writeTexture({ texture }, half, { bytesPerRow: width * 8, rowsPerImage: height }, [width, height]);
    // Owned by the cache from now on: retained, so scopes do not recycle it and nobody overwrites it.
    this.retain(texture);
    this.dataTextures.set(key, { texture, tick: this.useTick });
    return { texture };
  }

  private trimDataTextures(): void {
    while (this.dataTextures.size > this.limits.dataTextures) {
      const [key, v] = this.dataTextures.entries().next().value as [string, { texture: GPUTexture }];
      this.dataTextures.delete(key);
      this.release(v.texture);
    }
  }

  private dropDataTextures(): void {
    for (const v of this.dataTextures.values()) this.release(v.texture);
    this.dataTextures.clear();
  }

  /** Draw an image into a canvas texture (viewer, encoder). `nearest` keeps pixel art crisp. */
  blit(image: { texture: GPUTexture }, target: GPUTexture, nearest = true): void {
    const key = `${target.format}:${nearest}`;
    let entry = this.blitPipelines.get(key);
    if (!entry) {
      const module = this.device.createShaderModule({
        code: `@group(0) @binding(0) var smp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;
fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }
${VERTEX}`,
      });
      this.counters.shaderModulesCreated++;
      const pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_main', targets: [{ format: target.format }] },
      });
      this.counters.pipelinesCreated++;
      entry = { pipeline, layout: pipeline.getBindGroupLayout(0) };
      this.blitPipelines.set(key, entry);
    }
    const bgKey = `blit|${key}|${this.texId(image.texture)}`;
    let bindGroup = this.bindGroups.get(bgKey);
    if (bindGroup) this.counters.bindGroupHits++;
    else {
      this.counters.bindGroupMisses++;
      bindGroup = this.device.createBindGroup({
        layout: entry.layout,
        entries: [
          { binding: 0, resource: nearest ? this.nearest : this.linear },
          { binding: 1, resource: this.view(image.texture) },
        ],
      });
      this.counters.bindGroupsCreated++;
      this.cacheBindGroup(bgKey, bindGroup, [image.texture]);
    }
    const encoder = this.device.createCommandEncoder();
    const rp = encoder.beginRenderPass({
      // The canvas texture is a new object every frame: its view cannot be cached.
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
    });
    rp.setPipeline(entry.pipeline);
    rp.setBindGroup(0, bindGroup);
    rp.draw(3);
    rp.end();
    this.device.queue.submit([encoder.finish()]);
    this.counters.submits++;
  }

  /** Compute pipeline from WGSL, cached (bounded) by label + code. */
  computePipeline(label: string, code: string, entryPoint = 'main'): GPUComputePipeline {
    const key = `${label}|${entryPoint}|${code}`;
    let p = this.computePipelines.get(key);
    if (p) {
      this.computePipelines.delete(key);
      this.computePipelines.set(key, p);
      return p;
    }
    const module = this.device.createShaderModule({ label, code });
    this.counters.shaderModulesCreated++;
    p = this.device.createComputePipeline({ label, layout: 'auto', compute: { module, entryPoint } });
    this.counters.pipelinesCreated++;
    this.computePipelines.set(key, p);
    while (this.computePipelines.size > 64) this.computePipelines.delete(this.computePipelines.keys().next().value as string);
    return p;
  }

  /** The restricted facade handed to nodes. */
  facade(): NodeGpu {
    return {
      device: this.device,
      pass: (o) => this.pass(o),
      passMask: (o) => this.passMask(o),
      alloc: (w, h, unit, format) => this.alloc(w, h, unit, format),
      upload: (d, w, h, unit, straight) => this.upload(d, w, h, unit, straight),
      read: (img, straight) => this.read(img, straight),
      dataTexture: (d, w, h) => this.dataTexture(d, w, h),
      recycle: (img) => this.recycleNow(img.texture),
      scratch: (size, usage, label, opts) => this.scratch(size, usage, label, opts),
      releaseScratch: (b) => this.releaseScratch(b),
      scratchTexture: (d) => this.scratchTexture(d),
      releaseScratchTexture: (t) => this.releaseScratchTexture(t),
      view: (t) => this.view(t),
      computePipeline: (l, c, e) => this.computePipeline(l, c, e),
      createBuffer: (d, c) => this.createBuffer(d, c),
      destroyBuffer: (b) => this.destroyBuffer(b),
    };
  }
}

type GPUExtent3DDictStrict = { width: number; height?: number; depthOrArrayLayers?: number };

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(value: number): number {
  f32[0] = value;
  const x = u32[0];
  const sign = (x >> 16) & 0x8000;
  let exp = ((x >> 23) & 0xff) - 112;
  let mant = (x >> 12) & 0x7ff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = ((x & 0x7fffff) | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  return (sign | (exp << 10) | (mant >> 1)) + (mant & 1);
}

/** Browser device. Throws a readable error when WebGPU is missing. */
export async function createBrowserDevice(): Promise<GPUDevice> {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    throw new Error('WebGPU is not available in this browser. Use a current Chrome, Edge, Firefox or Safari.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter found.');
  return adapter.requestDevice();
}

/** Node.js device (tests, CLI) through the `webgpu` package. */
export async function createHeadlessDevice(): Promise<GPUDevice> {
  const name = 'webgpu';
  const mod = (await import(/* @vite-ignore */ name)) as { create: (flags: string[]) => GPU; globals: Record<string, unknown> };
  Object.assign(globalThis, mod.globals);
  // Keep the Dawn instance alive: if it is garbage-collected the next GPU readback crashes the process.
  const instance = mod.create([]);
  (globalThis as Record<string, unknown>).__rsmpsGpuInstance = instance;
  const adapter = await instance.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter found.');
  return adapter.requestDevice();
}
