/**
 * The motion sensors of the device the app itself runs on (a phone or tablet): orientation, rotation rate and acceleration from the
 * browser's `deviceorientation` / `devicemotion` events. They are fed into an ordinary `MotionSession` under the reserved name
 * `this-device`, as the same packets a linked phone sends, so everything downstream (smoothing, Recenter, recording a take, exporting
 * from a take, the inspector preview) is the code that already serves the linked phone.
 *
 * Rules kept here:
 *  - Nothing is listened to until something asks for a value (a node reading a channel, or the inspector panel being open), and the
 *    listeners are removed a few seconds after the last request. Like the camera, the sensors are only on while they are used.
 *  - No permission is asked without a press of the panel's button. Listening itself never makes a browser ask: on Android the values
 *    simply arrive, on iOS nothing arrives until the button was pressed and the question answered. Whether the browser HAS a question
 *    says nothing about the platform (Chrome has the same function as Safari and answers "granted" by itself), so the state is judged
 *    by what arrives, not by which functions exist.
 *  - The data stays in the page: nothing here opens a connection.
 *
 * Everything is reached through `SensorEnv`, so the tests run it with fake events and a fake clock.
 */
import { deviceOrientationToQuat, qConj, qMul, wrapAngle, type Quat, type Vec3 } from '../engine/lib/motion-math';
import { THIS_DEVICE } from '../engine/lib/motion-source';
import { MOTION_MAX_HZ, MOTION_VERSION, type CapsMsg, type MotionMsg } from '../phone/motion-protocol';
import { RateGate } from '../phone/motion-pure';
import type { MotionSession } from './phone-motion';

export { THIS_DEVICE };

/** Listeners are removed when nothing has asked for a value for this long. */
export const IDLE_STOP_MS = 3000;
/** With no sensor event this long after starting, the device is taken to have no sensors. */
export const SILENT_AFTER_MS = 2500;

export type DeviceSensorState =
  /** The browser has no motion events at all. */
  | 'unsupported'
  /** The page is not https: browsers keep the sensors away from it. */
  | 'insecure'
  /** Nothing arrives and the browser has a question it was not asked yet (iOS): the user has to press the button. */
  | 'needs-permission'
  /** The user (or a browser setting) said no. */
  | 'denied'
  /** Allowed, and not in use right now. */
  | 'idle'
  /** Listening, nothing has arrived yet. */
  | 'waiting'
  /** Listening for a while and nothing arrives: a computer without sensors, or the browser blocks them. */
  | 'silent'
  /** Sensor values are arriving. */
  | 'live';

export interface DeviceSensorStatus {
  state: DeviceSensorState;
  /** One plain sentence for the panel. */
  message: string;
  /** The browser has a permission question (iOS asks the user; Chrome answers by itself). */
  needsButton: boolean;
  /** A compass (north) reference is known. */
  compass: boolean;
}

type Listener = (e: never) => void;
export interface SensorEnv {
  /** Where the events arrive (the window). */
  target: { addEventListener(type: string, fn: Listener): void; removeEventListener(type: string, fn: Listener): void };
  now(): number;
  secure: boolean;
  hasOrientation: boolean;
  hasMotion: boolean;
  /** The browser has the separate north-referenced event (Android Chrome). */
  hasAbsoluteEvent: boolean;
  /** Ask for the orientation / motion permission (iOS shows a question). Must be called from a user gesture. Absent where no question exists. */
  requestOrientation?: () => Promise<string>;
  requestMotion?: () => Promise<string>;
  /** `screen.orientation.angle`: 0, 90, 180 or 270. */
  screenAngle(): number;
  /** Run `fn` every `ms`; returns the stop function. */
  every(ms: number, fn: () => void): () => void;
}

/** The real browser, or null where there is no window (tests, the command line). */
export function browserSensorEnv(): SensorEnv | null {
  if (typeof window === 'undefined') return null;
  type Ask = { requestPermission?: () => Promise<string> };
  const doe = (window as unknown as { DeviceOrientationEvent?: Ask }).DeviceOrientationEvent;
  const dme = (window as unknown as { DeviceMotionEvent?: Ask }).DeviceMotionEvent;
  return {
    target: window as unknown as SensorEnv['target'],
    now: () => performance.now(),
    secure: window.isSecureContext,
    hasOrientation: !!doe,
    hasMotion: !!dme,
    hasAbsoluteEvent: 'ondeviceorientationabsolute' in window,
    requestOrientation: typeof doe?.requestPermission === 'function' ? () => doe.requestPermission!() : undefined,
    requestMotion: typeof dme?.requestPermission === 'function' ? () => dme.requestPermission!() : undefined,
    screenAngle: () => ((screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) + 360) % 360,
    every: (ms, fn) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    },
  };
}

/* ------------------------------------------------------------------ pure parts */

/**
 * A vector measured along the phone's own axes (x towards its right edge, y towards its top edge), re-expressed along the screen as it
 * is shown now (x to the right of the picture, y up), so "tilt left" means left however the phone is held. `angle` is
 * `screen.orientation.angle`: 90 = the phone's top edge points to the left. z (out of the screen) is unchanged.
 */
export function toScreenAxes(v: Vec3, angle: number): Vec3 {
  const a = (angle * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

/**
 * How far the gyro-only orientation is turned away from north, in degrees: the turn about the vertical that takes the relative
 * orientation to the absolute one. Taken from the two quaternions (not from the alpha angles), so it is right in every pose.
 */
export function northOffset(relative: Quat, absolute: Quat): number {
  const d = qMul(absolute, qConj(relative));
  return wrapAngle((2 * Math.atan2(d[2], d[3]) * 180) / Math.PI);
}

/** Follow a noisy angle slowly, the short way round the circle. The compass jitters; the gyro does not. */
export function followAngle(prev: number | null, next: number, rate = 0.02): number {
  return prev === null ? next : wrapAngle(prev + rate * wrapAngle(next - prev));
}

interface Angles {
  alpha: number;
  beta: number;
  gamma: number;
}
interface Raw {
  /** Latest `deviceorientation` angles. */
  rel: Angles | null;
  /** That event said its angles are north-referenced (some browsers do this instead of a second event). */
  relIsAbsolute: boolean;
  /** Latest `deviceorientationabsolute` angles. */
  abs: Angles | null;
  /** iOS compass heading, degrees clockwise from north. */
  heading: number | null;
  north: number | null;
  rate: Vec3 | null;
  accel: Vec3 | null;
  accelG: Vec3 | null;
}

/** One packet in the linked phone's format, from the latest raw values (missing sensors are left out). */
export function buildDevicePacket(raw: Raw, t: number, screenAngle: number): MotionMsg | null {
  const msg: MotionMsg = { type: 'motion', t };
  if (raw.rel) {
    msg.q = deviceOrientationToQuat(raw.rel.alpha, raw.rel.beta, raw.rel.gamma, screenAngle);
    msg.abs = raw.relIsAbsolute ? 1 : 0;
    if (!raw.relIsAbsolute && raw.north !== null) msg.n = raw.north;
  } else if (raw.abs) {
    // only the north-referenced event delivers on this browser
    msg.q = deviceOrientationToQuat(raw.abs.alpha, raw.abs.beta, raw.abs.gamma, screenAngle);
    msg.abs = 1;
  }
  if (raw.heading !== null) msg.h = raw.heading;
  if (raw.rate) msg.r = toScreenAxes(raw.rate, screenAngle);
  if (raw.accel) msg.a = toScreenAxes(raw.accel, screenAngle);
  if (raw.accelG) msg.g = toScreenAxes(raw.accelG, screenAngle);
  return msg.q || msg.r || msg.a || msg.g ? msg : null;
}

const MESSAGES: Record<DeviceSensorState, string> = {
  unsupported: 'This browser has no motion sensors to offer.',
  insecure: 'Motion sensors only work on a secure (https) page. Open the app from its https address.',
  'needs-permission': 'No sensor values yet. Press "Allow motion sensors" so the browser can ask you (iPhone and iPad need this).',
  denied: 'Motion sensors are blocked for this site. On iPhone: Settings > Apps > Safari > Motion & Orientation Access, then reload. Elsewhere: the site settings behind the address bar.',
  idle: 'Motion sensors are ready. They switch on while a node uses them.',
  waiting: 'Waiting for the first sensor values.',
  silent: 'No sensor values arrive. This device seems to have no motion sensors (a computer has none): open the app on a phone or tablet, or set "Sensors from" to Linked phone.',
  live: 'Receiving motion from this device.',
};

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec = (o: { x?: number | null; y?: number | null; z?: number | null } | null | undefined): Vec3 | null => (o && finite(o.x) && finite(o.y) && finite(o.z) ? [o.x, o.y, o.z] : null);

/* ------------------------------------------------------------------ the provider */

export class DeviceSensors {
  private raw: Raw = { rel: null, relIsAbsolute: false, abs: null, heading: null, north: null, rate: null, accel: null, accelG: null };
  private gate = new RateGate(MOTION_MAX_HZ);
  private listening = false;
  private startedAt = 0;
  private lastDemand = -1e9;
  private lastEvent = -1e9;
  private gotAny = false;
  /** iOS: null = not asked in this page load. */
  private granted: boolean | null = null;
  private stopTimer: (() => void) | null = null;
  private capsKey = '';

  constructor(private session: MotionSession, private env: SensorEnv | null = browserSensorEnv()) {}

  private get needsButton(): boolean {
    return !!(this.env?.requestOrientation || this.env?.requestMotion);
  }

  /**
   * Something wants sensor values now (a node read a channel, or the panel is open): listen. Listening never makes a browser ask
   * anything; where a permission is needed first (iOS), nothing arrives until the panel's button was pressed.
   */
  demand(): void {
    const env = this.env;
    if (!env) return;
    this.lastDemand = env.now();
    if (this.listening || !this.available()) return;
    this.start();
  }

  private available(): boolean {
    const env = this.env;
    return !!env && env.secure && (env.hasOrientation || env.hasMotion);
  }

  /**
   * The panel's button. Asks the browser where a question exists (iOS; must run inside the click), then starts listening.
   * On Android there is no question: this only starts the sensors and reports what arrives.
   */
  async allow(): Promise<DeviceSensorStatus> {
    const env = this.env;
    if (env && this.available()) {
      if (this.needsButton) {
        // both questions must be put before the first await, or iOS no longer counts them as part of the press
        const asks = [env.requestOrientation?.(), env.requestMotion?.()].filter((a): a is Promise<string> => !!a);
        try {
          this.granted = (await Promise.all(asks)).every((a) => a === 'granted');
        } catch {
          this.granted = false;
        }
      }
      // Listen whatever the answer was: what counts is whether values arrive (some browsers answer "denied" and deliver anyway).
      // Listeners added before the answer are not always served afterwards, so they are added again.
      this.lastDemand = env.now();
      this.stop();
      this.start();
    }
    return this.status();
  }

  private start(): void {
    const env = this.env!;
    this.listening = true;
    this.startedAt = env.now();
    this.gotAny = false;
    this.gate.reset();
    env.target.addEventListener('deviceorientation', this.onOrientation as Listener);
    if (env.hasAbsoluteEvent) env.target.addEventListener('deviceorientationabsolute', this.onAbsolute as Listener);
    env.target.addEventListener('devicemotion', this.onMotion as Listener);
    this.stopTimer = env.every(1000, () => {
      if (env.now() - this.lastDemand > IDLE_STOP_MS) this.stop();
    });
    this.sendCaps();
  }

  /** Remove the listeners (also called when nothing has asked for a while). */
  stop(): void {
    const env = this.env;
    if (!env || !this.listening) return;
    this.listening = false;
    env.target.removeEventListener('deviceorientation', this.onOrientation as Listener);
    env.target.removeEventListener('deviceorientationabsolute', this.onAbsolute as Listener);
    env.target.removeEventListener('devicemotion', this.onMotion as Listener);
    this.stopTimer?.();
    this.stopTimer = null;
  }

  get active(): boolean {
    return this.listening;
  }

  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (!finite(e.alpha) || !finite(e.beta) || !finite(e.gamma)) return; // a computer fires one empty event
    const raw = this.raw;
    raw.rel = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
    raw.relIsAbsolute = e.absolute === true;
    const h = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
    raw.heading = finite(h) && h >= 0 ? h : null;
    // iOS: alpha starts anywhere, the compass heading says where north is
    if (raw.heading !== null && !raw.relIsAbsolute) raw.north = followAngle(raw.north, wrapAngle(360 - raw.heading - e.alpha), 0.05);
    this.flush();
  };

  private onAbsolute = (e: DeviceOrientationEvent): void => {
    if (!finite(e.alpha) || !finite(e.beta) || !finite(e.gamma)) return;
    const raw = this.raw;
    raw.abs = { alpha: e.alpha, beta: e.beta, gamma: e.gamma };
    if (raw.rel && !raw.relIsAbsolute) {
      const rel = deviceOrientationToQuat(raw.rel.alpha, raw.rel.beta, raw.rel.gamma);
      raw.north = followAngle(raw.north, northOffset(rel, deviceOrientationToQuat(e.alpha, e.beta, e.gamma)));
    }
    this.flush();
  };

  private onMotion = (e: DeviceMotionEvent): void => {
    const r = e.rotationRate;
    const rate: Vec3 | null = r && finite(r.alpha) && finite(r.beta) && finite(r.gamma) ? [r.beta, r.gamma, r.alpha] : null; // about x, y, z
    const accel = vec(e.acceleration);
    const accelG = vec(e.accelerationIncludingGravity);
    if (!rate && !accel && !accelG) return;
    this.raw.rate = rate;
    this.raw.accel = accel;
    this.raw.accelG = accelG;
    this.flush();
  };

  /** Hand the latest values to the session (at most 60 times a second: the two event streams are merged into one). */
  private flush(): void {
    const env = this.env!;
    const now = env.now();
    this.lastEvent = now;
    this.gotAny = true;
    if (!this.gate.ready(now)) return;
    const msg = buildDevicePacket(this.raw, now, env.screenAngle());
    if (!msg) return;
    this.sendCaps();
    this.session.ingest(msg, now);
  }

  /** The session shows what the device has in the same list a linked phone fills in. Sent again whenever it changes. */
  private sendCaps(): void {
    const raw = this.raw;
    const caps: CapsMsg = {
      type: 'caps',
      v: MOTION_VERSION,
      orientation: !!(raw.rel || raw.abs),
      motion: !!(raw.rate || raw.accel || raw.accelG),
      absolute: this.compass,
      geo: false,
      ar: false,
      touch: false,
      ios: this.needsButton,
      hz: MOTION_MAX_HZ,
      on: { motion: this.listening, touch: false, geo: false, ar: false },
    };
    const key = JSON.stringify(caps);
    if (key === this.capsKey) return;
    this.capsKey = key;
    this.session.ingest(caps, this.env!.now());
  }

  private get compass(): boolean {
    const raw = this.raw;
    return raw.relIsAbsolute || raw.north !== null || (!raw.rel && !!raw.abs);
  }

  state(): DeviceSensorState {
    const env = this.env;
    if (!env || (!env.hasOrientation && !env.hasMotion)) return 'unsupported';
    if (!env.secure) return 'insecure';
    const now = env.now();
    if (this.listening && this.gotAny && now - this.lastEvent < SILENT_AFTER_MS) return 'live';
    if (this.needsButton && this.granted === false) return 'denied';
    if (!this.listening) return 'idle';
    if (now - Math.max(this.startedAt, this.lastEvent) < SILENT_AFTER_MS) return 'waiting';
    // nothing arrives: either the browser wants to be asked first, or there are no sensors
    return this.needsButton && this.granted === null ? 'needs-permission' : 'silent';
  }

  status(): DeviceSensorStatus {
    const state = this.state();
    return { state, message: MESSAGES[state], needsButton: this.needsButton, compass: this.compass };
  }
}
