/**
 * Stop-motion capture, pure parts: the filmstrip model (add / delete / reorder / duplicate / hold), exposure timing on ones, twos and
 * threes (the holds model of print/holds.ts), onion skin blend weights, deterministic frame names, the timelapse schedule and the
 * transfer state for a full-resolution still that arrives in chunks (a phone on a tripod sending to the computer). No DOM, no camera.
 */
import { expandTimeline, resolveHolds, totalFrames } from './print/holds';

export const MAX_FRAMES = 2000;

export interface SmFrame {
  id: string;
  /** Extra exposure for this drawing only (frames it is shown for); null = use the global "shoot on". */
  hold: number | null;
}

export interface SmStrip {
  frames: SmFrame[];
  /** 1 = on ones, 2 = on twos, 3 = on threes. */
  shootOn: number;
}

export const emptyStrip = (shootOn = 1): SmStrip => ({ frames: [], shootOn: Math.min(3, Math.max(1, Math.round(shootOn))) });

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Add a frame after `after` (an id) or at the end. Refuses beyond MAX_FRAMES. */
export function addFrame(s: SmStrip, id: string, after?: string): SmStrip {
  if (s.frames.length >= MAX_FRAMES) throw new Error(`A take holds at most ${MAX_FRAMES} frames.`);
  const frame: SmFrame = { id, hold: null };
  const i = after ? s.frames.findIndex((f) => f.id === after) : -1;
  const frames = [...s.frames];
  frames.splice(i < 0 ? frames.length : i + 1, 0, frame);
  return { ...s, frames };
}

export function deleteFrame(s: SmStrip, id: string): SmStrip {
  return { ...s, frames: s.frames.filter((f) => f.id !== id) };
}

/** Move the frame at `from` so that it ends up at index `to` (both clamped). */
export function moveFrame(s: SmStrip, from: number, to: number): SmStrip {
  if (from < 0 || from >= s.frames.length) return s;
  const frames = [...s.frames];
  const [f] = frames.splice(from, 1);
  frames.splice(clamp(to, 0, frames.length), 0, f);
  return { ...s, frames };
}

/** A copy of a frame right after it (the same picture: `newId` shares the pixels of `id` through the caller's store). */
export function duplicateFrame(s: SmStrip, id: string, newId: string): SmStrip {
  const i = s.frames.findIndex((f) => f.id === id);
  if (i < 0) return s;
  if (s.frames.length >= MAX_FRAMES) throw new Error(`A take holds at most ${MAX_FRAMES} frames.`);
  const frames = [...s.frames];
  frames.splice(i + 1, 0, { id: newId, hold: s.frames[i].hold });
  return { ...s, frames };
}

export function setHold(s: SmStrip, id: string, hold: number | null): SmStrip {
  return { ...s, frames: s.frames.map((f) => (f.id === id ? { ...f, hold: hold === null ? null : clamp(Math.round(hold), 1, 24) } : f)) };
}

export const setShootOn = (s: SmStrip, on: number): SmStrip => ({ ...s, shootOn: clamp(Math.round(on), 1, 3) });

/** Frame ids as they appear on the timeline (holds expanded): this is the sequence that gets rendered. */
export function timelineIds(s: SmStrip): string[] {
  const opts = { shootOn: s.shootOn, holds: s.frames.map((f) => f.hold) };
  return expandTimeline(s.frames.length, opts).map((i) => s.frames[i].id);
}

/** Timeline length in frames, and in seconds at `fps`. */
export function runtime(s: SmStrip, fps: number): { frames: number; seconds: number } {
  const frames = totalFrames(resolveHolds(s.frames.length, { shootOn: s.shootOn, holds: s.frames.map((f) => f.hold) }));
  return { frames, seconds: frames / Math.max(1, fps) };
}

/** Which filmstrip frame is on screen at playback time `t` seconds (looping when `loop`), or -1 for an empty take. */
export function frameAtTime(s: SmStrip, fps: number, t: number, loop = true): number {
  const total = runtime(s, fps).frames;
  if (!total) return -1;
  let f = Math.floor(Math.max(0, t) * fps);
  f = loop ? f % total : Math.min(f, total - 1);
  const holds = resolveHolds(s.frames.length, { shootOn: s.shootOn, holds: s.frames.map((x) => x.hold) });
  let acc = 0;
  for (let i = 0; i < holds.length; i++) {
    acc += holds[i];
    if (f < acc) return i;
  }
  return holds.length - 1;
}

/* ------------------------------ onion skin ------------------------------ */

/**
 * Opacity of each previous frame laid over the live view, nearest first: `count` frames (1 to 3) fading from `opacity` down to
 * opacity / count. Returns [] for count 0. Opacity is clamped to 0..1.
 */
export function onionWeights(count: number, opacity: number): number[] {
  const n = clamp(Math.round(count), 0, 3);
  const o = clamp(opacity, 0, 1);
  return Array.from({ length: n }, (_, k) => o * ((n - k) / n));
}

/** Indices of the frames to ghost: the `count` frames before position `at` (nearest first), or the last ones when `at` is the end. */
export function onionFrames(total: number, at: number, count: number): number[] {
  const n = clamp(Math.round(count), 0, 3);
  const out: number[] = [];
  for (let k = 1; k <= n; k++) {
    const i = at - k;
    if (i >= 0 && i < total) out.push(i);
  }
  return out;
}

/* ------------------------------ names ------------------------------ */

const SAFE = /[^A-Za-z0-9_-]+/g;

/** `take_0001`: deterministic, sortable, safe in any file system. */
export function frameName(prefix: string, index: number, digits = 4): string {
  const p = prefix.replace(SAFE, '_').replace(/^_+|_+$/g, '') || 'take';
  return `${p}_${String(Math.max(0, index)).padStart(Math.max(digits, String(index).length), '0')}`;
}

/** Name for the next take given the names that exist ("Stop-motion 1", "Stop-motion 2"...). */
export function nextTakeName(existing: readonly string[], base = 'Stop-motion'): string {
  const used = new Set(existing);
  for (let i = 1; i < 10_000; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
  return `${base} ${existing.length + 1}`;
}

/* ------------------------------ timelapse ------------------------------ */

export interface TimelapsePlan {
  /** Seconds between shots (0.5 to 3600). */
  interval: number;
  /** Stop after this many shots (0 = until stopped). */
  maxShots: number;
}

export const normalizePlan = (p: TimelapsePlan): TimelapsePlan => ({ interval: clamp(Number.isFinite(p.interval) ? p.interval : 5, 0.5, 3600), maxShots: clamp(Math.round(p.maxShots) || 0, 0, MAX_FRAMES) });

/** Should a shot be taken now? `startedAt` and `now` in ms; `shots` already taken. Shots are on a fixed grid, so a slow capture does not drift. */
export function timelapseDue(plan: TimelapsePlan, startedAt: number, shots: number, now: number): { due: boolean; done: boolean; nextInMs: number } {
  const p = normalizePlan(plan);
  if (p.maxShots > 0 && shots >= p.maxShots) return { due: false, done: true, nextInMs: 0 };
  const at = startedAt + shots * p.interval * 1000;
  return { due: now >= at, done: false, nextInMs: Math.max(0, at - now) };
}

/* ------------------------------ chunked still transfer ------------------------------ */

export type TransferStatus = 'receiving' | 'complete' | 'failed';

/**
 * Receives one full-resolution still sent in numbered chunks (a phone on a tripod to the computer). Chunks may arrive in any order and
 * twice; every accepted chunk is acknowledged by index; the picture is only handed out when every chunk is in and the size matches.
 */
export class FrameTransfer {
  private chunks = new Map<number, Uint8Array>();
  status: TransferStatus = 'receiving';
  error?: string;
  constructor(readonly shotId: string, readonly total: number, readonly bytes: number, readonly maxBytes = 64 * 1024 * 1024) {
    if (!Number.isInteger(total) || total < 1 || total > 100_000 || !Number.isInteger(bytes) || bytes < 1 || bytes > maxBytes) {
      this.status = 'failed';
      this.error = 'The announced picture size is not acceptable.';
    }
  }
  /** Returns the index to acknowledge, or null when the chunk was refused. */
  accept(index: number, data: Uint8Array): number | null {
    if (this.status !== 'receiving') return null;
    if (!Number.isInteger(index) || index < 0 || index >= this.total) return null;
    if (!this.chunks.has(index)) {
      let have = 0;
      for (const c of this.chunks.values()) have += c.length;
      if (have + data.length > this.bytes) {
        this.status = 'failed';
        this.error = 'More data arrived than was announced.';
        return null;
      }
      this.chunks.set(index, data);
    }
    if (this.chunks.size === this.total) this.finish();
    return index;
  }
  private finish(): void {
    let n = 0;
    for (const c of this.chunks.values()) n += c.length;
    if (n !== this.bytes) {
      this.status = 'failed';
      this.error = `The picture arrived with ${n} bytes instead of ${this.bytes}.`;
    } else this.status = 'complete';
  }
  /** Chunks still missing (to ask the sender for them again). */
  missing(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.total; i++) if (!this.chunks.has(i)) out.push(i);
    return out;
  }
  get progress(): number {
    return this.total ? this.chunks.size / this.total : 0;
  }
  /** The assembled picture, only when complete. */
  result(): Uint8Array | null {
    if (this.status !== 'complete') return null;
    const out = new Uint8Array(this.bytes);
    let o = 0;
    for (let i = 0; i < this.total; i++) {
      const c = this.chunks.get(i)!;
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}
