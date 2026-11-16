/**
 * Error diffusion as a GPU compute pass. Diffusion is sequential, so one invocation walks the pixels in
 * scan order (or Hilbert order for Riemersma). The image is small (art resolution) and the walk is split
 * into chunks of dispatches so no single dispatch runs long. It mirrors `diffuseImage` in
 * pixel-dither-data.ts (the CPU reference used by the tests) step for step.
 */
import { PRELUDE } from '../gpu/prelude';
import type { ImageValue, NodeGpu } from '../types';
import type { DitherSpace, Rgb } from './pixel-color';
import { srgbToOklab, toSpace } from './pixel-color';
import { DIFFUSION_KERNELS, hilbertOrder } from './pixel-dither-data';
import { SPACE_INDEX } from './pixel-gpu';

const CHUNK = 8192;
const SUBMIT_STEPS = CHUNK * 8;

const WGSL = /* wgsl */ `
${PRELUDE}
struct Params { width: u32, height: u32, count: u32, mode: u32, serp: u32, space: u32, ntaps: u32, chunk: u32, total: u32, strength: f32 };
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var dst: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read> pal: array<vec4f>;
@group(0) @binding(4) var<storage, read> taps: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> err: array<vec4f>;
@group(0) @binding(6) var<storage, read> order: array<u32>;
@group(0) @binding(7) var<storage, read_write> state: array<vec4f>;

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

@compute @workgroup_size(1)
fn main() {
  let W = P.width;
  let H = P.height;
  // state[17].x is the walk's progress; every dispatch continues where the previous one stopped.
  let first = u32(state[17].x);
  let last = min(first + P.chunk, P.total);
  state[17] = vec4f(f32(last), 0.0, 0.0, 0.0);
  for (var s = first; s < last; s++) {
    var x = 0i;
    var y = 0i;
    var reverse = false;
    if (P.mode == 1u) {
      let pi = order[s];
      x = i32(pi % W);
      y = i32(pi / W);
    } else {
      y = i32(s / W);
      let k = i32(s % W);
      reverse = P.serp == 1u && (y & 1) == 1;
      x = select(k, i32(W) - 1 - k, reverse);
    }
    let pos = vec2i(x, y);
    let p = u32(y) * W + u32(x);
    let px = textureLoad(src, pos, 0);
    if (px.a < 0.5 / 255.0) {
      textureStore(dst, pos, px);
      continue;
    }
    var w = toWork(px.rgb / px.a);
    if (P.mode == 1u) {
      // Riemersma: weighted history of the last 16 errors along the Hilbert curve.
      var head = u32(state[16].x);
      let count = u32(state[16].y);
      var total = 0.0;
      for (var k = 0u; k < 16u; k++) { total += pow(16.0, -f32(k) / 15.0); }
      var acc = vec3f(0.0);
      for (var k = 0u; k < count; k++) {
        acc += state[(head + 16u - k) % 16u].xyz * (pow(16.0, -f32(k) / 15.0) / total);
      }
      w = clampWork(w + acc);
      let idx = nearest(w);
      head = (head + 1u) % 16u;
      state[head] = vec4f((w - pal[P.count + idx].xyz) * P.strength, 0.0);
      state[16] = vec4f(f32(head), f32(min(count + 1u, 16u)), 0.0, 0.0);
      textureStore(dst, pos, vec4f(pal[idx].xyz * px.a, px.a));
    } else {
      w = clampWork(w + err[p].xyz);
      let idx = nearest(w);
      let e = (w - pal[P.count + idx].xyz) * P.strength;
      let dir = select(1, -1, reverse);
      for (var t = 0u; t < P.ntaps; t++) {
        let tap = taps[t];
        let nx = x + i32(tap.x) * dir;
        let ny = y + i32(tap.y);
        if (nx < 0 || nx >= i32(W) || ny >= i32(H)) { continue; }
        let q = u32(ny) * W + u32(nx);
        err[q] = vec4f(err[q].xyz + e * tap.z, 0.0);
      }
      textureStore(dst, pos, vec4f(pal[idx].xyz * px.a, px.a));
    }
  }
}
`;

export interface DiffuseGpuOptions {
  algorithm: string;
  strength: number;
  space: DitherSpace;
  serpentine: boolean;
}

function storage(gpu: NodeGpu, data: Float32Array | Uint32Array, label: string): { buf: GPUBuffer; size: number } {
  const size = Math.max(16, Math.ceil(data.byteLength / 16) * 16);
  const buf = gpu.scratch(size, GPUBufferUsage.STORAGE, label);
  gpu.device.queue.writeBuffer(buf, 0, data as BufferSource);
  return { buf, size };
}

/** Error-diffuse `src` onto `palette` (sRGB 0..1) on the GPU. Alpha is kept; transparent pixels are untouched. */
export function diffuseGpu(gpu: NodeGpu, src: ImageValue, palette: Rgb[], opts: DiffuseGpuOptions): ImageValue {
  const device = gpu.device;
  const n = palette.length;
  const { width, height } = src;
  const riemersma = opts.algorithm === 'riemersma';
  const kernel = DIFFUSION_KERNELS[opts.algorithm] ?? DIFFUSION_KERNELS['floyd-steinberg'];

  const palData = new Float32Array(n * 2 * 4);
  palette.forEach((c, i) => {
    palData.set([c[0], c[1], c[2], srgbToOklab(c)[0]], i * 4);
    const s = toSpace(c, opts.space);
    palData.set([s[0], s[1], s[2], 0], (n + i) * 4);
  });
  const tapData = new Float32Array(Math.max(1, kernel.taps.length) * 4);
  kernel.taps.forEach((t, i) => tapData.set([t[0], t[1], t[2] / kernel.divisor, 0], i * 4));
  const orderData = riemersma ? hilbertOrder(width, height) : new Uint32Array(4);

  const pal = storage(gpu, palData, 'diffuse-palette');
  const tap = storage(gpu, tapData, 'diffuse-taps');
  const order = storage(gpu, orderData, 'diffuse-order');
  // Pooled and cleared: the error plane and the walker state must start at zero, but need not be a fresh allocation every frame.
  const errSize = Math.max(16, width * height * 16);
  const errBuf = gpu.scratch(errSize, GPUBufferUsage.STORAGE, 'diffuse-error', { clear: true });
  const stateBuf = gpu.scratch(18 * 16, GPUBufferUsage.STORAGE, 'diffuse-state', { clear: true });

  let dst!: ImageValue;
  const ubo = gpu.scratch(48, GPUBufferUsage.UNIFORM, 'diffuse-uniforms');
  try {
    dst = gpu.alloc(width, height, src.unit);
    const pipeline = gpu.computePipeline('dither-diffuse', WGSL);
    const layout = pipeline.getBindGroupLayout(0);
    const total = width * height;
    const params = new ArrayBuffer(48);
    new Uint32Array(params).set([width, height, n, riemersma ? 1 : 0, opts.serpentine ? 1 : 0, SPACE_INDEX[opts.space], kernel.taps.length, CHUNK, total]);
    new Float32Array(params)[9] = Math.min(1, Math.max(0, opts.strength));
      device.queue.writeBuffer(ubo, 0, params);
    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: { buffer: ubo, size: 48 } },
        { binding: 1, resource: gpu.view(src.texture) },
        { binding: 2, resource: gpu.view(dst.texture) },
        { binding: 3, resource: { buffer: pal.buf, size: pal.size } },
        { binding: 4, resource: { buffer: tap.buf, size: tap.size } },
        { binding: 5, resource: { buffer: errBuf, size: errSize } },
        { binding: 6, resource: { buffer: order.buf, size: order.size } },
        { binding: 7, resource: { buffer: stateBuf, size: 18 * 16 } },
      ],
    });
    // Several submits of at most SUBMIT_STEPS pixels each, so no single submission runs for long.
    for (let from = 0; from < total; from += SUBMIT_STEPS) {
      const encoder = device.createCommandEncoder({ label: 'dither-diffuse' });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      for (let start = from; start < Math.min(total, from + SUBMIT_STEPS); start += CHUNK) pass.dispatchWorkgroups(1);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
  } finally {
    for (const b of [ubo, pal.buf, tap.buf, order.buf, errBuf, stateBuf]) gpu.releaseScratch(b);
  }
  return dst;
}
