/**
 * Exact error diffusion in parallel: wavefront scheduling.
 *
 * Left-to-right diffusion makes pixel (x, y) depend only on pixels that come earlier in raster order inside
 * the kernel reach. With time t = x + k*y (k from `wavefrontSkew`, e.g. 2 for Floyd-Steinberg, 4 for
 * Stevenson-Arce) every tap lands strictly later than its source, so all pixels with the same t are independent
 * and can be processed together. The result is identical to the sequential raster walk (up to float summation
 * order). One workgroup of 256 threads walks the waves (W + k*H of them) with a barrier between waves; pixels
 * *gather* the error of their already-finished sources (no write conflicts). Waves are split across several
 * submits so no submit runs long.
 *
 * Serpentine scanning cannot run in waves (a reversed row needs the whole previous row finished), so it uses
 * the sequential walker in pixel-diffuse-gpu.ts instead.
 */
import { PRELUDE } from '../gpu/prelude';
import type { ImageValue, NodeGpu } from '../types';
import type { DitherSpace, Rgb } from './pixel-color';
import { spaceWeights, srgbToOklab, toSpace } from './pixel-color';
import { DIFFUSION_KERNELS, thresholdMatrix, wavefrontSkew } from './pixel-dither-data';
import { SPACE_INDEX, matrixTexture } from './pixel-gpu';

const WAVES_PER_SUBMIT = 768;

const WGSL = /* wgsl */ `
${PRELUDE}
struct Params {
  width: u32, height: u32, count: u32, skew: u32, space: u32, ntaps: u32, wave0: u32, wave1: u32,
  amount: f32, jitter: f32, edgeKeep: f32, snap: f32, spacing: f32,
};
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read> pal: array<vec4f>;
@group(0) @binding(4) var<storage, read> taps: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> store: array<vec4f>;
@group(0) @binding(6) var noise: texture_2d<f32>;

fn toWork(c: vec3f) -> vec3f {
  if (P.space == 0u) { return srgbToOklab(c); }
  if (P.space == 1u) { return srgbToLinear(c); }
  return c;
}
fn dist(a: vec3f, b: vec3f) -> f32 {
  let d = a - b;
  if (P.space == 0u) { return d.x * d.x + 1.6 * (d.y * d.y + d.z * d.z); }
  return 0.3 * d.x * d.x + 0.59 * d.y * d.y + 0.11 * d.z * d.z;
}
fn clampWork(c: vec3f) -> vec3f {
  if (P.space == 0u) { return vec3f(clamp(c.x, 0.0, 1.0), clamp(c.yz, vec2f(-0.5), vec2f(0.5))); }
  return clamp(c, vec3f(0.0), vec3f(1.0));
}
fn nearest(w: vec3f) -> u32 {
  var best = 0u;
  var bestD = 1e30;
  for (var i = 0u; i < P.count; i++) {
    let d = dist(w, pal[P.count + i].xyz);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// store[2p] = (error, 0), store[2p + 1] = (source colour in working space, 1 if opaque else 0)
fn process(x: i32, y: i32) {
  let W = i32(P.width);
  let H = i32(P.height);
  let pos = vec2i(x, y);
  let p = u32(y * W + x);
  let px = textureLoad(src, pos, 0);
  if (px.a < 0.5 / 255.0) {
    store[2u * p] = vec4f(0.0);
    store[2u * p + 1u] = vec4f(0.0);
    textureStore(dst, pos, px);
    return;
  }
  var c = px.rgb / px.a;
  if (P.snap > 0.0) { c = clamp(round(c / P.snap) * P.snap, vec3f(0.0), vec3f(1.0)); }
  let base = toWork(c);
  var acc = vec3f(0.0);
  for (var t = 0u; t < P.ntaps; t++) {
    let tap = taps[t];
    let qx = x - i32(tap.x);
    let qy = y - i32(tap.y);
    if (qx < 0 || qx >= W || qy < 0) { continue; }
    let q = u32(qy * W + qx);
    let qb = store[2u * q + 1u];
    if (qb.w < 0.5) { continue; }
    var wt = tap.z;
    if (P.edgeKeep > 0.0) {
      // Do not push error across strong edges of the source.
      wt = wt * (1.0 - P.edgeKeep * smoothstep(0.0036, 0.0324, dist(base, qb.xyz)));
    }
    acc += store[2u * q].xyz * wt;
  }
  let w = clampWork(base + acc);
  var probe = w;
  if (P.jitter > 0.0) {
    // Blue-noise threshold modulation (position only: no frame dependence, so no extra shimmer).
    let n = textureLoad(noise, vec2i(x & 63, y & 63), 0).r - 0.5;
    probe = clampWork(w + n * P.jitter * P.spacing * select(vec3f(1.0), vec3f(1.0, 0.5, 0.5), P.space == 0u));
  }
  let idx = nearest(probe);
  store[2u * p] = vec4f((w - pal[P.count + idx].xyz) * P.amount, 0.0);
  store[2u * p + 1u] = vec4f(base, 1.0);
  textureStore(dst, pos, vec4f(pal[idx].xyz * px.a, px.a));
}

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) lid: u32) {
  let W = i32(P.width);
  let H = i32(P.height);
  let k = i32(P.skew);
  for (var wave = P.wave0; wave < P.wave1; wave++) {
    let t = i32(wave);
    var ylo = 0;
    if (t > W - 1) { ylo = (t - (W - 1) + k - 1) / k; }
    let yhi = min(H - 1, t / k);
    for (var y = ylo + i32(lid); y <= yhi; y += 256) {
      process(t - k * y, y);
    }
    storageBarrier();
    workgroupBarrier();
  }
}
`;

const pipelines = new WeakMap<GPUDevice, GPUComputePipeline>();

export interface WavefrontOptions {
  algorithm: string;
  space: DitherSpace;
  /** Fraction of the quantisation error that is diffused (strength * errorAmount). */
  amount: number;
  /** 0..1 blue-noise threshold modulation. */
  jitter: number;
  /** 0..1: how much diffusion is stopped across strong source edges. */
  edgeKeep: number;
  /** Source values are snapped to this step in sRGB (0 = off): identical output for tiny source changes. */
  snap: number;
}

export function wavefrontWaves(width: number, height: number, algorithm: string): number {
  const kernel = DIFFUSION_KERNELS[algorithm] ?? DIFFUSION_KERNELS['floyd-steinberg'];
  return width + wavefrontSkew(kernel) * (height - 1);
}

export function diffuseWavefront(gpu: NodeGpu, src: ImageValue, palette: Rgb[], opts: WavefrontOptions): ImageValue {
  const device = gpu.device;
  const n = palette.length;
  const { width, height } = src;
  const kernel = DIFFUSION_KERNELS[opts.algorithm] ?? DIFFUSION_KERNELS['floyd-steinberg'];
  const skew = wavefrontSkew(kernel);

  const palData = new Float32Array(n * 2 * 4);
  const work: Rgb[] = [];
  palette.forEach((c, i) => {
    palData.set([c[0], c[1], c[2], srgbToOklab(c)[0]], i * 4);
    const s = toSpace(c, opts.space);
    work.push(s);
    palData.set([s[0], s[1], s[2], 0], (n + i) * 4);
  });
  // Typical distance between neighbouring palette colours: the jitter amplitude is relative to it.
  const wt = spaceWeights(opts.space);
  let spacing = 0;
  for (let i = 0; i < n; i++) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      best = Math.min(best, Math.sqrt(wt[0] * (work[i][0] - work[j][0]) ** 2 + wt[1] * (work[i][1] - work[j][1]) ** 2 + wt[2] * (work[i][2] - work[j][2]) ** 2));
    }
    spacing += Number.isFinite(best) ? best : 0.5;
  }
  spacing = n > 1 ? spacing / n : 0.5;
  const tapData = new Float32Array(kernel.taps.length * 4);
  kernel.taps.forEach((t, i) => tapData.set([t[0], t[1], t[2] / kernel.divisor, 0], i * 4));

  const mk = (data: Float32Array, label: string): GPUBuffer => {
    const b = device.createBuffer({ label, size: Math.max(16, Math.ceil(data.byteLength / 16) * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, data as BufferSource);
    return b;
  };
  const palBuf = mk(palData, 'wavefront-palette');
  const tapBuf = mk(tapData, 'wavefront-taps');
  const storeBuf = device.createBuffer({ label: 'wavefront-store', size: Math.max(32, width * height * 32), usage: GPUBufferUsage.STORAGE });
  const bn = thresholdMatrix('blue-noise')!;
  const noise = matrixTexture(gpu, bn.width, bn.height, bn.data);

  const dst = gpu.alloc(width, height, src.unit);
  let pipeline = pipelines.get(device);
  if (!pipeline) {
    pipeline = device.createComputePipeline({
      label: 'dither-wavefront',
      layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'dither-wavefront', code: WGSL }), entryPoint: 'main' },
    });
    pipelines.set(device, pipeline);
  }
  const layout = pipeline.getBindGroupLayout(0);
  const waves = width + skew * (height - 1);
  const temp: GPUBuffer[] = [];
  const srcView = src.texture.createView();
  const dstView = dst.texture.createView();
  const noiseView = noise.texture.createView();
  for (let from = 0; from < waves; from += WAVES_PER_SUBMIT) {
    const params = new ArrayBuffer(64);
    new Uint32Array(params).set([width, height, n, skew, SPACE_INDEX[opts.space], kernel.taps.length, from, Math.min(waves, from + WAVES_PER_SUBMIT)]);
    new Float32Array(params).set([opts.amount, opts.jitter, opts.edgeKeep, opts.snap, spacing], 8);
    const ubo = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(ubo, 0, params);
    temp.push(ubo);
    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: ubo } },
        { binding: 1, resource: srcView },
        { binding: 2, resource: dstView },
        { binding: 3, resource: { buffer: palBuf } },
        { binding: 4, resource: { buffer: tapBuf } },
        { binding: 5, resource: { buffer: storeBuf } },
        { binding: 6, resource: noiseView },
      ],
    });
    const encoder = device.createCommandEncoder({ label: 'dither-wavefront' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
  for (const b of [...temp, palBuf, tapBuf, storeBuf]) b.destroy();
  return dst;
}
