import { defineNode } from '../../define';
import type { CameraValue, ImageValue } from '../../types';
import { cameraSource } from '../../lib/live-source';
import { defaultRigCamera } from '../../lib/motion-rig';
import { isWorldTake, sampleWorldTake, worldTakeDuration, type WorldMoment } from '../../lib/world-take';
import { awayCamera, worldCamera } from '../../lib/xr-math';

/**
 * World AR Camera: the camera of the phone as the browser's built-in AR (WebXR) tracks it through the room, position and all, seen
 * from the object the user placed on a real surface. The object is the scene: it stays at the origin, where every 3D node puts it,
 * and this camera moves around it.
 *
 * Its Picture output is the live camera picture, so it can go into a material or any effect while the Webcam node is cut off by the AR
 * view: in the AR view it is the AR camera frame (the host copies it once per camera frame, and only while this output is wired); with
 * no AR view it is the device's back camera through the ordinary live path; with neither it is transparent. `liveTick` is stamped by
 * the player (only while Picture is wired) so the picture is never served from the evaluation cache.
 *
 * The camera has three sources and picks by itself:
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
    'Experimental. A 3D camera that follows the phone through the room (walking included) using the browser\'s built-in AR, so a 3D object stands on a real floor or table. Wire it into a 3D Object\'s Camera input, view the object and press "Start AR" in the inspector (Android Chrome). A recorded take plays back in the normal viewer, in step with the camera clip recorded with it. The Picture output is what the camera sees right now (in AR, the AR camera picture; outside AR, the back camera), so you can use the room as a texture.',
  keywords: ['ar', 'augmented reality', 'webxr', 'arcore', 'world', 'room', 'floor', 'table', 'place', 'anchor', 'surface', 'tracking', '6dof', 'walk', 'phone', 'camera', '3d', 'markerless'],
  inputs: {},
  outputs: {
    camera: { type: 'camera', label: 'Camera' },
    picture: { type: 'image', label: 'Picture' },
  },
  optionalOutputs: ['picture'],
  params: {
    live: { type: 'json', default: null, label: 'Live pose', visibleIf: () => false },
    liveTick: { type: 'string', default: '', label: 'Live tick', visibleIf: () => false },
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
  async render(ctx) {
    const p = ctx.params;
    let m: WorldMoment | null = null;
    if (isMoment(p.live)) m = p.live;
    else if (isWorldTake(p.take)) m = sampleWorldTake(p.take, ctx.time.seconds - p.startAt, p.loopTake);
    let camera: CameraValue;
    if (!m) camera = { ...defaultRigCamera(), position: [0, 1, -4.5] }; // nothing to follow: an ordinary camera above the object, looking at it
    else if (!m.object) camera = awayCamera(); // tracked, but nothing is placed (yet): the object must not show
    else camera = worldCamera(m.view, m.lens, { p: m.object.p, q: m.object.q, yaw: 0, scale: m.object.scale }, { unit: p.size / 2, lift: p.lift }, ctx.canvas);
    // the Picture costs a camera copy every frame: only made when something is wired to it (asking the host also tells it the picture is in use)
    if (!ctx.wants('picture')) return { camera };
    void ctx.time.seconds; // live: re-render every frame
    const clear = (): ImageValue => {
      const width = Math.max(1, Math.round(ctx.canvas.width));
      const height = Math.max(1, Math.round(ctx.canvas.height));
      return ctx.gpu.pass({ label: 'world-ar-clear', size: { width, height, unit: ctx.unitFor(width, height) }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0); }' });
    };
    const host = ctx.host;
    const ar = host.arCameraFrame?.();
    if (ar?.session) {
      // the AR view owns the camera: its own frame, or nothing where the phone does not hand it over (or none came yet)
      if (!ar.frame) return { camera, picture: clear() };
      return { camera, picture: { kind: 'image', texture: ar.frame.texture, width: ar.frame.width, height: ar.frame.height, unit: ctx.unitFor(ar.frame.width, ar.frame.height) } };
    }
    // no AR view: the back camera of this device, through the same path as a Webcam node set to the back camera
    if (!host.liveFrame) return { camera, picture: clear() };
    const source = cameraSource({ device: '', facing: 'back', resolution: 'auto' });
    if (host.liveBlocked?.(source)) return { camera, picture: clear() };
    const maxSide = ctx.proxy < 1 ? Math.ceil(Math.max(ctx.canvas.width, ctx.canvas.height)) : 0;
    let frame: Awaited<ReturnType<NonNullable<typeof host.liveFrame>>> = null;
    try {
      frame = await host.liveFrame(source, maxSide, ctx.time.seconds);
    } catch {
      frame = null; // no camera, refused, in use: a transparent picture, not an error (the graph can still be built)
    }
    if (!frame) return { camera, picture: clear() };
    return { camera, picture: { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit: ctx.unitFor(frame.width, frame.height) } };
  },
});
