import { defineNode } from '../../define';
import { clamp, deadzone } from '../../lib/motion-math';
import { isTake } from '../../lib/motion-take';
import { SENSORS_FROM_OPTIONS, motionReader } from '../../lib/motion-source';

/**
 * Phone Motion: a phone's gyroscope, accelerometer, compass, touch pad and (optionally) position as numbers you can wire into any number
 * setting. The phone is either one linked by QR code or, with "Sensors from: This device", the phone or tablet the app itself runs on
 * (io/device-sensors.ts feeds the same channels). Live values come through the signal bridge (`Host.signal('phone.<session>', channel)`, see io/phone-motion.ts); with a recorded
 * take (the inspector's Record button) it can instead read the take, which needs no phone and reproduces exactly in exports and the CLI.
 * Angles are in degrees and unwrapped, so they do not jump at +-180.
 */

/** Channels that are not smoothed (counts, pulses, the shake envelope already has its own attack and release). */
export const NO_SMOOTH: ReadonlySet<string> = new Set(['tc', 'tap', 'jolt', 'shake']);

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
  jolt: { type: 'number', label: 'Jolt (1 for a moment)', hint: 'A short pulse each time the phone is bumped or flicked.' },
  gravX: { type: 'number', label: 'Gravity X (-1..1)', hint: 'Which way is down on the screen. Above 0 when the right edge is lower. Wire it into a position to make things fall.' },
  gravY: { type: 'number', label: 'Gravity Y (-1..1)', hint: '-1 when the phone is upright, 0 when it lies flat, +1 upside down.' },
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

/** The same readings bundled three to a wire (vector sockets), next to the single numbers above. */
export const MOTION_VECTOR_OUTPUTS = {
  rotation: { type: 'vector', label: 'Object rotate XYZ', hint: 'Object rotate X, Y and Z on one wire: into the Rotate vector socket of a 3D node.' },
  rate: { type: 'vector', label: 'Rotation rate XYZ' },
  acceleration: { type: 'vector', label: 'Acceleration XYZ' },
  position: { type: 'vector', label: 'Position XYZ (m)', hint: 'Position X, Y and Z on one wire: into the Move vector socket of a 3D node.' },
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
    jolt: read('jolt'),
    gravX: clamp(read('gx'), -1, 1),
    gravY: clamp(read('gy'), -1, 1),
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
    'Turns a phone into a controller: tilt and turn (gyro), shake, gravity, touch pad, pinch and twist, compass and position become numbers for any setting. Use a phone linked by QR code, or the sensors of the phone or tablet the app runs on (Sensors from: This device). Wire yaw / pitch / roll into a 3D object\'s rotation or into a Phone Camera Rig. Record a move and replay it exactly, even in exports.',
  keywords: ['gyro', 'gyroscope', 'accelerometer', 'tilt', 'sensor', 'orientation', 'motion control', 'wii', 'remote', 'phone', 'shake', 'touch', 'compass', 'imu', 'controller', 'joystick', 'gravity', 'device', 'this device', 'jolt'],
  inputs: {},
  outputs: { ...MOTION_OUTPUTS, ...MOTION_VECTOR_OUTPUTS },
  params: {
    session: { type: 'string', default: '', label: 'Session', visibleIf: () => false },
    liveTick: { type: 'string', default: '', label: 'Live tick', visibleIf: () => false },
    take: { type: 'json', default: null, label: 'Recorded take', visibleIf: () => false },
    device: {
      type: 'enum',
      default: 'linked',
      label: 'Sensors from',
      hint: 'Linked phone: a second phone linked by QR code (needs the desktop app or LAN mode). This device: the motion sensors of the phone or tablet this app is running on. Nothing leaves the device.',
      options: [...SENSORS_FROM_OPTIONS],
    },
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
    const from = p.source === 'recorded' && take ? 'recorded take' : p.device === 'this' ? 'live, this device' : 'live';
    return p.device === 'this' ? `${from} · ${p.mode}` : `${from} · ${p.mode} · position: AR if tracking, else location, else touch pad`;
  },
  render(ctx) {
    const p = ctx.params;
    // the reader takes the clock, so the node renders again every frame while live
    const o = shapeOutputs(motionReader(p, ctx.host, ctx.time.seconds, 'Phone Motion', NO_SMOOTH), p);
    return { ...o, rotation: [o.objX, o.objY, o.objZ], rate: [o.rateX, o.rateY, o.rateZ], acceleration: [o.accX, o.accY, o.accZ], position: [o.posX, o.posY, o.posZ] };
  },
});
