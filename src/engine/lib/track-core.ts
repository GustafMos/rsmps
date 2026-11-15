/**
 * Pure CPU helpers for the Detect & Track nodes: connected-component labelling, box merging and the
 * shared "what to keep" parameters every detector has. No GPU here, so it is trivially testable.
 */
import type { ParamSchema, Region } from '../types';

export type Box = [number, number, number, number];

export const SORT_OPTIONS = [
  { value: 'score', label: 'Best match first' },
  { value: 'size', label: 'Largest first' },
  { value: 'left', label: 'Left to right' },
  { value: 'top', label: 'Top to bottom' },
] as const;

/** Parameters shared by every detector (spread into the node's `params`). */
export const DETECT_PARAMS = {
  minSize: {
    type: 'number',
    default: 0.05,
    min: 0,
    max: 100,
    step: 0.01,
    unit: '%',
    label: 'Smallest region',
    hint: 'Ignore regions whose box covers less than this percentage of the frame.',
    group: 'What to keep',
  },
  maxSize: {
    type: 'number',
    default: 60,
    min: 0,
    max: 100,
    step: 0.5,
    unit: '%',
    label: 'Largest region',
    hint: 'Ignore regions whose box covers more than this percentage of the frame.',
    group: 'What to keep',
  },
  maxCount: { type: 'number', default: 8, min: 1, max: 64, step: 1, integer: true, label: 'Most regions', group: 'What to keep' },
  mergeDistance: {
    type: 'number',
    default: 0.02,
    min: 0,
    max: 0.5,
    step: 0.005,
    unit: 'norm',
    label: 'Join regions closer than',
    hint: 'Regions whose gap is smaller than this (fraction of the frame size) become one.',
    group: 'What to keep',
  },
  padding: {
    type: 'number',
    default: 0.01,
    min: 0,
    max: 0.5,
    step: 0.005,
    unit: 'norm',
    label: 'Box padding',
    hint: 'Grow every box by this fraction of the frame size.',
    group: 'What to keep',
  },
  sort: { type: 'enum', default: 'score', options: SORT_OPTIONS, label: 'Order', group: 'What to keep' },
} as const satisfies ParamSchema;

export interface DetectOptions {
  minSize: number;
  maxSize: number;
  maxCount: number;
  mergeDistance: number;
  padding: number;
  sort: string;
}

export interface Comp {
  x0: number;
  y0: number;
  /** Inclusive. */
  x1: number;
  y1: number;
  area: number;
  /** Sum of strength (0..1) over the component's pixels. */
  sum: number;
}

/** Keep the work bounded on pathological input (white noise gives thousands of one-pixel specks). */
const MAX_COMPS = 1500;

/**
 * 8-connected component labelling of `strength` (RGBA, red channel used) at the given 0..255 threshold.
 * Two-pass union-find, O(pixels).
 */
export function labelComponents(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, thr = 128): Comp[] {
  const labels = new Int32Array(w * h);
  const parent: number[] = [0];
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      if (ra < rb) parent[rb] = ra;
      else parent[ra] = rb;
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (rgba[i * 4] < thr) continue;
      let lab = 0;
      const consider = (j: number) => {
        const l = labels[j];
        if (!l) return;
        if (!lab) lab = l;
        else if (l !== lab) union(lab, l);
      };
      if (x > 0) consider(i - 1);
      if (y > 0) {
        consider(i - w);
        if (x > 0) consider(i - w - 1);
        if (x < w - 1) consider(i - w + 1);
      }
      if (!lab) {
        lab = parent.length;
        parent.push(lab);
      }
      labels[i] = lab;
    }
  }
  const comps = new Map<number, Comp>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x];
      if (!l) continue;
      const r = find(l);
      let c = comps.get(r);
      if (!c) {
        c = { x0: x, y0: y, x1: x, y1: y, area: 0, sum: 0 };
        comps.set(r, c);
      }
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      c.area++;
      c.sum += rgba[(y * w + x) * 4] / 255;
    }
  }
  let list = [...comps.values()];
  if (list.length > MAX_COMPS) list = list.sort((a, b) => b.sum - a.sum).slice(0, MAX_COMPS);
  return list;
}

/** Merge components whose boxes are within `gap` texels of each other (repeats until stable). */
export function mergeComps(list: Comp[], gap: number): Comp[] {
  const comps = list.map((c) => ({ ...c }));
  if (gap < 0 || comps.length < 2) return comps;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < comps.length; i++) {
      for (let j = comps.length - 1; j > i; j--) {
        const a = comps[i];
        const b = comps[j];
        if (a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1) {
          a.x0 = Math.min(a.x0, b.x0);
          a.y0 = Math.min(a.y0, b.y0);
          a.x1 = Math.max(a.x1, b.x1);
          a.y1 = Math.max(a.y1, b.y1);
          a.area += b.area;
          a.sum += b.sum;
          comps.splice(j, 1);
          changed = true;
        }
      }
    }
  }
  return comps;
}

/**
 * Turn raw components of a `w`x`h` analysis grid into regions: merge, size-filter, rank, cap, pad, order.
 * Everything that depends on resolution is expressed in normalised units first, so a 2x copy of an
 * image yields (nearly) the same regions.
 */
export function componentsToRegions(comps: Comp[], w: number, h: number, o: DetectOptions, label: string): Region[] {
  const long = Math.max(w, h);
  const merged = mergeComps(comps, o.mergeDistance * long);
  const frame = w * h;
  const kept = merged.filter((c) => {
    const pct = (((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)) / frame) * 100;
    return pct >= o.minSize && pct <= o.maxSize;
  });
  const scored = kept.map((c) => ({ c, score: Math.min(1, Math.max(0, c.sum / Math.max(1, c.area))) }));
  scored.sort((a, b) => Math.round(b.score * 100) - Math.round(a.score * 100) || b.c.area - a.c.area || a.c.y0 - b.c.y0 || a.c.x0 - b.c.x0);
  let top = scored.slice(0, Math.max(1, Math.round(o.maxCount)));
  if (o.sort === 'size') top = [...top].sort((a, b) => b.c.area - a.c.area);
  else if (o.sort === 'left') top = [...top].sort((a, b) => a.c.x0 - b.c.x0);
  else if (o.sort === 'top') top = [...top].sort((a, b) => a.c.y0 - b.c.y0);
  const padX = (o.padding * long) / w;
  const padY = (o.padding * long) / h;
  return top.map(({ c, score }, i) => ({
    id: i,
    label,
    score,
    box: clampBox([c.x0 / w - padX, c.y0 / h - padY, (c.x1 + 1) / w + padX, (c.y1 + 1) / h + padY]),
  }));
}

export function clampBox(b: Box): Box {
  const c = (v: number) => Math.min(1, Math.max(0, v));
  return [c(b[0]), c(b[1]), c(b[2]), c(b[3])];
}

/* ------------------------------ region helpers ----------------------------- */

export const centerOf = (b: Box): [number, number] => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
export const sizeOf = (b: Box): [number, number] => [Math.max(0, b[2] - b[0]), Math.max(0, b[3] - b[1])];
export const areaOf = (b: Box): number => {
  const [w, h] = sizeOf(b);
  return w * h;
};

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const union = areaOf(a) + areaOf(b) - inter;
  return union > 1e-12 ? inter / union : 0;
}

/** A pleasant default palette for per-id colours (straight sRGB 0..1). */
export const HUD_PALETTE: [number, number, number][] = [
  [0.25, 0.95, 0.85],
  [1.0, 0.45, 0.35],
  [1.0, 0.85, 0.25],
  [0.55, 0.7, 1.0],
  [0.85, 0.5, 1.0],
  [0.5, 1.0, 0.45],
  [1.0, 0.55, 0.85],
  [1.0, 0.65, 0.2],
];

export function paletteColor(palette: [number, number, number][], id: number): [number, number, number] {
  const list = palette.length ? palette : HUD_PALETTE;
  return list[((Math.floor(id) % list.length) + list.length) % list.length];
}

/** Defensive read of an incoming regions list (a test or plugin may hand over odd data). */
export function validRegions(items: Region[] | undefined | null): Region[] {
  if (!items) return [];
  return items.filter((r) => r && Array.isArray(r.box) && r.box.length === 4 && r.box.every((v) => Number.isFinite(v)));
}

/** Tiny deterministic hash of numbers → positive 31-bit integer. */
export function hashInts(...values: number[]): number {
  let h = 2166136261;
  for (const v of values) {
    h ^= v | 0;
    h = Math.imul(h, 16777619);
    h ^= h >>> 15;
    h = Math.imul(h, 2246822507);
  }
  return (h >>> 0) % 2147483647;
}

/** Fill {label} {id} {score} {index} in a template. */
export function formatLabel(template: string, r: { label: string; id: number; score: number }, index: number): string {
  return template
    .replace(/\{label\}/g, r.label)
    .replace(/\{id\}/g, String(r.id))
    .replace(/\{score\}/g, r.score.toFixed(2))
    .replace(/\{index\}/g, String(index));
}
