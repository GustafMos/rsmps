import { defineNode } from '../../define';
import { qNorm } from '../../lib/motion-math';
import { cameraFromQuat } from '../../lib/motion-rig';
import { isTake } from '../../lib/motion-take';
import { SENSORS_FROM_OPTIONS, motionReader } from '../../lib/motion-source';

/**
 * AR Camera: a 3D camera that turns exactly like the phone, so a 3D object stays where it is in the room while the phone looks
 * around (turning only: walking is not followed). It reads the "level" orientation of the motion session (true to gravity, only the
 * heading is recentered) as a quaternion, so there is no gimbal lock when the phone points up or down. Same sources and the same
 * recorded-take story as Phone Motion: the inspector panel and the hidden params are shared.
 */
const NO_SMOOTH: ReadonlySet<string> = new Set();

export default defineNode({
  id: 'ar-camera',
  title: 'AR Camera',
  category: 'input',
  description:
    'A 3D camera that follows the way the phone is pointing, so a 3D object stays put in the room while you look around (turning only, not walking). Wire it into a 3D Object\'s Camera input and merge the object over the Webcam picture of the back camera. Record a move to export it.',
  keywords: ['ar', 'augmented reality', 'gyro', 'gyroscope', 'device camera', 'phone', 'orientation', 'look around', '3d', 'camera', 'window', 'world', 'sensor', 'this device', 'vr'],
  inputs: {},
  outputs: { camera: { type: 'camera', label: 'Camera' } },
  params: {
    session: { type: 'string', default: '', label: 'Session', visibleIf: () => false },
    liveTick: { type: 'string', default: '', label: 'Live tick', visibleIf: () => false },
    take: { type: 'json', default: null, label: 'Recorded take', visibleIf: () => false },
    device: {
      type: 'enum',
      default: 'linked',
      label: 'Sensors from',
      hint: 'This device: the phone or tablet this app is running on. Linked phone: a second phone linked by QR code (needs the desktop app or LAN mode).',
      options: [...SENSORS_FROM_OPTIONS],
    },
    source: {
      type: 'enum',
      default: 'live',
      label: 'Source',
      hint: 'Live follows the phone. Recorded plays the take you recorded: no sensors needed, and exports reproduce it exactly.',
      options: [
        { value: 'live', label: 'Live' },
        { value: 'recorded', label: 'Recorded take' },
      ],
      visibleIf: (p) => !!p.take,
    },
    fov: {
      type: 'number',
      default: 45,
      min: 5,
      max: 150,
      step: 0.5,
      unit: 'deg',
      label: 'Field of view',
      hint: 'Across the picture\'s shorter side, like 3D Camera. It must match the real camera: a phone\'s main back camera is about 40 for wide (16:9) video and about 52 for 4:3. Turn the phone slowly and adjust until the object stops sliding against the camera picture.',
    },
    distance: { type: 'number', default: 4.5, min: 0, max: 100, step: 0.05, label: 'Distance', hint: 'How far in front of you the middle of the 3D scene is after Recenter.' },
    height: { type: 'number', default: 0, min: -100, max: 100, step: 0.05, label: 'Eye height', hint: 'Raises the camera: above 0 the scene sits lower, as if it stood on the floor.' },
    smoothing: { type: 'number', default: 0.15, min: 0, max: 1, step: 0.01, label: 'Smoothing', hint: 'Live only. 0 = raw sensor. Higher is calmer but the object trails behind the camera picture when you turn fast.' },
    recLoop: { type: 'bool', default: false, label: 'Loop take', hint: 'The take repeats; smoothing wraps around the seam.', group: 'Recording' },
    recBlend: { type: 'number', default: 12, min: 0, max: 120, step: 1, integer: true, label: 'Loop blend', hint: 'Fades the last frames into the first so the loop has no jump. Shortens the take by this much.', group: 'Recording', visibleIf: (p) => !!p.recLoop },
    takeSmoothing: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Take smoothing', hint: 'Smooths the recorded take (zero lag: the move is not delayed). 0 = as recorded.', group: 'Recording', visibleIf: (p) => !!p.take },
    keepFast: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Keep fast moves', hint: 'Smooth small jitter more than large deliberate motion.', group: 'Recording', visibleIf: (p) => !!p.take },
    loopTake: { type: 'bool', default: false, label: 'Repeat the take', hint: 'Play the take again from the start when it ends (otherwise it holds its last pose).', group: 'Recording', visibleIf: (p) => !!p.take },
  },
  summary: (p) => `${p.source === 'recorded' && isTake(p.take) ? 'recorded take' : p.device === 'this' ? 'live, this device' : 'live, linked phone'} · ${p.fov}°`,
  render(ctx) {
    const p = ctx.params;
    const read = motionReader(p, ctx.host, ctx.time.seconds, 'AR Camera', NO_SMOOTH);
    // the four numbers are smoothed one by one, so they are made unit length again here
    const q = qNorm([read('lqx'), read('lqy'), read('lqz'), read('lqw')]);
    return { camera: cameraFromQuat(q, { fov: p.fov, distance: p.distance, height: p.height }) };
  },
});
