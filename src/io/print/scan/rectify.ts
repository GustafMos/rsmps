/** Perspective rectification of a photo onto the canonical page (CPU bilinear). Pure. */
import { applyH, type Mat3 } from '../geometry';
import { createRaster, type RasterImage } from '../raster';

/** Local scale (photo pixels per mm) of a mm -> photo homography at a point. */
export function photoPixelsPerMm(H: Mat3, xMm: number, yMm: number): number {
  const e = 1;
  const p = applyH(H, xMm, yMm);
  const px = applyH(H, xMm + e, yMm);
  const py = applyH(H, xMm, yMm + e);
  const det = Math.abs((px.x - p.x) * (py.y - p.y) - (px.y - p.y) * (py.x - p.x));
  return Math.sqrt(det) / (e * e);
}

/**
 * Resample `photo` into an image of `widthMm` x `heightMm` at `pxPerMm`, where `H` maps page mm to photo pixels.
 * When the photo is much finer than the output, a small box of sub-samples averages it down.
 */
export function rectify(photo: RasterImage, H: Mat3, widthMm: number, heightMm: number, pxPerMm: number): RasterImage {
  const ow = Math.round(widthMm * pxPerMm);
  const oh = Math.round(heightMm * pxPerMm);
  const out = createRaster(ow, oh);
  const scale = photoPixelsPerMm(H, widthMm / 2, heightMm / 2) / pxPerMm;
  const ss = Math.max(1, Math.min(3, Math.round(scale)));
  const { width: pw, height: ph, data: pd } = photo;
  const o = out.data;
  const inv = 1 / pxPerMm;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sj = 0; sj < ss; sj++) {
        for (let si = 0; si < ss; si++) {
          const mx = (x + (si + 0.5) / ss) * inv;
          const my = (y + (sj + 0.5) / ss) * inv;
          const wgt = H[6] * mx + H[7] * my + H[8];
          const sx = (H[0] * mx + H[1] * my + H[2]) / wgt - 0.5;
          const sy = (H[3] * mx + H[4] * my + H[5]) / wgt - 0.5;
          let x0 = Math.floor(sx);
          let y0 = Math.floor(sy);
          const tx = sx - x0;
          const ty = sy - y0;
          let x1 = x0 + 1;
          let y1 = y0 + 1;
          x0 = x0 < 0 ? 0 : x0 >= pw ? pw - 1 : x0;
          x1 = x1 < 0 ? 0 : x1 >= pw ? pw - 1 : x1;
          y0 = y0 < 0 ? 0 : y0 >= ph ? ph - 1 : y0;
          y1 = y1 < 0 ? 0 : y1 >= ph ? ph - 1 : y1;
          const i00 = (y0 * pw + x0) * 4;
          const i10 = (y0 * pw + x1) * 4;
          const i01 = (y1 * pw + x0) * 4;
          const i11 = (y1 * pw + x1) * 4;
          const a = (1 - tx) * (1 - ty);
          const bb = tx * (1 - ty);
          const c = (1 - tx) * ty;
          const d = tx * ty;
          r += pd[i00] * a + pd[i10] * bb + pd[i01] * c + pd[i11] * d;
          g += pd[i00 + 1] * a + pd[i10 + 1] * bb + pd[i01 + 1] * c + pd[i11 + 1] * d;
          b += pd[i00 + 2] * a + pd[i10 + 2] * bb + pd[i01 + 2] * c + pd[i11 + 2] * d;
        }
      }
      const n = ss * ss;
      const j = (y * ow + x) * 4;
      o[j] = r / n;
      o[j + 1] = g / n;
      o[j + 2] = b / n;
    }
  }
  return out;
}
