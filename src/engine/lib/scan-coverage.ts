/**
 * How well a 3D scan covers its target (pure): the dome of viewing directions around the target, which cells a photo fills, when a
 * new photo is worth taking, whether the phone is steady, what to tell the user next, and the quality summary after the scan.
 *
 * The dome: directions from the target centre to the camera. Azimuth runs around the target's `up` axis (`grid.az` columns), elevation
 * from `EL_MIN_DEG` below the horizon to straight up (`grid.el` rows, row 0 lowest). Increasing azimuth is the viewer walking to
 * their own RIGHT while looking at the target.
 *
 * A photo fills its cell when (1) the target centre is in the middle part of the picture (`AIM_FRACTION` of each half-side), (2) the
 * camera is 0.5 to 4 radii away. Only reachable rows count towards the percentage: when the centre is low over the ground, rows that
 * would need the camera under the floor are left out, and straight below is never part of the dome at all.
 */
import { qConj, qNorm, quatFromMat, rotate, type Quat, type Vec3 } from './motion-math';
import { projectToShot, type ScanData, type ScanShot, type ScanTarget } from './scan-data';

export const EL_MIN_DEG = -10;
export const AIM_FRACTION = 0.6;
export const DIST_MIN_RADII = 0.5;
export const DIST_MAX_RADII = 4;
/** A new photo needs a viewpoint this many degrees from every kept one (at a similar distance). */
export const NEW_VIEW_DEG = 10;
/** The same, in a cell that has fewer photos than `CELL_TARGET`. */
export const NEW_VIEW_DEG_THIN = 7;
export const CELL_TARGET = 2;
export const STEADY_ANGULAR_DEG_S = 20;
export const STEADY_LINEAR_M_S = 0.3;
export const SIMILAR_DISTANCE = 0.3;
/** Rules of thumb behind the verdict. */
export const MIN_PHOTOS = 40;
export const MAX_NEIGHBOUR_DEG = 15;
export const MIN_RINGS = 2;
export const GOOD_COVERAGE = 0.85;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const DEG = Math.PI / 180;

export interface Grid {
  az: number;
  el: number;
}
export interface Cell {
  col: number;
  row: number;
}

/** Horizontal axes for azimuth: e1 x e2 = up. Deterministic for any up. */
export function basisFor(up: Vec3): { e1: Vec3; e2: Vec3; up: Vec3 } {
  const u = unit(up);
  let e1 = cross(u, [0, 0, 1]);
  if (len(e1) < 1e-3) e1 = cross(u, [1, 0, 0]);
  e1 = unit(e1);
  return { e1, e2: cross(u, e1), up: u };
}

/** Azimuth (radians, 0..2pi) and elevation (degrees) of a direction around `up`. */
export function dirAngles(dir: Vec3, up: Vec3): { az: number; el: number } {
  const b = basisFor(up);
  const d = unit(dir);
  const az = Math.atan2(dot(d, b.e2), dot(d, b.e1));
  return { az: az < 0 ? az + 2 * Math.PI : az, el: Math.asin(Math.max(-1, Math.min(1, dot(d, b.up)))) / DEG };
}

const rowStep = (grid: Grid): number => (90 - EL_MIN_DEG) / grid.el;

/** The cell of a viewing direction (from the target centre to the camera); null when it is below the dome. */
export function dirToCell(dir: Vec3, up: Vec3, grid: Grid): Cell | null {
  const { az, el } = dirAngles(dir, up);
  if (el < EL_MIN_DEG) return null;
  const col = Math.min(grid.az - 1, Math.floor((az / (2 * Math.PI)) * grid.az));
  const row = Math.min(grid.el - 1, Math.floor((el - EL_MIN_DEG) / rowStep(grid)));
  return { col, row };
}

/** A direction on the dome at azimuth `az` (radians) and elevation `el` (degrees). */
export function angleToDir(az: number, el: number, up: Vec3): Vec3 {
  const b = basisFor(up);
  const c = Math.cos(el * DEG);
  const s = Math.sin(el * DEG);
  return [0, 1, 2].map((i) => c * (Math.cos(az) * b.e1[i] + Math.sin(az) * b.e2[i]) + s * b.up[i]) as Vec3;
}

export const cellCenterAngles = (cell: Cell, grid: Grid): { az: number; el: number } => ({ az: ((cell.col + 0.5) / grid.az) * 2 * Math.PI, el: EL_MIN_DEG + (cell.row + 0.5) * rowStep(grid) });
export const cellCenterDir = (cell: Cell, up: Vec3, grid: Grid): Vec3 => {
  const a = cellCenterAngles(cell, grid);
  return angleToDir(a.az, a.el, up);
};

/** Angle between two directions, degrees. */
export const angleBetween = (a: Vec3, b: Vec3): number => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) / DEG;

/** Which rows can be reached: all of them, or (centre lifted `h` metres over a floor) those where a camera up to 2 radii away stays 10 cm above the floor. */
export function reachableRows(grid: Grid, radius: number, h: number | null | undefined): boolean[] {
  const rows: boolean[] = [];
  for (let r = 0; r < grid.el; r++) {
    const top = EL_MIN_DEG + (r + 1) * rowStep(grid);
    rows.push(h == null || h + 2 * radius * Math.sin(top * DEG) >= 0.1);
  }
  return rows;
}

/** Whether the target should be treated as standing on a floor (its up is within 25 degrees of the world's up). */
export const onFloor = (target: Pick<ScanTarget, 'up'>): boolean => unit(target.up)[1] > 0.9;

/** The height to use for the reachable rows: the centre's lift over a floor, else null (nothing is excluded). */
export const groundHeight = (target: ScanTarget): number | null => (onFloor(target) && typeof target.h === 'number' ? target.h : null);

/** Is the target centre in the middle part of the picture? `ndc` is the centre's position in the picture, -1..1. */
export const isAimed = (ndc: [number, number] | null, frac = AIM_FRACTION): boolean => !!ndc && Math.abs(ndc[0]) <= frac && Math.abs(ndc[1]) <= frac;

/** The target centre's place in a stored shot's picture, -1..1 (x right, y up), or null when it is behind the camera. */
export function centreNdcInShot(shot: ScanShot, center: Vec3): [number, number] | null {
  const px = projectToShot(shot, center);
  return px ? [(px[0] / shot.w) * 2 - 1, 1 - (px[1] / shot.h) * 2] : null;
}

export const distanceOk = (dist: number, radius: number): boolean => dist >= DIST_MIN_RADII * radius && dist <= DIST_MAX_RADII * radius;

export interface ViewPoint {
  pos: Vec3;
}
/** Direction (unit, from the centre to the camera) and distance. */
export function viewFromCentre(pos: Vec3, center: Vec3): { dir: Vec3; dist: number } {
  const d = sub(pos, center);
  return { dir: unit(d), dist: len(d) };
}

export interface CoverageReport {
  grid: Grid;
  /** Qualifying photos per cell, row-major (index = row * az + col). */
  counts: number[];
  reachable: boolean[];
  /** Cells (of the reachable ones) with at least one photo. */
  coveredCells: number;
  reachableCells: number;
  /** 0..1 of the reachable cells. */
  fraction: number;
  /** Photos that count (aimed, right distance, inside the dome). */
  counted: number;
}

/** The cell a stored shot fills, or null when it does not count (not aimed at the target, wrong distance, below the dome). */
export function shotCell(shot: ScanShot, target: ScanTarget, grid: Grid): Cell | null {
  const v = viewFromCentre(shot.pos, target.center);
  if (!distanceOk(v.dist, target.radius)) return null;
  if (!isAimed(centreNdcInShot(shot, target.center))) return null;
  return dirToCell(v.dir, target.up, grid);
}

/** Coverage of a scan, computed from the stored photos alone. */
export function coverageOf(scan: Pick<ScanData, 'target' | 'grid' | 'shots'>): CoverageReport {
  const { target, grid } = scan;
  const counts = new Array<number>(grid.az * grid.el).fill(0);
  let counted = 0;
  for (const s of scan.shots) {
    const c = shotCell(s, target, grid);
    if (c) {
      counts[c.row * grid.az + c.col]++;
      counted++;
    }
  }
  const rows = reachableRows(grid, target.radius, groundHeight(target));
  const reachable = counts.map((_, i) => rows[Math.floor(i / grid.az)]);
  let reachableCells = 0;
  let coveredCells = 0;
  counts.forEach((n, i) => {
    if (!reachable[i]) return;
    reachableCells++;
    if (n > 0) coveredCells++;
  });
  return { grid, counts, reachable, coveredCells, reachableCells, fraction: reachableCells ? coveredCells / reachableCells : 0, counted };
}

/** Is a camera at `pos` a new viewpoint, given the photos kept (or being saved) so far? */
export function isNewViewpoint(pos: Vec3, shots: readonly { pos: Vec3 }[], target: ScanTarget, grid: Grid, counts?: readonly number[]): boolean {
  const v = viewFromCentre(pos, target.center);
  const cell = dirToCell(v.dir, target.up, grid);
  const thin = !cell || !counts || counts[cell.row * grid.az + cell.col] < CELL_TARGET;
  const limit = thin ? NEW_VIEW_DEG_THIN : NEW_VIEW_DEG;
  for (const s of shots) {
    const o = viewFromCentre(s.pos, target.center);
    if (Math.abs(o.dist - v.dist) > SIMILAR_DISTANCE * Math.max(v.dist, 1e-6)) continue;
    if (angleBetween(o.dir, v.dir) < limit) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ steadiness */

export interface PoseSample {
  /** Milliseconds. */
  t: number;
  pos: Vec3;
  quat: Quat;
}

/** The last fraction of a second of poses, and how fast the phone moved and turned over it. */
export class PoseHistory {
  private list: PoseSample[] = [];
  constructor(private windowMs = 300) {}
  push(s: PoseSample): void {
    this.list.push(s);
    while (this.list.length > 2 && s.t - this.list[1].t >= this.windowMs) this.list.shift();
  }
  clear(): void {
    this.list = [];
  }
  /** Angular speed (degrees per second) and linear speed (metres per second), or null before there is enough history. */
  speeds(): { ang: number; lin: number } | null {
    const l = this.list;
    if (l.length < 2) return null;
    const a = l[0];
    const b = l[l.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.08) return null;
    const qa = qNorm(a.quat);
    const qb = qNorm(b.quat);
    const d = Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3]);
    return { ang: (2 * Math.acos(Math.min(1, d))) / DEG / dt, lin: len(sub(b.pos, a.pos)) / dt };
  }
  steady(maxAng = STEADY_ANGULAR_DEG_S, maxLin = STEADY_LINEAR_M_S): boolean {
    const s = this.speeds();
    return !!s && s.ang <= maxAng && s.lin <= maxLin;
  }
}

/* ------------------------------------------------------------------ guidance */

export type GuidanceKind = 'slower' | 'aim' | 'closer' | 'back' | 'lower' | 'higher' | 'left' | 'right' | 'done' | 'start';
export interface Guidance {
  kind: GuidanceKind;
  text: string;
}

export interface GuidanceInput {
  steady: boolean;
  /** The target centre is in the middle of the picture. */
  aimed: boolean;
  /** The camera's distance from the centre, metres. */
  distance: number;
  radius: number;
  report: CoverageReport;
  /** Direction from the centre to the camera. */
  dir: Vec3;
  up: Vec3;
}

/** The one line to show, by priority: speed, aim, distance, then which side is missing. */
export function guidanceFor(g: GuidanceInput): Guidance {
  if (!g.steady) return { kind: 'slower', text: 'Move slower' };
  if (!g.aimed) return { kind: 'aim', text: 'Aim at the object' };
  if (g.distance < DIST_MIN_RADII * g.radius) return { kind: 'closer', text: 'Step back a little: you are too close for a sharp overview' };
  if (g.distance > DIST_MAX_RADII * g.radius) return { kind: 'back', text: 'Move closer to the object' };
  const r = g.report;
  const grid = r.grid;
  let best: { cell: Cell; angle: number } | null = null;
  for (let row = 0; row < grid.el; row++)
    for (let col = 0; col < grid.az; col++) {
      const i = row * grid.az + col;
      if (!r.reachable[i] || r.counts[i] > 0) continue;
      const angle = angleBetween(cellCenterDir({ col, row }, g.up, grid), g.dir);
      if (!best || angle < best.angle) best = { cell: { col, row }, angle };
    }
  if (!best) return { kind: 'done', text: 'Good: every side is covered. Press Done.' };
  const a = dirAngles(g.dir, g.up);
  const camRow = Math.max(0, Math.min(grid.el - 1, Math.floor((a.el - EL_MIN_DEG) / rowStep(grid))));
  const camCol = (a.az / (2 * Math.PI)) * grid.az;
  let dCol = best.cell.col + 0.5 - camCol;
  dCol -= grid.az * Math.round(dCol / grid.az);
  const dRow = best.cell.row - camRow;
  if (dRow !== 0 && Math.abs(dCol) <= 2) return dRow < 0 ? { kind: 'lower', text: 'Go lower: the sides near the ground are missing' } : { kind: 'higher', text: best.cell.row === grid.el - 1 ? 'Go higher / over the top' : 'Go higher: the upper sides are missing' };
  return dCol > 0 ? { kind: 'right', text: 'Walk to the right: that side is missing' } : { kind: 'left', text: 'Walk to the left: that side is missing' };
}

export const COVERAGE_MEANING = 'Coverage is the share of viewing directions around the object that have a sharp photo. Straight underneath, and any low angle that would put the phone below the floor, are not counted.';

/* ------------------------------------------------------------------ blur */

/** Variance of the Laplacian of a greyscale picture (row-major, values 0..255): high = sharp. Edges are skipped. */
export function laplacianVariance(grey: ArrayLike<number>, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = grey[i - 1] + grey[i + 1] + grey[i - w] + grey[i + w] - 4 * grey[i];
      sum += l;
      sum2 += l * l;
      n++;
    }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/** A Laplacian variance as a 0..1 sharpness: 0 flat, about 0.5 at a variance of 60, towards 1 for a crisp picture. */
export const sharpnessFromVariance = (v: number): number => (v > 0 ? 1 - Math.exp(-v / 87) : 0);

/** A photo is too blurry when it is under this share of the running median of the kept photos (needs a few photos to judge). */
export const BLUR_REJECT_RATIO = 0.45;
export function isTooBlurry(sharp: number, keptSharp: readonly number[]): boolean {
  if (sharp < 0.03) return true;
  if (keptSharp.length < 4) return false;
  const s = [...keptSharp].sort((a, b) => a - b);
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return sharp < median * BLUR_REJECT_RATIO;
}

/* ------------------------------------------------------------------ quality summary */

export interface QualitySummary {
  kept: number;
  rejected: number;
  /** 0..1 of the reachable dome. */
  coverage: number;
  /** Elevation rings with enough photos to count (a third of the way around). */
  rings: number;
  /** Largest gap between neighbouring photos on a well-filled ring, degrees along the ring; 0 when no ring is well filled. */
  maxGapDeg: number;
  /** Median camera distance, metres (0 without photos). */
  medianDistance: number;
  /** The thinnest sides in words, worst first. */
  weakest: string[];
  verdict: { level: 'empty' | 'few' | 'usable' | 'good'; text: string };
  notes: string[];
}

const median = (v: number[]): number => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const SIDES = ['front', 'right side', 'back', 'left side'];

export function qualitySummary(scan: ScanData, rejected = scan.rejected ?? 0): QualitySummary {
  const kept = scan.shots.length;
  const { target, grid } = scan;
  const r = coverageOf(scan);
  const medianDistance = median(scan.shots.map((s) => viewFromCentre(s.pos, target.center).dist));
  const empty = { kept, rejected, coverage: r.fraction, rings: 0, maxGapDeg: 0, medianDistance, weakest: [] as string[], notes: [] as string[] };
  if (!kept) return { ...empty, verdict: { level: 'empty', text: 'No photos yet.' } };

  // rings and gaps from the photos' own directions
  const rowAz: number[][] = Array.from({ length: grid.el }, () => []);
  for (const s of scan.shots) {
    const a = dirAngles(viewFromCentre(s.pos, target.center).dir, target.up);
    const row = Math.floor((a.el - EL_MIN_DEG) / rowStep(grid));
    if (row >= 0 && row < grid.el) rowAz[row].push(a.az);
  }
  let ringCount = 0;
  let maxGap = 0;
  for (let row = 0; row < grid.el; row++) {
    let filled = 0;
    for (let c = 0; c < grid.az; c++) if (r.counts[row * grid.az + c] > 0) filled++;
    if (filled >= grid.az / 3) ringCount++;
    const az = rowAz[row].sort((a, b) => a - b);
    if (az.length >= 12) {
      let gap = az[0] + 2 * Math.PI - az[az.length - 1];
      for (let i = 1; i < az.length; i++) gap = Math.max(gap, az[i] - az[i - 1]);
      const el = (EL_MIN_DEG + (row + 0.5) * rowStep(grid)) * DEG;
      maxGap = Math.max(maxGap, (gap / DEG) * Math.cos(el));
    }
  }

  // the thinnest sides, relative to where the scan started
  const first = dirAngles(viewFromCentre(scan.shots[0].pos, target.center).dir, target.up).az;
  const sideTotal = [0, 0, 0, 0];
  const sideCovered = [0, 0, 0, 0];
  const bandTotal = [0, 0, 0];
  const bandCovered = [0, 0, 0];
  for (let row = 0; row < grid.el; row++)
    for (let col = 0; col < grid.az; col++) {
      const i = row * grid.az + col;
      if (!r.reachable[i]) continue;
      let d = ((col + 0.5) / grid.az) * 2 * Math.PI - first;
      d -= 2 * Math.PI * Math.floor((d + Math.PI / 4) / (2 * Math.PI));
      const side = Math.min(3, Math.floor((d + Math.PI / 4) / (Math.PI / 2)));
      const band = Math.min(2, Math.floor((row * 3) / grid.el));
      sideTotal[side]++;
      bandTotal[band]++;
      if (r.counts[i] > 0) {
        sideCovered[side]++;
        bandCovered[band]++;
      }
    }
  const gaps: { text: string; share: number }[] = [];
  sideTotal.forEach((t, i) => t && gaps.push({ text: `the ${SIDES[i]}`, share: sideCovered[i] / t }));
  ['the low sides', 'the middle height', 'the top'].forEach((text, i) => bandTotal[i] && gaps.push({ text, share: bandCovered[i] / bandTotal[i] }));
  const weakest = gaps
    .filter((g) => g.share < 0.6)
    .sort((a, b) => a.share - b.share)
    .slice(0, 3)
    .map((g) => g.text);

  const notes: string[] = [];
  if (kept < MIN_PHOTOS) notes.push(`${kept} photos is few: aim for at least ${MIN_PHOTOS} for an object.`);
  if (ringCount < MIN_RINGS) notes.push('Only one height was walked: do a second round, lower or higher, so the photos form at least two rings.');
  if (maxGap > MAX_NEIGHBOUR_DEG) notes.push(`Some neighbouring photos are about ${Math.round(maxGap)} degrees apart: aim for ${MAX_NEIGHBOUR_DEG} or less.`);
  if (rejected) notes.push(`${rejected} photo${rejected === 1 ? ' was' : 's were'} left out for being blurry.`);
  if (weakest.length) notes.push(`Thinnest: ${weakest.join(', ')}.`);

  let verdict: QualitySummary['verdict'];
  if (kept < MIN_PHOTOS) verdict = { level: 'few', text: `Too few photos: aim for at least ${MIN_PHOTOS}` };
  else if (r.fraction >= GOOD_COVERAGE && ringCount >= MIN_RINGS && (maxGap === 0 || maxGap <= MAX_NEIGHBOUR_DEG * 1.3)) verdict = { level: 'good', text: 'Good for reconstruction' };
  else verdict = { level: 'usable', text: weakest.length ? `Usable, but ${weakest[0]} is thin` : 'Usable, but the photos are spread thin' };
  return { ...empty, rings: ringCount, maxGapDeg: Math.round(maxGap), weakest, verdict, notes };
}

/* ------------------------------------------------------------------ the dome as drawn */

export interface DomeMesh {
  /** Filled patches: x y z r g b a (premultiplied), triangles. */
  tris: Float32Array;
  /** Outlines and photo markers: the same vertex layout, line segments. */
  lines: Float32Array;
}

const pushV = (out: number[], p: Vec3, c: [number, number, number, number]) => out.push(p[0], p[1], p[2], c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]);

/**
 * The coverage dome around the target as coloured patches: red where a reachable cell has no photo, grey for cells that cannot be
 * reached, green and faint where covered (so the object stays visible), a bright patch for the cell the camera is in; a small cross at
 * every kept photo's position.
 */
export function buildDomeMesh(target: ScanTarget, report: CoverageReport, current: Cell | null, shotPositions: readonly Vec3[]): DomeMesh {
  const grid = report.grid;
  const tris: number[] = [];
  const lines: number[] = [];
  const R = target.radius;
  const at = (az: number, el: number): Vec3 => {
    const d = angleToDir(az, el, target.up);
    return [target.center[0] + d[0] * R, target.center[1] + d[1] * R, target.center[2] + d[2] * R];
  };
  const step = rowStep(grid);
  for (let row = 0; row < grid.el; row++)
    for (let col = 0; col < grid.az; col++) {
      const i = row * grid.az + col;
      const a0 = (col / grid.az) * 2 * Math.PI;
      const a1 = ((col + 1) / grid.az) * 2 * Math.PI;
      const e0 = EL_MIN_DEG + row * step;
      const e1 = e0 + step;
      const p00 = at(a0, e0);
      const p10 = at(a1, e0);
      const p01 = at(a0, e1);
      const p11 = at(a1, e1);
      const n = report.counts[i];
      const here = !!current && current.col === col && current.row === row;
      const color: [number, number, number, number] = here ? [1, 0.9, 0.2, 0.55] : !report.reachable[i] ? [0.6, 0.6, 0.6, 0.06] : n > 0 ? [0.2, 0.9, 0.3, n >= CELL_TARGET ? 0.05 : 0.12] : [1, 0.15, 0.15, 0.3];
      for (const p of [p00, p10, p11, p00, p11, p01]) pushV(tris, p, color);
      const edge: [number, number, number, number] = [1, 1, 1, n > 0 ? 0.12 : 0.3];
      for (const [p, q] of [[p00, p10], [p10, p11], [p11, p01], [p01, p00]] as [Vec3, Vec3][]) {
        pushV(lines, p, edge);
        pushV(lines, q, edge);
      }
    }
  const mark: [number, number, number, number] = [0.3, 1, 0.4, 0.9];
  const k = 0.012 + R * 0.01;
  for (const p of shotPositions) {
    for (const o of [[k, 0, 0], [0, k, 0], [0, 0, k]] as Vec3[]) {
      pushV(lines, [p[0] - o[0], p[1] - o[1], p[2] - o[2]], mark);
      pushV(lines, [p[0] + o[0], p[1] + o[1], p[2] + o[2]], mark);
    }
  }
  return { tris: new Float32Array(tris), lines: new Float32Array(lines) };
}

/** Which cell is a camera position in (null when below the dome). */
export const cellOfPosition = (pos: Vec3, target: ScanTarget, grid: Grid): Cell | null => dirToCell(viewFromCentre(pos, target.center).dir, target.up, grid);

/** Camera-space helper for tests and the loop: the camera's forward direction in the world. */
export const forwardOf = (quat: Quat): Vec3 => rotate(qNorm(quat), [0, 0, -1]);
export const inverseQuat = (q: Quat): Quat => qConj(qNorm(q));

/** The camera-to-world rotation of a camera at `pos` looking at `at` (WebXR: looks down -Z, +Y up), `up` is the world's up. */
export function lookAtQuat(pos: Vec3, at: Vec3, up: Vec3 = [0, 1, 0]): Quat {
  const f = unit(sub(at, pos));
  let right = cross(f, up);
  if (len(right) < 1e-6) right = cross(f, [0, 0, 1]);
  right = unit(right);
  const u = cross(right, f);
  // rows of the 3x3 matrix; its columns are right, up and -forward
  return quatFromMat([right[0], u[0], -f[0], right[1], u[1], -f[1], right[2], u[2], -f[2]]);
}
