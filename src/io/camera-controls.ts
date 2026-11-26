/**
 * Camera controls of a live webcam: what the node asks for (`CameraControls`) turned into MediaStreamTrack constraints,
 * given what the camera reports it can do (`track.getCapabilities()`). Pure, so it is easy to test.
 *
 * Values that depend on the camera's own range are given as 0..1 (0 = the camera's minimum, 1 = its maximum), so a saved
 * project or a wire does not depend on which camera is plugged in. Zoom (x), exposure compensation (EV), colour temperature (K)
 * and frame rate (fps) are real units and are clamped to the camera's range.
 */
import type { CameraControls } from '../engine/types';

export type { CameraControls };
export type Caps = Record<string, unknown>;

export interface Range {
  min: number;
  max: number;
  step: number;
}

export const CANNOT_MESSAGE = 'This camera cannot do that.';

/** The numeric range a camera reports for a control, or null when it does not have the control. */
export function rangeOf(caps: Caps | null | undefined, key: string): Range | null {
  const c = caps?.[key] as { min?: unknown; max?: unknown; step?: unknown } | undefined;
  if (!c || typeof c !== 'object') return null;
  const min = Number(c.min);
  const max = Number(c.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return null;
  const step = Number(c.step);
  return { min, max, step: Number.isFinite(step) && step > 0 ? step : 0 };
}

/** The modes a camera reports for a control such as focusMode (an empty list when it has none). */
export function modesOf(caps: Caps | null | undefined, key: string): string[] {
  const c = caps?.[key];
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : [];
}

export function hasTorch(caps: Caps | null | undefined): boolean {
  return !!caps?.torch;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 0..1 -> the camera's own range. */
export function fromUnit(u: number, r: Range): number {
  return r.min + clamp(u, 0, 1) * (r.max - r.min);
}

/** The camera's own value -> 0..1 (0.5 when the range is a single value). */
export function toUnit(v: number, r: Range): number {
  return r.max > r.min ? clamp((v - r.min) / (r.max - r.min), 0, 1) : 0.5;
}

/** The controls that are plain 0..1 ranges: key in CameraControls -> capability name. */
export const UNIT_CONTROLS = {
  focusDistance: 'focusDistance',
  exposureTime: 'exposureTime',
  iso: 'iso',
  brightness: 'brightness',
  contrast: 'contrast',
  saturation: 'saturation',
  sharpness: 'sharpness',
} as const;

export interface BuiltConstraints {
  /** The constraint set to hand to `applyConstraints` (frame rate is the only top-level entry; the rest goes into `advanced`). */
  constraints: MediaTrackConstraints;
  /** Constraint names this set contains. */
  keys: string[];
  /** The ones of them that are asked for (not neutral): remembered, so they can be put back to neutral when let go of. */
  active: string[];
  /** Controls that were asked for (not neutral) but that the camera does not report. */
  unsupported: string[];
  /** Stable text of the set, to skip an identical one. */
  signature: string;
}

const AUTO_MODES = ['continuous', 'single-shot'];

function autoMode(modes: string[]): string | null {
  for (const m of AUTO_MODES) if (modes.includes(m)) return m;
  return modes.find((m) => m !== 'manual') ?? null;
}

/**
 * The full constraint set for what is wanted. Only controls that are not neutral are included, plus the ones in `sent` (asked
 * for before) that are now neutral again, which are sent once with their neutral value so they really go back. `initial` is what
 * the camera reported when it was opened.
 */
export function buildConstraints(wanted: CameraControls, caps: Caps | null, sent: ReadonlySet<string>, initial: Record<string, unknown>): BuiltConstraints {
  const adv: Record<string, unknown> = {};
  const unsupported: string[] = [];
  const active = new Set<string>();
  const want = (name: string, neutral: boolean) => {
    if (!neutral) active.add(name);
    return !neutral || sent.has(name);
  };
  const noCaps = !caps;

  // zoom
  const zr = rangeOf(caps, 'zoom');
  const zoom = wanted.zoom ?? 1;
  if (want('zoom', zoom === 1)) {
    if (zr) adv.zoom = clamp(zoom, zr.min, zr.max);
    // no zoom of its own: the picture is zoomed instead (see digitalZoomFor)
  }

  // torch
  const torch = !!wanted.torch;
  if (want('torch', !torch)) {
    if (hasTorch(caps)) adv.torch = torch;
    else if (torch && !noCaps) unsupported.push('torch');
  }

  // focus
  const fm = modesOf(caps, 'focusMode');
  const manualFocus = wanted.focus === 'manual';
  if (want('focusMode', !manualFocus)) {
    if (manualFocus ? fm.includes('manual') : fm.length > 0) adv.focusMode = manualFocus ? 'manual' : (autoMode(fm) ?? 'continuous');
    else if (manualFocus && !noCaps) unsupported.push('focus');
  }
  const fdr = rangeOf(caps, 'focusDistance');
  if (manualFocus && wanted.focusDistance !== undefined && fm.includes('manual')) {
    if (fdr) adv.focusDistance = fromUnit(wanted.focusDistance, fdr);
    else unsupported.push('focusDistance');
  }

  // exposure
  const em = modesOf(caps, 'exposureMode');
  const manualExp = wanted.exposure === 'manual';
  if (want('exposureMode', !manualExp)) {
    if (manualExp ? em.includes('manual') : em.length > 0) adv.exposureMode = manualExp ? 'manual' : (autoMode(em) ?? 'continuous');
    else if (manualExp && !noCaps) unsupported.push('exposure');
  }
  const etr = rangeOf(caps, 'exposureTime');
  if (manualExp && wanted.exposureTime !== undefined && em.includes('manual')) {
    if (etr) adv.exposureTime = fromUnit(wanted.exposureTime, etr);
    else unsupported.push('exposureTime');
  }
  const ecr = rangeOf(caps, 'exposureCompensation');
  const comp = wanted.exposureComp ?? 0;
  if (want('exposureCompensation', comp === 0)) {
    if (ecr) adv.exposureCompensation = clamp(comp, ecr.min, ecr.max);
    else if (comp !== 0 && !noCaps) unsupported.push('exposureComp');
  }

  // white balance
  const wm = modesOf(caps, 'whiteBalanceMode');
  const manualWb = wanted.whiteBalance === 'manual';
  if (want('whiteBalanceMode', !manualWb)) {
    if (manualWb ? wm.includes('manual') : wm.length > 0) adv.whiteBalanceMode = manualWb ? 'manual' : (autoMode(wm) ?? 'continuous');
    else if (manualWb && !noCaps) unsupported.push('whiteBalance');
  }
  const ctr = rangeOf(caps, 'colorTemperature');
  if (manualWb && wanted.colorTemp !== undefined && wm.includes('manual')) {
    if (ctr) adv.colorTemperature = clamp(wanted.colorTemp, ctr.min, ctr.max);
    else unsupported.push('colorTemp');
  }

  // plain 0..1 ranges that are always independent: ISO, brightness, contrast, saturation, sharpness
  for (const key of ['iso', 'brightness', 'contrast', 'saturation', 'sharpness'] as const) {
    const v = wanted[key];
    const r = rangeOf(caps, key);
    if (v !== undefined) {
      active.add(key);
      if (r) adv[key] = fromUnit(v, r);
      else if (!noCaps) unsupported.push(key);
    } else if (sent.has(key) && r && typeof initial[key] === 'number') adv[key] = clamp(initial[key] as number, r.min, r.max);
  }

  // frame rate: ideal only, so a rate the camera cannot do falls back instead of failing
  const constraints: MediaTrackConstraints = {};
  let fr: number | undefined;
  if (wanted.frameRate && wanted.frameRate > 0) {
    const r = rangeOf(caps, 'frameRate');
    fr = r ? clamp(wanted.frameRate, r.min, r.max) : wanted.frameRate;
    active.add('frameRate');
  } else if (sent.has('frameRate') && typeof initial.frameRate === 'number') fr = initial.frameRate;
  if (fr !== undefined) constraints.frameRate = { ideal: fr };

  const keys = Object.keys(adv);
  if (fr !== undefined) keys.push('frameRate');
  if (keys.length && Object.keys(adv).length) (constraints as { advanced?: unknown }).advanced = [adv];
  return { constraints, keys, active: [...active], unsupported, signature: JSON.stringify(constraints) };
}

/** What is left of the zoom to do in the picture itself: the whole zoom when the camera has no zoom of its own, otherwise nothing. */
export function digitalZoomFor(wantedZoom: number | undefined, caps: Caps | null): number {
  const z = Number.isFinite(wantedZoom) ? Math.max(1, wantedZoom as number) : 1;
  return rangeOf(caps, 'zoom') ? 1 : z;
}
