import { defineNode } from '../../define';
import { applyRig, defaultRigCamera } from '../../lib/motion-rig';

/**
 * Phone Camera Rig: a normal camera value whose view direction follows the phone (the phone is a window you look around with) and whose
 * position can follow the phone's position. It does not talk to the phone itself: wire Phone Motion's yaw / pitch / roll (and Position
 * X / Y / Z) into it, so it works the same from a live phone or a recorded take, and the result goes into any 3D node's camera input.
 */
export default defineNode({
  id: 'phone-camera-rig',
  title: 'Phone 3D Camera Rig',
  category: 'input',
  description: 'Look around a 3D scene by moving a phone. Wire Phone Motion\'s yaw, pitch and roll (and position) in; the camera output goes into any 3D node. Orbit mode makes the phone swing the camera round the object instead.',
  keywords: ['phone', 'gyro', 'camera', 'look around', 'orbit', '3d', 'vr', 'window', 'rig', 'first person', 'head', 'phone camera rig', '3d camera'],
  inputs: { camera: { type: 'camera', label: 'Camera (optional)' } },
  outputs: { camera: { type: 'camera', label: 'Camera' } },
  params: {
    yaw: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.1, unit: 'deg', label: 'Yaw', hint: 'Wire Phone Motion → Yaw.' },
    pitch: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.1, unit: 'deg', label: 'Pitch', hint: 'Wire Phone Motion → Pitch. Held within ±89.5° so the horizon never flips.' },
    roll: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.1, unit: 'deg', label: 'Roll', hint: 'Wire Phone Motion → Roll.' },
    posX: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'Move X', group: 'Position', hint: 'Wire Phone Motion → Position X (meters). Scaled by "Scene units per meter".' },
    posY: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'Move Y', group: 'Position' },
    posZ: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'Move Z', group: 'Position' },
    moveScale: { type: 'number', default: 1, min: -1000, max: 1000, step: 0.05, label: 'Units per meter', group: 'Position' },
    heightOffset: { type: 'number', default: 0, min: -1000, max: 1000, step: 0.05, label: 'Height offset', group: 'Position', hint: 'Raises or lowers the camera.' },
    orbit: { type: 'bool', default: false, label: 'Orbit mode', hint: 'Off: the camera turns its head where it stands. On: the phone swings the camera round the target, always looking at it.' },
    lockRoll: { type: 'bool', default: false, label: 'Lock roll', hint: 'Ignore the phone\'s roll: the horizon stays level.' },
  },
  summary: (p) => `${p.orbit ? 'orbit' : 'look around'}${p.lockRoll ? ' · level horizon' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const base = ctx.in.camera ?? defaultRigCamera();
    const camera = applyRig(base, p.yaw, p.pitch, p.roll, [p.posX, p.posY, p.posZ], { orbit: p.orbit, lockRoll: p.lockRoll, heightOffset: p.heightOffset, moveScale: p.moveScale });
    return { camera };
  },
});
