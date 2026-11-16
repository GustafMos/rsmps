import { defineNode } from '../../define';
import { PIXEL_SIZE_PARAM, withArtGrid } from '../../lib/art-grid';
import type { DitherSpace } from '../../lib/pixel-color';
import { diffuseGpu } from '../../lib/pixel-diffuse-gpu';
import { diffuseWavefront } from '../../lib/pixel-wavefront-gpu';
import { DITHER_ALGORITHMS, algorithmFamily, thresholdMatrix } from '../../lib/pixel-dither-data';
import { PALETTE_WGSL, SPACE_INDEX, SPACE_OPTIONS, clampPalette, matrixTexture, paletteTexture } from '../../lib/pixel-gpu';
import { FALLBACK_PARAM, paletteSummary, resolvePalette } from '../../lib/pixel-palettes';

/**
 * Dither: image + palette in, image out that uses ONLY palette colours.
 *
 * Ordered / pattern / palette-blend run on the GPU. Ordered dithering works for any palette (not just
 * greys) through Knoll's method: for each pixel, accumulate the quantisation error over 16 trial steps,
 * sort the 16 resulting palette colours by lightness and let the threshold matrix pick one. For a
 * black/white palette that is exactly classic ordered dithering; for colour palettes it keeps the average
 * colour right, which a "add noise then snap" offset cannot do.
 *
 * Error diffusion is inherently sequential: it runs as a single-invocation compute pass that walks the
 * (small) art-resolution image in scan order (Hilbert order for Riemersma), chunked into short dispatches.
 * `diffuseImage` in pixel-dither-data.ts is the CPU reference it is tested against.
 *
 * What was wrong with the old tool's last groups (pattern + palette blend + Riemersma), all fixed here:
 *  - dot screen used a Chebyshev distance with only 3 distinct values in 0.33..1.0 (mean 0.82): the image
 *    came out far too dark/light with huge flat blobs. Crosshatch used sine sums (7 distinct, bell shaped),
 *    diagonal lines used values 0..0.75 (mean 0.375), "horizontal" lines varied along x (so they drew
 *    vertical lines), checker had only 2 thresholds, and "clustered dot 8x8" was really the Bayer 8x8
 *    table. None of those matrices was a rank matrix, so tones were not preserved. Now every matrix is a
 *    bijective rank matrix (see pixel-dither-data.ts).
 *  - ordered offsets were a fixed fraction of the average palette spacing, so for uneven or colour
 *    palettes the pattern was too weak/strong and shifted hues. Replaced by the Knoll mix above.
 *  - Yliluoma blended the two *nearest* colours, which are often not on opposite sides of the pixel's
 *    colour (so the ratio clamped to 0 and areas banded), and added random noise whenever strength < 1.
 *    Now it searches the best pair among the nearest four and strength only softens the mix.
 *  - Riemersma's Hilbert index rotated with `s - 1 - x` instead of `n - 1 - x`, so the visiting order was
 *    not a continuous curve and error was fed to unrelated pixels (worm-like streaks). Fixed curve.
 *  - the "blue noise" table was broken: 376 of its 4096 cells were 0 (the whole darkest 9% collapsed),
 *    so dark tones got clumpy white-noise-like dots. Regenerated as a true void-and-cluster rank matrix.
 *  - error diffusion in OKLab let the carried error grow without limit for small palettes; the working
 *    colour is now clamped to the gamut.
 */

/** Serpentine and Riemersma walk pixels one at a time (~2.4 s per megapixel): refused above this size, with an error. */
const SEQUENTIAL_BUDGET = 350_000;
const isSequential = (p: { algorithm: string; serpentine: boolean }): boolean => p.algorithm === 'riemersma' || p.serpentine;

const WGSL = /* wgsl */ `
${PALETTE_WGSL}

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn threshold(cell: vec2i) -> f32 {
  if (i32(u.kind) == 1) {
    let h = pcg(pcg(u32(cell.x) + 0x9e3779b9u * u32(u.seed + 1.0)) + u32(cell.y));
    return (f32(h >> 8u) + 0.5) / 16777216.0;
  }
  let mw = i32(u.matW);
  let mh = i32(u.matH);
  return textureLoad(mat, vec2i(cell.x % mw, cell.y % mh), 0).r;
}

fn clampWork(c: vec3f) -> vec3f {
  if (i32(u.colorSpace) == 0) { return vec3f(clamp(c.x, 0.0, 1.0), clamp(c.yz, vec2f(-0.5), vec2f(0.5))); }
  return clamp(c, vec3f(0.0), vec3f(1.0));
}

// Knoll: 16 trial colours from accumulated error, sorted dark to light, the matrix picks one.
fn knoll(tgt: vec3f, t: f32) -> i32 {
  var cand: array<i32, 16>;
  var err = vec3f(0.0);
  for (var i = 0; i < 16; i++) {
    let q = nearestIdx(clampWork(tgt + err * u.strength));
    cand[i] = q;
    err += tgt - palSpace(q);
  }
  for (var i = 1; i < 16; i++) {
    let v = cand[i];
    let k = palKey(v);
    var j = i - 1;
    loop {
      if (j < 0) { break; }
      if (palKey(cand[j]) <= k) { break; }
      cand[j + 1] = cand[j];
      j = j - 1;
    }
    cand[j + 1] = v;
  }
  return cand[clamp(i32(floor(t * 16.0)), 0, 15)];
}

// Yliluoma-style: best two-colour mix among the four nearest palette colours, matrix decides which one.
fn yliluoma(tgt: vec3f, t: f32) -> i32 {
  let n = i32(u.palCount);
  var ids = array<i32, 4>(0, 0, 0, 0);
  var ds = array<f32, 4>(1e30, 1e30, 1e30, 1e30);
  for (var i = 0; i < n; i++) {
    let d = spaceDist(tgt, palSpace(i));
    if (d < ds[3]) {
      ds[3] = d;
      ids[3] = i;
      var j = 3;
      loop {
        if (j == 0) { break; }
        if (ds[j - 1] <= ds[j]) { break; }
        let td = ds[j - 1]; ds[j - 1] = ds[j]; ds[j] = td;
        let ti = ids[j - 1]; ids[j - 1] = ids[j]; ids[j] = ti;
        j = j - 1;
      }
    }
  }
  let m = min(4, n);
  var wv = vec3f(0.3, 0.59, 0.11);
  if (i32(u.colorSpace) == 0) { wv = vec3f(1.0, 1.6, 1.6); }
  var bestErr = 1e30;
  var bestA = ids[0];
  var bestB = ids[0];
  var bestR = 0.0;
  for (var a = 0; a < m; a++) {
    for (var b = a + 1; b < m; b++) {
      let pa = palSpace(ids[a]);
      let pb = palSpace(ids[b]);
      let v = pb - pa;
      let denom = max(dot(wv * v, v), 1e-9);
      let r = clamp(dot(wv * (tgt - pa), v) / denom, 0.0, 1.0);
      let e = spaceDist(tgt, pa + v * r) + 0.08 * spaceDist(pa, pb);
      if (e < bestErr) { bestErr = e; bestA = ids[a]; bestB = ids[b]; bestR = r; }
    }
  }
  // Order the pair dark -> light; ratio = share of the lighter colour.
  var lo = bestA;
  var hi = bestB;
  var ratio = bestR;
  if (palKey(bestA) > palKey(bestB)) { lo = bestB; hi = bestA; ratio = 1.0 - bestR; }
  let soft = mix(step(0.5, ratio), ratio, u.strength);
  if (t < soft) { return hi; }
  return lo;
}

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  if (s.a <= 0.0001) { return s; }
  let tgt = toSpace(s.rgb / s.a);
  let kind = i32(u.kind);
  var idx = 0;
  if (kind == 2) {
    idx = nearestIdx(tgt);
  } else {
    let t = threshold(vec2i(floor(px / u.scale)));
    if (kind == 3) { idx = yliluoma(tgt, t); } else { idx = knoll(tgt, t); }
  }
  return premul(vec4f(palSrgb(idx), s.a));
}
`;

export default defineNode({
  id: 'dither',
  title: 'Dither',
  category: 'pixel',
  description:
    'Reduces an image to the wired palette with a dither pattern: ordered, pattern, palette-blend or error diffusion. ' +
    'Works on the pixel grid: after a (masked) Pixelate it follows that grid, and on a full-resolution image set Pixel size to dither in chunky, fast art pixels (e.g. footage + tracked mask -> Dither).',
  keywords: ['bayer', 'floyd', 'steinberg', 'atkinson', 'halftone', 'blue noise', 'ordered', 'diffusion', 'retro', 'palette'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    palette: { type: 'palette', label: 'Palette' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    fallback: FALLBACK_PARAM,
    pixelSize: PIXEL_SIZE_PARAM,
    algorithm: {
      type: 'enum',
      default: 'bayer-4',
      label: 'Algorithm',
      options: DITHER_ALGORITHMS.map((a) => ({ value: a.id, label: a.label })),
    },
    strength: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Strength', hint: '0 = plain nearest colour, 1 = full dithering.' },
    errorAmount: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Error amount', group: 'Error diffusion', hint: 'Share of the quantisation error that is passed on. Below 1 reduces worm artefacts at the cost of tone accuracy.', visibleIf: (p) => algorithmFamily(p.algorithm as string) === 'diffusion' },
    jitter: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Jitter', group: 'Error diffusion', hint: 'Blue-noise threshold modulation. Breaks up worms and structured patterns in flat areas. Position-only, so it does not shimmer in video. Not used by serpentine / Riemersma.', visibleIf: (p) => algorithmFamily(p.algorithm as string) === 'diffusion' },
    edgeKeep: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Edge keep', group: 'Error diffusion', hint: 'Stops error from spreading across strong edges of the source, keeping outlines crisp. Not used by serpentine / Riemersma.', visibleIf: (p) => algorithmFamily(p.algorithm as string) === 'diffusion' },
    stable: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Video stability', group: 'Error diffusion', hint: 'Snaps source values to a coarse step (up to 15/255) before diffusing, so small frame-to-frame changes (noise, compression) give identical output instead of shimmering. All noise terms already depend on position only. Not used by serpentine / Riemersma.', visibleIf: (p) => algorithmFamily(p.algorithm as string) === 'diffusion' },
    scale: {
      type: 'number',
      default: 1,
      min: 1,
      max: 64,
      softMax: 16,
      step: 1,
      unit: 'px',
      label: 'Pattern scale',
      hint: 'Size of one pattern cell. 1 = one art pixel (one texel after Pixelate, or one grid cell when Pixel size is used). On other images it scales with the media. Always rounded to a whole number of texels, never below 1, so patterns stay even on coarse or fine render grids.',
      visibleIf: (p) => algorithmFamily(p.algorithm as string) !== 'diffusion',
    },
    colorSpace: { type: 'enum', default: 'oklab', options: SPACE_OPTIONS, label: 'Color space' },
    serpentine: {
      type: 'bool',
      default: false,
      label: 'Serpentine scan',
      group: 'Error diffusion',
      hint: 'Alternate the scan direction each row. Exact but strictly sequential, so it is limited to 0.35 megapixels (Pixelate first); the default left-to-right scan runs in parallel at any size.',
      visibleIf: (p) => algorithmFamily(p.algorithm as string) === 'diffusion' && p.algorithm !== 'riemersma',
    },
    seed: { type: 'number', default: 0, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', visibleIf: (p) => p.algorithm === 'white-noise' },
  },
  summary: (p, wired) => `${DITHER_ALGORITHMS.find((a) => a.id === p.algorithm)?.label ?? p.algorithm}${algorithmFamily(p.algorithm) === 'diffusion' ? (isSequential(p) ? ' · sequential (max 0.35 MP)' : ' · exact parallel') : ''} · ${paletteSummary(!!wired?.has('palette'), p.fallback)}`,
  async render(ctx) {
    const input = ctx.in.image;
    const p = ctx.params;
    const colors = clampPalette(resolvePalette(ctx.in.palette, p.fallback));
    if (colors.length === 0) return { image: input };
    const space = p.colorSpace as DitherSpace;
    const family = algorithmFamily(p.algorithm);

    // Everything below runs on the art grid when the image carries one (or Pixel size > 0): see lib/art-grid.ts.
    const image = withArtGrid(ctx.gpu, input, p.pixelSize, (src, grid) => {
      if (family === 'diffusion') {
        if (isSequential(p)) {
          if (src.width * src.height > SEQUENTIAL_BUDGET) {
            throw new Error(`Dither: ${p.algorithm === 'riemersma' ? 'Riemersma' : 'Serpentine scan'} walks pixels one by one and is limited to ${SEQUENTIAL_BUDGET / 1000}k pixels (this working grid is ${src.width}x${src.height}). Turn off Serpentine / choose another algorithm, or raise Pixel size.`);
          }
          return diffuseGpu(ctx.gpu, src, colors, { algorithm: p.algorithm, strength: p.strength * p.errorAmount, space, serpentine: p.serpentine });
        }
        return diffuseWavefront(ctx.gpu, src, colors, { algorithm: p.algorithm, space, amount: p.strength * p.errorAmount, jitter: p.jitter, edgeKeep: p.edgeKeep, snap: p.stable * 0.06 });
      }

      const algorithm = p.algorithm;
      const matrix = thresholdMatrix(algorithm);
      const kind = family === 'none' ? 2 : algorithm === 'white-noise' ? 1 : algorithm === 'yliluoma' ? 3 : 0;
      const mat = matrix ? matrixTexture(ctx.gpu, matrix.width, matrix.height, matrix.data) : matrixTexture(ctx.gpu, 1, 1, new Float32Array([0.5]));
      return ctx.gpu.pass({
        label: 'dither',
        size: src,
        textures: { src, pal: paletteTexture(ctx.gpu, colors, space), mat: { texture: mat.texture } },
        uniforms: {
          palCount: colors.length,
          colorSpace: SPACE_INDEX[space],
          strength: p.strength,
          scale: Math.max(1, Math.round(grid.toArt(p.scale))),
          kind,
          matW: mat.width,
          matH: mat.height,
          seed: p.seed,
        },
        wgsl: WGSL,
      });
    });
    return { image };
  },
});
