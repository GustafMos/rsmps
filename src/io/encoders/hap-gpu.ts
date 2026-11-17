/**
 * GPU block compression for HAP: a WebGPU compute shader that runs the SAME integer algorithm as `compressDxt(..., { refine: 0 })`
 * (see dxt.ts) one thread per 4x4 block, writes the blocks to a storage buffer and reads them back as bytes. Output is bit-identical
 * to the CPU path with refine 0 (asserted in hap-gpu.test.ts). The CPU path with refinement is a little better (higher PSNR) but ~10x slower.
 *
 * Input is an engine image (rgba8unorm, premultiplied). Only HAP Alpha (Hap5) un-premultiplies (same rounding as `Gpu.read`); HAP and HAP Q have no
 * alpha, so they keep the premultiplied colour = the picture composited over black, like every other opaque format.
 * Uses only the public Gpu pool API (scratch buffers, computePipeline); creates no textures.
 */
import { blockBytes, dxtFrameBytes, type DxtFormat } from './dxt';

/** The part of `Gpu` / `NodeGpu` this needs. */
export interface HapGpu {
  readonly device: GPUDevice;
  computePipeline(label: string, code: string, entryPoint?: string): GPUComputePipeline;
  scratch(size: number, usage: number, label?: string, opts?: { clear?: boolean }): GPUBuffer;
  releaseScratch(buf: GPUBuffer): void;
  view?(tex: GPUTexture): GPUTextureView;
}

const SHADER = /* wgsl */ `
struct P { w: u32, h: u32, bw: u32, nblocks: u32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> outb: array<u32>;
@group(0) @binding(2) var<uniform> p: P;

var<private> R: array<i32, 16>;
var<private> G: array<i32, 16>;
var<private> B: array<i32, 16>;
var<private> A: array<i32, 16>;
var<private> pal: array<i32, 12>;

fn q5(v: i32) -> i32 { return (v * 62 + 255) / 510; }
fn q6(v: i32) -> i32 { return (v * 126 + 255) / 510; }
fn e5(v: i32) -> i32 { return (v << 3u) | (v >> 2u); }
fn e6(v: i32) -> i32 { return (v << 2u) | (v >> 4u); }

fn colorBlock(lockBlue: i32) -> vec2<u32> {
  var minR = 255; var minG = 255; var minB = 255;
  var maxR = 0; var maxG = 0; var maxB = 0;
  for (var i = 0; i < 16; i++) {
    minR = min(minR, R[i]); maxR = max(maxR, R[i]);
    minG = min(minG, G[i]); maxG = max(maxG, G[i]);
    minB = min(minB, B[i]); maxB = max(maxB, B[i]);
  }
  let midR = minR + maxR; let midG = minG + maxG; let midB = minB + maxB;
  var covXZ = 0; var covYZ = 0;
  for (var i = 0; i < 16; i++) {
    let bz = 2 * B[i] - midB;
    covXZ += (2 * R[i] - midR) * bz;
    covYZ += (2 * G[i] - midG) * bz;
  }
  let insR = (maxR - minR) >> 4u; let insG = (maxG - minG) >> 4u; let insB = (maxB - minB) >> 4u;
  minR += insR; maxR -= insR; minG += insG; maxG -= insG; minB += insB; maxB -= insB;
  if (covXZ < 0) { let t = minR; minR = maxR; maxR = t; }
  if (covYZ < 0) { let t = minG; minG = maxG; maxG = t; }
  var bHi = q5(maxB); var bLo = q5(minB);
  if (lockBlue >= 0) { bHi = q5(lockBlue); bLo = bHi; }
  var c0 = (q5(maxR) << 11u) | (q6(maxG) << 5u) | bHi;
  var c1 = (q5(minR) << 11u) | (q6(minG) << 5u) | bLo;
  if (c0 < c1) { let t = c0; c0 = c1; c1 = t; }
  if (c0 == c1) { return vec2<u32>(u32(c0) | (u32(c1) << 16u), 0u); }
  pal[0] = e5(c0 >> 11u); pal[1] = e6((c0 >> 5u) & 63); pal[2] = e5(c0 & 31);
  pal[3] = e5(c1 >> 11u); pal[4] = e6((c1 >> 5u) & 63); pal[5] = e5(c1 & 31);
  for (var k = 0; k < 3; k++) {
    pal[6 + k] = (2 * pal[k] + pal[3 + k]) / 3;
    pal[9 + k] = (pal[k] + 2 * pal[3 + k]) / 3;
  }
  var idx = 0u;
  for (var i = 0; i < 16; i++) {
    var best = 0x7fffffff;
    var bi = 0;
    for (var k = 0; k < 4; k++) {
      let dr = R[i] - pal[k * 3]; let dg = G[i] - pal[k * 3 + 1]; let db = B[i] - pal[k * 3 + 2];
      let d = dr * dr + dg * dg + db * db;
      if (d < best) { best = d; bi = k; }
    }
    idx |= u32(bi) << u32(i * 2);
  }
  return vec2<u32>(u32(c0) | (u32(c1) << 16u), idx);
}

fn alphaBlock() -> vec2<u32> {
  var mn = 255; var mx = 0;
  for (var i = 0; i < 16; i++) { mn = min(mn, A[i]); mx = max(mx, A[i]); }
  if (mx == mn) { return vec2<u32>(u32(mx) | (u32(mn) << 8u), 0u); }
  var ap: array<i32, 8>;
  ap[0] = mx; ap[1] = mn;
  for (var k = 2; k < 8; k++) { ap[k] = ((8 - k) * mx + (k - 1) * mn) / 7; }
  var lo = 0u; var hi = 0u;
  for (var i = 0; i < 16; i++) {
    var best = 0x7fffffff;
    var bi = 0;
    for (var k = 0; k < 8; k++) {
      let d = abs(A[i] - ap[k]);
      if (d < best) { best = d; bi = k; }
    }
    let bit = i * 3;
    if (bit < 24) { lo |= u32(bi) << u32(bit); } else { hi |= u32(bi) << u32(bit - 24); }
  }
  return vec2<u32>(u32(mx) | (u32(mn) << 8u) | ((lo & 0xffffu) << 16u), ((lo >> 16u) & 0xffu) | (hi << 8u));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  if (n >= p.nblocks) { return; }
  let bx = n % p.bw;
  let by = n / p.bw;
  for (var i = 0; i < 16; i++) {
    let x = min(p.w - 1u, bx * 4u + u32(i & 3));
    let y = min(p.h - 1u, by * 4u + u32(i >> 2u));
    let t = textureLoad(src, vec2<i32>(i32(x), i32(y)), 0);
    var r = i32(round(t.r * 255.0)); var g = i32(round(t.g * 255.0)); var b = i32(round(t.b * 255.0));
    let a = i32(round(t.a * 255.0));
    if (UNPREMUL && a != 0 && a != 255) {
      r = min(255, (2 * r * 255 + a) / (2 * a));
      g = min(255, (2 * g * 255 + a) / (2 * a));
      b = min(255, (2 * b * 255 + a) / (2 * a));
    }
    R[i] = r; G[i] = g; B[i] = b; A[i] = a;
  }
  if (FORMAT == 0) {
    let c = colorBlock(-1);
    outb[n * 2u] = c.x; outb[n * 2u + 1u] = c.y;
  } else if (FORMAT == 1) {
    let a = alphaBlock();
    let c = colorBlock(-1);
    outb[n * 4u] = a.x; outb[n * 4u + 1u] = a.y; outb[n * 4u + 2u] = c.x; outb[n * 4u + 3u] = c.y;
  } else {
    var dev = 0;
    for (var i = 0; i < 16; i++) {
      let r = R[i]; let g = G[i]; let b = B[i];
      let yy = (r + 2 * g + b + 2) >> 2u;
      let co = max(1, min(255, ((r - b) >> 1u) + 128));
      let cg = max(1, min(255, ((2 * g - r - b) >> 2u) + 128));
      A[i] = yy; R[i] = co; G[i] = cg;
      dev = max(dev, max(abs(co - 128), abs(cg - 128)));
    }
    var s = 1;
    if (dev < 32) { s = 4; } else if (dev < 64) { s = 2; }
    let blue = (s - 1) * 8;
    for (var i = 0; i < 16; i++) {
      R[i] = max(0, min(255, (R[i] - 128) * s + 128));
      G[i] = max(0, min(255, (G[i] - 128) * s + 128));
      B[i] = blue;
    }
    let a = alphaBlock();
    let c = colorBlock(blue);
    outb[n * 4u] = a.x; outb[n * 4u + 1u] = a.y; outb[n * 4u + 2u] = c.x; outb[n * 4u + 3u] = c.y;
  }
}
`;

export interface HapGpuCompressor {
  readonly bytes: number;
  /**
   * Compress an engine image (rgba8unorm texture, size == the compressor's size). Resolves with a reused buffer that is overwritten by
   * the next call: copy it (hapFrame / HapSession.addTexture already do).
   */
  compress(image: { texture: GPUTexture }): Promise<Uint8Array>;
  dispose(): void;
}

export function createHapGpuCompressor(gpu: HapGpu, width: number, height: number, fmt: DxtFormat): HapGpuCompressor {
  const bw = Math.ceil(width / 4);
  const nblocks = bw * Math.ceil(height / 4);
  const bytes = dxtFrameBytes(width, height, fmt);
  const code = SHADER.replace(/FORMAT/g, String(fmt === 'Hap1' ? 0 : fmt === 'Hap5' ? 1 : 2)).replace(/UNPREMUL/g, fmt === 'Hap5' ? 'true' : 'false');
  const pipeline = gpu.computePipeline(`hap-${fmt}`, code);
  const out = gpu.scratch(bytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, 'hap-blocks');
  const read = gpu.scratch(bytes, GPUBufferUsage.MAP_READ, 'hap-readback');
  const ubo = gpu.scratch(16, GPUBufferUsage.UNIFORM, 'hap-params');
  gpu.device.queue.writeBuffer(ubo, 0, new Uint32Array([width, height, bw, nblocks]));
  const result = new Uint8Array(bytes);
  let disposed = false;
  void blockBytes;
  return {
    bytes,
    async compress(image) {
      if (disposed) throw new Error('HAP GPU compressor was disposed.');
      const view = gpu.view ? gpu.view(image.texture) : image.texture.createView();
      const group = gpu.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: view },
          { binding: 1, resource: { buffer: out, size: bytes } },
          { binding: 2, resource: { buffer: ubo, size: 16 } },
        ],
      });
      const enc = gpu.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(nblocks / 64));
      pass.end();
      enc.copyBufferToBuffer(out, 0, read, 0, bytes);
      gpu.device.queue.submit([enc.finish()]);
      await read.mapAsync(GPUMapMode.READ, 0, bytes);
      result.set(new Uint8Array(read.getMappedRange(0, bytes)));
      read.unmap();
      return result;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gpu.releaseScratch(out);
      gpu.releaseScratch(read);
      gpu.releaseScratch(ubo);
    },
  };
}
