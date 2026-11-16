/** Touch pad maths (pure): pinch, twist and two-finger pan from normalised touches, and tap / double-tap detection. */
import { unwrapAngle } from '../engine/lib/motion-math';

export interface PadTouch {
  id: number;
  /** 0..1 across the pad, y down. */
  x: number;
  y: number;
  force: number;
}

export interface GestureState {
  /** Gesture counter: bumped whenever a new two-finger gesture starts. */
  gid: number;
  active: boolean;
  ids: [number, number];
  dist0: number;
  angle0: number;
  cx0: number;
  cy0: number;
  lastTwist: number;
}
export const newGesture = (): GestureState => ({ gid: 0, active: false, ids: [-1, -1], dist0: 1, angle0: 0, cx0: 0, cy0: 0, lastTwist: 0 });

export interface GestureOut {
  pinch: number;
  /** Degrees, clockwise positive (y is down on the pad, so a clockwise twist as seen by the user is +). */
  twist: number;
  pan: [number, number];
}

/** Advance the gesture state with the current touches. Uses the two oldest touches (lowest ids). Mutates and returns `st`. */
export function updateGesture(st: GestureState, touches: PadTouch[], aspect = 1): GestureOut {
  const two = [...touches].sort((a, b) => a.id - b.id).slice(0, 2);
  if (two.length < 2) {
    st.active = false;
    return { pinch: 1, twist: 0, pan: [0, 0] };
  }
  const [a, b] = two;
  // work in a square space so a twist is not distorted by the pad's aspect ratio
  const dx = (b.x - a.x) * aspect;
  const dy = b.y - a.y;
  const dist = Math.max(1e-4, Math.hypot(dx, dy));
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  if (!st.active || st.ids[0] !== a.id || st.ids[1] !== b.id) {
    st.active = true;
    st.gid++;
    st.ids = [a.id, b.id];
    st.dist0 = dist;
    st.angle0 = ang;
    st.cx0 = cx;
    st.cy0 = cy;
    st.lastTwist = 0;
    return { pinch: 1, twist: 0, pan: [0, 0] };
  }
  const twist = unwrapAngle(st.lastTwist, ang - st.angle0);
  st.lastTwist = twist;
  return { pinch: dist / st.dist0, twist, pan: [cx - st.cx0, cy - st.cy0] };
}

export type TapEvent = 'tap' | 'doubletap';
/** A tap is a short touch that barely moves; two taps close together are a double tap (which also reports the tap). */
export class TapDetector {
  private down = new Map<number, { t: number; x: number; y: number }>();
  private lastTap = -1e9;
  constructor(private maxMs = 250, private maxMove = 0.04, private doubleMs = 350) {}
  start(id: number, t: number, x: number, y: number): void {
    this.down.set(id, { t, x, y });
  }
  /** Returns the events produced when this touch ends. `multi` = more than one finger was down at some point (not a tap). */
  end(id: number, t: number, x: number, y: number, multi = false): TapEvent[] {
    const d = this.down.get(id);
    this.down.delete(id);
    if (!d || multi) return [];
    if (t - d.t > this.maxMs || Math.hypot(x - d.x, y - d.y) > this.maxMove) return [];
    const out: TapEvent[] = ['tap'];
    if (t - this.lastTap < this.doubleMs) {
      out.push('doubletap');
      this.lastTap = -1e9;
    } else this.lastTap = t;
    return out;
  }
  cancel(id: number): void {
    this.down.delete(id);
  }
}
