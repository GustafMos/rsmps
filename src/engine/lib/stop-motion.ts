/**
 * The sequence of the Stop Motion node: shots in order, each a still (held for a number of animation frames) or a short clip (plays
 * at its own speed). Pure data and pure maths, shared by the node, the capture controller, the editor strip, the Media Timeline
 * bookkeeping and the tests.
 *
 *   frames of a shot   still: `hold` (whole frames, at least 1)      clip: its length in seconds times the frame rate, at least 1
 *   animation length   the sum of the frames of all shots; time wraps there (the animation loops exactly)
 */

export const STOP_MOTION_ID = 'stop-motion';

export interface Shot {
  /** Media asset holding the picture (still) or the clip. */
  asset: string;
  kind: 'still' | 'clip';
  /** Stills: how many animation frames the picture lasts. Default 1. */
  hold?: number;
  /** Clips: its length in seconds. */
  seconds?: number;
}

export const MAX_HOLD = 24;
export const MIN_FPS = 1;
export const MAX_FPS = 60;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Any stored value as a valid list of shots. Bad entries are dropped, numbers clamped. Never throws. */
export function normalizeShots(raw: unknown): Shot[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { shots?: unknown }).shots) ? (raw as { shots: unknown[] }).shots : [];
  const out: Shot[] = [];
  for (const r of list as Partial<Shot>[]) {
    if (!r || typeof r !== 'object' || typeof r.asset !== 'string' || !r.asset) continue;
    if (r.kind === 'clip') {
      const seconds = num(r.seconds, 0);
      if (!(seconds > 0)) continue;
      out.push({ asset: r.asset, kind: 'clip', seconds });
    } else {
      const hold = Math.min(MAX_HOLD, Math.max(1, Math.round(num(r.hold, 1))));
      out.push(hold === 1 ? { asset: r.asset, kind: 'still' } : { asset: r.asset, kind: 'still', hold });
    }
  }
  return out;
}

export const clampFps = (fps: unknown): number => Math.min(MAX_FPS, Math.max(MIN_FPS, num(fps, 12)));

/** Animation frames a shot lasts. */
export function shotFrames(shot: Shot, fps: number): number {
  if (shot.kind === 'clip') return Math.max(1, Math.round((shot.seconds ?? 0) * fps));
  return Math.max(1, Math.round(shot.hold ?? 1));
}

export function totalFrames(shots: readonly Shot[], fps: number): number {
  let n = 0;
  for (const s of shots) n += shotFrames(s, fps);
  return n;
}

/** Length of the animation in seconds (0 for no shots). */
export const totalSeconds = (shots: readonly Shot[], fps: number): number => totalFrames(shots, fps) / fps;

export interface ShotSpan {
  index: number;
  /** Seconds from the start of the animation. */
  start: number;
  duration: number;
}

/** Where every shot sits in the animation, in seconds. */
export function shotSpans(shots: readonly Shot[], fps: number): ShotSpan[] {
  const out: ShotSpan[] = [];
  let f = 0;
  shots.forEach((s, index) => {
    const n = shotFrames(s, fps);
    out.push({ index, start: f / fps, duration: n / fps });
    f += n;
  });
  return out;
}

export interface ShotAt {
  index: number;
  /** Seconds into the shot to read (0 for a still). */
  local: number;
}

/** Which shot shows at animation time `seconds`, wrapping at the end. Null for no shots. */
export function shotAt(shots: readonly Shot[], fps: number, seconds: number): ShotAt | null {
  const total = totalFrames(shots, fps);
  if (total <= 0) return null;
  const f = Math.floor(seconds * fps + 1e-6);
  let frame = ((f % total) + total) % total;
  for (let i = 0; i < shots.length; i++) {
    const n = shotFrames(shots[i], fps);
    if (frame < n) {
      const s = shots[i];
      return { index: i, local: s.kind === 'clip' ? Math.min(frame / fps, Math.max(0, (s.seconds ?? 0) - 1e-3)) : 0 };
    }
    frame -= n;
  }
  return null;
}

/* --------------------------------------------- edits (pure; used by the strip) --------------------------------------------- */

export const addShot = (shots: readonly Shot[], shot: Shot): Shot[] => [...shots, shot];
export const removeShot = (shots: readonly Shot[], i: number): Shot[] => shots.filter((_, k) => k !== i);
export const removeLast = (shots: readonly Shot[]): Shot[] => shots.slice(0, -1);

export function moveShot(shots: readonly Shot[], i: number, delta: -1 | 1): Shot[] {
  const j = i + delta;
  if (i < 0 || i >= shots.length || j < 0 || j >= shots.length) return [...shots];
  const out = [...shots];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export function duplicateShot(shots: readonly Shot[], i: number): Shot[] {
  if (i < 0 || i >= shots.length) return [...shots];
  const out = [...shots];
  out.splice(i + 1, 0, { ...shots[i] });
  return out;
}

/** Next hold when tapping the hold button: 1, 2, 3, 4, then back to 1. */
export const cycleHold = (hold: number | undefined): number => (Math.max(1, Math.round(hold ?? 1)) % 4) + 1;

export function setHold(shots: readonly Shot[], i: number, hold: number): Shot[] {
  const s = shots[i];
  if (!s || s.kind !== 'still') return [...shots];
  const h = Math.min(MAX_HOLD, Math.max(1, Math.round(hold)));
  const out = [...shots];
  out[i] = h === 1 ? { asset: s.asset, kind: 'still' } : { asset: s.asset, kind: 'still', hold: h };
  return out;
}

/** Replace shot `i` with another picture (Retake), keeping its hold. */
export function replaceShot(shots: readonly Shot[], i: number, asset: string): Shot[] {
  const s = shots[i];
  if (!s) return [...shots];
  const out = [...shots];
  out[i] = s.kind === 'still' && s.hold ? { asset, kind: 'still', hold: s.hold } : { asset, kind: 'still' };
  return out;
}

/** "5 shots · 2.5 s" */
export function describeShots(shots: readonly Shot[], fps: number): string {
  if (shots.length === 0) return 'no shots yet';
  const s = totalSeconds(shots, fps);
  return `${shots.length} shot${shots.length === 1 ? '' : 's'} · ${s < 10 ? s.toFixed(2).replace(/\.?0+$/, '') : s.toFixed(1)} s`;
}

/** The longest side a shot is stored at ('full' = as the input is). */
export function shotMaxSide(size: unknown): number {
  return size === '1080' ? 1080 : size === '720' ? 720 : 0;
}
