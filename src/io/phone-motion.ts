/**
 * Phone motion, computer side. One `MotionSession` per paired phone (pure: no sockets, no clock of its own), and a `PhoneMotionStore`
 * that holds the sessions and answers the signal bridge (`Host.signal('phone.<token>', channel, seconds)`).
 *
 * What it does with the phone's packets (format: src/phone/motion-protocol.ts):
 *  - keeps a short, time-stamped buffer and answers at "now - a small delay" with slerp / linear interpolation, so Wi-Fi jitter does not show;
 *  - maps the phone's clock to this one (the smallest observed transit time, creeping up slowly, is the clock offset);
 *  - turns the W3C quaternion into the scene frame, relative to the recenter reference or absolute (compass), and keeps yaw / pitch / roll
 *    and the 3D Object Euler trio continuous (unwrapped);
 *  - derives shake (envelope), touch pad values and a position (AR pose, else location, else a virtual dolly from the pad);
 *  - optional per-channel smoothing: ask for the channel `name@0.35` (one-euro, smoothing 0..1);
 *  - records the processed channels into a take (src/engine/lib/motion-take.ts).
 */
import type { PhoneMotionMessage, CapsMsg, MotionMsg, TouchMsg, GeoMsg, ArMsg } from '../phone/motion-protocol';
import { parseMotionMessage } from '../phone/motion-protocol';
import { OneEuro, Unwrapper, envelope, lookAngles, objectRotation, qNorm, qSlerp, quatFromLook, relativeTo, rotate, smoothingToEuro, worldToScene, type Quat, type Vec3 } from '../engine/lib/motion-math';
import { buildTake, neutralFrame, type MotionFrame, type MotionTake, type RawSample } from '../engine/lib/motion-take';

/** How far behind "now" the live value is read, so interpolation has data on both sides. */
export const RENDER_DELAY_MS = 40;
const BUFFER = 300;
/** A sensor is "live" while its last packet is younger than this. */
export const LIVE_MS = 1500;
export const TAP_PULSE_MS = 150;
/** Acceleration (m/s^2, no gravity) that counts as a full shake. */
export const SHAKE_FULL = 18;

export type PositionSource = 'ar' | 'location' | 'touch';

interface OrientSample {
  /** Local (this computer's) time of the sample, ms. */
  t: number;
  /** Device -> world quaternion from the phone. */
  q: Quat | null;
  abs: boolean;
  r: Vec3 | null;
  a: Vec3 | null;
  g: Vec3 | null;
}

export interface PhoneMotionStatus {
  caps: CapsMsg | null;
  /** Motion packets are arriving. */
  live: boolean;
  /** Packets per second over the last second. */
  hz: number;
  touching: number;
  positionSource: PositionSource;
  /** Latest processed channels (for the panel preview). */
  frame: MotionFrame;
  recording: boolean;
  recordedSeconds: number;
  /** Acceleration including gravity, device axes (for the panel). */
  gravity: Vec3 | null;
}

export class MotionSession {
  caps: CapsMsg | null = null;
  private buf: OrientSample[] = [];
  private offset: number | null = null;
  private lastMotionAt = -1e9;
  private lastTouchAt = -1e9;
  private lastGeoAt = -1e9;
  private lastArAt = -1e9;
  private arrivals: number[] = [];
  private touch: TouchMsg | null = null;
  private touchGid = -1;
  private lastPan: [number, number] = [0, 0];
  private lastPinch = 1;
  private dolly: Vec3 = [0, 0, 0];
  private geo: GeoMsg | null = null;
  private geoRef: { x: number; y: number; alt: number } | null = null;
  private ar: ArMsg | null = null;
  private arRef: { p: Vec3; yaw: number } | null = null;
  private refRel: Quat | null = null;
  private lastTapAt = -1e9;
  private unwrap: Record<string, Unwrapper> = {};
  private shake = 0;
  private shakeT = -1;
  private filters = new Map<string, { f: OneEuro; t: number; v: number }>();
  private cacheT = -1e9;
  private cacheFrame: MotionFrame | null = null;
  private rec: { start: number; samples: RawSample[] } | null = null;

  constructor(private now: () => number = () => performance.now()) {}

  /* ------------------------------------------------ receiving */

  /** Handle one message (already parsed JSON). Unknown or invalid messages are ignored. */
  ingest(raw: unknown, arrival = this.now()): void {
    const msg = parseMotionMessage(raw);
    if (!msg) return;
    this.apply(msg, arrival);
  }

  private apply(msg: PhoneMotionMessage, arrival: number): void {
    this.cacheFrame = null; // new data: the per-millisecond answer is stale
    switch (msg.type) {
      case 'caps':
        this.caps = msg;
        break;
      case 'motion':
        this.onMotion(msg, arrival);
        break;
      case 'touch':
        this.onTouch(msg, arrival);
        break;
      case 'geo':
        this.geo = msg;
        this.lastGeoAt = arrival;
        if (!this.geoRef) this.geoRef = { x: msg.x, y: msg.y, alt: msg.alt ?? 0 };
        break;
      case 'ar':
        this.ar = msg;
        this.lastArAt = arrival;
        if (!this.arRef) this.arRef = this.arReference(msg);
        break;
      case 'mevent':
        if (msg.e === 'recenter' || msg.e === 'doubletap') this.recenter();
        if (msg.e === 'tap' || msg.e === 'doubletap') this.lastTapAt = arrival;
        break;
    }
  }

  private localTime(t: number, arrival: number): number {
    const d = arrival - t;
    // the smallest transit time seen is the clock offset; it may creep up so a changing clock is followed
    this.offset = this.offset === null ? d : Math.min(d, this.offset + 0.02);
    return t + this.offset;
  }

  private onMotion(m: MotionMsg, arrival: number): void {
    const t = this.localTime(m.t, arrival);
    const last = this.buf[this.buf.length - 1];
    if (last && t <= last.t) return; // out of order or duplicate
    this.buf.push({ t, q: m.q ?? null, abs: m.abs === 1, r: m.r ?? null, a: m.a ?? null, g: m.g ?? null });
    if (this.buf.length > BUFFER) this.buf.shift();
    this.lastMotionAt = arrival;
    this.arrivals.push(arrival);
    while (this.arrivals.length && arrival - this.arrivals[0] > 1000) this.arrivals.shift();
    if (this.rec) this.rec.samples.push({ t: (t - this.rec.start) / 1000, v: this.frameAtLocal(t) });
  }

  private onTouch(m: TouchMsg, arrival: number): void {
    this.touch = m;
    this.lastTouchAt = arrival;
    // virtual dolly: a two-finger pan / pinch moves a position; only the change within one gesture counts
    if (m.p.length >= 2 && m.g === this.touchGid) {
      this.dolly[0] += (m.pn[0] - this.lastPan[0]) * 2;
      this.dolly[1] -= (m.pn[1] - this.lastPan[1]) * 2;
      this.dolly[2] += (m.ps - this.lastPinch) * 2;
    }
    this.touchGid = m.p.length >= 2 ? m.g : -1;
    this.lastPan = m.pn;
    this.lastPinch = m.ps;
  }

  /* ------------------------------------------------ recenter */

  /** The current pose becomes neutral: orientation, position (AR / location / dolly) and the angles restart from 0. */
  recenter(): void {
    const q = this.sceneQuatAt(this.now() - RENDER_DELAY_MS);
    if (q) this.refRel = q;
    this.dolly = [0, 0, 0];
    if (this.ar) this.arRef = this.arReference(this.ar);
    if (this.geo) this.geoRef = { x: this.geo.x, y: this.geo.y, alt: this.geo.alt ?? 0 };
    for (const u of Object.values(this.unwrap)) u.reset();
    this.filters.clear();
    this.cacheFrame = null;
  }

  private arReference(m: ArMsg): { p: Vec3; yaw: number } {
    const q: Quat = [-m.q[0], -m.q[1], m.q[2], m.q[3]]; // WebXR (-z forward) to the scene frame: mirror z
    return { p: [m.p[0], m.p[1], -m.p[2]], yaw: lookAngles(qNorm(q)).yaw };
  }

  /* ------------------------------------------------ sampling */

  private orientAt(tLocal: number): { q: Quat | null; abs: boolean } {
    const b = this.buf;
    if (!b.length) return { q: null, abs: false };
    let hi = b.length - 1;
    while (hi > 0 && b[hi - 1].t >= tLocal) hi--;
    // b[hi] is the first sample with t >= tLocal (or the last one)
    if (tLocal >= b[b.length - 1].t) return { q: b[b.length - 1].q, abs: b[b.length - 1].abs };
    if (hi === 0) return { q: b[0].q, abs: b[0].abs };
    const a = b[hi - 1];
    const c = b[hi];
    if (!a.q || !c.q) return { q: c.q ?? a.q, abs: c.abs };
    const u = (tLocal - a.t) / Math.max(1e-6, c.t - a.t);
    return { q: qSlerp(a.q, c.q, Math.max(0, Math.min(1, u))), abs: c.abs };
  }

  private sceneQuatAt(tLocal: number): Quat | null {
    const o = this.orientAt(tLocal);
    return o.q ? worldToScene(o.q) : null;
  }

  private nearest(tLocal: number): OrientSample | null {
    const b = this.buf;
    if (!b.length) return null;
    let best = b[b.length - 1];
    for (let i = b.length - 1; i >= 0; i--) {
      if (Math.abs(b[i].t - tLocal) < Math.abs(best.t - tLocal)) best = b[i];
      if (b[i].t < tLocal) break;
    }
    return best;
  }

  private uw(name: string): Unwrapper {
    return (this.unwrap[name] ??= new Unwrapper());
  }

  /** Processed channels at a local time (no delay applied here). Stateful for unwrapping and the shake envelope, which only advance forward. */
  frameAtLocal(tLocal: number): MotionFrame {
    const f = neutralFrame();
    const o = this.orientAt(tLocal);
    if (o.q) {
      const qs = worldToScene(o.q);
      if (!this.refRel) this.refRel = qs; // the first pose is the neutral one until Recenter is pressed
      const rel = relativeTo(this.refRel, qs);
      const abq: Quat = o.abs ? qs : rel;
      for (const [prefix, q, keys] of [['', rel, ['qx', 'qy', 'qz', 'qw']], ['abs.', abq, ['aqx', 'aqy', 'aqz', 'aqw']]] as [string, Quat, string[]][]) {
        keys.forEach((k, i) => (f[k] = q[i]));
        const a = lookAngles(q);
        const e = objectRotation(q);
        f[`${prefix}yaw`] = this.uw(`${prefix}yaw`).push(a.yaw);
        f[`${prefix}pitch`] = a.pitch;
        f[`${prefix}roll`] = this.uw(`${prefix}roll`).push(a.roll);
        f[`${prefix}orx`] = this.uw(`${prefix}orx`).push(e[0]);
        f[`${prefix}ory`] = e[1];
        f[`${prefix}orz`] = this.uw(`${prefix}orz`).push(e[2]);
      }
      f.heading = f['abs.yaw'];
    }
    const s = this.nearest(tLocal);
    if (s?.r) [f.rx, f.ry, f.rz] = s.r;
    if (s?.a) {
      [f.ax, f.ay, f.az] = s.a;
      const mag = Math.hypot(s.a[0], s.a[1], s.a[2]);
      const dt = this.shakeT < 0 ? 0 : Math.max(0, (tLocal - this.shakeT) / 1000);
      if (tLocal > this.shakeT) {
        this.shake = envelope(this.shake, Math.min(1, mag / SHAKE_FULL), dt, 0.02, 0.25);
        this.shakeT = tLocal;
      }
    }
    f.shake = this.shake;
    // touch pad
    const tc = this.touch; // the last touch packet stands until the phone sends another (fingers up = an empty packet)
    if (tc) {
      f.tc = tc.p.length;
      if (tc.p[0]) {
        f.tx = tc.p[0][1] * 2 - 1;
        f.ty = -(tc.p[0][2] * 2 - 1);
      }
      f.pinch = tc.ps;
      f.twist = tc.tw;
      f.panx = tc.pn[0] * 2;
      f.pany = -tc.pn[1] * 2;
    }
    // position
    const src = this.positionSource();
    if (src === 'ar' && this.ar && this.arRef) {
      const p: Vec3 = [this.ar.p[0] - this.arRef.p[0], this.ar.p[1] - this.arRef.p[1], -this.ar.p[2] - this.arRef.p[2]];
      const rp = rotate(quatFromLook(-this.arRef.yaw, 0, 0), [p[0], p[1], p[2]]);
      [f.px, f.py, f.pz] = rp;
    } else if (src === 'location' && this.geo && this.geoRef) {
      f.px = this.geo.x - this.geoRef.x;
      f.pz = this.geo.y - this.geoRef.y;
      f.py = (this.geo.alt ?? 0) - this.geoRef.alt;
    } else [f.px, f.py, f.pz] = this.dolly;
    f.tap = this.now() - this.lastTapAt < TAP_PULSE_MS ? 1 : 0;
    return f;
  }

  /** Where `px / py / pz` come from right now. */
  positionSource(): PositionSource {
    const n = this.now();
    if (this.ar && n - this.lastArAt < LIVE_MS) return 'ar';
    if (this.geo && n - this.lastGeoAt < 10_000) return 'location';
    return 'touch';
  }

  /** Live value of every channel (delayed a little so interpolation always has data on both sides). */
  frame(nowMs = this.now()): MotionFrame {
    const t = Math.floor(nowMs); // one answer per millisecond: every channel read for one render agrees
    if (this.cacheFrame && this.cacheT === t) return this.cacheFrame;
    const f = this.frameAtLocal(nowMs - RENDER_DELAY_MS);
    this.cacheT = t;
    this.cacheFrame = f;
    return f;
  }

  /**
   * One channel. `name@0.35` applies one-euro smoothing (0..1) to it. `live` is 1 while motion packets are arriving.
   */
  channel(name: string, nowMs = this.now()): number {
    if (name === 'live') return this.isLive(nowMs) ? 1 : 0;
    const at = name.indexOf('@');
    const base = at < 0 ? name : name.slice(0, at);
    const v = this.frame(nowMs)[base] ?? 0;
    if (at < 0) return v;
    const smoothing = Number(name.slice(at + 1));
    if (!(smoothing > 0)) return v;
    let st = this.filters.get(name);
    if (!st) {
      const e = smoothingToEuro(smoothing);
      st = { f: new OneEuro(e.minCutoff, e.beta), t: -1, v };
      this.filters.set(name, st);
      if (this.filters.size > 200) this.filters.delete(this.filters.keys().next().value as string);
    }
    const tt = Math.floor(nowMs);
    if (st.t !== tt) {
      st.v = st.f.filter(v, nowMs / 1000);
      st.t = tt;
    }
    return st.v;
  }

  isLive(nowMs = this.now()): boolean {
    return nowMs - this.lastMotionAt < LIVE_MS;
  }

  status(): PhoneMotionStatus {
    const n = this.now();
    return {
      caps: this.caps,
      live: this.isLive(n),
      hz: this.arrivals.filter((a) => n - a < 1000).length,
      touching: this.touch?.p.length ?? 0,
      positionSource: this.positionSource(),
      frame: this.frame(n),
      recording: this.rec !== null,
      recordedSeconds: this.rec && this.buf.length ? (this.buf[this.buf.length - 1].t - this.rec.start) / 1000 : 0,
      gravity: this.buf.length ? this.buf[this.buf.length - 1].g : null,
    };
  }

  /* ------------------------------------------------ recording */

  startRecording(): void {
    this.rec = { start: this.buf.length ? this.buf[this.buf.length - 1].t : this.now(), samples: [] };
  }
  get recording(): boolean {
    return this.rec !== null;
  }
  /** Stop and build the take (null when fewer than two packets arrived). */
  stopRecording(opts: { fps: number; loop?: boolean; loopBlend?: number }): MotionTake | null {
    const r = this.rec;
    this.rec = null;
    return r ? buildTake(r.samples, opts) : null;
  }
  cancelRecording(): void {
    this.rec = null;
  }
}

/** All sessions, keyed by pairing token. */
export class PhoneMotionStore {
  private sessions = new Map<string, MotionSession>();
  constructor(private now: () => number = () => performance.now()) {}

  session(token: string): MotionSession {
    let s = this.sessions.get(token);
    if (!s) this.sessions.set(token, (s = new MotionSession(this.now)));
    return s;
  }
  has(token: string): boolean {
    return this.sessions.has(token);
  }
  /** A text frame of the pairing socket (JSON). Non-motion types are ignored. */
  ingest(token: string, raw: unknown): void {
    const type = (raw as { type?: unknown } | null)?.type;
    if (typeof type !== 'string') return;
    this.session(token).ingest(raw, this.now());
  }
  /** The bridge: Host.signal('phone.<token>', channel). Unknown sessions answer neutral values (0, identity). */
  signal(token: string, name: string): number {
    const s = this.sessions.get(token);
    if (!s) return name === 'qw' || name === 'aqw' || name === 'pinch' ? 1 : 0;
    return s.channel(name, this.now());
  }
  drop(token: string): void {
    this.sessions.delete(token);
  }
}
