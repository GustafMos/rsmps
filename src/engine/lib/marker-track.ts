/**
 * The part of Marker Camera between "a marker was (or was not) seen in this frame" and "this is the camera to use" (pure).
 * Two ways in, one way out:
 *  - live and plain preview: one frame at a time, with a small memory of the frames before (`stepLive`);
 *  - an analysed clip: every frame's sighting is known, so a frame is answered from its neighbours on both sides, the same
 *    whenever and in whatever order it is asked for (`fromClip`). That is what makes an export repeatable.
 */
import { blendPoses, columnsFromQuat, poseFromCorners, smoothStep, type MarkerPose, type Pt, type SmoothState } from './marker-pose';

/** One frame's sighting: corners as fractions of the picture (0..1, top-left origin), already flipped back if the picture was mirrored. */
export interface Sighting {
  id: number;
  /** x0, y0, ... x3, y3: the marker's own top-left, top-right, bottom-right, bottom-left. */
  c: number[];
  /** The picture was a mirror image. */
  m: boolean;
  /** 0..1 */
  s: number;
}

export type LostMode = 'hold' | 'fade' | 'hide';

export interface TrackOptions {
  width: number;
  height: number;
  fov: number;
  /** 0..1 */
  smoothing: number;
  lost: LostMode;
  /** Seconds the last pose is kept at full strength after the marker is lost (fade and hide). */
  holdTime: number;
  fps: number;
}

export interface TrackResult {
  /** The pose to use, or null while there has never been one. */
  pose: { r: number[]; t: [number, number, number] } | null;
  /** 0..1: how visible the object should be. */
  visible: number;
  /** The marker is in this very frame. */
  seen: boolean;
  /** The picture is a mirror image (as last seen). */
  mirrored: boolean;
}

/** Seconds of the fade in "Fade out". */
const FADE = 0.4;

export function visibility(lost: LostMode, holdTime: number, lostFor: number): number {
  if (lostFor <= 0) return 1;
  if (!Number.isFinite(lostFor)) return 0;
  if (lost === 'hold') return 1;
  // a hair of slack: a tenth of a second added three times is a little more than 0.3
  if (lostFor <= holdTime + 1e-6) return 1;
  return lost === 'fade' ? Math.max(0, Math.min(1, 1 - (lostFor - holdTime) / FADE)) : 0;
}

export function cornersPx(s: Sighting, width: number, height: number): Pt[] {
  return [0, 1, 2, 3].map((i): Pt => [s.c[i * 2] * width, s.c[i * 2 + 1] * height]);
}

/* ------------------------------------------------------------------ */
/* live                                                                 */
/* ------------------------------------------------------------------ */

export interface LiveState {
  frame: number;
  filter: SmoothState | null;
  pose: { r: number[]; t: [number, number, number] } | null;
  /** Seconds since the marker was last seen (Infinity = never). */
  lostFor: number;
  mirrored: boolean;
}

/**
 * One live step. `prev` is the state after the frame before, or null to start afresh (the first frame, after a jump in time).
 * `dt` = seconds since `prev` (0 when the same frame is simply asked for again).
 */
export function stepLive(prev: LiveState | null, seen: Sighting | null, frame: number, dt: number, o: TrackOptions): { state: LiveState; result: TrackResult } {
  let state: LiveState;
  const pose = seen ? poseFromCorners(cornersPx(seen, o.width, o.height), o.width, o.height, o.fov, prev?.pose) : null;
  if (seen && pose) {
    // after a real gap the old pose is history: start from the new one instead of sliding over to it
    const cont = prev && prev.lostFor < 0.25 ? prev.filter : null;
    const filter = smoothStep(cont, pose, dt, o.smoothing);
    state = { frame, filter, pose: { r: columnsFromQuat(filter.q), t: filter.t }, lostFor: 0, mirrored: seen.m };
  } else {
    state = { frame, filter: prev?.filter ?? null, pose: prev?.pose ?? null, lostFor: prev ? prev.lostFor + dt : Infinity, mirrored: prev?.mirrored ?? false };
  }
  return { state, result: { pose: state.pose, visible: state.pose ? visibility(o.lost, o.holdTime, state.lostFor) : 0, seen: !!(seen && pose), mirrored: state.mirrored } };
}

/* ------------------------------------------------------------------ */
/* analysed clip                                                        */
/* ------------------------------------------------------------------ */

/** Sightings of a whole clip in a compact form for storage: per frame 0 (not seen) or [id, mirrored 0/1, score, x0, y0 ... x3, y3]. */
export type StoredFrame = 0 | number[];

export function packSighting(s: Sighting | null): StoredFrame {
  if (!s) return 0;
  const r = (v: number): number => Math.round(v * 1e6) / 1e6;
  return [s.id, s.m ? 1 : 0, Math.round(s.s * 1000) / 1000, ...s.c.map(r)];
}
export function unpackSighting(f: StoredFrame | undefined | null): Sighting | null {
  if (!Array.isArray(f) || f.length < 11) return null;
  return { id: f[0], m: f[1] === 1, s: f[2], c: f.slice(3, 11) };
}

/**
 * The answer for frame `frame` of an analysed clip. Smoothing looks at the frames on BOTH sides (a bell-shaped window), so it calms
 * the pose without trailing behind the picture at all.
 */
export function fromClip(frames: readonly StoredFrame[], frame: number, o: TrackOptions): TrackResult {
  const n = frames.length;
  const f = Math.min(n - 1, Math.max(0, frame));
  let last = f;
  while (last >= 0 && !unpackSighting(frames[last])) last--;
  if (n === 0 || last < 0) return { pose: null, visible: 0, seen: false, mirrored: false };
  const here = unpackSighting(frames[last])!;
  const sigma = o.smoothing * o.fps * 0.12;
  const reach = Math.min(30, Math.ceil(sigma * 2.5));
  const poses: MarkerPose[] = [];
  const weights: number[] = [];
  // Solve the window in time order, each frame taking the one before as its hint (see poseFromCorners): the same chain every time.
  // A few frames of lead-in settle which of the two possible tilts is the right one before the window starts.
  let prior: MarkerPose | null = null;
  for (let g = last - reach - 3; g <= last + reach; g++) {
    const s = g >= 0 && g < n ? unpackSighting(frames[g]) : null;
    if (!s) continue;
    const p = poseFromCorners(cornersPx(s, o.width, o.height), o.width, o.height, o.fov, prior);
    if (!p) continue;
    prior = p;
    if (g < last - reach) continue;
    poses.push(p);
    weights.push(sigma > 0.01 ? Math.exp(-((g - last) ** 2) / (2 * sigma * sigma)) : g === last ? 1 : 0);
  }
  const pose = blendPoses(poses, weights);
  if (!pose) return { pose: null, visible: 0, seen: false, mirrored: here.m };
  return { pose, visible: visibility(o.lost, o.holdTime, (f - last) / Math.max(1, o.fps)), seen: last === f, mirrored: here.m };
}

/** Area-average a straight RGBA picture down to a grey one of `tw` x `th` (for the clip analysis, which reads full pictures back). */
export function shrinkToGrey(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, tw: number, th: number): Uint8Array {
  const out = new Uint8Array(tw * th);
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor((y * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / th));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / tw));
      let s = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * w + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) s += rgba[i] * 54 + rgba[i + 1] * 183 + rgba[i + 2] * 19;
      }
      out[y * tw + x] = Math.round(s / (256 * (x1 - x0) * (y1 - y0)));
    }
  }
  return out;
}

/** Size of the small picture the marker is looked for in: `long` pixels on the long side, never larger than the picture itself. */
export function analysisSize(width: number, height: number, long: number): { width: number; height: number } {
  const k = Math.min(1, long / Math.max(1, width, height));
  return { width: Math.max(16, Math.round(width * k)), height: Math.max(16, Math.round(height * k)) };
}
