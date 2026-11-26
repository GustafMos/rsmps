/**
 * Phone sensor messages (phone -> computer), JSON text frames on the EXISTING pairing WebSocket (the same one that carries the WebRTC
 * signalling and the JPEG fallback). The servers (dev server and desktop app) relay every text frame untouched, so nothing server-side
 * knows these types. Compact on purpose (~120 bytes at 60 Hz): numbers are rounded, short keys.
 *
 * Time `t` is the phone's `performance.now()` in milliseconds (its own clock); the computer maps it to its clock (see io/phone-motion.ts).
 */
import type { Quat, Vec3 } from '../engine/lib/motion-math';

export const MOTION_VERSION = 1;
export const MOTION_MAX_HZ = 60;

/** What the phone has and what is switched on. Sent when the page opens, after every change, and after a reconnect. */
export interface CapsMsg {
  type: 'caps';
  v: number;
  /** DeviceOrientation events exist. */
  orientation: boolean;
  /** DeviceMotion events exist (rotation rate, acceleration). */
  motion: boolean;
  /** A north-referenced orientation is available (Android `deviceorientationabsolute`, or iOS compass heading). */
  absolute: boolean;
  geo: boolean;
  /** WebXR immersive-ar is supported (6-DoF position). Untested on real devices. */
  ar: boolean;
  touch: boolean;
  ios: boolean;
  /** Stream rate cap in Hz. */
  hz: number;
  /** What is currently streaming. */
  on: { motion: boolean; touch: boolean; geo: boolean; ar: boolean };
}

/** Orientation, rotation rate and acceleration. Any field may be missing when the sensor does not report it. */
export interface MotionMsg {
  type: 'motion';
  t: number;
  /** Device -> world quaternion [x, y, z, w] with the screen orientation applied (W3C alpha/beta/gamma). */
  q?: Quat;
  /** 1 when `q` is referenced to north (compass), 0 when its yaw is arbitrary. */
  abs?: 0 | 1;
  /** iOS `webkitCompassHeading` (degrees clockwise from north), when reported. */
  h?: number;
  /**
   * Degrees to turn `q` about the world's vertical axis to reference it to north, when `q` itself is not (abs = 0) but a compass is
   * known. Lets the orientation come from the steadier gyro-only sensor while the compass heading is still available.
   */
  n?: number;
  /** Rotation rate about the device x, y, z axes, degrees per second. */
  r?: Vec3;
  /** Acceleration without gravity, device axes, m/s^2. */
  a?: Vec3;
  /** Acceleration including gravity, device axes, m/s^2 (sign differs between iOS and Android: see docs). */
  g?: Vec3;
}

/** The touch pad: up to 5 touches [id, x, y, pressure] normalised 0..1 (y down), plus the two-finger gesture. */
export interface TouchMsg {
  type: 'touch';
  t: number;
  p: [number, number, number, number][];
  /** Pinch scale since the gesture started (1 = none). */
  ps: number;
  /** Twist in degrees since the gesture started (clockwise positive). */
  tw: number;
  /** Two-finger pan since the gesture started, pad fractions [x, y] (y down). */
  pn: [number, number];
  /** Gesture counter: changes when a new two-finger gesture begins. */
  g: number;
}

/** Position relative to the start point, metres (east, north), speed m/s, altitude change. */
export interface GeoMsg {
  type: 'geo';
  t: number;
  x: number;
  y: number;
  s?: number;
  alt?: number;
  acc?: number;
}

/** WebXR viewer pose (local space: x right, y up, -z forward), metres and quaternion. */
export interface ArMsg {
  type: 'ar';
  t: number;
  p: Vec3;
  q: Quat;
}

export interface EventMsg {
  type: 'mevent';
  t: number;
  e: 'recenter' | 'tap' | 'doubletap';
}

export type PhoneMotionMessage = CapsMsg | MotionMsg | TouchMsg | GeoMsg | ArMsg | EventMsg;

export const MOTION_TYPES = new Set(['caps', 'motion', 'touch', 'geo', 'ar', 'mevent']);

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(num);

/** Round for the wire. */
export const r5 = (x: number): number => Math.round(x * 1e5) / 1e5;
export const r3 = (x: number): number => Math.round(x * 1e3) / 1e3;
export const r1 = (x: number): number => Math.round(x * 10) / 10;

/** Validate an incoming message (the computer never trusts the phone). Returns a cleaned copy, or null. */
export function parseMotionMessage(raw: unknown): PhoneMotionMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.type !== 'string' || !MOTION_TYPES.has(m.type)) return null;
  switch (m.type) {
    case 'caps': {
      const on = (m.on ?? {}) as Record<string, unknown>;
      return {
        type: 'caps',
        v: num(m.v) ? m.v : MOTION_VERSION,
        orientation: m.orientation === true,
        motion: m.motion === true,
        absolute: m.absolute === true,
        geo: m.geo === true,
        ar: m.ar === true,
        touch: m.touch === true,
        ios: m.ios === true,
        hz: num(m.hz) ? Math.max(1, Math.min(MOTION_MAX_HZ, m.hz)) : MOTION_MAX_HZ,
        on: { motion: on.motion === true, touch: on.touch === true, geo: on.geo === true, ar: on.ar === true },
      };
    }
    case 'motion': {
      if (!num(m.t)) return null;
      const out: MotionMsg = { type: 'motion', t: m.t };
      if (vec(m.q, 4)) out.q = m.q as Quat;
      if (m.abs === 1 || m.abs === 0) out.abs = m.abs;
      if (num(m.h)) out.h = m.h;
      if (num(m.n)) out.n = m.n;
      if (vec(m.r, 3)) out.r = m.r as Vec3;
      if (vec(m.a, 3)) out.a = m.a as Vec3;
      if (vec(m.g, 3)) out.g = m.g as Vec3;
      return out.q || out.r || out.a || out.g ? out : null; // a packet with no sensor data is not a packet
    }
    case 'touch': {
      if (!num(m.t) || !Array.isArray(m.p)) return null;
      const p = (m.p as unknown[]).filter((x) => vec(x, 4)).slice(0, 5) as [number, number, number, number][];
      return { type: 'touch', t: m.t, p, ps: num(m.ps) ? m.ps : 1, tw: num(m.tw) ? m.tw : 0, pn: vec(m.pn, 2) ? (m.pn as [number, number]) : [0, 0], g: num(m.g) ? m.g : 0 };
    }
    case 'geo': {
      if (!num(m.t) || !num(m.x) || !num(m.y)) return null;
      return { type: 'geo', t: m.t, x: m.x, y: m.y, ...(num(m.s) ? { s: m.s } : {}), ...(num(m.alt) ? { alt: m.alt } : {}), ...(num(m.acc) ? { acc: m.acc } : {}) };
    }
    case 'ar':
      return num(m.t) && vec(m.p, 3) && vec(m.q, 4) ? { type: 'ar', t: m.t, p: m.p as Vec3, q: m.q as Quat } : null;
    case 'mevent':
      return num(m.t) && (m.e === 'recenter' || m.e === 'tap' || m.e === 'doubletap') ? { type: 'mevent', t: m.t, e: m.e } : null;
  }
  return null;
}
