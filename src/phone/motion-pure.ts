/** Pure helpers of the phone's motion driver (kept apart from the DOM code so they can be unit tested). */
import { deviceOrientationToQuat, wrapAngle } from '../engine/lib/motion-math';
import { MOTION_MAX_HZ, r1, r3, r5, type MotionMsg } from './motion-protocol';

export interface RawSensors {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  /** `deviceorientationabsolute` (or an equivalent) delivered the angles: alpha is referenced to north. */
  absolute: boolean;
  /** iOS `webkitCompassHeading`, degrees clockwise from north. */
  heading: number | null;
  screenAngle: number;
  /** DeviceMotion: rotationRate alpha / beta / gamma in deg/s (z, x, y axes). */
  rate: { alpha: number | null; beta: number | null; gamma: number | null } | null;
  accel: { x: number | null; y: number | null; z: number | null } | null;
  accelG: { x: number | null; y: number | null; z: number | null } | null;
}

/**
 * iOS has no absolute orientation event, but reports the compass heading. The yaw offset that turns iOS's arbitrary alpha into a
 * north-referenced one is (360 - heading) - alpha. Smoothed on the circle so a noisy compass does not make the yaw wobble.
 * Only trustworthy when the phone is roughly upright or flat; `usable` is false when it is tipped over.
 */
export function iosAlphaOffset(alpha: number, heading: number, prev: number | null, usable = true): number {
  if (!usable) return prev ?? wrapAngle(360 - heading - alpha);
  const raw = wrapAngle(360 - heading - alpha);
  if (prev === null) return raw;
  return wrapAngle(prev + 0.05 * wrapAngle(raw - prev));
}

const vec3 = (o: { x: number | null; y: number | null; z: number | null } | null, round: (x: number) => number): [number, number, number] | undefined =>
  o && o.x !== null && o.y !== null && o.z !== null ? [round(o.x), round(o.y), round(o.z)] : undefined;

/** One motion packet from the latest sensor values (fields the sensors do not report are left out). */
export function buildMotionPacket(s: RawSensors, t: number, iosOffset: number | null): MotionMsg {
  const msg: MotionMsg = { type: 'motion', t: Math.round(t * 10) / 10 };
  if (s.alpha !== null && s.beta !== null && s.gamma !== null) {
    const useOffset = !s.absolute && iosOffset !== null && s.heading !== null;
    const alpha = useOffset ? s.alpha + iosOffset! : s.alpha;
    const q = deviceOrientationToQuat(alpha, s.beta, s.gamma, s.screenAngle);
    msg.q = [r5(q[0]), r5(q[1]), r5(q[2]), r5(q[3])];
    msg.abs = s.absolute || useOffset ? 1 : 0;
  }
  if (s.heading !== null) msg.h = r1(s.heading);
  if (s.rate && s.rate.alpha !== null && s.rate.beta !== null && s.rate.gamma !== null) msg.r = [r1(s.rate.beta), r1(s.rate.gamma), r1(s.rate.alpha)];
  const a = vec3(s.accel, r3);
  if (a) msg.a = a;
  const g = vec3(s.accelG, r3);
  if (g) msg.g = g;
  return msg;
}

/** Caps the stream rate; rendering ticks arrive per animation frame and are coalesced (the latest values win). */
export class RateGate {
  private last = -1e9;
  constructor(public hz = MOTION_MAX_HZ) {}
  /** True when a packet may go out at time `nowMs` (a tick that arrives a hair early still goes: frames are not exactly 1000/hz apart). */
  ready(nowMs: number): boolean {
    const gap = 1000 / Math.max(1, Math.min(MOTION_MAX_HZ, this.hz));
    if (nowMs - this.last < gap * 0.85) return false;
    this.last = nowMs;
    return true;
  }
  reset(): void {
    this.last = -1e9;
  }
}

/** Geolocation fix to metres east / north of the first fix (equirectangular, fine for the tens of metres a phone moves). */
export class GeoOrigin {
  private lat0 = 0;
  private lon0 = 0;
  private alt0: number | null = null;
  private set = false;
  fix(lat: number, lon: number, alt: number | null): { x: number; y: number; alt?: number } {
    if (!this.set) {
      this.set = true;
      this.lat0 = lat;
      this.lon0 = lon;
      this.alt0 = alt;
    }
    const mPerDegLat = 111_320;
    const x = (lon - this.lon0) * mPerDegLat * Math.cos((this.lat0 * Math.PI) / 180);
    const y = (lat - this.lat0) * mPerDegLat;
    return { x: r3(x), y: r3(y), ...(alt !== null && this.alt0 !== null ? { alt: r3(alt - this.alt0) } : {}) };
  }
  reset(): void {
    this.set = false;
    this.alt0 = null;
  }
}
