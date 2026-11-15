/**
 * Plain raster types and small pixel helpers shared by the print and scan code.
 *
 * Coordinate convention everywhere in src/io/print: continuous coordinates where pixel (i, j) covers
 * [i, i+1) x [j, j+1) and its centre is at (i + 0.5, j + 0.5). Page millimetres map to page pixels by
 * `mm * dpi / 25.4` in this system.
 */

/** Straight-alpha RGBA, 8 bit, row-major. */
export interface RasterImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

export function createRaster(width: number, height: number, fill: [number, number, number, number] = [255, 255, 255, 255]): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  if (fill[0] === fill[1] && fill[1] === fill[2] && fill[2] === fill[3]) data.fill(fill[0]);
  else for (let i = 0; i < data.length; i += 4) data.set(fill, i);
  return { width, height, data };
}

/** Rec. 601 luma of an RGBA image as bytes (alpha ignored: composite first if needed). */
export function toGray8(img: RasterImage): Uint8Array {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  const d = img.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29 + 128) >> 8;
  return out;
}

/** Bilinear sample of a single-channel image at continuous (x, y); clamps at the border. */
export function sampleGray(g: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  let x0 = Math.floor(fx);
  let y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  x0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0;
  x1 = x1 < 0 ? 0 : x1 >= w ? w - 1 : x1;
  y0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0;
  y1 = y1 < 0 ? 0 : y1 >= h ? h - 1 : y1;
  const a = g[y0 * w + x0] * (1 - tx) + g[y0 * w + x1] * tx;
  const b = g[y1 * w + x0] * (1 - tx) + g[y1 * w + x1] * tx;
  return a * (1 - ty) + b * ty;
}

/** Bilinear sample of one channel of an RGBA image. */
export function sampleChannel(img: RasterImage, c: number, x: number, y: number): number {
  const { width: w, height: h, data } = img;
  const fx = x - 0.5;
  const fy = y - 0.5;
  let x0 = Math.floor(fx);
  let y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  x0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0;
  x1 = x1 < 0 ? 0 : x1 >= w ? w - 1 : x1;
  y0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0;
  y1 = y1 < 0 ? 0 : y1 >= h ? h - 1 : y1;
  const a = data[(y0 * w + x0) * 4 + c] * (1 - tx) + data[(y0 * w + x1) * 4 + c] * tx;
  const b = data[(y1 * w + x0) * 4 + c] * (1 - tx) + data[(y1 * w + x1) * 4 + c] * tx;
  return a * (1 - ty) + b * ty;
}

/**
 * Resize an RGBA image. Strong upscales (>= 2x on both axes) use nearest neighbour (keeps pixel art crisp);
 * downscales use an exact area average; everything else is bilinear. Transparent pixels are composited
 * over white first, so the result is opaque.
 */
export function resizeRaster(src: RasterImage, dw: number, dh: number, mode: 'auto' | 'nearest' | 'bilinear' | 'area' = 'auto'): RasterImage {
  const sw = src.width;
  const sh = src.height;
  const out = createRaster(dw, dh);
  const s = src.data;
  const o = out.data;
  let m = mode;
  if (m === 'auto') m = dw >= 2 * sw && dh >= 2 * sh ? 'nearest' : dw <= sw && dh <= sh ? 'area' : 'bilinear';
  const px = (i: number, ch: number): number => {
    const a = s[i + 3] / 255;
    return s[i + ch] * a + 255 * (1 - a);
  };
  if (m === 'nearest') {
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
        const i = (sy * sw + sx) * 4;
        const j = (y * dw + x) * 4;
        o[j] = px(i, 0);
        o[j + 1] = px(i, 1);
        o[j + 2] = px(i, 2);
      }
    }
  } else if (m === 'area') {
    const kx = sw / dw;
    const ky = sh / dh;
    for (let y = 0; y < dh; y++) {
      const y0 = y * ky;
      const y1 = y0 + ky;
      for (let x = 0; x < dw; x++) {
        const x0 = x * kx;
        const x1 = x0 + kx;
        let r = 0;
        let g = 0;
        let b = 0;
        let wsum = 0;
        for (let yy = Math.floor(y0); yy < Math.min(sh, Math.ceil(y1)); yy++) {
          const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
          for (let xx = Math.floor(x0); xx < Math.min(sw, Math.ceil(x1)); xx++) {
            const wgt = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
            const i = (yy * sw + xx) * 4;
            r += px(i, 0) * wgt;
            g += px(i, 1) * wgt;
            b += px(i, 2) * wgt;
            wsum += wgt;
          }
        }
        const j = (y * dw + x) * 4;
        o[j] = r / wsum;
        o[j + 1] = g / wsum;
        o[j + 2] = b / wsum;
      }
    }
  } else {
    for (let y = 0; y < dh; y++) {
      const gy = ((y + 0.5) * sh) / dh - 0.5;
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(gy)));
      const y1 = Math.min(sh - 1, y0 + 1);
      const ty = Math.min(1, Math.max(0, gy - y0));
      for (let x = 0; x < dw; x++) {
        const gx = ((x + 0.5) * sw) / dw - 0.5;
        const x0 = Math.max(0, Math.min(sw - 1, Math.floor(gx)));
        const x1 = Math.min(sw - 1, x0 + 1);
        const tx = Math.min(1, Math.max(0, gx - x0));
        const j = (y * dw + x) * 4;
        for (let c = 0; c < 3; c++) {
          const a = px((y0 * sw + x0) * 4, c) * (1 - tx) + px((y0 * sw + x1) * 4, c) * tx;
          const b = px((y1 * sw + x0) * 4, c) * (1 - tx) + px((y1 * sw + x1) * 4, c) * tx;
          o[j + c] = a * (1 - ty) + b * ty;
        }
      }
    }
  }
  return out;
}

export function isGreyscale(img: RasterImage): boolean {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) if (d[i] !== d[i + 1] || d[i] !== d[i + 2]) return false;
  return true;
}
