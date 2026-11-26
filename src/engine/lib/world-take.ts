/**
 * A recorded World AR session ("world take"), pure. Per project frame: where the phone was and how it was turned, where the placed
 * object stood, and the lens of the camera. It lives in the World AR Camera node's hidden `take` param in the same compact form as a
 * phone motion take (motion-take.ts): keyframes per channel, quantised and simplified, so reading it is deterministic and exports
 * reproduce it exactly without a phone.
 *
 * It is a format of its own (not more channels of a motion take) because nothing here may be smoothed or recentered: the poses must
 * stay glued to the camera clip recorded with them, frame for frame.
 *
 * Two ways of filling the frames:
 *  - with a camera clip: every sample carries the clip frame it belongs to. Frame n of the take is then exactly the pose of the
 *    picture in frame n of the clip; a frame the recorder skipped holds the pose before it, like the clip holds its picture.
 *  - motion only: samples carry seconds and are resampled at the project frame rate (positions blended, orientations slerped).
 */
import { qAlign, qNorm, qSlerp, type Quat, type Vec3 } from './motion-math';
import { rdp } from './motion-take';
import type { Lens, XrPose } from './xr-math';

/** One moment of a session: the viewer, the lens, and the placed object (null before anything is placed). */
export interface WorldMoment {
  view: XrPose;
  lens: Lens;
  /** The placed object: its point on the surface, its full orientation (surface frame and twist together) and its size multiplier. */
  object: { p: Vec3; q: Quat; scale: number } | null;
}

export interface WorldSample extends WorldMoment {
  /** Seconds since the recording started. */
  t: number;
  /** The frame of the camera clip this pose belongs to (clip recordings only). */
  frame?: number;
}

export interface WorldTake {
  v: 1;
  kind: 'world-ar';
  fps: number;
  frames: number;
  /** [frame, value, frame, value, ...] per channel. */
  tracks: Record<string, number[]>;
  /** True when the frames match a camera clip recorded in the same session. */
  clip: boolean;
}

interface Spec {
  step: number;
  tol: number;
}
// Tolerances are far below what shows: 0.3 mm and about 0.02 degrees. The object must not visibly slide against the camera clip.
const POS: Spec = { step: 1e-4, tol: 3e-4 };
const ROT: Spec = { step: 2e-5, tol: 1e-4 };
const LENS: Spec = { step: 1e-5, tol: 5e-5 };
const SCALE: Spec = { step: 1e-4, tol: 5e-4 };
const FLAG: Spec = { step: 1, tol: 0.25 };

const CHANNELS: Record<string, Spec> = {
  cx: POS, cy: POS, cz: POS,
  cqx: ROT, cqy: ROT, cqz: ROT, cqw: ROT,
  ox: POS, oy: POS, oz: POS,
  oqx: ROT, oqy: ROT, oqz: ROT, oqw: ROT,
  os: SCALE,
  on: FLAG,
  l0: LENS, l5: LENS, l8: LENS, l9: LENS,
};
export const WORLD_CHANNELS = Object.keys(CHANNELS);
const QUATS: [string, string, string, string][] = [
  ['cqx', 'cqy', 'cqz', 'cqw'],
  ['oqx', 'oqy', 'oqz', 'oqw'],
];

export function isWorldTake(v: unknown): v is WorldTake {
  const t = v as WorldTake | null;
  return !!t && typeof t === 'object' && t.v === 1 && t.kind === 'world-ar' && typeof t.fps === 'number' && typeof t.frames === 'number' && !!t.tracks && typeof t.tracks === 'object';
}

export const worldTakeDuration = (take: WorldTake): number => take.frames / take.fps;

type Row = Record<string, number>;

function rowOf(m: WorldMoment, last: Row | null): Row {
  // before anything is placed the object channels keep the values they will have (or had), so the tracks have no jump to zero in them
  const o = m.object;
  const vq = qNorm(m.view.q);
  const oq = o ? qNorm(o.q) : null;
  return {
    cx: m.view.p[0], cy: m.view.p[1], cz: m.view.p[2],
    cqx: vq[0], cqy: vq[1], cqz: vq[2], cqw: vq[3],
    ox: o ? o.p[0] : (last?.ox ?? 0), oy: o ? o.p[1] : (last?.oy ?? 0), oz: o ? o.p[2] : (last?.oz ?? 0),
    oqx: oq ? oq[0] : (last?.oqx ?? 0), oqy: oq ? oq[1] : (last?.oqy ?? 0), oqz: oq ? oq[2] : (last?.oqz ?? 0), oqw: oq ? oq[3] : (last?.oqw ?? 1),
    os: o ? o.scale : (last?.os ?? 1),
    on: o ? 1 : 0,
    l0: m.lens[0], l5: m.lens[1], l8: m.lens[2], l9: m.lens[3],
  };
}

function blend(a: Row, b: Row, u: number): Row {
  const out: Row = {};
  for (const n of WORLD_CHANNELS) out[n] = n === 'on' ? (u < 0.5 ? a[n] : b[n]) : a[n] + (b[n] - a[n]) * u;
  for (const g of QUATS) {
    const q = qSlerp([a[g[0]], a[g[1]], a[g[2]], a[g[3]]], [b[g[0]], b[g[1]], b[g[2]], b[g[3]]], u);
    g.forEach((name, i) => (out[name] = q[i]));
  }
  return out;
}

const quantise = (v: number, step: number): number => Number((Math.round(v / step) * step).toFixed(6));

/** Turn the samples of a session into a take. Returns null when there is nothing usable (fewer than two samples). */
export function buildWorldTake(samples: WorldSample[], opts: { fps: number }): WorldTake | null {
  if (samples.length < 2) return null;
  const fps = opts.fps;
  const byFrame = samples.every((s) => typeof s.frame === 'number');
  const sorted = [...samples].sort((a, b) => (byFrame ? a.frame! - b.frame! : a.t - b.t));
  const rows: Row[] = [];
  let last: Row | null = null;
  for (const s of sorted) rows.push((last = rowOf(s, last)));
  // the first placed sample fills the object channels of everything before it
  const firstOn = rows.find((r) => r.on === 1);
  if (firstOn) for (const r of rows) {
    if (r.on === 1) break;
    for (const n of ['ox', 'oy', 'oz', 'oqx', 'oqy', 'oqz', 'oqw', 'os']) r[n] = firstOn[n];
  }
  let frames: number;
  const dense: Row[] = [];
  if (byFrame) {
    const f0 = sorted[0].frame!;
    frames = Math.max(2, sorted[sorted.length - 1].frame! - f0 + 1);
    let j = 0;
    for (let i = 0; i < frames; i++) {
      while (j + 1 < sorted.length && sorted[j + 1].frame! - f0 <= i) j++;
      dense.push(rows[j]);
    }
  } else {
    const t0 = sorted[0].t;
    const dur = sorted[sorted.length - 1].t - t0;
    frames = Math.max(2, Math.round(dur * fps) + 1);
    let hi = 0;
    for (let i = 0; i < frames; i++) {
      const t = t0 + i / fps;
      while (hi < sorted.length && sorted[hi].t < t) hi++;
      if (hi === 0) dense.push(rows[0]);
      else if (hi >= sorted.length) dense.push(rows[rows.length - 1]);
      else {
        const a = sorted[hi - 1];
        const b = sorted[hi];
        dense.push(blend(rows[hi - 1], rows[hi], b.t - a.t < 1e-9 ? 0 : (t - a.t) / (b.t - a.t)));
      }
    }
  }
  // one hemisphere along the whole take, so the four numbers of an orientation can be simplified and blended one by one
  const ch: Record<string, Float64Array> = {};
  for (const n of WORLD_CHANNELS) ch[n] = Float64Array.from(dense, (r) => r[n]);
  for (const g of QUATS) {
    let prev: Quat | null = null;
    for (let i = 0; i < frames; i++) {
      let q: Quat = [ch[g[0]][i], ch[g[1]][i], ch[g[2]][i], ch[g[3]][i]];
      if (prev) q = qAlign(q, prev);
      prev = q;
      g.forEach((name, k) => (ch[name][i] = q[k]));
    }
  }
  const tracks: Record<string, number[]> = {};
  for (const n of WORLD_CHANNELS) {
    const spec = CHANNELS[n];
    const q = new Float64Array(frames);
    for (let i = 0; i < frames; i++) q[i] = quantise(ch[n][i], spec.step);
    const flat: number[] = [];
    for (const i of rdp(q, spec.tol)) flat.push(i, q[i]);
    tracks[n] = flat;
  }
  return { v: 1, kind: 'world-ar', fps, frames, tracks, clip: byFrame };
}

const NEUTRAL: Row = { cx: 0, cy: 0, cz: 0, cqx: 0, cqy: 0, cqz: 0, cqw: 1, ox: 0, oy: 0, oz: 0, oqx: 0, oqy: 0, oqz: 0, oqw: 1, os: 1, on: 0, l0: 1, l5: 1, l8: 0, l9: 0 };

function expand(take: WorldTake): Record<string, Float64Array> {
  const ch: Record<string, Float64Array> = {};
  for (const name of WORLD_CHANNELS) {
    const k = take.tracks[name];
    const out = new Float64Array(take.frames);
    // a channel a take does not have (an older or hand-edited take) reads as its neutral value
    if (!k || k.length < 2) out.fill(NEUTRAL[name]);
    else {
      let j = 0;
      for (let i = 0; i < take.frames; i++) {
        while (j + 2 < k.length && k[j + 2] <= i) j += 2;
        const f0 = k[j];
        const v0 = k[j + 1];
        if (j + 2 >= k.length || i <= f0) out[i] = v0;
        else out[i] = name === 'on' ? v0 : v0 + ((k[j + 3] - v0) * (i - f0)) / Math.max(1e-9, k[j + 2] - f0);
      }
    }
    ch[name] = out;
  }
  return ch;
}

const cache = new WeakMap<object, Record<string, Float64Array>>();

/** The moment at `seconds`. Holds the ends, or repeats when `loop`. Between two frames positions are blended and orientations slerped. */
export function sampleWorldTake(take: WorldTake, seconds: number, loop = false): WorldMoment {
  let ch = cache.get(take);
  if (!ch) cache.set(take, (ch = expand(take)));
  const n = take.frames;
  let f = seconds * take.fps;
  if (loop) f = ((f % n) + n) % n;
  else f = Math.max(0, Math.min(n - 1, f));
  // a hair of tolerance: seconds that are a whole frame apart from rounding must land ON the frame, where the take matches its clip
  if (Math.abs(f - Math.round(f)) < 1e-6) f = Math.round(f);
  const i0 = Math.min(n - 1, Math.floor(f));
  const i1 = loop ? (i0 + 1) % n : Math.min(n - 1, i0 + 1);
  const u = f - i0;
  const c = ch;
  const num = (name: string): number => c[name][i0] + (c[name][i1] - c[name][i0]) * u;
  const quat = (g: [string, string, string, string]): Quat => qNorm(qSlerp([c[g[0]][i0], c[g[1]][i0], c[g[2]][i0], c[g[3]][i0]], [c[g[0]][i1], c[g[1]][i1], c[g[2]][i1], c[g[3]][i1]], u));
  const on = (u < 0.5 ? c.on[i0] : c.on[i1]) >= 0.5;
  return {
    view: { p: [num('cx'), num('cy'), num('cz')], q: quat(QUATS[0]) },
    lens: [num('l0'), num('l5'), num('l8'), num('l9')],
    object: on ? { p: [num('ox'), num('oy'), num('oz')], q: quat(QUATS[1]), scale: num('os') } : null,
  };
}
