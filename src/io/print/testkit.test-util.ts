/** Test helpers: synthetic frames and a simulated phone photo of a rendered sheet. Tests only (uses sharp). */
import sharp from 'sharp';
import { fitHomography, invert3, type Mat3, type Pt } from './geometry';
import { createRaster, type RasterImage } from './raster';

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
}

/** Frames with colourful, high-contrast blocks that move with the frame index. */
export function makeFrames(count: number, w = 96, h = 72, seed = 7): RasterImage[] {
  const r = rng(seed);
  const blocks = Array.from({ length: 9 }, () => ({
    x: r() * w,
    y: r() * h,
    bw: 8 + r() * 18,
    bh: 8 + r() * 18,
    c: [60 + r() * 195, 60 + r() * 195, 60 + r() * 195],
    vx: (r() - 0.5) * 6,
    vy: (r() - 0.5) * 6,
  }));
  const frames: RasterImage[] = [];
  for (let f = 0; f < count; f++) {
    const img = createRaster(w, h);
    const d = img.data;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        d[i] = 230 - (x / w) * 40;
        d[i + 1] = 235 - (y / h) * 50;
        d[i + 2] = 220 + ((f * 7) % 30);
      }
    for (const b of blocks) {
      const bx = Math.round(b.x + b.vx * f);
      const by = Math.round(b.y + b.vy * f);
      for (let y = by; y < by + b.bh; y++)
        for (let x = bx; x < bx + b.bw; x++) {
          const xx = ((x % w) + w) % w;
          const yy = ((y % h) + h) % h;
          const i = (yy * w + xx) * 4;
          d[i] = b.c[0];
          d[i + 1] = b.c[1];
          d[i + 2] = b.c[2];
        }
    }
    // a dark outline box so frame edges are visible
    for (let x = 0; x < w; x++) for (const y of [0, h - 1]) d.set([20, 20, 30, 255], (y * w + x) * 4);
    for (let y = 0; y < h; y++) for (const x of [0, w - 1]) d.set([20, 20, 30, 255], (y * w + x) * 4);
    frames.push(img);
  }
  return frames;
}

export interface PhotoOptions {
  width?: number;
  height?: number;
  /** Extra rotation in degrees (on top of perspective). */
  rotateDeg?: number;
  /** Perspective strength as a fraction of the page size (corner jitter). */
  perspective?: number;
  /** Fraction of the photo the page may fill. */
  fill?: number;
  /** Lighting: brightness at the dark and bright side (multiplier). */
  light?: [number, number];
  noise?: number;
  blur?: number;
  jpegQuality?: number;
  seed?: number;
  /** Dark cluttered desk with decoy nested squares and dark rectangles instead of a flat background. */
  clutter?: boolean;
  /** A hard shadow edge across the background (and a soft one over a corner of the sheet). */
  shadow?: boolean;
  /** Downscale to this size before the JPEG round trip (phone messenger style). */
  outWidth?: number;
  outHeight?: number;
  /** Optional mutation of the page before photographing (user drawings). */
  mutate?: (page: RasterImage) => void;
}

export interface Photo {
  image: RasterImage;
  /** Page pixel -> photo pixel. */
  H: Mat3;
}

/** Simulate a hand-held phone photo of a page bitmap. */
export async function photograph(page: RasterImage, o: PhotoOptions = {}): Promise<Photo> {
  const W = o.width ?? 3000;
  const Hh = o.height ?? 4000;
  const r = rng(o.seed ?? 3);
  const src = o.mutate ? { ...page, data: new Uint8ClampedArray(page.data) } : page;
  o.mutate?.(src);
  const th = ((o.rotateDeg ?? 0) * Math.PI) / 180 + (r() - 0.5) * 0.12;
  const pw = page.width;
  const ph = page.height;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const persp = o.perspective ?? 0.03;
  // Rotate the page rectangle about its centre, jitter the corners (perspective), then scale to fit.
  const base: Pt[] = [
    { x: 0, y: 0 },
    { x: pw, y: 0 },
    { x: pw, y: ph },
    { x: 0, y: ph },
  ];
  const rot = base.map((p) => {
    const x = p.x - pw / 2 + (r() - 0.5) * 2 * persp * pw;
    const y = p.y - ph / 2 + (r() - 0.5) * 2 * persp * ph;
    return { x: x * c - y * s, y: x * s + y * c };
  });
  const minX = Math.min(...rot.map((p) => p.x));
  const maxX = Math.max(...rot.map((p) => p.x));
  const minY = Math.min(...rot.map((p) => p.y));
  const maxY = Math.max(...rot.map((p) => p.y));
  const k = Math.min((W * (o.fill ?? 0.92)) / (maxX - minX), (Hh * (o.fill ?? 0.92)) / (maxY - minY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const target = rot.map((p) => ({ x: W / 2 + (p.x - cx) * k + (r() - 0.5) * 20, y: Hh / 2 + (p.y - cy) * k + (r() - 0.5) * 20 }));
  const H = fitHomography(base, target)!;
  const Hi = invert3(H)!;
  const [lo, hi] = o.light ?? [0.7, 1.0];
  const out = new Uint8ClampedArray(W * Hh * 4);
  const bg = new Uint8ClampedArray(W * Hh * 4);
  for (let i = 0; i < W * Hh; i++) bg.set([70, 62, 55, 255], i * 4);
  if (o.clutter) {
    const rr = rng(77);
    const rect = (x0: number, y0: number, x1: number, y1: number, c: number[]) => {
      for (let y = Math.max(0, Math.round(y0)); y < Math.min(Hh, Math.round(y1)); y++) for (let x = Math.max(0, Math.round(x0)); x < Math.min(W, Math.round(x1)); x++) bg.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
    };
    for (let i = 0; i < 60; i++) {
      const c = [30 + rr() * 90, 25 + rr() * 80, 20 + rr() * 70];
      rect(rr() * W, rr() * Hh, rr() * W, rr() * Hh, c);
    }
    for (let i = 0; i < 14; i++) {
      const m = 12 + rr() * 22; // module in px: 1:1:3:1:1 rings like the corner markers
      const cx = rr() * W;
      const cy = rr() * Hh;
      rect(cx - 3.5 * m, cy - 3.5 * m, cx + 3.5 * m, cy + 3.5 * m, [25, 22, 20]);
      rect(cx - 2.5 * m, cy - 2.5 * m, cx + 2.5 * m, cy + 2.5 * m, [190, 180, 160]);
      rect(cx - 1.5 * m, cy - 1.5 * m, cx + 1.5 * m, cy + 1.5 * m, [25, 22, 20]);
    }
  }
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const wgt = Hi[6] * (x + 0.5) + Hi[7] * (y + 0.5) + Hi[8];
      const px = (Hi[0] * (x + 0.5) + Hi[1] * (y + 0.5) + Hi[2]) / wgt - 0.5;
      const py = (Hi[3] * (x + 0.5) + Hi[4] * (y + 0.5) + Hi[5]) / wgt - 0.5;
      const i = (y * W + x) * 4;
      let rr = bg[i];
      let gg = bg[i + 1];
      let bb = bg[i + 2];
      if (px >= -0.5 && py >= -0.5 && px <= pw - 0.5 && py <= ph - 0.5) {
        const x0 = Math.max(0, Math.min(pw - 2, Math.floor(px)));
        const y0 = Math.max(0, Math.min(ph - 2, Math.floor(py)));
        const tx = Math.min(1, Math.max(0, px - x0));
        const ty = Math.min(1, Math.max(0, py - y0));
        const i00 = (y0 * pw + x0) * 4;
        const a = (1 - tx) * (1 - ty);
        const b = tx * (1 - ty);
        const cc = (1 - tx) * ty;
        const d = tx * ty;
        const D = src.data;
        rr = D[i00] * a + D[i00 + 4] * b + D[i00 + pw * 4] * cc + D[i00 + pw * 4 + 4] * d;
        gg = D[i00 + 1] * a + D[i00 + 5] * b + D[i00 + pw * 4 + 1] * cc + D[i00 + pw * 4 + 5] * d;
        bb = D[i00 + 2] * a + D[i00 + 6] * b + D[i00 + pw * 4 + 2] * cc + D[i00 + pw * 4 + 6] * d;
      }
      out[i] = rr;
      out[i + 1] = gg;
      out[i + 2] = bb;
      out[i + 3] = 255;
    }
  }
  // blur through sharp, then lighting + noise, then a JPEG round trip
  let buf = Buffer.from(out.buffer);
  if ((o.blur ?? 1.0) > 0.3) {
    buf = await sharp(buf, { raw: { width: W, height: Hh, channels: 4 } }).blur(o.blur ?? 1.0).raw().toBuffer();
  }
  const px = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length);
  const nz = o.noise ?? 4;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const t = (x / W) * 0.75 + (y / Hh) * 0.25;
      let m = lo + (hi - lo) * t;
      if (o.shadow) {
        // hard shadow edge: a line crossing the picture; dark side 0.45 on the background, soft 0.8 over the sheet
        const d = (x - W * 0.35) * 0.9 + (y - Hh * 0.1) * 0.35;
        if (d < 0) m *= 0.45;
        else if (x > W * 0.78 && y < Hh * 0.2) m *= 0.8;
      }
      const i = (y * W + x) * 4;
      px[i] = px[i] * m + gauss(r) * nz;
      px[i + 1] = px[i + 1] * m + gauss(r) * nz;
      px[i + 2] = px[i + 2] * m + gauss(r) * nz;
    }
  }
  let pipeline = sharp(Buffer.from(px.buffer, px.byteOffset, px.length), { raw: { width: W, height: Hh, channels: 4 } });
  if (o.outWidth && o.outHeight) pipeline = pipeline.resize(o.outWidth, o.outHeight, { fit: 'fill' });
  const jpg = await pipeline
    .jpeg({ quality: o.jpegQuality ?? 82 })
    .toBuffer();
  const raw = await sharp(jpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { image: { width: raw.info.width, height: raw.info.height, data: new Uint8ClampedArray(raw.data.buffer, raw.data.byteOffset, raw.data.length) }, H };
}

/** Mean absolute RGB error between two same-size images, ignoring a border. */
export function meanAbsError(a: RasterImage, b: RasterImage, border = 4): number {
  let s = 0;
  let n = 0;
  for (let y = border; y < a.height - border; y++)
    for (let x = border; x < a.width - border; x++) {
      const i = (y * a.width + x) * 4;
      s += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
      n += 3;
    }
  return s / n;
}

function shiftedError(rec: RasterImage, ref: RasterImage, dx: number, dy: number, border: number): number {
  const w = rec.width;
  const h = rec.height;
  let s = 0;
  let n = 0;
  for (let y = border; y < h - border; y++)
    for (let x = border; x < w - border; x++) {
      // sample rec at (x + dx, y + dy) bilinearly (pixel-centre coordinates)
      const fx = x + dx;
      const fy = y + dy;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      let e = 0;
      for (let c = 1; c < 3; c++) {
        const g = (xx: number, yy: number) => rec.data[(yy * w + xx) * 4 + c];
        const v = g(x0, y0) * (1 - tx) * (1 - ty) + g(x0 + 1, y0) * tx * (1 - ty) + g(x0, y0 + 1) * (1 - tx) * ty + g(x0 + 1, y0 + 1) * tx * ty;
        e += (v - ref.data[(y * w + x) * 4 + c]) ** 2;
      }
      s += e;
      n += 2;
    }
  return s / n;
}

/** Sub-pixel translation of `rec` relative to `ref` (the shift that best aligns them). */
export function estimateShift(rec: RasterImage, ref: RasterImage, border = 6): { dx: number; dy: number } {
  let best = { dx: 0, dy: 0, e: Infinity };
  for (let dy = -3; dy <= 3; dy += 0.5)
    for (let dx = -3; dx <= 3; dx += 0.5) {
      const e = shiftedError(rec, ref, dx, dy, border);
      if (e < best.e) best = { dx, dy, e };
    }
  for (const step of [0.25, 0.1]) {
    const c = { ...best };
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const e = shiftedError(rec, ref, c.dx + dx * step, c.dy + dy * step, border);
        if (e < best.e) best = { dx: c.dx + dx * step, dy: c.dy + dy * step, e };
      }
  }
  return { dx: best.dx, dy: best.dy };
}
