/**
 * Vector output for pen plotters: trace a 1-bit mask (or one mask per ink) into closed polylines with marching squares,
 * simplify them (Ramer-Douglas-Peucker), optionally fill with hatching, order the paths to shorten pen travel and write an SVG
 * in millimetres with one layer per ink. Pure and dependency-free.
 */
import { assignInks, hexOf, paletteOf, type Ink, type Palette, type Rgb } from './separations';
import { PAPER_MM, type PaperId } from './format';
import type { RasterImage } from './raster';

export type Pt = [number, number];
export interface Polyline {
  points: Pt[];
  closed: boolean;
}

/**
 * Outlines of the set pixels of `mask` (w x h, non-zero = inside), as closed polylines in pixel coordinates (x right, y
 * down; pixel (i, j) covers [i, i+1) x [j, j+1)). Holes come out as their own loops.
 */
export function traceMask(mask: ArrayLike<number>, w: number, h: number): Polyline[] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x] ? 1 : 0);
  // segments between edge midpoints, with integer keys (coordinates doubled)
  const segs: number[][] = []; // [x0, y0, x1, y1] in doubled coordinates
  const top = (x: number, y: number): Pt => [2 * x + 1, 2 * y];
  const right = (x: number, y: number): Pt => [2 * x + 2, 2 * y + 1];
  const bottom = (x: number, y: number): Pt => [2 * x + 1, 2 * y + 2];
  const left = (x: number, y: number): Pt => [2 * x, 2 * y + 1];
  const add = (a: Pt, b: Pt) => segs.push([a[0], a[1], b[0], b[1]]);
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = at(x, y);
      const tr = at(x + 1, y);
      const br = at(x + 1, y + 1);
      const bl = at(x, y + 1);
      const c = (tl << 3) | (tr << 2) | (br << 1) | bl;
      switch (c) {
        case 1: case 14: add(left(x, y), bottom(x, y)); break;
        case 2: case 13: add(bottom(x, y), right(x, y)); break;
        case 3: case 12: add(left(x, y), right(x, y)); break;
        case 4: case 11: add(top(x, y), right(x, y)); break;
        case 5: add(top(x, y), right(x, y)); add(left(x, y), bottom(x, y)); break;
        case 6: case 9: add(top(x, y), bottom(x, y)); break;
        case 7: case 8: add(top(x, y), left(x, y)); break;
        case 10: add(top(x, y), left(x, y)); add(right(x, y), bottom(x, y)); break;
        default: break;
      }
    }
  }
  const keyOf = (x: number, y: number) => x * 65536 + y;
  const byPoint = new Map<number, number[]>();
  segs.forEach((s, i) => {
    for (const k of [keyOf(s[0], s[1]), keyOf(s[2], s[3])]) {
      const l = byPoint.get(k);
      if (l) l.push(i);
      else byPoint.set(k, [i]);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops: Polyline[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts: Pt[] = [[segs[i][0] / 2 + 0.5, segs[i][1] / 2 + 0.5]];
    let cx = segs[i][2];
    let cy = segs[i][3];
    const sx = segs[i][0];
    const sy = segs[i][1];
    for (;;) {
      pts.push([cx / 2 + 0.5, cy / 2 + 0.5]);
      if (cx === sx && cy === sy) break;
      const cand = byPoint.get(keyOf(cx, cy))?.find((j) => !used[j]);
      if (cand === undefined) break;
      used[cand] = 1;
      const s = segs[cand];
      if (s[0] === cx && s[1] === cy) {
        cx = s[2];
        cy = s[3];
      } else {
        cx = s[0];
        cy = s[1];
      }
    }
    pts.pop(); // the closing point repeats the first
    if (pts.length >= 3) loops.push({ points: pts, closed: true });
  }
  return loops;
}

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function rdp(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let wi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = perpDist(pts[i], pts[a], pts[b]);
      if (d > worst) {
        worst = d;
        wi = i;
      }
    }
    if (worst > tol && wi > 0) {
      keep[wi] = 1;
      stack.push([a, wi], [wi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Ramer-Douglas-Peucker simplification (a closed loop is split at its two farthest apart points). */
export function simplifyPolyline(line: Polyline, tol: number): Polyline {
  const pts = line.points;
  if (pts.length < 4 || tol <= 0) return line;
  if (!line.closed) return { points: rdp(pts, tol), closed: false };
  let far = 0;
  let fd = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const a = rdp(pts.slice(0, far + 1), tol);
  const b = rdp([...pts.slice(far), pts[0]], tol);
  const merged = [...a.slice(0, -1), ...b.slice(0, -1)];
  return merged.length >= 3 ? { points: merged, closed: true } : line;
}

/** Hatch lines (open two-point polylines in pixel coordinates) filling the set pixels, at an angle and spacing in pixels. */
export function hatchMask(mask: ArrayLike<number>, w: number, h: number, spacingPx: number, angleDeg = 45): Polyline[] {
  const out: Polyline[] = [];
  const th = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(th);
  const dy = Math.sin(th);
  const nx = -dy;
  const ny = dx;
  const diag = Math.hypot(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const inside = (x: number, y: number) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    return ix >= 0 && iy >= 0 && ix < w && iy < h && mask[iy * w + ix] !== 0;
  };
  const step = 0.5;
  for (let off = -diag / 2; off <= diag / 2; off += spacingPx) {
    let runStart: Pt | null = null;
    let last: Pt | null = null;
    for (let t = -diag / 2; t <= diag / 2; t += step) {
      const x = cx + nx * off + dx * t;
      const y = cy + ny * off + dy * t;
      if (inside(x, y)) {
        if (!runStart) runStart = [x, y];
        last = [x, y];
      } else if (runStart && last) {
        if (Math.hypot(last[0] - runStart[0], last[1] - runStart[1]) >= spacingPx * 0.4) out.push({ points: [runStart, last], closed: false });
        runStart = null;
        last = null;
      }
    }
    if (runStart && last && Math.hypot(last[0] - runStart[0], last[1] - runStart[1]) >= spacingPx * 0.4) out.push({ points: [runStart, last], closed: false });
  }
  return out;
}

/** Greedy nearest-neighbour ordering (open paths may be reversed) to shorten pen-up travel. Skipped above `cap` paths. */
export function orderPaths(paths: Polyline[], cap = 5000): Polyline[] {
  if (paths.length < 3 || paths.length > cap) return paths;
  const rest = paths.slice();
  const out: Polyline[] = [rest.shift()!];
  let cur: Pt = out[0].closed ? out[0].points[0] : out[0].points[out[0].points.length - 1];
  while (rest.length) {
    let bi = 0;
    let bd = Infinity;
    let rev = false;
    for (let i = 0; i < rest.length; i++) {
      const p = rest[i].points;
      const d0 = (p[0][0] - cur[0]) ** 2 + (p[0][1] - cur[1]) ** 2;
      if (d0 < bd) {
        bd = d0;
        bi = i;
        rev = false;
      }
      if (!rest[i].closed) {
        const e = p[p.length - 1];
        const d1 = (e[0] - cur[0]) ** 2 + (e[1] - cur[1]) ** 2;
        if (d1 < bd) {
          bd = d1;
          bi = i;
          rev = true;
        }
      }
    }
    const [next] = rest.splice(bi, 1);
    const n = rev ? { points: next.points.slice().reverse(), closed: false } : next;
    out.push(n);
    cur = n.closed ? n.points[0] : n.points[n.points.length - 1];
  }
  return out;
}

export interface PlotOptions {
  /** Number of pen colours (1 = single pen, dark pixels; 2..12 = ink palette by k-means / exact colours). Default 1. */
  inks?: number;
  paper?: PaperId;
  orientation?: 'portrait' | 'landscape';
  /** Page margin in mm (default 10). Set `widthMm` / `heightMm` for a custom plot area instead of a paper size. */
  marginMm?: number;
  widthMm?: number;
  heightMm?: number;
  /** Fill shapes with parallel hatch lines. */
  hatch?: boolean;
  hatchSpacingMm?: number;
  hatchAngleDeg?: number;
  /** Path simplification tolerance in mm (default 0.15). */
  simplifyMm?: number;
  /** Stroke width written to the SVG in mm (default 0.4). */
  strokeMm?: number;
  /** Single-pen mode: luminance (0..255) below which a pixel is ink (default 128). */
  threshold?: number;
  /** Ignore loops enclosing less than this area in mm2 (specks; default 0.5). */
  minAreaMm2?: number;
  /** Palette to use instead of deriving one (e.g. shared across animation frames). */
  palette?: Palette;
}

export interface PlotLayer {
  name: string;
  color: string;
  paths: Polyline[];
}

export interface Plot {
  widthMm: number;
  heightMm: number;
  layers: PlotLayer[];
  /** Total pen-down length in mm and number of paths, for the UI / logs. */
  lengthMm: number;
  pathCount: number;
}

const loopArea = (pts: Pt[]): number => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
};

/** Trace a picture into plotter paths in millimetres, one layer per ink. */
export function planPlot(frame: RasterImage, o: PlotOptions = {}): Plot {
  const [pw, ph] = PAPER_MM[o.paper ?? 'a4'];
  const W = o.widthMm ?? (o.orientation === 'landscape' ? ph : pw);
  const H = o.heightMm ?? (o.orientation === 'landscape' ? pw : ph);
  const margin = Math.max(0, o.marginMm ?? 10);
  const k = Math.min((W - 2 * margin) / frame.width, (H - 2 * margin) / frame.height);
  if (!(k > 0)) throw new Error('The plot area is too small for this margin.');
  const ox = (W - frame.width * k) / 2;
  const oy = (H - frame.height * k) / 2;
  const tolPx = Math.max(0.2, (o.simplifyMm ?? 0.15) / k);
  const minArea = (o.minAreaMm2 ?? 0.5) / (k * k);
  const spacingPx = Math.max(1, (o.hatchSpacingMm ?? 1) / k);
  const n = frame.width * frame.height;
  let masks: { ink: Ink; mask: Uint8Array }[];
  if ((o.inks ?? 1) <= 1) {
    const m = new Uint8Array(n);
    const thr = o.threshold ?? 128;
    for (let i = 0; i < n; i++) {
      const a = frame.data[i * 4 + 3] / 255;
      const l = (0.299 * frame.data[i * 4] + 0.587 * frame.data[i * 4 + 1] + 0.114 * frame.data[i * 4 + 2]) * a + 255 * (1 - a);
      m[i] = l < thr ? 1 : 0;
    }
    masks = [{ ink: { rgb: [0, 0, 0], hex: '#000000', name: 'Black' }, mask: m }];
  } else {
    const pal = o.palette ?? paletteOf([frame], o.inks ?? 2);
    const idx = assignInks(frame, pal);
    masks = pal.inks.map((ink, i) => {
      const m = new Uint8Array(n);
      for (let j = 0; j < n; j++) if (idx[j] === i) m[j] = 1;
      return { ink, mask: m };
    });
  }
  const toMm = (p: Pt): Pt => [Math.round((p[0] * k + ox) * 1000) / 1000, Math.round((p[1] * k + oy) * 1000) / 1000];
  const layers: PlotLayer[] = [];
  let length = 0;
  let count = 0;
  masks.forEach(({ ink, mask }, li) => {
    let paths: Polyline[] = traceMask(mask, frame.width, frame.height)
      .filter((l) => loopArea(l.points) >= minArea)
      .map((l) => simplifyPolyline(l, tolPx));
    if (o.hatch) paths = paths.concat(hatchMask(mask, frame.width, frame.height, spacingPx, (o.hatchAngleDeg ?? 45) + li * 30));
    paths = orderPaths(paths).map((l) => ({ closed: l.closed, points: l.points.map(toMm) }));
    for (const p of paths) {
      count++;
      for (let i = 1; i < p.points.length; i++) length += Math.hypot(p.points[i][0] - p.points[i - 1][0], p.points[i][1] - p.points[i - 1][1]);
      if (p.closed && p.points.length) length += Math.hypot(p.points[0][0] - p.points[p.points.length - 1][0], p.points[0][1] - p.points[p.points.length - 1][1]);
    }
    layers.push({ name: `Ink ${li + 1} ${ink.name} ${ink.hex}`, color: ink.hex, paths });
  });
  return { widthMm: W, heightMm: H, layers, lengthMm: length, pathCount: count };
}

const fmt = (v: number): string => String(Math.round(v * 1000) / 1000);

/** SVG in millimetres; every ink is an Inkscape / AxiDraw "layer" group. */
export function plotToSvg(plot: Plot, strokeMm = 0.4): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${fmt(plot.widthMm)}mm" height="${fmt(plot.heightMm)}mm" viewBox="0 0 ${fmt(plot.widthMm)} ${fmt(plot.heightMm)}">`);
  plot.layers.forEach((layer, i) => {
    out.push(`<g id="layer${i + 1}" inkscape:groupmode="layer" inkscape:label="${layer.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}" fill="none" stroke="${layer.color}" stroke-width="${fmt(strokeMm)}" stroke-linecap="round" stroke-linejoin="round">`);
    for (const p of layer.paths) {
      if (p.points.length < 2) continue;
      out.push(`<path d="M${p.points.map((q) => `${fmt(q[0])} ${fmt(q[1])}`).join(' L')}${p.closed ? ' Z' : ''}"/>`);
    }
    out.push('</g>');
  });
  out.push('</svg>');
  return out.join('\n') + '\n';
}

