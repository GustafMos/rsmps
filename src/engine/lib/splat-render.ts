/**
 * Splat renderer: instanced quads, EWA projection in the vertex shader (lib/splat-wgsl.ts), premultiplied over-blending.
 *
 * TWO SOURCES, ONE PIPELINE FAMILY
 *   cloud    a SplatCloud uploaded once to storage buffers (64 bytes per splat; a small LRU like lib/model-render.ts, counted in
 *            gpu.stats() as `splat-buffer`, destroyed on eviction and when the device was replaced).
 *   picture  a picture (+ depth) turned into splats IN THE VERTEX SHADER: instance index -> grid cell -> unprojection. No CPU work.
 *
 * ORDER
 *   cloud / sorted  16-bit counting sort of the centres by depth along the view direction (lib/splat-math.ts `sortBackToFront`), on the
 *                   CPU, synchronously and deterministically. Done ONLY when the cloud or the SNAPPED view changes: the order lives in a
 *                   per-cloud GPU buffer remembered by its view key, so a slider that does not move the camera never sorts again.
 *   cloud / draft   no sort: weighted blended order-independent transparency (accum + reveal), approximate, for playback.
 *   picture         an occlusion-compatible grid traversal (McMillan; `pictureOrder`): exact for a single-layer depth picture, no sort,
 *                   no depth buffer, so video works at full speed.
 *
 * COST NOTES. The sort runs on the CPU thread of the render. A Web Worker was not used: the engine has no worker facility, results must
 * be identical and available synchronously for export and tests, and a counting sort of 1 M splats is a few milliseconds (see the
 * numbers in the node tests). A moving camera on a huge cloud re-sorts every frame; a still camera never does.
 */
import type { ImageValue, NodeGpu } from '../types';
import type { SplatCloud } from './splat-cloud';
import { newSortScratch, pictureOrder, sortBackToFront, sortView, type M3, type SortScratch, type ViewSetup } from './splat-math';
import { COMPOSITE_DEPTH_DRAFT, COMPOSITE_DEPTH_SORTED, COMPOSITE_DRAFT, COMPOSITE_SORTED, FR_SLOTS, splatShader, type ShaderKey } from './splat-wgsl';
import type { V3 } from './gen-camera';

/** Counters for tests and benchmarks (a spy: they never influence a render). */
export const splatDebug = {
  sorts: 0,
  sortMs: 0,
  lastSortCount: 0,
  uploads: 0,
  orderUploads: 0,
  pipelines: 0,
  draws: 0,
  /** Times a depth image was produced (it is only produced when something wants it). */
  depthPasses: 0,
};
export function resetSplatDebug(): void {
  splatDebug.sorts = 0;
  splatDebug.sortMs = 0;
  splatDebug.lastSortCount = 0;
  splatDebug.uploads = 0;
  splatDebug.orderUploads = 0;
  splatDebug.pipelines = 0;
  splatDebug.draws = 0;
  splatDebug.depthPasses = 0;
}

const BYTES_PER_SPLAT = 64;
const MAX_CLOUDS = 3;
const MAX_CLOUD_BYTES = 640 * 1024 * 1024;
const MAX_TARGET_BYTES = 900 * 1024 * 1024;
const TARGET_FORMAT: GPUTextureFormat = 'rgba16float';

/** How many splats this device can hold in one storage buffer. */
export const maxSplatsFor = (device: GPUDevice): number => Math.floor(Math.min(device.limits.maxStorageBufferBindingSize, device.limits.maxBufferSize) / BYTES_PER_SPLAT);

export interface SplatXform {
  /** Row-major 3x3: world = A (p - centre) + t. Orientation, rotation and scale folded together (A = s Q, Q orthogonal). */
  A: M3;
  t: V3;
  centre: V3;
  /** Scale of the fitted cloud space the crop shapes live in (crop q = fitK (p - centre)). */
  fitK: number;
}

export interface SplatLook {
  sizeMul: number;
  opacityMul: number;
  minOpacity: number;
  shape: 'gaussian' | 'sharp' | 'square';
  exposure: number;
  saturation: number;
  tint: readonly number[];
  viewDependent: boolean;
  antialias: boolean;
  crop: { mode: 'none' | 'box' | 'sphere'; invert: boolean; centre: V3; half: V3; radius: number };
  background: readonly number[];
}

export const DEFAULT_LOOK: SplatLook = {
  sizeMul: 1,
  opacityMul: 1,
  minOpacity: 0,
  shape: 'gaussian',
  exposure: 0,
  saturation: 1,
  tint: [1, 1, 1],
  viewDependent: true,
  antialias: true,
  crop: { mode: 'none', invert: false, centre: [0, 0, 0], half: [1, 1, 1], radius: 1 },
  background: [0, 0, 0, 0],
};

const SHAPE_ID = { gaussian: 0, sharp: 1, square: 2 } as const;

/* ------------------------------------------------------------------------------------------------------------------ */
/* Per-device pipelines                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

interface DeviceBits {
  layouts: { cloud: GPUBindGroupLayout; picture: GPUBindGroupLayout };
  sampler: GPUSampler;
  pipes: Map<string, Promise<GPURenderPipeline>>;
}
const perDevice = new WeakMap<GPUDevice, DeviceBits>();

function bits(device: GPUDevice): DeviceBits {
  let b = perDevice.get(device);
  if (!b) {
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const V = GPUShaderStage.VERTEX;
    b = {
      layouts: {
        cloud: device.createBindGroupLayout({
          label: 'splat cloud',
          entries: [
            { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
            { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } },
            { binding: 2, visibility: V, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: V, buffer: { type: 'read-only-storage' } },
          ],
        }),
        picture: device.createBindGroupLayout({
          label: 'splat picture',
          entries: [
            { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
            { binding: 1, visibility: V, texture: { sampleType: 'float' } },
            { binding: 2, visibility: V, texture: { sampleType: 'float' } },
            { binding: 3, visibility: V, sampler: { type: 'filtering' } },
          ],
        }),
      },
      sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
      pipes: new Map(),
    };
    perDevice.set(device, b);
  }
  return b;
}

const OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
const ADD: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};
const REVEAL: GPUBlendState = {
  color: { srcFactor: 'zero', dstFactor: 'one-minus-src', operation: 'add' },
  alpha: { srcFactor: 'zero', dstFactor: 'one-minus-src', operation: 'add' },
};

function getPipeline(device: GPUDevice, key: ShaderKey): Promise<GPURenderPipeline> {
  const b = bits(device);
  const k = `${key.source}|${key.mode}|${key.depth ? 'depth' : 'colour'}`;
  let p = b.pipes.get(k);
  if (!p) {
    splatDebug.pipelines++;
    p = (async () => {
      const module = device.createShaderModule({ label: `splat ${k}`, code: splatShader(key) });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) throw new Error(`splat shader (${k}) failed to compile: ${errors.map((e) => `line ${e.lineNum}: ${e.message}`).join('; ')}`);
      const targets: GPUColorTargetState[] =
        key.mode === 'sorted'
          ? [{ format: TARGET_FORMAT, blend: OVER }, ...(key.depth ? [{ format: TARGET_FORMAT, blend: OVER }] : [])]
          : [{ format: TARGET_FORMAT, blend: ADD }, { format: TARGET_FORMAT, blend: REVEAL }, ...(key.depth ? [{ format: TARGET_FORMAT, blend: ADD }] : [])];
      return device.createRenderPipeline({
        label: `splat ${k}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [b.layouts[key.source]] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets },
        primitive: { topology: 'triangle-strip', cullMode: 'none' },
      });
    })();
    b.pipes.set(k, p);
    p.catch(() => b.pipes.delete(k));
  }
  return p;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* GPU copies of clouds (small LRU)                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

interface GpuCloud {
  device: GPUDevice;
  gpu: NodeGpu;
  data: GPUBuffer;
  order: GPUBuffer;
  sh: GPUBuffer;
  bytes: number;
  hasSh: boolean;
  /** Key of the view the `order` buffer currently holds, and how many splats it lists. */
  orderKey: string | null;
  orderCount: number;
  scratch: SortScratch;
  groups: WeakMap<GPUBuffer, GPUBindGroup>;
}
const clouds = new Map<SplatCloud, GpuCloud>();

function destroyCloud(c: GpuCloud): void {
  for (const b of [c.data, c.order, c.sh]) {
    try {
      c.gpu.destroyBuffer(b);
    } catch {
      /* the device is already gone */
    }
  }
}

function trimClouds(keep: SplatCloud): void {
  let total = 0;
  for (const c of clouds.values()) total += c.bytes;
  for (const [k, c] of [...clouds]) {
    if (clouds.size <= MAX_CLOUDS && total <= MAX_CLOUD_BYTES) break;
    if (k === keep) continue;
    total -= c.bytes;
    destroyCloud(c);
    clouds.delete(k);
  }
}

/** Drop every GPU copy (tests; also what a device loss does implicitly). */
export function dropSplatBuffers(): void {
  for (const c of clouds.values()) destroyCloud(c);
  clouds.clear();
}

function uploadCloud(gpu: NodeGpu, cloud: SplatCloud): GpuCloud {
  const device = gpu.device;
  let g = clouds.get(cloud);
  if (g && g.device !== device) {
    destroyCloud(g);
    clouds.delete(cloud);
    g = undefined;
  }
  if (g) {
    clouds.delete(cloud); // refresh LRU position
    clouds.set(cloud, g);
    return g;
  }
  const n = cloud.count;
  const limit = maxSplatsFor(device);
  if (n > limit) {
    throw new Error(`This graphics card can hold ${limit.toLocaleString('en-US')} splats in one buffer and the cloud has ${n.toLocaleString('en-US')}. Lower "Max splats".`);
  }
  const data = gpu.createBuffer({ label: 'splat data', size: Math.max(16, n * BYTES_PER_SPLAT), usage: GPUBufferUsage.STORAGE, mappedAtCreation: true }, 'splat-buffer');
  const f = new Float32Array(data.getMappedRange());
  const { positions: P, scales: S, rotations: R, colors: C, opacity: O } = cloud;
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    f[o] = P[i * 3]; f[o + 1] = P[i * 3 + 1]; f[o + 2] = P[i * 3 + 2]; f[o + 3] = O[i];
    f[o + 4] = S[i * 3]; f[o + 5] = S[i * 3 + 1]; f[o + 6] = S[i * 3 + 2];
    f[o + 8] = R[i * 4]; f[o + 9] = R[i * 4 + 1]; f[o + 10] = R[i * 4 + 2]; f[o + 11] = R[i * 4 + 3];
    f[o + 12] = C[i * 3]; f[o + 13] = C[i * 3 + 1]; f[o + 14] = C[i * 3 + 2];
  }
  data.unmap();
  const order = gpu.createBuffer({ label: 'splat order', size: Math.max(16, n * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }, 'splat-buffer');
  const hasSh = !!cloud.sh1;
  const sh = gpu.createBuffer({ label: 'splat sh1', size: hasSh ? Math.max(16, n * 36) : 16, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true }, 'splat-buffer');
  if (hasSh) new Float32Array(sh.getMappedRange()).set(cloud.sh1!);
  sh.unmap();
  splatDebug.uploads++;
  g = {
    device,
    gpu,
    data,
    order,
    sh,
    bytes: n * BYTES_PER_SPLAT + n * 4 + (hasSh ? n * 36 : 16),
    hasSh,
    orderKey: null,
    orderCount: 0,
    scratch: newSortScratch(n),
    groups: new WeakMap(),
  };
  clouds.set(cloud, g);
  trimClouds(cloud);
  return g;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Uniforms                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

class Fr {
  readonly f = new Float32Array(FR_SLOTS * 4);
  set(slot: number, a = 0, b = 0, c = 0, d = 0): void {
    this.f.set([a, b, c, d], slot * 4);
  }
}

function setView(fr: Fr, v: ViewSetup, base: { cam: number; right: number; up: number; fwd: number }): void {
  fr.set(base.cam, v.pos[0], v.pos[1], v.pos[2], v.persp ? 1 : 0);
  fr.set(base.right, v.right[0], v.right[1], v.right[2], v.tanH);
  fr.set(base.up, v.up[0], v.up[1], v.up[2], v.orthoHalf);
  fr.set(base.fwd, v.fwd[0], v.fwd[1], v.fwd[2], v.near);
}

function look(fr: Fr, l: SplatLook, view: ViewSetup, count: number): void {
  const W = view.width;
  const H = view.height;
  fr.set(4, W, H, view.shift[0], view.shift[1]);
  fr.set(9, l.sizeMul, l.opacityMul, l.minOpacity, SHAPE_ID[l.shape]);
  fr.set(10, Math.pow(2, l.exposure), l.saturation, l.antialias ? 1 : 0, l.viewDependent ? 1 : 0);
  fr.set(11, l.tint[0] ?? 1, l.tint[1] ?? 1, l.tint[2] ?? 1, Math.max(W, H));
  fr.set(12, { none: 0, box: 1, sphere: 2 }[l.crop.mode], l.crop.invert ? 1 : 0, l.crop.radius, 0);
  fr.set(13, l.crop.centre[0], l.crop.centre[1], l.crop.centre[2], 0);
  fr.set(14, l.crop.half[0], l.crop.half[1], l.crop.half[2], count);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Drawing                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

interface Targets {
  acc: GPUTexture;
  rev: GPUTexture | null;
  dacc: GPUTexture | null;
}

function checkTarget(gpu: NodeGpu, W: number, H: number, draft: boolean, depth: boolean): void {
  const max = gpu.device.limits.maxTextureDimension2D;
  const layers = 1 + (draft ? 1 : 0) + (depth ? 1 : 0);
  if (W > max || H > max || W * H * 8 * layers > MAX_TARGET_BYTES) {
    throw new Error(`The output (${W}x${H}) is too large to render splats. Use a smaller frame.`);
  }
}

function drawInto(gpu: NodeGpu, pipe: GPURenderPipeline, group: GPUBindGroup, W: number, H: number, instances: number, key: ShaderKey): Targets {
  const device = gpu.device;
  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
  const mk = (label: string) => gpu.scratchTexture({ width: W, height: H, format: TARGET_FORMAT, usage, label });
  const acc = mk('splat accum');
  const rev = key.mode === 'draft' ? mk('splat reveal') : null;
  const dacc = key.depth ? mk('splat depth') : null;
  const attachments: GPURenderPassColorAttachment[] = [{ view: gpu.view(acc), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }];
  if (rev) attachments.push({ view: gpu.view(rev), loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] });
  if (dacc) attachments.push({ view: gpu.view(dacc), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] });
  const enc = device.createCommandEncoder({ label: 'splats' });
  const rp = enc.beginRenderPass({ colorAttachments: attachments });
  if (instances > 0) {
    rp.setPipeline(pipe);
    rp.setBindGroup(0, group);
    rp.draw(4, instances);
    splatDebug.draws++;
  }
  rp.end();
  device.queue.submit([enc.finish()]);
  return { acc, rev, dacc };
}

function compose(
  gpu: NodeGpu,
  t: Targets,
  size: { width: number; height: number; unit?: number },
  background: readonly number[],
  wantDepth: boolean,
): { image: ImageValue; depth: ImageValue | null } {
  const draft = !!t.rev;
  const bg = [background[0] ?? 0, background[1] ?? 0, background[2] ?? 0, background[3] ?? 0];
  const image = gpu.pass({
    label: draft ? 'splat composite (draft)' : 'splat composite',
    size,
    textures: draft ? { acc: { texture: t.acc }, rev: { texture: t.rev! } } : { acc: { texture: t.acc } },
    uniforms: { bg },
    wgsl: draft ? COMPOSITE_DRAFT : COMPOSITE_SORTED,
  });
  let depth: ImageValue | null = null;
  if (wantDepth && t.dacc) {
    splatDebug.depthPasses++;
    depth = gpu.pass({
      label: draft ? 'splat depth (draft)' : 'splat depth',
      size,
      textures: draft ? { dacc: { texture: t.dacc }, rev: { texture: t.rev! } } : { dacc: { texture: t.dacc } },
      wgsl: draft ? COMPOSITE_DEPTH_DRAFT : COMPOSITE_DEPTH_SORTED,
      format: 'rgba16float',
    });
  }
  gpu.releaseScratchTexture(t.acc);
  if (t.rev) gpu.releaseScratchTexture(t.rev);
  if (t.dacc) gpu.releaseScratchTexture(t.dacc);
  return { image, depth };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Cloud                                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------ */

export interface RenderSplatsArgs {
  gpu: NodeGpu;
  cloud: SplatCloud;
  view: ViewSetup;
  xf: SplatXform;
  look: SplatLook;
  size: { width: number; height: number; unit?: number };
  /** true = depth-sorted over-blending (exact); false = draft (order-independent weighted blending, no sort). */
  sorted: boolean;
  wantDepth: boolean;
}

export interface RenderSplatsResult {
  image: ImageValue;
  depth: ImageValue | null;
  /** Splats that went to the GPU (after the near-plane cut when sorted). */
  drawn: number;
  /** True when this call had to sort (false = the cached order was reused). */
  sortedNow: boolean;
}

/** Render a cloud. Throws readable errors (frame too large, cloud too big for the card). */
export async function renderSplats(a: RenderSplatsArgs): Promise<RenderSplatsResult> {
  const { gpu, cloud, view, xf, size } = a;
  const W = Math.round(size.width);
  const H = Math.round(size.height);
  checkTarget(gpu, W, H, !a.sorted, a.wantDepth);
  const key: ShaderKey = { source: 'cloud', mode: a.sorted ? 'sorted' : 'draft', depth: a.wantDepth };
  const device = gpu.device;
  const pipe = await getPipeline(device, key);
  const g = uploadCloud(gpu, cloud);
  const n = cloud.count;

  let instances = n;
  let sortedNow = false;
  if (a.sorted && n > 0) {
    const sv = sortView(view, xf.A, xf.t, xf.centre, cloud.bounds.radius);
    if (g.orderKey !== sv.key) {
      const t0 = performance.now();
      const res = sortBackToFront(cloud.positions, n, sv, g.scratch);
      splatDebug.sortMs += performance.now() - t0;
      splatDebug.sorts++;
      splatDebug.lastSortCount = res.count;
      if (res.count > 0) device.queue.writeBuffer(g.order, 0, res.order.buffer, res.order.byteOffset, res.order.byteLength);
      splatDebug.orderUploads++;
      g.orderKey = sv.key;
      g.orderCount = res.count;
      sortedNow = true;
    }
    instances = g.orderCount;
  }

  const fr = new Fr();
  setView(fr, view, { cam: 0, right: 1, up: 2, fwd: 3 });
  look(fr, a.look, { ...view, width: W, height: H }, n);
  fr.set(5, xf.A[0], xf.A[1], xf.A[2], xf.t[0]);
  fr.set(6, xf.A[3], xf.A[4], xf.A[5], xf.t[1]);
  fr.set(7, xf.A[6], xf.A[7], xf.A[8], xf.t[2]);
  fr.set(8, xf.centre[0], xf.centre[1], xf.centre[2], xf.fitK);
  // depth range for the draft weights: the cloud's bounding sphere
  const s = Math.sqrt(xf.A[0] * xf.A[0] + xf.A[1] * xf.A[1] + xf.A[2] * xf.A[2]);
  const bc = cloud.bounds.centre;
  const d = [bc[0] - xf.centre[0], bc[1] - xf.centre[1], bc[2] - xf.centre[2]];
  const cw: V3 = [
    xf.A[0] * d[0] + xf.A[1] * d[1] + xf.A[2] * d[2] + xf.t[0],
    xf.A[3] * d[0] + xf.A[4] * d[1] + xf.A[5] * d[2] + xf.t[1],
    xf.A[6] * d[0] + xf.A[7] * d[1] + xf.A[8] * d[2] + xf.t[2],
  ];
  const dc = view.persp ? Math.hypot(cw[0] - view.pos[0], cw[1] - view.pos[1], cw[2] - view.pos[2]) : (cw[0] - view.pos[0]) * view.fwd[0] + (cw[1] - view.pos[1]) * view.fwd[1] + (cw[2] - view.pos[2]) * view.fwd[2];
  const reach = cloud.bounds.radius * s * 1.05;
  fr.set(15, dc - reach, dc + reach, 0, 0);
  fr.set(13, a.look.crop.centre[0], a.look.crop.centre[1], a.look.crop.centre[2], a.sorted ? 1 : 0);

  const ubo = gpu.scratch(fr.f.byteLength, GPUBufferUsage.UNIFORM, 'splat frame');
  device.queue.writeBuffer(ubo, 0, fr.f);
  let group = g.groups.get(ubo);
  if (!group) {
    group = device.createBindGroup({
      layout: bits(device).layouts.cloud,
      entries: [
        { binding: 0, resource: { buffer: ubo, size: fr.f.byteLength } },
        { binding: 1, resource: { buffer: g.data } },
        { binding: 2, resource: { buffer: g.order } },
        { binding: 3, resource: { buffer: g.sh } },
      ],
    });
    g.groups.set(ubo, group);
  }
  const targets = drawInto(gpu, pipe, group, W, H, instances, key);
  gpu.releaseScratch(ubo);
  const out = compose(gpu, targets, { width: W, height: H, unit: size.unit }, a.look.background, a.wantDepth);
  return { ...out, drawn: instances, sortedNow };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Picture                                                                                                             */
/* ------------------------------------------------------------------------------------------------------------------ */

export type DepthEncoding = 'luma-near-white' | 'luma-near-black' | 'scene';
export type DepthGuess = 'flat' | 'luminance' | 'bulge' | 'luminance-bulge';

export interface PictureSplatArgs {
  gpu: NodeGpu;
  image: ImageValue;
  /** Null = no depth wired: the guess is used. */
  depth: ImageValue | null;
  /** The camera that sees the splats. */
  view: ViewSetup;
  /** The camera the picture (and depth) were made with. */
  capture: ViewSetup;
  grid: { w: number; h: number };
  size: { width: number; height: number; unit?: number };
  encoding: DepthEncoding;
  guess: DepthGuess;
  near: number;
  far: number;
  /** Splat thickness along the surface normal, in units of one cell's footprint. */
  thickness: number;
  /** Multiplier of the splat's in-plane size (1 = a Gaussian of 0.7 cells). */
  sizeMul: number;
  /** 0 = off; otherwise the stretch (in cells) above which a splat across a depth jump is dropped or shrunk. */
  edgeThreshold: number;
  edgeMode: 'drop' | 'shrink';
  /** Random shift of each splat inside its cell, in cells. */
  jitter: number;
  opacity: number;
  shape: 'gaussian' | 'sharp' | 'square';
  background: readonly number[];
  wantDepth: boolean;
  antialias: boolean;
}

const picGroups = new WeakMap<GPUBuffer, WeakMap<GPUTexture, WeakMap<GPUTexture, GPUBindGroup>>>();

export const PICTURE_SIGMA = 0.7;

export async function renderPictureSplats(a: PictureSplatArgs): Promise<{ image: ImageValue; depth: ImageValue | null; splats: number }> {
  const { gpu, image, view, capture, size } = a;
  const W = Math.round(size.width);
  const H = Math.round(size.height);
  checkTarget(gpu, W, H, false, a.wantDepth);
  const device = gpu.device;
  const key: ShaderKey = { source: 'picture', mode: 'sorted', depth: a.wantDepth };
  const pipe = await getPipeline(device, key);
  const gw = Math.max(1, Math.round(a.grid.w));
  const gh = Math.max(1, Math.round(a.grid.h));
  const total = gw * gh;
  const order = pictureOrder(capture, { ...view, width: W, height: H }, { w: gw, h: gh, imgW: image.width, imgH: image.height });

  const fr = new Fr();
  setView(fr, view, { cam: 0, right: 1, up: 2, fwd: 3 });
  look(
    fr,
    {
      ...DEFAULT_LOOK,
      opacityMul: a.opacity,
      shape: a.shape,
      antialias: a.antialias,
      viewDependent: false,
    },
    { ...view, width: W, height: H },
    total,
  );
  const enc = a.depth ? ({ 'luma-near-white': 0, 'luma-near-black': 1, scene: 2 } as const)[a.encoding] : 3;
  const guess = ({ flat: 0, luminance: 1, bulge: 2, 'luminance-bulge': 3 } as const)[a.guess];
  fr.set(16, gw, gh, image.width, image.height);
  fr.set(17, a.near, a.far, enc, guess);
  fr.set(18, a.thickness, PICTURE_SIGMA * a.sizeMul, a.edgeThreshold, a.edgeMode === 'shrink' ? 1 : 0);
  fr.set(19, a.jitter, 0, 0, 0);
  setView(fr, capture, { cam: 20, right: 21, up: 22, fwd: 23 });
  fr.set(24, capture.shift[0], capture.shift[1], 0, 0);
  fr.set(25, order.x.split, order.x.dir, order.y.split, order.y.dir);
  // depth range for the draft weights is unused here (always ordered), but keep the slot sane
  fr.set(15, 0, 1, 0, 0);

  const ubo = gpu.scratch(fr.f.byteLength, GPUBufferUsage.UNIFORM, 'splat picture frame');
  device.queue.writeBuffer(ubo, 0, fr.f);
  const depthTex = (a.depth ?? image).texture;
  let byColour = picGroups.get(ubo);
  if (!byColour) picGroups.set(ubo, (byColour = new WeakMap()));
  let byDepth = byColour.get(image.texture);
  if (!byDepth) byColour.set(image.texture, (byDepth = new WeakMap()));
  let group = byDepth.get(depthTex);
  if (!group) {
    group = device.createBindGroup({
      layout: bits(device).layouts.picture,
      entries: [
        { binding: 0, resource: { buffer: ubo, size: fr.f.byteLength } },
        { binding: 1, resource: gpu.view(image.texture) },
        { binding: 2, resource: gpu.view(depthTex) },
        { binding: 3, resource: bits(device).sampler },
      ],
    });
    byDepth.set(depthTex, group);
  }
  const targets = drawInto(gpu, pipe, group, W, H, total, key);
  gpu.releaseScratch(ubo);
  const out = compose(gpu, targets, { width: W, height: H, unit: size.unit }, a.background, a.wantDepth);
  return { ...out, splats: total };
}
