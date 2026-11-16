/**
 * Colour separations for riso / screen printing: pick a set of inks (the exact palette of a quantized or dithered picture, or
 * k-means for anything else), assign every pixel to one ink or to the paper, and render one greyscale plate per ink
 * (black = ink) on a page with registration marks and the ink name printed outside the frame. Pure.
 */
import { FONT_HEIGHT, textWidthPx } from './font';
import { PAPER_MM, type PaperId } from './format';
import type { ImposedPage } from './imposition';
import { mmToPx } from './layout';
import { createRaster, resizeRaster, type RasterImage } from './raster';
import { drawText, fillRectAA } from './render';

export type Rgb = [number, number, number];

export interface Ink {
  rgb: Rgb;
  hex: string;
  name: string;
}

export interface Palette {
  inks: Ink[];
  /** The colour treated as unprinted paper (usually white), or null when none of the clusters is paper-like. */
  paper: Rgb | null;
  /** True when the colours were exact (the picture already had few enough colours), false when k-means chose them. */
  exact: boolean;
}

/** Approximate stock colours of common risograph drums, used only to name inks. */
const RISO: { name: string; rgb: Rgb }[] = [
  { name: 'Black', rgb: [0, 0, 0] },
  { name: 'Burgundy', rgb: [145, 78, 114] },
  { name: 'Blue', rgb: [0, 120, 191] },
  { name: 'Green', rgb: [0, 169, 92] },
  { name: 'Medium Blue', rgb: [50, 85, 164] },
  { name: 'Bright Red', rgb: [241, 80, 96] },
  { name: 'Risofederal Blue', rgb: [61, 85, 135] },
  { name: 'Purple', rgb: [118, 91, 167] },
  { name: 'Teal', rgb: [0, 131, 138] },
  { name: 'Flat Gold', rgb: [187, 139, 65] },
  { name: 'Hunter Green', rgb: [64, 112, 76] },
  { name: 'Red', rgb: [255, 102, 94] },
  { name: 'Orange', rgb: [255, 108, 47] },
  { name: 'Yellow', rgb: [255, 232, 0] },
  { name: 'Fluorescent Pink', rgb: [255, 72, 176] },
  { name: 'Sky Blue', rgb: [73, 130, 207] },
  { name: 'Mint', rgb: [130, 216, 213] },
  { name: 'Grey', rgb: [136, 137, 138] },
  { name: 'Brown', rgb: [146, 95, 82] },
  { name: 'Lilac', rgb: [185, 164, 213] },
];

export const hexOf = (c: Rgb): string => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const d2 = (a: ArrayLike<number>, b: ArrayLike<number>) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const luma = (c: ArrayLike<number>) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

export function inkName(rgb: Rgb): string {
  let best = RISO[0];
  let bd = Infinity;
  for (const r of RISO) {
    const d = d2(rgb, r.rgb);
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  return best.name;
}

/** 5 bits per channel histogram of all frames (alpha composited over white). */
function histogram(images: readonly RasterImage[], budget = 200000): Map<number, { w: number; r: number; g: number; b: number }> {
  const hist = new Map<number, { w: number; r: number; g: number; b: number }>();
  for (const img of images) {
    const n = img.width * img.height;
    const stride = Math.max(1, Math.floor((n * images.length) / budget));
    for (let i = 0; i < n; i += stride) {
      const a = img.data[i * 4 + 3] / 255;
      const r = img.data[i * 4] * a + 255 * (1 - a);
      const g = img.data[i * 4 + 1] * a + 255 * (1 - a);
      const b = img.data[i * 4 + 2] * a + 255 * (1 - a);
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const e = hist.get(key);
      if (e) {
        e.w++;
        e.r += r;
        e.g += g;
        e.b += b;
      } else hist.set(key, { w: 1, r, g, b });
    }
  }
  return hist;
}


function kmeans(points: { c: Rgb; w: number }[], k: number): Rgb[] {
  // deterministic farthest-first seeding starting from the heaviest colour
  const centres: Rgb[] = [];
  let first = points[0];
  for (const p of points) if (p.w > first.w) first = p;
  centres.push([...first.c] as Rgb);
  while (centres.length < k) {
    let far = points[0];
    let fd = -1;
    for (const p of points) {
      let m = Infinity;
      for (const c of centres) m = Math.min(m, d2(p.c, c));
      const score = m * Math.sqrt(p.w);
      if (score > fd) {
        fd = score;
        far = p;
      }
    }
    centres.push([...far.c] as Rgb);
  }
  for (let it = 0; it < 14; it++) {
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (const p of points) {
      let bi = 0;
      let bd = Infinity;
      for (let i = 0; i < centres.length; i++) {
        const d = d2(p.c, centres[i]);
        if (d < bd) {
          bd = d;
          bi = i;
        }
      }
      sum[bi][0] += p.c[0] * p.w;
      sum[bi][1] += p.c[1] * p.w;
      sum[bi][2] += p.c[2] * p.w;
      sum[bi][3] += p.w;
    }
    let moved = 0;
    sum.forEach((s, i) => {
      if (s[3] === 0) return;
      const n: Rgb = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
      moved += d2(n, centres[i]);
      centres[i] = n;
    });
    if (moved < 0.5) break;
  }
  return centres;
}

/**
 * The ink palette of some frames. When the pictures have at most `inks` (+ paper) distinct colours (quantized, dithered,
 * posterized art) those exact colours are the inks; otherwise k-means picks `inks` colours. A near-white cluster is paper and
 * gets no plate.
 */
export function paletteOf(images: readonly RasterImage[], inks: number): Palette {
  const want = Math.max(1, Math.min(12, Math.round(inks)));
  const hist = histogram(images);
  const points = [...hist.values()].map((e) => ({ c: [e.r / e.w, e.g / e.w, e.b / e.w] as Rgb, w: e.w }));
  // exact colours: use real (unquantized) values when few enough
  const distinct = points.length;
  let colours: Rgb[];
  let exact = false;
  if (distinct <= want + 1) {
    colours = points.sort((a, b) => b.w - a.w).map((p) => p.c);
    exact = true;
  } else {
    colours = kmeans(points, Math.min(want + 1, distinct));
  }
  // paper: the lightest colour when it is nearly white
  colours.sort((a, b) => luma(b) - luma(a));
  let paper: Rgb | null = null;
  if (luma(colours[0]) >= 225) paper = colours.shift()!;
  else if (!exact) colours = kmeans(points, Math.min(want, distinct)).sort((a, b) => luma(b) - luma(a));
  colours = colours.slice(0, want);
  // darkest first, so plate 1 is the key colour
  colours.sort((a, b) => luma(a) - luma(b));
  return { inks: colours.map((rgb) => ({ rgb, hex: hexOf(rgb), name: inkName(rgb) })), paper, exact };
}

/** Index of the ink each pixel belongs to (palette.inks.length = paper / unprinted). */
export function assignInks(img: RasterImage, pal: Palette): Uint8Array {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  const all: Rgb[] = pal.inks.map((i) => i.rgb);
  const paperIdx = all.length;
  if (pal.paper) all.push(pal.paper);
  const cache = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3] / 255;
    const r = img.data[i * 4] * a + 255 * (1 - a);
    const g = img.data[i * 4 + 1] * a + 255 * (1 - a);
    const b = img.data[i * 4 + 2] * a + 255 * (1 - a);
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let v = cache.get(key);
    if (v === undefined) {
      let bi = 0;
      let bd = Infinity;
      for (let k = 0; k < all.length; k++) {
        const d = d2([r, g, b], all[k]);
        if (d < bd) {
          bd = d;
          bi = k;
        }
      }
      v = bi === paperIdx && pal.paper ? paperIdx : bi;
      cache.set(key, v);
    }
    out[i] = v;
  }
  return out;
}

export interface PlateOptions {
  inks?: number;
  paper?: PaperId;
  orientation?: 'portrait' | 'landscape';
  dpi?: number;
  marginMm?: number;
  title?: string;
}

export interface Plates {
  palette: Palette;
  /** One list of pages (a page per frame) for every ink, in palette order. */
  plates: { ink: Ink; pages: ImposedPage[] }[];
}

function regMark(img: RasterImage, dpi: number, cx: number, cy: number): void {
  const a = mmToPx(4, dpi);
  const t = Math.max(0.5, mmToPx(0.2, dpi) / 2);
  const x = mmToPx(cx, dpi);
  const y = mmToPx(cy, dpi);
  fillRectAA(img, x - a, y - t, x + a, y + t);
  fillRectAA(img, x - t, y - a, x + t, y + a);
  const r = mmToPx(2.2, dpi);
  for (let i = 0; i < 48; i++) {
    const ang = (i / 48) * Math.PI * 2;
    fillRectAA(img, x + Math.cos(ang) * r - t, y + Math.sin(ang) * r - t, x + Math.cos(ang) * r + t, y + Math.sin(ang) * r + t);
  }
}

/** Plates for frames: one greyscale page per ink and frame (black = ink), with registration marks and the ink name outside the frame. */
export function renderPlates(frames: readonly RasterImage[], o: PlateOptions = {}): Plates {
  if (frames.length === 0) throw new Error('No frames to separate.');
  const dpi = Math.max(72, Math.min(600, Math.round(o.dpi ?? 300)));
  const [pw, ph] = PAPER_MM[o.paper ?? 'a4'];
  const W = o.orientation === 'landscape' ? ph : pw;
  const H = o.orientation === 'landscape' ? pw : ph;
  const margin = Math.max(20, o.marginMm ?? 24);
  // palette from up to six evenly spaced frames, at a reduced size
  const sampleIdx = new Set<number>();
  for (let i = 0; i < Math.min(6, frames.length); i++) sampleIdx.add(Math.round((i * (frames.length - 1)) / Math.max(1, Math.min(6, frames.length) - 1)));
  const palette = paletteOf([...sampleIdx].map((i) => frames[i]), o.inks ?? 3);
  const f0 = frames[0];
  const k = Math.min((W - 2 * margin) / f0.width, (H - 2 * margin) / f0.height);
  const fwPx = Math.max(1, Math.round(mmToPx(f0.width * k, dpi)));
  const fhPx = Math.max(1, Math.round(mmToPx(f0.height * k, dpi)));
  const fx = Math.round(mmToPx(W / 2, dpi) - fwPx / 2);
  const fy = Math.round(mmToPx(H / 2, dpi) - fhPx / 2);
  const px = Math.max(1, Math.round(mmToPx(2.2, dpi) / FONT_HEIGHT));
  const plates = palette.inks.map((ink) => ({ ink, pages: [] as ImposedPage[] }));
  for (let f = 0; f < frames.length; f++) {
    // assignment at the printed size, so plate edges are as sharp as the page allows
    const big = frames[f].width < fwPx && frames[f].height < fhPx ? resizeRaster(frames[f], fwPx, fhPx, 'nearest') : resizeRaster(frames[f], fwPx, fhPx, 'auto');
    const idx = assignInks(big, palette);
    palette.inks.forEach((ink, n) => {
      const img = createRaster(Math.round(mmToPx(W, dpi)), Math.round(mmToPx(H, dpi)));
      for (let y = 0; y < fhPx; y++) {
        const row = (fy + y) * img.width + fx;
        for (let x = 0; x < fwPx; x++) {
          if (idx[y * fwPx + x] === n) {
            const j = (row + x) * 4;
            img.data[j] = img.data[j + 1] = img.data[j + 2] = 0;
          }
        }
      }
      // registration marks outside the frame, the same place on every plate
      const off = 9;
      for (const [cx, cy] of [[W / 2, margin - off], [W / 2, H - margin + off], [margin - off, H / 2], [W - margin + off, H / 2], [margin - off, margin - off], [W - margin + off, margin - off], [margin - off, H - margin + off], [W - margin + off, H - margin + off]]) regMark(img, dpi, cx, cy);
      const label = `INK ${n + 1}/${palette.inks.length}  ${ink.name.toUpperCase()}  ${ink.hex}   ${o.title ? o.title.toUpperCase().replace(/[^A-Z0-9 ._()#%+/:=-]/g, '').slice(0, 20) + '   ' : ''}FRAME ${f + 1}/${frames.length}`;
      const lw = textWidthPx(label) * px;
      drawText(img, label, (img.width - lw) / 2, mmToPx(H - margin + 15, dpi), px);
      plates[n].pages.push({ bitmap: img, widthMm: W, heightMm: H, label: `ink ${n + 1} frame ${f + 1}` });
    });
  }
  return { palette, plates };
}
