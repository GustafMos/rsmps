/**
 * Subtitles, the GPU part: a word atlas and a sprite renderer.
 *
 * Atlas. Every distinct WORD of a page of cues is rasterised ONCE (Host.rasterizeText, so the font's own kerning and shaping are kept),
 * packed into one texture and kept for as long as the page is in use: r = coverage, g = signed distance to the glyph edge (jump
 * flooding, computed once per atlas with `gen-sdf2d`), so stroke width, shadow blur, soft edges and the 1-pixel pixel-art outline are
 * just numbers in the sprite shader. Atlases are memoised by (font, size, weight, italic, case, page of the file); a file of any length
 * is cut into pages of `PAGE_CUES` cues and the pages live in an LRU with a byte cap, so memory stays bounded.
 *
 * Sprites. One instanced draw per frame: every visible word becomes a few quads (box, shadow, stroke, fill) described by 7 vec4 in a
 * single storage buffer. No texture or buffer is created while playing (pooled scratch buffer, cached bind group, one pipeline per device).
 */
import type { Host, ImageValue, NodeGpu, TextSpec } from '../types';
import { occupancy, signedField } from './gen-sdf2d';

export const PAGE_CUES = 24;
const MAX_ATLAS_SIDE = 4096;
const MAX_ATLASES = 8;
const MAX_ATLAS_BYTES = 128 * 1024 * 1024;
export const MAX_INSTANCES = 384;
const HDR = 8; // vec4s of header
const INST = 7; // vec4s per instance

/** Counters for tests and the memory readout. */
export const subtitleDebug = { atlasBuilds: 0, rasterCalls: 0, atlasHits: 0, atlasEvictions: 0, draws: 0, pipelines: 0, bindGroups: 0 };

export interface AtlasStyle {
  font: string;
  /** Size the words are rasterised at, texels. */
  sizePx: number;
  weight: number;
  italic: boolean;
}

/** Padding the host's rasteriser puts around the text (same formula as src/io/library.ts). A word's advance width is bitmap width - 2 * pad. */
export const rasterPad = (sizePx: number): number => Math.ceil(sizePx * 0.15) + 2;

export function wordSpec(word: string, st: AtlasStyle): TextSpec {
  return { text: word, font: st.font || 'sans-serif', sizePx: Math.max(1, st.sizePx), weight: st.weight, italic: st.italic, align: 'left', lineHeight: 1.2, maxWidthPx: 0 };
}

export interface Cell {
  /** Cell rectangle in the atlas (the bitmap plus `margin` on every side), texels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Advance width of the word, texels. */
  adv: number;
}

export interface Atlas {
  texture: GPUTexture;
  width: number;
  height: number;
  cells: Map<string, Cell>;
  /** Width of a space, texels. */
  space: number;
  pad: number;
  /** Signed-distance margin around each bitmap, texels. */
  margin: number;
  /** Height of the text line box (font size x 1.2), texels. */
  lineBox: number;
  bytes: number;
  /** Words that were asked for but could not be rasterised or did not fit. */
  missing: number;
}

interface AtlasCache {
  map: Map<string, Atlas>;
  bytes: number;
  gpu: NodeGpu;
}
const caches = new WeakMap<GPUDevice, AtlasCache>();

const PACK_WGSL = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c0 = vec2i(floor(px));
  let c = textureLoad(cov, c0, 0).a;
  var g = textureLoad(field, c0, 0).r;
  if (abs(g) < 1.01 && c > 0.0 && c < 1.0) { g = 0.5 - c; }
  let e = clamp(0.5 + g / (2.0 * u.spread), 0.0, 1.0);
  return vec4f(c, e, 0.0, 1.0);
}`;

function buildAtlas(gpu: NodeGpu, host: Host, words: readonly string[], st: AtlasStyle): Atlas | null {
  if (!host.rasterizeText) return null;
  subtitleDebug.atlasBuilds++;
  const pad = rasterPad(st.sizePx);
  const margin = Math.ceil(st.sizePx * 0.3) + 4;
  const raster = (text: string) => {
    subtitleDebug.rasterCalls++;
    return host.rasterizeText!(wordSpec(text, st));
  };
  const items: { word: string; bmp: { data: Uint8ClampedArray; width: number; height: number } }[] = [];
  let missing = 0;
  for (const word of words) {
    const bmp = raster(word);
    if (!bmp || bmp.width < 1 || bmp.height < 1) missing++;
    else items.push({ word, bmp });
  }
  const sp = raster('n n');
  const nn = raster('nn');
  const space = sp && nn && sp.width > nn.width ? sp.width - nn.width : st.sizePx * 0.28;
  if (!items.length) return null;

  const maxSide = Math.min(MAX_ATLAS_SIDE, gpu.device.limits.maxTextureDimension2D);
  const widest = Math.max(...items.map((i) => i.bmp.width + margin * 2));
  let W = 256;
  while (W < widest && W < maxSide) W *= 2;
  W = Math.min(maxSide, Math.max(W, 256));
  // Shelf packing: tallest-first rows, words in order of appearance inside a row.
  const placed: { word: string; bmp: (typeof items)[number]['bmp']; x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const it of items) {
    const cw = it.bmp.width + margin * 2;
    const ch = it.bmp.height + margin * 2;
    if (cw > W) {
      missing++;
      continue;
    }
    if (x + cw > W) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    if (y + ch > maxSide) {
      missing++;
      continue;
    }
    placed.push({ word: it.word, bmp: it.bmp, x, y });
    x += cw;
    rowH = Math.max(rowH, ch);
  }
  if (!placed.length) return null;
  const H = Math.max(16, y + rowH);

  const data = new Uint8Array(W * H * 4);
  const cells = new Map<string, Cell>();
  for (const p of placed) {
    const { bmp } = p;
    for (let row = 0; row < bmp.height; row++) {
      let si = row * bmp.width * 4;
      let di = ((p.y + margin + row) * W + p.x + margin) * 4;
      for (let col = 0; col < bmp.width; col++, si += 4, di += 4) {
        const a = bmp.data[si + 3];
        data[di] = a; // premultiplied white
        data[di + 1] = a;
        data[di + 2] = a;
        data[di + 3] = a;
      }
    }
    cells.set(p.word, { x: p.x, y: p.y, w: bmp.width + margin * 2, h: bmp.height + margin * 2, adv: Math.max(1, bmp.width - 2 * pad) });
  }

  const img: ImageValue = gpu.upload(data, W, H, 1, false);
  const occ = occupancy(gpu, img, { gw: W, gh: H }, { threshold: 0.5, fromBrightness: false, nearest: true });
  const field = signedField(gpu, occ);
  gpu.recycle(occ);
  const packed = gpu.pass({ label: 'subtitle-atlas-pack', size: { width: W, height: H }, textures: { cov: img, field }, uniforms: { spread: margin }, wgsl: PACK_WGSL });
  gpu.recycle(field);
  gpu.recycle(img);

  const texture = gpu.scratchTexture({ width: W, height: H, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'subtitle-atlas' });
  const enc = gpu.device.createCommandEncoder({ label: 'subtitle-atlas-copy' });
  enc.copyTextureToTexture({ texture: packed.texture }, { texture }, [W, H]);
  gpu.device.queue.submit([enc.finish()]);
  gpu.recycle(packed);
  return { texture, width: W, height: H, cells, space, pad, margin, lineBox: st.sizePx * 1.2, bytes: W * H * 4, missing };
}

/**
 * The atlas for `key` (a string naming file content, font, size, weight, italic, case and page), built from `words` on a miss.
 * Hits cost a Map lookup. Returns null when the host cannot rasterise text or nothing could be drawn.
 */
export function getAtlas(gpu: NodeGpu, host: Host, key: string, words: () => string[], st: AtlasStyle): Atlas | null {
  let cache = caches.get(gpu.device);
  if (!cache) caches.set(gpu.device, (cache = { map: new Map(), bytes: 0, gpu }));
  const hit = cache.map.get(key);
  if (hit) {
    subtitleDebug.atlasHits++;
    cache.map.delete(key);
    cache.map.set(key, hit);
    return hit;
  }
  const atlas = buildAtlas(gpu, host, words(), st);
  if (!atlas) return null;
  cache.map.set(key, atlas);
  cache.bytes += atlas.bytes;
  while (cache.map.size > 1 && (cache.map.size > MAX_ATLASES || cache.bytes > MAX_ATLAS_BYTES)) {
    const [k, old] = cache.map.entries().next().value as [string, Atlas];
    cache.map.delete(k);
    cache.bytes -= old.bytes;
    gpu.releaseScratchTexture(old.texture);
    subtitleDebug.atlasEvictions++;
  }
  return atlas;
}

/** Drop every atlas of a device (tests). */
export function clearAtlases(device: GPUDevice): void {
  const c = caches.get(device);
  if (!c) return;
  for (const a of c.map.values()) c.gpu.releaseScratchTexture(a.texture);
  c.map.clear();
  c.bytes = 0;
}

export function atlasStats(device: GPUDevice): { count: number; bytes: number } {
  const c = caches.get(device);
  return { count: c?.map.size ?? 0, bytes: c?.bytes ?? 0 };
}

/* ------------------------------------------------------------------------ */
/* Sprites                                                                   */
/* ------------------------------------------------------------------------ */

export const KIND = { box: 0, shadow: 1, stroke: 2, fill: 3 } as const;

/** Frame-wide settings (the header of the storage buffer). */
export interface FrameHeader {
  canvasW: number;
  canvasH: number;
  /** 0 = solid colour, 1 = gradient, 2 = picture, 3 = ordered-dither between the two colours. */
  fillMode: 0 | 1 | 2 | 3;
  /** Screen texels per dither cell (mode 3). */
  ditherCell: number;
  /** Hard (1-bit) edges and their threshold. */
  hard: boolean;
  threshold: number;
  nearest: boolean;
  gradA: [number, number, number, number];
  gradB: [number, number, number, number];
  /** Gradient / picture box (the text block), screen texels. */
  block: [number, number, number, number];
  gradDir: [number, number];
}

const SHADER = /* wgsl */ `
@group(0) @binding(0) var<storage, read> D: array<vec4f>;
@group(0) @binding(1) var smpL: sampler;
@group(0) @binding(2) var smpN: sampler;
@group(0) @binding(3) var atlas: texture_2d<f32>;
@group(0) @binding(4) var fillTex: texture_2d<f32>;

const HDR = ${HDR}u;
const INST = ${INST}u;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) id: u32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let a = D[HDR + ii * INST];
  let p = a.xy + corners[vi] * a.zw;
  let canvas = D[0].xy;
  var o: VOut;
  o.pos = vec4f(p.x / canvas.x * 2.0 - 1.0, 1.0 - p.y / canvas.y * 2.0, 0.0, 1.0);
  o.id = ii;
  return o;
}

fn soft(sd: f32, w: f32) -> f32 { return clamp(0.5 - sd / w, 0.0, 1.0); }

var<private> BAYER = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
fn bayer4(c: vec2f) -> f32 {
  let i = u32(c.x) % 4u + (u32(c.y) % 4u) * 4u;
  return (BAYER[i] + 0.5) / 16.0;
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let base = HDR + in.id * INST;
  let a = D[base];
  let b = D[base + 1u];
  let c = D[base + 2u];
  let col = D[base + 3u];
  let e = D[base + 4u];
  let f = D[base + 5u];
  let g = D[base + 6u];
  let h1 = D[1];
  let spread = h1.x;
  let hard = h1.y > 0.5;
  let thr = h1.z;
  let p = in.pos.xy;
  let kind = i32(c.y + 0.5);
  var alpha = e.w;
  var rgb = col.rgb;
  var cov = 0.0;

  if (kind == 0) {
    // rounded box: b.zw = half size, e.x = radius
    let q = abs(p - a.xy) - (b.zw - vec2f(e.x));
    let sd = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - e.x;
    cov = soft(sd, 1.0);
    if (hard) { cov = select(0.0, 1.0, cov >= thr); }
    let ba = cov * alpha * abs(col.a);
    return vec4f(rgb * ba, ba);
  }

  // glyph layers: wave bends the sampling row, shadow samples at an offset
  var q = p;
  if (kind == 1) { q = q - vec2f(e.y, e.z); }
  q.y = q.y - f.x * sin(f.y * p.x + f.z);
  let k = c.x;
  let ac = b.xy + b.zw * 0.5 + (q - a.xy) / k;
  var sd = spread * k;
  var covg = 0.0;
  if (ac.x >= b.x && ac.y >= b.y && ac.x < b.x + b.z && ac.y < b.y + b.w) {
    let uv = ac / D[0].zw;
    var s: vec4f;
    if (h1.w > 0.5) { s = textureSampleLevel(atlas, smpN, uv, 0.0); } else { s = textureSampleLevel(atlas, smpL, uv, 0.0); }
    covg = s.r;
    sd = (s.g - 0.5) * 2.0 * spread * k;
  }
  let blur = c.w;
  let w = max(1.0, blur * 2.0);
  if (kind == 3) {
    cov = covg;
    if (blur > 0.0) { cov = soft(sd, w); }
    if (hard) { cov = select(0.0, 1.0, cov >= thr); }
  } else if (kind == 2) {
    cov = clamp(e.x - sd + 0.5, 0.0, 1.0);
    if (hard) { cov = select(0.0, 1.0, cov >= 0.5); }
  } else {
    // shadow: the (stroked) shape, softened by e.x px of blur, drawn at the offset
    let sw = max(1.0, e.x * 2.0);
    let t = soft(sd - g.w, sw);
    cov = t * t * (3.0 - 2.0 * t);
    if (hard) { cov = select(0.0, 1.0, cov >= 0.5); }
  }
  // reveal: wipe from the left and the per-letter ramp (g.x, g.y = the word's left edge and width on screen)
  let u = (p.x - g.x) / max(g.y, 1.0);
  if (c.z < 1.0) { cov = cov * clamp((c.z - u) * g.y, 0.0, 1.0); }
  if (g.z > 0.0) { cov = cov * clamp(f.w * (1.0 + g.z) - u * g.z, 0.0, 1.0); }

  if (kind == 3) {
    let mode = i32(D[5].w + 0.5);
    let keepCol = col.a < 0.0;
    if (!keepCol && (mode == 1 || mode == 3)) {
      let bb = D[4];
      let ctr = (bb.xy + bb.zw) * 0.5;
      let ext = max(abs(D[5].x) * (bb.z - bb.x) + abs(D[5].y) * (bb.w - bb.y), 1.0);
      var t = clamp(dot(p - ctr, D[5].xy) / ext + 0.5, 0.0, 1.0);
      if (mode == 3) { t = select(0.0, 1.0, t > bayer4(floor(p / max(D[5].z, 1.0)))); }
      let m = mix(D[2], D[3], t);
      rgb = m.rgb;
      alpha = alpha * m.a;
    } else if (!keepCol && mode == 2) {
      let t = textureSampleLevel(fillTex, smpL, p / D[0].xy, 0.0);
      rgb = select(vec3f(0.0), t.rgb / t.a, t.a > 0.001);
      alpha = alpha * t.a;
    } else {
      alpha = alpha * abs(col.a);
    }
  } else {
    alpha = alpha * abs(col.a);
  }
  let outA = cov * alpha;
  return vec4f(rgb * outA, outA);
}
`;

interface Pipe {
  pipeline: GPURenderPipeline;
  layout: GPUBindGroupLayout;
  linear: GPUSampler;
  nearest: GPUSampler;
  white: GPUTexture;
  groups: WeakMap<GPUBuffer, WeakMap<GPUTexture, WeakMap<GPUTexture, GPUBindGroup>>>;
  data: Float32Array;
}
const pipes = new WeakMap<GPUDevice, Promise<Pipe>>();
const readyPipes = new WeakMap<GPUDevice, Pipe>();

/** Compile the pipeline once per device. Await it BEFORE building sprites: `drawSprites` is synchronous so shared sprite storage cannot interleave between renders. */
export function ensurePipe(gpu: NodeGpu): Promise<void> {
  return getPipe(gpu).then((p) => void readyPipes.set(gpu.device, p));
}

function getPipe(gpu: NodeGpu): Promise<Pipe> {
  const device = gpu.device;
  let p = pipes.get(device);
  if (!p) {
    p = (async () => {
      const module = device.createShaderModule({ label: 'subtitles', code: SHADER });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) throw new Error(`subtitles shader failed to compile: ${errors.map((e) => `line ${e.lineNum}: ${e.message}`).join('; ')}`);
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });
      const pipeline = device.createRenderPipeline({
        label: 'subtitles',
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: {
          module,
          entryPoint: 'fs',
          targets: [
            {
              format: 'rgba8unorm',
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      });
      subtitleDebug.pipelines++;
      const white = gpu.scratchTexture({ width: 1, height: 1, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'subtitle-white' });
      device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
      return {
        pipeline,
        layout,
        linear: device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
        nearest: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
        white,
        groups: new WeakMap(),
        data: new Float32Array((HDR + MAX_INSTANCES * INST) * 4),
      };
    })();
    pipes.set(device, p);
    p.catch(() => pipes.delete(device));
  }
  return p;
}

/** One sprite, 28 floats in `Sprites.data` order: see the shader. */
export interface Sprite {
  kind: number;
  /** Quad centre and half size on screen. */
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  /** Atlas cell rect (glyph kinds) or the box's half size (kind box). */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  /** Screen texels per atlas texel. */
  k: number;
  /** Fraction of the word revealed from the left (1 = all). */
  wipe: number;
  /** Edge blur in screen texels. */
  blur: number;
  r: number;
  g: number;
  b: number;
  /** Colour alpha; NEGATIVE = keep this exact colour (highlight / palette), ignore the gradient and picture fill. */
  a: number;
  /** stroke width | shadow blur | box radius */
  p1: number;
  /** shadow offset */
  sx: number;
  sy: number;
  /** Opacity. */
  alpha: number;
  waveAmp: number;
  waveK: number;
  wavePhase: number;
  /** Letter progress 0..1 for the per-letter ramp. */
  letter: number;
  /** The word's left edge and width on screen (for wipe and letter ramp). */
  left: number;
  width: number;
  /** Per-letter spread (0 = off). */
  spread: number;
  /** Stroke width the shadow should include (shadow of the stroked shape). */
  shadowGrow: number;
}

export function newSprite(): Sprite {
  return { kind: 0, cx: 0, cy: 0, hw: 0, hh: 0, bx: 0, by: 0, bw: 0, bh: 0, k: 1, wipe: 1, blur: 0, r: 1, g: 1, b: 1, a: 1, p1: 0, sx: 0, sy: 0, alpha: 1, waveAmp: 0, waveK: 0, wavePhase: 0, letter: 1, left: 0, width: 1, spread: 0, shadowGrow: 0 };
}

export interface DrawArgs {
  gpu: NodeGpu;
  out: ImageValue;
  atlas: Atlas | null;
  fill: ImageValue | null;
  header: FrameHeader;
  sprites: readonly Sprite[];
  count: number;
}

/** Draw the sprites into `out` (cleared first) with one instanced draw. */
export function drawSprites(a: DrawArgs): void {
  const { gpu, out } = a;
  const device = gpu.device;
  const pipe = readyPipes.get(device);
  if (!pipe) throw new Error('subtitles: call ensurePipe(gpu) before drawSprites');
  const n = Math.min(a.count, MAX_INSTANCES);
  const d = pipe.data;
  const h = a.header;
  const atlasTex = a.atlas?.texture ?? pipe.white;
  d[0] = h.canvasW;
  d[1] = h.canvasH;
  d[2] = a.atlas?.width ?? 1;
  d[3] = a.atlas?.height ?? 1;
  d[4] = a.atlas?.margin ?? 1;
  d[5] = h.hard ? 1 : 0;
  d[6] = h.threshold;
  d[7] = h.nearest ? 1 : 0;
  d.set(h.gradA, 8);
  d.set(h.gradB, 12);
  d.set(h.block, 16);
  d[20] = h.gradDir[0];
  d[21] = h.gradDir[1];
  d[22] = h.ditherCell;
  d[23] = h.fillMode;
  let o = HDR * 4;
  for (let i = 0; i < n; i++) {
    const s = a.sprites[i];
    d[o++] = s.cx; d[o++] = s.cy; d[o++] = s.hw; d[o++] = s.hh;
    d[o++] = s.bx; d[o++] = s.by; d[o++] = s.bw; d[o++] = s.bh;
    d[o++] = s.k; d[o++] = s.kind; d[o++] = s.wipe; d[o++] = s.blur;
    d[o++] = s.r; d[o++] = s.g; d[o++] = s.b; d[o++] = s.a;
    d[o++] = s.p1; d[o++] = s.sx; d[o++] = s.sy; d[o++] = s.alpha;
    d[o++] = s.waveAmp; d[o++] = s.waveK; d[o++] = s.wavePhase; d[o++] = s.letter;
    d[o++] = s.left; d[o++] = s.width; d[o++] = s.spread; d[o++] = s.shadowGrow;
  }
  const bytes = (HDR + n * INST) * 16;
  const buf = gpu.scratch(bytes, GPUBufferUsage.STORAGE, 'subtitles frame');
  device.queue.writeBuffer(buf, 0, d as unknown as BufferSource, 0, (HDR + n * INST) * 4);
  const fillTex = a.fill?.texture ?? pipe.white;
  let byAtlas = pipe.groups.get(buf);
  if (!byAtlas) pipe.groups.set(buf, (byAtlas = new WeakMap()));
  let byFill = byAtlas.get(atlasTex);
  if (!byFill) byAtlas.set(atlasTex, (byFill = new WeakMap()));
  let group = byFill.get(fillTex);
  if (!group) {
    subtitleDebug.bindGroups++;
    group = device.createBindGroup({
      layout: pipe.layout,
      entries: [
        { binding: 0, resource: { buffer: buf, size: Math.max(16, buf.size) } },
        { binding: 1, resource: pipe.linear },
        { binding: 2, resource: pipe.nearest },
        { binding: 3, resource: gpu.view(atlasTex) },
        { binding: 4, resource: gpu.view(fillTex) },
      ],
    });
    byFill.set(fillTex, group);
  }
  const enc = device.createCommandEncoder({ label: 'subtitles' });
  const rp = enc.beginRenderPass({ colorAttachments: [{ view: gpu.view(out.texture), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
  if (n > 0) {
    rp.setPipeline(pipe.pipeline);
    rp.setBindGroup(0, group);
    rp.draw(6, n);
    subtitleDebug.draws++;
  }
  rp.end();
  device.queue.submit([enc.finish()]);
  gpu.releaseScratch(buf);
}
