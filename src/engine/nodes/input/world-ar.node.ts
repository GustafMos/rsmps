import { defineNode } from '../../define';
import { defaultRigCamera } from '../../lib/motion-rig';
import { isWorldTake, sampleWorldTake, worldTakeDuration, type WorldMoment } from '../../lib/world-take';
import { awayCamera, worldCamera } from '../../lib/xr-math';

/**
 * World AR Camera: the camera of the phone as the browser's built-in AR (WebXR) tracks it through the room, position and all, seen
 * from the object the user placed on a real surface. The object is the scene: it stays at the origin, where every 3D node puts it,
 * and this camera moves around it.
 *
 * It has three sources and picks by itself:
 *  - the AR view is open: the view hands the pose of each camera frame in through the hidden `live` param (it evaluates a copy of the
 *    graph with that param filled in, the way live picture nodes get their tick), so the picture is rendered for exactly that pose;
 *  - a recorded take: plays it by the clock, in step with the camera clip recorded with it, so effects and exports work;
 *  - neither: an ordinary camera in front of the object, so the object can be designed in the normal viewer.
 */
function isMoment(v: unknown): v is WorldMoment {
  const m = v as WorldMoment | null;
  return !!m && typeof m === 'object' && !!m.view && Array.isArray(m.view.p) && Array.isArray(m.view.q) && Array.isArray(m.lens) && m.lens.length === 4;
}

export default defineNode({
  id: 'world-ar',
  title: 'World AR Camera',
  category: 'input',
  description:
    'Experimental. A 3D camera that follows the phone through the room (walking included) using the browser\'s built-in AR, so a 3D object stands on a real floor or table. Wire it into a 3D Object\'s Camera input, view the object and press "Open AR view" in the inspector (Android Chrome). A recorded take plays back in the normal viewer, in step with the camera clip recorded with it.',
  keywords: ['ar', 'augmented reality', 'webxr', 'arcore', 'world', 'room', 'floor', 'table', 'place', 'anchor', 'surface', 'tracking', '6dof', 'walk', 'phone', 'camera', '3d', 'markerless'],
  inputs: {},
  outputs: { camera: { type: 'camera', label: 'Camera' } },
  params: {
    live: { type: 'json', default: null, label: 'Live pose', visibleIf: () => false },
    take: { type: 'json', default: null, label: 'Recorded take', visibleIf: () => false },
    size: {
      type: 'number',
      default: 0.5,
      min: 0.01,
      max: 50,
      step: 0.01,
      label: 'Object size',
      hint: 'How wide a default 3D Object is in the room, in meters. Pinching in the AR view scales on top of this.',
    },
    lift: {
      type: 'number',
      default: 1,
      min: -10,
      max: 10,
      step: 0.01,
      label: 'Lift',
      hint: '1 stands a default 3D Object on the surface. 0 puts its middle on the surface (half of it is below).',
    },
    cardMode: {
      type: 'enum',
      default: 'upright',
      label: 'Flat pictures',
      hint: 'How a picture that does not look through this camera (any ordinary node) stands in the room when you open the AR view on it.',
      group: 'AR view',
      options: [
        { value: 'upright', label: 'Standing' },
        { value: 'flat', label: 'Lying on the surface' },
        { value: 'billboard', label: 'Always facing you' },
      ],
    },
    cardWidth: { type: 'number', default: 0.5, min: 0.02, max: 20, step: 0.01, label: 'Picture width', hint: 'Width of a flat picture in the room, in meters.', group: 'AR view' },
    startAt: {
      type: 'number',
      default: 0,
      min: -3600,
      max: 3600,
      step: 0.01,
      unit: 's',
      label: 'Take starts at',
      hint: 'When the take begins on the timeline. Keep it the same as the start of its camera clip.',
      group: 'Recording',
      visibleIf: (p) => !!p.take,
    },
    loopTake: { type: 'bool', default: false, label: 'Repeat the take', hint: 'Play the take again from the start when it ends (otherwise it holds its last pose).', group: 'Recording', visibleIf: (p) => !!p.take },
  },
  summary: (p) => (isWorldTake(p.take) ? `recorded take · ${worldTakeDuration(p.take).toFixed(1)} s` : 'no take yet'),
  render(ctx) {
    const p = ctx.params;
    let m: WorldMoment | null = null;
    if (isMoment(p.live)) m = p.live;
    else if (isWorldTake(p.take)) m = sampleWorldTake(p.take, ctx.time.seconds - p.startAt, p.loopTake);
    // nothing to follow: an ordinary camera, a little above the object and looking at it
    if (!m) return { camera: { ...defaultRigCamera(), position: [0, 1, -4.5] } };
    // tracked, but nothing is placed (yet): the object must not show
    if (!m.object) return { camera: awayCamera() };
    const placement = { p: m.object.p, q: m.object.q, yaw: 0, scale: m.object.scale };
    return { camera: worldCamera(m.view, m.lens, placement, { unit: p.size / 2, lift: p.lift }, ctx.canvas) };
  },
});
