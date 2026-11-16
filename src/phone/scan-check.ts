/**
 * The viewfinder's light marker check: from a small greyscale preview frame, are the four corner finder squares of a printed sheet in
 * view, and is the sheet holding still? It reuses the pure finder search of the scan pipeline (`io/print/scan/finder.ts`, which imports
 * nothing but a type), so the phone bundle does not pull in the pipeline. It does NOT read the data strip (which sheet it is) - that is
 * done on the computer after the shot; a wrong guess here only changes a hint, never the scan.
 *
 * All of this is pure (no DOM, no clock of its own) and unit-tested with rendered sheets.
 */
import { adaptiveBinarize, findFinders, rankQuads, type Finder } from '../io/print/scan/finder';

/** The long side of the frame the check runs on. Finder modules are about 3 px wide at this size when the sheet fills the view. */
export const CHECK_SIDE = 720;

export interface CheckResult {
  /** Corner finders seen in each quarter of the picture: top-left, top-right, bottom-right, bottom-left OF THE VIEW. */
  corners: [boolean, boolean, boolean, boolean];
  /** How many of the four quarters hold a finder. */
  count: number;
  /** All four finders form a paper-shaped quadrilateral (positions 0..1 of the frame, clockwise). */
  quad: { x: number; y: number }[] | null;
  /** Average module size in pixels of the analysed frame (null when nothing was found). */
  module: number | null;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Check one greyscale frame (width x height, row-major). */
export function checkFrame(gray: Uint8Array, w: number, h: number): CheckResult {
  const none: CheckResult = { corners: [false, false, false, false], count: 0, quad: null, module: null };
  if (w < 64 || h < 64) return none;
  const radius = clamp(Math.round(Math.min(w, h) / 10), 12, 120);
  const finders: Finder[] = findFinders(adaptiveBinarize(gray, w, h, radius), w, h).sort((a, b) => b.hits - a.hits);
  if (finders.length === 0) return none;
  const corners: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  for (const f of finders.slice(0, 12)) {
    const right = f.x >= w / 2;
    const bottom = f.y >= h / 2;
    corners[bottom ? (right ? 2 : 3) : right ? 1 : 0] = true;
  }
  const quads = rankQuads(finders, 1);
  if (quads.length) {
    const q = quads[0];
    const module = q.reduce((s, f) => s + f.module, 0) / 4;
    return { corners: [true, true, true, true], count: 4, quad: q.map((f) => ({ x: f.x / w, y: f.y / h })), module };
  }
  const module = finders.slice(0, 4).reduce((s, f) => s + f.module, 0) / Math.min(4, finders.length);
  return { corners, count: corners.filter(Boolean).length, quad: null, module };
}

/** Box-downscale RGBA pixels (a canvas readback) to a greyscale frame whose long side is at most `side`. */
export function rgbaToGray(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29 + 128) >> 8;
  return out;
}

/** Size of the analysis frame for a video of this size. */
export function checkSize(videoW: number, videoH: number, side = CHECK_SIDE): { w: number; h: number } {
  const k = Math.min(1, side / Math.max(1, videoW, videoH));
  return { w: Math.max(1, Math.round(videoW * k)), h: Math.max(1, Math.round(videoH * k)) };
}

/* ----------------------------------------------- steadiness ----------------------------------------------- */

/** Largest corner movement (as a fraction of the frame's long side) between two checks that still counts as "holding still". */
export const STEADY_TOLERANCE = 0.012;

export class SteadyTracker {
  private prev: { x: number; y: number }[] | null = null;
  private since: number | null = null;
  /** Fraction of the long side the corners moved between the last two checks (null = no pair yet). */
  movement: number | null = null;

  constructor(private aspect = 1, private tolerance = STEADY_TOLERANCE) {}

  /** Feed the quad (or null) of one check at time `now` (ms). Returns how long the sheet has been steady (0 = not steady). */
  update(quad: { x: number; y: number }[] | null, now: number, aspect = this.aspect): number {
    this.aspect = aspect;
    if (!quad) {
      this.prev = null;
      this.since = null;
      this.movement = null;
      return 0;
    }
    if (this.prev) {
      // corners are fractions of width / height: compare in units of the long side
      let worst = 0;
      for (let i = 0; i < 4; i++) {
        const dx = (quad[i].x - this.prev[i].x) * (aspect >= 1 ? 1 : aspect);
        const dy = (quad[i].y - this.prev[i].y) * (aspect >= 1 ? 1 / aspect : 1);
        worst = Math.max(worst, Math.hypot(dx, dy));
      }
      this.movement = worst;
      if (worst > this.tolerance) this.since = now;
    } else {
      this.since = now;
    }
    this.prev = quad;
    return this.since === null ? 0 : now - this.since;
  }
}

/* ----------------------------------------------- auto capture ----------------------------------------------- */

/** Steady time with all four corners before the shutter fires by itself. */
export const AUTO_HOLD_MS = 700;

/**
 * Decides when auto-capture fires: all four corners found and steady for `holdMs`. After a shot it is disarmed until the sheet has left
 * the view (corners lost) or `rearmMs` passed with the sheet gone/changed, so one sheet is never photographed over and over.
 */
export class AutoCaptureGate {
  private armed = true;
  private lostAt: number | null = null;

  constructor(private holdMs = AUTO_HOLD_MS, private minGapMs = 1500) {}
  private lastShot = -1e9;

  /** `steadyMs`: from SteadyTracker (0 when not steady or no quad). Returns true when the shutter should fire now. */
  update(steadyMs: number, hasQuad: boolean, now: number): boolean {
    if (!hasQuad) {
      if (this.lostAt === null) this.lostAt = now;
      if (now - this.lostAt >= 300) this.armed = true; // the sheet was away for a moment: ready for the next one
      return false;
    }
    this.lostAt = null;
    if (!this.armed || now - this.lastShot < this.minGapMs) return false;
    if (steadyMs >= this.holdMs) {
      this.armed = false;
      this.lastShot = now;
      return true;
    }
    return false;
  }

  /** A manual shot also disarms (the same sheet must not be shot again by the timer). */
  shotTaken(now: number): void {
    this.armed = false;
    this.lastShot = now;
  }

  get isArmed(): boolean {
    return this.armed;
  }
}

/* ----------------------------------------------- hints ----------------------------------------------- */

export type HintTone = 'idle' | 'warn' | 'steady' | 'ready';
export interface Hint {
  text: string;
  tone: HintTone;
}

/** Smallest module size (px at CHECK_SIDE) that still reads reliably on the computer; below it the hint says "Move closer". */
export const MIN_MODULE_PX = 2.2;

/** The words for the viewfinder. `steadyMs`: how long the sheet has held still; `autoOn`: auto-capture is switched on. */
export function markerHint(r: CheckResult, steadyMs: number, autoOn: boolean): Hint {
  if (r.count === 0) return { text: 'Point at a printed sheet. All four corner squares must be in view.', tone: 'idle' };
  if (!r.quad) {
    if (r.count < 4) return { text: r.count === 1 ? 'Move back: only 1 corner square in view' : `Move back: ${r.count} of 4 corner squares in view`, tone: 'warn' };
    return { text: 'All four corners are in view but the sheet looks skewed. Hold the phone above the page.', tone: 'warn' };
  }
  if (r.module !== null && r.module < MIN_MODULE_PX) return { text: 'Move closer: the corner squares are too small', tone: 'warn' };
  if (steadyMs < 250) return { text: 'Hold steady', tone: 'steady' };
  return { text: autoOn ? 'All four corners found. Capturing…' : 'All four corners found. Tap the shutter', tone: 'ready' };
}
