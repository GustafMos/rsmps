import { defineNode } from '../../define';
import { orbitPosition, type V3 } from '../../lib/gen-camera';
import type { CameraValue } from '../../types';

const TAU = Math.PI * 2;

export default defineNode({
  id: 'camera',
  title: 'Camera',
  category: 'generate',
  description:
    'A virtual camera for 3D Object nodes. Pick a lens (flat, perspective, fisheye, 360° panorama, cylinder), a viewpoint and optional looping camera motion. Wire it into any number of 3D objects, or give each object its own.',
  keywords: ['lens', 'view', 'panorama', 'panoramic', 'fisheye', 'isometric', 'orthographic', 'perspective', 'orbit', 'dolly', '360', 'equirectangular', '3d'],
  inputs: {},
  outputs: { camera: { type: 'camera', label: 'Camera' } },
  params: {
    projection: {
      type: 'enum',
      default: 'perspective',
      label: 'Lens',
      options: [
        { value: 'perspective', label: 'Perspective' },
        { value: 'orthographic', label: 'Orthographic (flat)' },
        { value: 'isometric', label: 'Isometric (pixel-art 3/4 view)' },
        { value: 'dimetric', label: 'Dimetric (2:1 pixel-art view)' },
        { value: 'fisheye', label: 'Fisheye' },
        { value: 'panoramic', label: 'Panorama 360°' },
        { value: 'cylindrical', label: 'Cylindrical 360°' },
      ],
    },
    rig: {
      type: 'enum',
      default: 'orbit',
      label: 'Viewpoint',
      options: [
        { value: 'orbit', label: 'Orbit (angle + distance)' },
        { value: 'threeQuarter', label: 'Three-quarter' },
        { value: 'front', label: 'Front' },
        { value: 'side', label: 'Side' },
        { value: 'top', label: 'Top' },
        { value: 'free', label: 'Free (position + target)' },
      ],
    },
    motion: {
      type: 'enum',
      default: 'none',
      label: 'Motion',
      options: [
        { value: 'none', label: 'None' },
        { value: 'orbit', label: 'Orbit around' },
        { value: 'dolly', label: 'Dolly in and out' },
        { value: 'sway', label: 'Sway side to side' },
        { value: 'roll', label: 'Roll' },
      ],
    },
    cycles: {
      type: 'number',
      default: 1,
      min: 1,
      max: 16,
      step: 1,
      integer: true,
      unit: 'cycles',
      label: 'Motion cycles per loop',
      hint: 'Whole repeats per loop so the motion loops exactly.',
      visibleIf: (p) => p.motion !== 'none',
    },
    motionAmount: {
      type: 'number',
      default: 0.35,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Motion amount',
      hint: 'Dolly: fraction of the distance. Sway: fraction of 60°. Orbit and roll always do whole turns.',
      visibleIf: (p) => p.motion === 'dolly' || p.motion === 'sway',
    },
    fov: { type: 'number', default: 40, min: 5, max: 360, step: 1, unit: 'deg', label: 'Field of view', hint: 'Across the frame’s shorter side. Fisheye accepts up to 360°; for cylindrical it is the vertical view.', visibleIf: (p) => p.projection === 'perspective' || p.projection === 'fisheye' || p.projection === 'cylindrical' },
    orthoSize: { type: 'number', default: 2.8, min: 0.1, max: 40, step: 0.05, label: 'View size', hint: 'How many scene units fit across the shorter side. Smaller = zoomed in.', visibleIf: (p) => p.projection === 'orthographic' || p.projection === 'isometric' || p.projection === 'dimetric' },
    distance: { type: 'number', default: 0, min: 0, max: 60, step: 0.05, label: 'Distance', hint: '0 = automatic: far enough for a normal lens, close for fisheye / panorama / cylinder where the object needs to fill more of the view.', visibleIf: (p) => p.rig !== 'free' },
    azimuth: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Angle around', visibleIf: (p) => p.rig === 'orbit' },
    elevation: { type: 'number', default: 15, min: -89, max: 89, step: 1, unit: 'deg', label: 'Height angle', visibleIf: (p) => p.rig === 'orbit' },
    posX: { type: 'number', default: 0, min: -60, max: 60, step: 0.05, label: 'Position X', group: 'Free viewpoint', visibleIf: (p) => p.rig === 'free' },
    posY: { type: 'number', default: 1, min: -60, max: 60, step: 0.05, label: 'Position Y', group: 'Free viewpoint', visibleIf: (p) => p.rig === 'free' },
    posZ: { type: 'number', default: -4.5, min: -60, max: 60, step: 0.05, label: 'Position Z', group: 'Free viewpoint', visibleIf: (p) => p.rig === 'free' },
    targetX: { type: 'number', default: 0, min: -60, max: 60, step: 0.05, label: 'Look-at X', group: 'Free viewpoint' },
    targetY: { type: 'number', default: 0, min: -60, max: 60, step: 0.05, label: 'Look-at Y', group: 'Free viewpoint' },
    targetZ: { type: 'number', default: 0, min: -60, max: 60, step: 0.05, label: 'Look-at Z', group: 'Free viewpoint' },
    roll: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Roll', hint: 'Tilt the horizon.' },
    shiftX: { type: 'number', default: 0, min: -2, max: 2, step: 0.01, label: 'Lens shift X', hint: 'Slides the picture sideways without changing perspective (fraction of the shorter side).' },
    shiftY: { type: 'number', default: 0, min: -2, max: 2, step: 0.01, label: 'Lens shift Y', hint: 'Slides the picture up or down without changing perspective.' },
  },
  summary: (p) => `${p.projection} · ${p.rig}${p.motion !== 'none' ? ` · ${p.motion} ×${p.cycles}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    let projection: CameraValue['projection'];
    let rig: string = p.rig;
    let az = p.azimuth;
    let el = p.elevation;
    switch (p.projection) {
      case 'isometric':
        projection = 'orthographic';
        rig = 'orbit';
        az = 45;
        el = 35.264;
        break;
      case 'dimetric':
        projection = 'orthographic';
        rig = 'orbit';
        az = 45;
        el = 30;
        break;
      default:
        projection = p.projection as CameraValue['projection'];
    }
    switch (rig) {
      case 'threeQuarter':
        az = 35;
        el = 25;
        break;
      case 'front':
        az = 0;
        el = 0;
        break;
      case 'side':
        az = 90;
        el = 0;
        break;
      case 'top':
        az = 0;
        el = 90;
        break;
    }

    const moving = p.motion !== 'none';
    const phase = moving ? ctx.time.phase : 0;
    const wave = Math.sin(TAU * p.cycles * phase);
    const autoDist = p.projection === 'panoramic' ? 1.7 : p.projection === 'fisheye' || p.projection === 'cylindrical' ? 2.3 : 4.5;
    const baseDist = p.distance > 0 ? p.distance : autoDist;
    let dist = baseDist;
    let roll = p.roll;
    if (moving) {
      if (p.motion === 'orbit') az += 360 * p.cycles * phase;
      else if (p.motion === 'sway') {
        az += wave * 60 * p.motionAmount;
        el += Math.cos(TAU * p.cycles * phase) * 15 * p.motionAmount;
      } else if (p.motion === 'dolly') dist *= 1 + wave * p.motionAmount;
      else if (p.motion === 'roll') roll += 360 * p.cycles * phase;
    }

    const target: V3 = [p.targetX, p.targetY, p.targetZ];
    let position: V3;
    if (rig === 'free') {
      position = [p.posX, p.posY, p.posZ];
      if (moving) {
        // free rig: motion works around the look-at point, keeping the starting distance
        const off: V3 = [position[0] - target[0], position[1] - target[1], position[2] - target[2]];
        const d0 = Math.hypot(...off) || 1;
        const baseAz = (Math.atan2(off[0], -off[2]) * 180) / Math.PI;
        const baseEl = (Math.asin(off[1] / d0) * 180) / Math.PI;
        const dAz = az - p.azimuth; // motion only changes az/el relative to the rig's own start
        position = orbitPosition(target, d0 * (dist / baseDist), baseAz + dAz, baseEl + (el - p.elevation));
      }
    } else {
      position = orbitPosition(target, dist, az, el);
    }

    const camera: CameraValue = {
      kind: 'camera',
      projection,
      fov: p.fov,
      orthoSize: p.orthoSize,
      position,
      target,
      roll,
      shift: [p.shiftX, p.shiftY],
    };
    return { camera };
  },
});
