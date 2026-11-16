/**
 * Scanned textures: crop and deskew a photo of paper, tape, scribbles... by its four corners, make it tile seamlessly, and
 * limit its size. Pure (RGBA arrays), so the Scan tab and tests share it.
 */
import { applyH, fitHomography, type Pt } from './geometry';
import { createRaster, sampleChannel, type RasterImage } from './raster';

/** Corners in photo pixels, clockwise from the top-left of the thing to keep. */
export type Quad = [Pt, Pt, Pt, Pt];

export function defaultQuad(w: number, h: number, inset = 0.06): Quad {
  return [
    { x: w * inset, y: h * inset },
    { x: w * (1 - inset), y: h * inset },
    { x: w * (1 - inset), y: h * (1 - inset) },
    { x: w * inset, y: h * (1 - inset) },
  ];
}

/**
 * Rectify the quad to a w x h image (default: the average edge lengths). Bilinear, one resampling pass. The long side is
 * limited to `maxSide` (default 2048) so a library texture stays a reasonable size.
 */
export function cropTexture(photo: RasterImage, quad: Quad, opts: { width?: number; height?: number; maxSide?: number } = {}): RasterImage {
  const len = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = opts.width ?? Math.round((len(quad[0], quad[1]) + len(quad[3], quad[2])) / 2);
  let h = opts.height ?? Math.round((len(quad[0], quad[3]) + len(quad[1], quad[2])) / 2);
  const maxSide = opts.maxSide ?? 2048;
  const k = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(2, Math.round(w * k));
  h = Math.max(2, Math.round(h * k));
  const H = fitHomography([{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }], quad);
  if (!H) throw new Error('The four corners do not form a usable quadrilateral.');
  const out = createRaster(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = applyH(H, x + 0.5, y + 0.5);
      const j = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) out.data[j + c] = sampleChannel(photo, c, p.x, p.y);
    }
  }
  return out;
}

/**
 * Make an image tile without visible seams: four copies offset by half the size, cross-faded with weights that are 1 in the
 * middle of each copy and 0 at its borders (the borders, where the seams were, come entirely from the shifted copy). `strength`
 * 0..1 limits how far into the image the cross-fade reaches (1 = whole image, the classic result; lower keeps more of the
 * original contrast away from the edges).
 */
export function makeSeamless(img: RasterImage, strength = 1): RasterImage {
  const { width: w, height: h } = img;
  const out = createRaster(w, h);
  const reach = Math.max(0.05, Math.min(1, strength));
  const weight = (t: number, n: number) => {
    // 0 at the borders, 1 once `reach` of the half-size away from them
    const d = 1 - Math.abs((2 * (t + 0.5)) / n - 1);
    const v = Math.max(0, Math.min(1, d / reach));
    return v * v * (3 - 2 * v);
  };
  const hx = Math.floor(w / 2);
  const hy = Math.floor(h / 2);
  for (let y = 0; y < h; y++) {
    const wy = weight(y, h);
    const y2 = (y + hy) % h;
    for (let x = 0; x < w; x++) {
      const wx = weight(x, w);
      const x2 = (x + hx) % w;
      const j = (y * w + x) * 4;
      const a = (y * w + x) * 4;
      const b = (y * w + x2) * 4;
      const c = (y2 * w + x) * 4;
      const d = (y2 * w + x2) * 4;
      for (let ch = 0; ch < 3; ch++) {
        out.data[j + ch] = img.data[a + ch] * wx * wy + img.data[b + ch] * (1 - wx) * wy + img.data[c + ch] * wx * (1 - wy) + img.data[d + ch] * (1 - wx) * (1 - wy);
      }
    }
  }
  return out;
}

/** Largest absolute difference between the left and right columns plus top and bottom rows (0 = tiles perfectly). */
export function seamError(img: RasterImage): number {
  const { width: w, height: h, data } = img;
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++)
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(data[(y * w) * 4 + c] - data[(y * w + w - 1) * 4 + c]);
      n++;
    }
  for (let x = 0; x < w; x++)
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(data[x * 4 + c] - data[((h - 1) * w + x) * 4 + c]);
      n++;
    }
  return n ? sum / n : 0;
}
