/**
 * Two device cameras at once. Phones that can run the front and back camera together only do so for a limited set of
 * picture sizes, and a web page cannot ask which. So the page tries: a request that is too demanding fails with a vague
 * "camera in use" error, and the page then asks again for something smaller. This file holds the pure parts of that.
 */

export interface Size {
  width: number;
  height: number;
}

export const SIZE_HD: Size = { width: 1280, height: 720 };
export const SIZE_SD: Size = { width: 640, height: 480 };

/** Errors that a too-demanding second camera shows up as (and that a friendlier request may fix). */
export function isClashError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotReadableError' || name === 'OverconstrainedError' || name === 'AbortError';
}

export type Selector = { deviceId: string } | { facing: 'user' | 'environment' } | null;

export interface Rung {
  id: 'hd' | 'sd' | 'hd-alt' | 'sd-alt';
  size: Size;
  constraints: MediaTrackConstraints;
}

function selector(s: Selector): MediaTrackConstraints {
  if (!s) return {};
  return 'deviceId' in s ? { deviceId: { exact: s.deviceId } } : { facingMode: { exact: s.facing } };
}

/** The friendlier requests for one camera, in the order they are tried: same camera at 1280x720 then 640x480, then the other way of choosing it. */
export function ladderRungs(same: Selector, alt: Selector): Rung[] {
  const mk = (id: Rung['id'], s: Selector, size: Size): Rung => ({ id, size, constraints: { ...selector(s), width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: 30 } } });
  const out: Rung[] = [mk('hd', same, SIZE_HD), mk('sd', same, SIZE_SD)];
  if (alt) out.push(mk('hd-alt', alt, SIZE_HD), mk('sd-alt', alt, SIZE_SD));
  return out;
}

/** What the page remembers about one pair of cameras for the session. */
export type PairOutcome = { ok: true; rung: Rung['id']; size: Size; otherSize: Size | null } | { ok: false; at: number };

/** A pair of cameras is the same pair whichever opens first. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('+');
}

/** After a failed ladder the page does not try the pair again for this long (a button restart clears it). */
export const PAIR_FAIL_MS = 60_000;

export const CLASH_MESSAGE =
  "This phone's browser could not run these two cameras at the same time (tried smaller picture sizes). Other apps can because they are not web pages. Set When cameras clash to Take turns, or use a second phone through Phone Camera instead.";

export const sizeText = (s: Size): string => `${s.width} × ${s.height}`;

export const reducedNote = (s: Size, pair: string): string => `Running at ${sizeText(s)} so ${pair} can work together`;

/* ---------------------------------- the "test cameras together" table ---------------------------------- */

export const TEST_SIZES: { label: string; size: Size }[] = [
  { label: '1080p', size: { width: 1920, height: 1080 } },
  { label: '720p', size: SIZE_HD },
  { label: '480p', size: { width: 640, height: 480 } },
];

export interface PairTest {
  a: string;
  b: string;
  /** Sizes (labels from TEST_SIZES) at which both opened together. */
  works: string[];
}

/** One plain line per pair, for the owner to read out or paste into a report. */
export function describePairTests(rows: PairTest[]): string[] {
  return rows.map((r) => {
    if (!r.works.length) return `${r.a} with ${r.b}: does not work at any size`;
    if (r.works.length === TEST_SIZES.length) return `${r.a} with ${r.b}: works at every size, up to ${r.works[0]}`;
    return `${r.a} with ${r.b}: works only at ${r.works.join(' and ')}`;
  });
}

/* ------------------------------------ recovery of a stuck camera ------------------------------------ */

/** A camera whose track stays muted longer than this is restarted. */
export const MUTE_GRACE_MS = 1500;
/** No new picture for this long while a node wants it counts as stuck. */
export const STUCK_MS = 2000;
/** Waits before each full restart; after these the page stops and says so. */
export const RESTART_BACKOFF_MS = [500, 1000, 2000];
/** Time given to a cheap fix to show a new picture. */
export const CHEAP_FIX_MS = 800;

export const GAVE_UP_MESSAGE = 'The camera stopped and could not be restarted by itself. Press Restart camera.';
