import { defineNode } from '../../define';
import type { CameraValue, ImageValue } from '../../types';
import { cameraSource } from '../../lib/live-source';
import { defaultRigCamera } from '../../lib/motion-rig';
import { isWorldTake, sampleWorldTake, worldTakeDuration, type WorldMoment } from '../../lib/world-take';
import { awayCamera, worldCamera } from '../../lib/xr-math';
import { lightForScene } from '../../lib/xr-light';

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
 * LIGHT AND FLOOR. Besides the pose the camera carries two optional facts, which the 3D nodes read from their Camera input: `ground`
 * (where the real surface the object stands on is, as a y in scene units: under the object by the Lift and the height the object was
 * raised, so an object held 30 cm above the floor casts its shadow 30 cm below itself) and, when the phone estimates the light of the
 * room and "Match the room's light" is on, `light` (azimuth, height, ambient, strength in the terms of the 3D nodes' light settings). The
 * same numbers are outputs, so they can also be wired by hand. The estimate comes in smoothed and holds its last value; a take records it.
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

// The Picture and Zoom sockets and the five light sockets stay hidden until wired or until "Advanced outputs" is on: the room light reaches
// the 3D objects through the Camera value itself, nothing needs wiring.
const advOut = (p: Record<string, unknown>): boolean => p.advOut === true;

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
    lightAzimuth: { type: 'number', label: 'Light azimuth', hint: 'Where the room\'s main light comes from, left to right, as the Light azimuth of the 3D nodes. Their own value when the phone cannot estimate the light.', visibleIf: advOut },
    lightElevation: { type: 'number', label: 'Light height', hint: 'How high the room\'s main light is, as the Light height of the 3D nodes.', visibleIf: advOut },
    lightStrength: { type: 'number', label: 'Light strength', hint: 'How bright the main light is (1 = the lamp the 3D nodes assume).', visibleIf: advOut },
    ambient: { type: 'number', label: 'Ambient', hint: 'How much of the room\'s light comes from everywhere (0 to 1), as the Ambient light of the 3D nodes.', visibleIf: advOut },
    ambientColor: { type: 'color', label: 'Ambient colour', hint: 'The colour of the room\'s ambient light.', visibleIf: advOut },
    zoom: { type: 'number', label: 'Zoom', visibleIf: advOut, hint: 'The AR view\'s zoom at this moment of the take (1 = none). The saved video uses it to zoom the camera clip the same way.' },
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
    advOut: { type: 'bool', default: false, label: 'Advanced outputs', hint: 'Shows the Zoom and the five Light sockets on the node. You never need them for the room light: it reaches the 3D objects through the camera.', group: 'Advanced' },
    matchLight: {
      type: 'bool',
      default: true,
      label: 'Match room light',
      hint: 'While the AR view is open (and in a take recorded with it), the 3D nodes that take this camera light their object like the room: the light\'s direction and how much is ambient. Needs a phone that estimates light; the AR view says "light: yes" or "light: no". Switched off, the phone is not asked to estimate light at all, which saves it some work. A 3D node can opt out with its "Light from camera".',
      group: 'AR view',
      visibleIf: () => false, // shown in the inspector's Room light block
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
    recordRate: {
      type: 'enum',
      default: 'project',
      label: 'Recording rate',
      hint: 'How many times a second the AR view notes the phone and takes a camera picture while recording, and the frame rate of the saved video. The phone\'s AR camera often runs at 30: asking for more records at what it gives, and the AR view says so.',
      group: 'AR view',
      options: [
        { value: 'project', label: 'Match project' },
        { value: '24', label: '24 per second' },
        { value: '25', label: '25 per second' },
        { value: '30', label: '30 per second' },
        { value: '60', label: '60 per second' },
      ],
    },
    steadying: {
      type: 'enum',
      default: 'auto',
      label: 'Steadying',
      hint: 'How steady the object stays when the phone moves. Automatic: the object is drawn a little ahead only while you clearly walk or swing the phone, and not at all while you hold still. Off: always for where the phone is now. Predict movement: always ahead, which helps on fast moves when the picture is late and can add wobble when holding still.',
      group: 'AR view',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'off', label: 'Off, as before' },
        { value: 'predict', label: 'Predict movement' },
      ],
    },
    saveVideo: {
      type: 'bool',
      default: true,
      label: 'Save video',
      hint: 'After you close the AR view, make a video file of the recording: the camera picture with the object over it. It is added to Media and downloaded.',
      group: 'AR view',
    },
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
  guide: {
    does: 'A camera that follows your phone through the room, so a 3D object stands on the real floor and is lit and shadowed like the room. It only affects the 3D objects wired to it.',
    steps: [
      'Select a 3D object and press Show in AR in its Camera section: this adds the camera and wires the object to it. You can also tick objects in the list "Objects in AR" below.',
      'View the object (the eye on its node), then press Start AR (Android Chrome), move the phone until a ring shows on the floor and tap to place.',
      'The room light and the real floor reach every wired object by themselves: there is nothing else to wire. You can use several cameras, each with its own objects.',
    ],
    seeAlso: ['object-3d', 'physics', 'camera'],
  },
  summary: (p) => (isWorldTake(p.take) ? `recorded take · ${worldTakeDuration(p.take).toFixed(1)} s` : 'no take yet'),
  async render(ctx) {
    const p = ctx.params;
    let m: WorldMoment | null = null;
    if (isMoment(p.live)) m = p.live;
    else if (isWorldTake(p.take)) m = sampleWorldTake(p.take, ctx.time.seconds - p.startAt, p.loopTake);
    const zoom = m?.zoom && m.zoom > 0 ? m.zoom : 1;
    const sceneLight = m?.light && m.object ? lightForScene(m.light, m.object.q) : null;
    let camera: CameraValue;
    if (!m) camera = { ...defaultRigCamera(), position: [0, 1, -4.5] }; // nothing to follow: an ordinary camera above the object, looking at it
    else if (!m.object) camera = awayCamera(); // tracked, but nothing is placed (yet): the object must not show
    else {
      camera = worldCamera(m.view, m.lens, { p: m.object.p, q: m.object.q, yaw: 0, scale: m.object.scale }, { unit: p.size / 2, lift: p.lift }, ctx.canvas);
      // the real surface in scene units: the object's origin floats `lift` above it (plus the height it was raised to, in scene units)
      camera = { ...camera, ground: -p.lift - (m.object.h ?? 0) / Math.max(1e-6, m.object.scale * (p.size / 2)), ...(typeof m.physics === 'number' && m.physics >= 0 ? { clock: m.physics } : {}) };
      if (sceneLight && p.matchLight) camera = { ...camera, light: { azimuth: sceneLight.azimuth, elevation: sceneLight.elevation, ambient: sceneLight.ambient, strength: sceneLight.strength } };
    }
    const lightOut = {
      lightAzimuth: sceneLight ? sceneLight.azimuth : -35,
      lightElevation: sceneLight ? sceneLight.elevation : 40,
      lightStrength: sceneLight ? sceneLight.strength : 1,
      ambient: sceneLight ? sceneLight.ambient : 0.35,
      ambientColor: (m?.light ? [...m.light.ambientColor, 1] : [1, 1, 1, 1]) as [number, number, number, number],
    };
    // the Picture costs a camera copy every frame: only made when something is wired to it (asking the host also tells it the picture is in use)
    if (!ctx.wants('picture')) return { camera, zoom, ...lightOut };
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
      if (!ar.frame) return { camera, zoom, ...lightOut, picture: clear() };
      return { camera, zoom, ...lightOut, picture: { kind: 'image', texture: ar.frame.texture, width: ar.frame.width, height: ar.frame.height, unit: ctx.unitFor(ar.frame.width, ar.frame.height) } };
    }
    // no AR view: the back camera of this device, through the same path as a Webcam node set to the back camera
    if (!host.liveFrame) return { camera, zoom, ...lightOut, picture: clear() };
    const source = cameraSource({ device: '', facing: 'back', resolution: 'auto' });
    if (host.liveBlocked?.(source)) return { camera, zoom, ...lightOut, picture: clear() };
    const maxSide = ctx.proxy < 1 ? Math.ceil(Math.max(ctx.canvas.width, ctx.canvas.height)) : 0;
    let frame: Awaited<ReturnType<NonNullable<typeof host.liveFrame>>> = null;
    try {
      frame = await host.liveFrame(source, maxSide, ctx.time.seconds);
    } catch {
      frame = null; // no camera, refused, in use: a transparent picture, not an error (the graph can still be built)
    }
    if (!frame) return { camera, zoom, ...lightOut, picture: clear() };
    return { camera, zoom, ...lightOut, picture: { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit: ctx.unitFor(frame.width, frame.height) } };
  },
});
