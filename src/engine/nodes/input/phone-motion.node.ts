import { defineNode } from '../../define';
import { clamp, deadzone } from '../../lib/motion-math';
import { isTake, sampleTake, takeDense, type MotionFrame } from '../../lib/motion-take';

/**
 * Phone Motion: the phone's gyroscope, accelerometer, compass, touch pad and (optionally) position as numbers you can wire into any number
 * setting. Live values come through the signal bridge (`Host.signal('phone.<session>', channel)`, see io/phone-motion.ts); with a recorded
 * take (the inspector's Record button) it can instead read the take, which needs no phone and reproduces exactly in exports and the CLI.
 * Angles are in degrees and unwrapped, so they do not jump at +-180.
 */

/** Channels that are not smoothed (counts, pulses, the shake envelope already has its own attack and release). */
const NO_SMOOTH = new Set(['tc', 'tap', 'shake']);

export const MOTION_OUTPUTS = {
  yaw: { type: 'number', label: 'Yaw', hint: 'Turning right is positive.' },
  pitch: { type: 'number', label: 'Pitch', hint: 'Looking up is positive.' },
  roll: { type: 'number', label: 'Roll', hint: 'Clockwise tilt is positive.' },
  objX: { type: 'number', label: 'Object rotate X' },
  objY: { type: 'number', label: 'Object rotate Y' },
  objZ: { type: 'number', label: 'Object rotate Z' },
  rateX: { type: 'number', label: 'Rotation rate X (deg/s)' },
  rateY: { type: 'number', label: 'Rotation rate Y (deg/s)' },
  rateZ: { type: 'number', label: 'Rotation rate Z (deg/s)' },
  accX: { type: 'number', label: 'Acceleration X (m/s²)' },
  accY: { type: 'number', label: 'Acceleration Y (m/s²)' },
  accZ: { type: 'number', label: 'Acceleration Z (m/s²)' },
  shake: { type: 'number', label: 'Shake (0..1)' },
  tiltX: { type: 'number', label: 'Tilt X (-1..1)' },
  tiltY: { type: 'number', label: 'Tilt Y (-1..1)' },
  touchX: { type: 'number', label: 'Touch X (-1..1)' },
  touchY: { type: 'number', label: 'Touch Y (-1..1)' },
  touches: { type: 'number', label: 'Touch count' },
  pinch: { type: 'number', label: 'Pinch (1 = none)' },
  twist: { type: 'number', label: 'Twist (deg)' },
  panX: { type: 'number', label: 'Pan X' },
  panY: { type: 'number', label: 'Pan Y' },
  heading: { type: 'number', label: 'Compass heading (deg)' },
  posX: { type: 'number', label: 'Position X (m)' },
  posY: { type: 'number', label: 'Position Y (m)' },
  posZ: { type: 'number', label: 'Position Z (m)' },
  tap: { type: 'number', label: 'Tap (1 for a moment)' },
} as const;

export interface ShapeParams {
  mode: 'relative' | 'absolute';
  gainX: number;
  gainY: number;
  gainZ: number;
  invertX: boolean;
  invertY: boolean;
  invertZ: boolean;
  deadzone: number;
  limit: number;
  tiltRange: number;
  shakeGain: number;
}

/**
 * From the processed phone channels to the node's outputs (pure, shared by the live and the recorded path).
 * Axis naming: X = pitch (about the phone's left-right axis), Y = yaw, Z = roll. `read(name)` gives a channel of `MotionFrame`.
 */
export function shapeOutputs(read: (name: string) => number, p: ShapeParams): Record<keyof typeof MOTION_OUTPUTS, number> {
  const pre = p.mode === 'absolute' ? 'abs.' : '';
  const sx = (p.invertX ? -1 : 1) * p.gainX;
  const sy = (p.invertY ? -1 : 1) * p.gainY;
  const sz = (p.invertZ ? -1 : 1) * p.gainZ;
  const lim = (v: number): number => (p.limit > 0 ? clamp(v, -p.limit, p.limit) : v);
  const ang = (v: number, full: number, s: number): number => lim(deadzone(v, p.deadzone, full) * s);
  const yaw = ang(read(`${pre}yaw`), 180, sy);
  const pitch = ang(read(`${pre}pitch`), 90, sx);
  const roll = ang(read(`${pre}roll`), 180, sz);
  const tr = Math.max(1, p.tiltRange);
  return {
    yaw,
    pitch,
    roll,
    objX: ang(read(`${pre}orx`), 180, sx),
    objY: ang(read(`${pre}ory`), 90, sy),
    objZ: ang(read(`${pre}orz`), 180, sz),
    rateX: read('rx') * sx,
    rateY: read('ry') * sy,
    rateZ: read('rz') * sz,
    accX: read('ax') * sx,
    accY: read('ay') * sy,
    accZ: read('az') * sz,
    shake: clamp(read('shake') * p.shakeGain, 0, 1),
    tiltX: clamp(roll / tr, -1, 1),
    tiltY: clamp(pitch / tr, -1, 1),
    touchX: read('tx'),
    touchY: read('ty'),
    touches: read('tc'),
    pinch: read('pinch'),
    twist: read('twist'),
    panX: read('panx'),
    panY: read('pany'),
    heading: read('heading'),
    posX: read('px'),
    posY: read('py'),
    posZ: read('pz'),
    tap: read('tap'),
  };
}

export default defineNode({
  id: 'phone-motion',
  title: 'Phone Motion',
  category: 'input',
  description:
    'Turns a linked phone into a controller: tilt and turn (gyro), shake, touch pad, pinch and twist, compass and position become numbers for any setting. Wire yaw / pitch / roll into a 3D object\'s rotation or into a Phone Camera Rig. Record a move and replay it exactly, even in exports.',
  keywords: ['gyro', 'gyroscope', 'accelerometer', 'tilt', 'sensor', 'orientation', 'motion control', 'wii', 'remote', 'phone', 'shake', 'touch', 'compass', 'imu', 'controller', 'joystick'],
  inputs: {},
  outputs: MOTION_OUTPUTS,
  params: {
    session: { type: 'string', default: '', label: 'Session', visibleIf: () => false },
    liveTick: { type: 'string', default: '', label: 'Live tick', visibleIf: () => false },
    take: { type: 'json', default: null, label: 'Recorded take', visibleIf: () => false },
    source: {
      type: 'enum',
      default: 'live',
      label: 'Source',
      hint: 'Live reads the phone. Recorded plays the take you recorded: no phone needed, and exports reproduce it exactly.',
      options: [
        { value: 'live', label: 'Live' },
        { value: 'recorded', label: 'Recorded take' },
      ],
      visibleIf: (p) => !!p.take,
    },
    mode: {
      type: 'enum',
      default: 'relative',
      label: 'Angles',
      hint: 'Relative: the pose you recentered at is 0 (use Recenter). Absolute: referenced to north by the compass (needs Android Chrome, or iPhone with the compass); falls back to relative when the phone has none.',
      options: [
        { value: 'relative', label: 'Relative to Recenter' },
        { value: 'absolute', label: 'Absolute' },
      ],
    },
    smoothing: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Smoothing', hint: 'Live only. 0 = raw sensor; higher removes shake with a little lag (one-euro filter: it speeds up on fast moves).' },
    gainX: { type: 'number', default: 1, min: -10, max: 10, step: 0.05, label: 'Gain X', hint: 'Pitch sensitivity.', group: 'Response' },
    gainY: { type: 'number', default: 1, min: -10, max: 10, step: 0.05, label: 'Gain Y', hint: 'Yaw sensitivity.', group: 'Response' },
    gainZ: { type: 'number', default: 1, min: -10, max: 10, step: 0.05, label: 'Gain Z', hint: 'Roll sensitivity.', group: 'Response' },
    invertX: { type: 'bool', default: false, label: 'Invert X', group: 'Response' },
    invertY: { type: 'bool', default: false, label: 'Invert Y', group: 'Response' },
    invertZ: { type: 'bool', default: false, label: 'Invert Z', group: 'Response' },
    deadzone: { type: 'number', default: 0, min: 0, max: 45, step: 0.5, unit: 'deg', label: 'Dead zone', hint: 'Angles smaller than this read 0 (the rest is rescaled).', group: 'Response' },
    limit: { type: 'number', default: 0, min: 0, max: 360, step: 1, unit: 'deg', label: 'Limit angles to ±', hint: '0 = no limit.', group: 'Response' },
    tiltRange: { type: 'number', default: 45, min: 5, max: 180, step: 1, unit: 'deg', label: 'Full tilt', hint: 'How far the phone tilts for Tilt X / Y to reach ±1.', group: 'Response' },
    shakeGain: { type: 'number', default: 1, min: 0, max: 10, step: 0.05, label: 'Shake boost', group: 'Response' },
    recLoop: { type: 'bool', default: false, label: 'Loop take', hint: 'The take repeats; smoothing wraps around the seam.', group: 'Recording' },
    recBlend: { type: 'number', default: 12, min: 0, max: 120, step: 1, integer: true, label: 'Loop blend', hint: 'Fades the last frames into the first so the loop has no jump. Shortens the take by this much.', group: 'Recording', visibleIf: (p) => !!p.recLoop },
    takeSmoothing: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Take smoothing', hint: 'Smooths the recorded take (zero lag: the move is not delayed). 0 = as recorded. "Smooth take" bakes it in; "Reset to raw" undoes the bake.', group: 'Recording', visibleIf: (p) => !!p.take },
    keepFast: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Keep fast moves', hint: 'Smooth small jitter more than large deliberate motion.', group: 'Recording', visibleIf: (p) => !!p.take },
    loopTake: { type: 'bool', default: false, label: 'Repeat the take', hint: 'Play the take again from the start when it ends (otherwise it holds its last pose).', group: 'Recording', visibleIf: (p) => !!p.take },
  },
  summary: (p) => {
    const take = isTake(p.take);
    return `${p.source === 'recorded' && take ? 'recorded take' : 'live'} · ${p.mode} · position: AR if tracking, else location, else touch pad`;
  },
  render(ctx) {
    const p = ctx.params;
    const t = ctx.time.seconds; // live: re-render every frame
    const take = isTake(p.take) ? p.take : null;
    const host = ctx.host;
    const id = `phone.${p.session}`;
    const shape: ShapeParams = p;

    const fromTake = (): Record<keyof typeof MOTION_OUTPUTS, number> => {
      const d = takeDense(take!, { amount: p.takeSmoothing, keepFast: p.keepFast });
      const fr: MotionFrame = sampleTake(d, t, p.loopTake || take!.loop);
      return shapeOutputs((n) => fr[n] ?? 0, shape);
    };
    if (take && p.source === 'recorded') return fromTake();

    const exporting = !!host.signal && host.signal(id, 'export', t) === 1;
    if (exporting || !host.signal) {
      if (take) return fromTake(); // a take exists: use it where live input cannot exist
      throw new Error('Phone Motion is live only. Exports and headless runs have no phone: record a take (Record in the inspector) and set Source to Recorded.');
    }
    if (!p.session) {
      if (take) return fromTake();
      throw new Error('Not linked to a phone yet. Use "Link a phone" in the inspector, scan the QR code and press Start motion on the phone.');
    }
    const live = host.signal(id, 'live', t) === 1;
    // linked, but no motion arriving (the phone has not pressed Start motion, or its page is hidden): neutral values, not an error
    if (!live) return shapeOutputs((n) => (n === 'pinch' ? 1 : 0), shape);
    const sig = host.signal;
    const read = (n: string): number => sig.call(host, id, p.smoothing > 0 && !NO_SMOOTH.has(n) ? `${n}@${p.smoothing}` : n, t);
    return shapeOutputs(read, shape);
  },
});
