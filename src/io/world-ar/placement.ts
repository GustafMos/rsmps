/**
 * Placing the object in the room (pure): the little state machine behind the AR view, and the recogniser that turns fingers on the
 * screen into "tap", "drag", "twist" and "pinch". No WebXR and no DOM in here, so the tests drive it with plain numbers.
 *
 *   searching --(a surface is found)--> aiming --(tap / Place)--> placed --(Reset)--> aiming
 *
 * While aiming, a ring (the reticle) shows where the object would land. Once placed: one finger drags it along its surface, two
 * fingers turn it (twist) and resize it (pinch).
 */
import type { Vec3 } from '../../engine/lib/motion-math';
import { yawFacing, type Placement, type XrPose } from '../../engine/lib/xr-math';

export type Phase = 'searching' | 'aiming' | 'placed';

export interface PlaceState {
  phase: Phase;
  /** The surface point in the middle of the screen, when the phone sees one. */
  reticle: XrPose | null;
  placement: Placement | null;
  /** False while the phone has lost track of the room. */
  tracking: boolean;
}

export type PlaceEvent =
  /** Once per camera frame: what the phone sees. */
  | { type: 'frame'; hit: XrPose | null; tracking: boolean }
  /** Tap or the Place button: put the object on the reticle, facing the viewer. Ignored when there is no reticle. */
  | { type: 'place'; viewer: Vec3 }
  /** One-finger drag: the object's point moves to `to` (already on its surface). */
  | { type: 'move'; to: Vec3 }
  | { type: 'twist'; deg: number }
  | { type: 'pinch'; factor: number }
  /** The browser refined where the anchored surface point is. */
  | { type: 'anchor'; pose: XrPose }
  /** Pick the object up again. */
  | { type: 'reset' };

export const MIN_SCALE = 0.05;
export const MAX_SCALE = 40;

export const initialPlaceState = (): PlaceState => ({ phase: 'searching', reticle: null, placement: null, tracking: true });

export function placeStep(s: PlaceState, e: PlaceEvent): PlaceState {
  switch (e.type) {
    case 'frame': {
      const phase: Phase = s.phase === 'placed' ? 'placed' : e.hit ? 'aiming' : 'searching';
      // a surface that was found stays the reticle through a frame or two without a hit, so the ring does not flicker; a lost
      // tracking clears it, because the old point is then meaningless
      const reticle = e.hit ?? (e.tracking ? s.reticle : null);
      return { ...s, phase: phase === 'searching' && reticle ? 'aiming' : phase, reticle, tracking: e.tracking };
    }
    case 'place': {
      if (!s.reticle) return s;
      const keep = s.placement?.scale ?? 1; // moving a placed object to the ring keeps the size the user pinched
      return { ...s, phase: 'placed', placement: { p: s.reticle.p, q: s.reticle.q, yaw: yawFacing(s.reticle, e.viewer), scale: keep } };
    }
    case 'move':
      return s.placement ? { ...s, placement: { ...s.placement, p: e.to } } : s;
    case 'twist':
      return s.placement ? { ...s, placement: { ...s.placement, yaw: wrap(s.placement.yaw + e.deg) } } : s;
    case 'pinch':
      return s.placement && e.factor > 0 ? { ...s, placement: { ...s.placement, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, s.placement.scale * e.factor)) } } : s;
    case 'anchor':
      return s.placement ? { ...s, placement: { ...s.placement, p: e.pose.p, q: e.pose.q } } : s;
    case 'reset':
      return { ...s, phase: s.reticle ? 'aiming' : 'searching', placement: null };
  }
}

const wrap = (deg: number): number => deg - 360 * Math.round(deg / 360);

/** The sentence under the buttons. `gestures` = fingers on the screen reach the page (the DOM overlay is on). */
export function hintFor(s: PlaceState, o: { gestures: boolean; recording: boolean; paused?: boolean }): string {
  if (o.paused) return 'AR is paused. Come back to this screen to continue.';
  if (!s.tracking) return 'Lost track of the room. Move the phone slowly and point it at something with detail (not a blank wall or a dark corner).';
  if (s.phase === 'searching') return 'Move the phone slowly to find a surface. Point it at the floor or a table.';
  if (s.phase === 'aiming') return o.gestures ? 'Tap the screen or press Place to put it on the ring.' : 'Tap the screen to put it on the ring.';
  if (o.recording) return 'Recording. Walk around it. Press Stop when you are done.';
  return o.gestures ? 'Walk around it. Drag to move, two fingers to turn and resize.' : 'Walk around it. Tap to put it somewhere else.';
}

/* ------------------------------------------------------------------ fingers */

export type Gesture =
  | { type: 'tap'; x: number; y: number }
  | { type: 'drag-start'; x: number; y: number }
  | { type: 'drag'; x: number; y: number }
  | { type: 'drag-end' }
  | { type: 'twist'; deg: number }
  | { type: 'pinch'; factor: number };

/** A finger must travel this far (CSS pixels) before it is a drag and no longer a tap. */
export const TAP_SLOP = 12;
/** A tap is over within this long (ms). */
export const TAP_MS = 450;

interface Finger {
  x: number;
  y: number;
  x0: number;
  y0: number;
  t0: number;
}

/**
 * Turns pointer events into gestures. One finger: a tap (short, nearly still) or a drag. Two fingers: twist (the angle of the line
 * between them) and pinch (its length), reported as changes since the last move. A touch that was ever part of a two-finger gesture
 * never ends as a tap, so lifting one finger after a pinch does not place anything.
 */
export class GestureReader {
  private fingers = new Map<number, Finger>();
  private dragging = false;
  private multi = false;
  private last: { angle: number; dist: number } | null = null;

  down(id: number, x: number, y: number, t: number): Gesture[] {
    const out: Gesture[] = [];
    if (this.fingers.size >= 2) return out; // a third finger is ignored
    this.fingers.set(id, { x, y, x0: x, y0: y, t0: t });
    if (this.fingers.size === 2) {
      if (this.dragging) out.push({ type: 'drag-end' });
      this.dragging = false;
      this.multi = true;
      this.last = this.pair();
    }
    return out;
  }

  move(id: number, x: number, y: number): Gesture[] {
    const f = this.fingers.get(id);
    if (!f) return [];
    f.x = x;
    f.y = y;
    if (this.fingers.size === 2) {
      const now = this.pair();
      const was = this.last;
      this.last = now;
      if (!now || !was || was.dist < 1 || now.dist < 1) return [];
      const out: Gesture[] = [];
      let d = now.angle - was.angle;
      d -= 360 * Math.round(d / 360);
      // the screen's y runs down, so a clockwise turn of the fingers is a positive angle here; seen from above the object turns the same way
      if (Math.abs(d) > 1e-4) out.push({ type: 'twist', deg: -d });
      const k = now.dist / was.dist;
      if (Math.abs(k - 1) > 1e-5) out.push({ type: 'pinch', factor: k });
      return out;
    }
    if (this.multi) return []; // the finger left over from a two-finger gesture does nothing
    if (!this.dragging) {
      if (Math.hypot(x - f.x0, y - f.y0) < TAP_SLOP) return [];
      this.dragging = true;
      return [{ type: 'drag-start', x: f.x0, y: f.y0 }, { type: 'drag', x, y }];
    }
    return [{ type: 'drag', x, y }];
  }

  up(id: number, t: number): Gesture[] {
    const f = this.fingers.get(id);
    if (!f) return [];
    this.fingers.delete(id);
    const out: Gesture[] = [];
    if (this.dragging) {
      this.dragging = false;
      out.push({ type: 'drag-end' });
    } else if (!this.multi && t - f.t0 <= TAP_MS && Math.hypot(f.x - f.x0, f.y - f.y0) < TAP_SLOP) out.push({ type: 'tap', x: f.x, y: f.y });
    this.last = null;
    if (this.fingers.size === 0) this.multi = false;
    return out;
  }

  /** The browser took the touch away (a system gesture): nothing is placed. */
  cancel(id: number): Gesture[] {
    if (!this.fingers.delete(id)) return [];
    const out: Gesture[] = this.dragging ? [{ type: 'drag-end' }] : [];
    this.dragging = false;
    this.last = null;
    if (this.fingers.size === 0) this.multi = false;
    return out;
  }

  private pair(): { angle: number; dist: number } | null {
    const [a, b] = [...this.fingers.values()];
    if (!a || !b) return null;
    return { angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI, dist: Math.hypot(b.x - a.x, b.y - a.y) };
  }
}
