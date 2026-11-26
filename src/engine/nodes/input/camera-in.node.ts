import { defineNode } from '../../define';
import { liveInputKernel } from '../../audio/live-input';
import { cameraSource, liveOrientOfNode } from '../../lib/live-source';

/**
 * Live webcam. The host opens the camera lazily, shares one stream between nodes using the same device and
 * closes it when nothing has asked for a frame for a few seconds. Live only: exports and headless runs have
 * no camera, so the node reports a readable error there (the Record button in the inspector saves the picture as a clip in Media).
 * `liveTick` is stamped by the player so a live picture is never served from the evaluation cache; leave it alone.
 */
export default defineNode({
  id: 'camera-in',
  title: 'Webcam',
  category: 'input',
  description: 'Live picture from a webcam, the camera of this phone or tablet, or another capture device (not the 3D camera; see 3D Camera). Needs camera permission. Live preview only: to export, record it first.',
  keywords: ['webcam', 'camera', 'live', 'video', 'phone', 'phone camera', 'back camera', 'front camera', 'selfie', 'this device', 'tablet', 'camera input', 'capture', 'usb camera'],
  inputs: {},
  outputs: {
    image: { type: 'image', label: 'Image' },
    audio: { type: 'audio', label: 'Sound' },
    tap: { type: 'audio', label: 'Silent tap (always live)' },
  },
  params: {
    device: { type: 'device', device: 'video-input', default: '', label: 'Camera' },
    facing: {
      type: 'enum',
      default: 'auto',
      label: 'Side',
      options: [
        { value: 'auto', label: 'Any' },
        { value: 'back', label: 'Back camera' },
        { value: 'front', label: 'Front camera' },
      ],
      hint: 'On a phone or tablet: which of its own cameras to open. Used while Camera is on the default; picking a camera by name overrides it. The back camera is never mirrored.',
      visibleIf: (p) => !p.device,
    },
    resolution: {
      type: 'enum',
      default: 'auto',
      label: 'Resolution',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: '640x480', label: '640 × 480' },
        { value: '1280x720', label: '1280 × 720' },
        { value: '1920x1080', label: '1920 × 1080' },
      ],
    },
    mirror: { type: 'bool', default: true, label: 'Mirror', hint: 'Flip horizontally, like a mirror (natural for a front camera).' },
    freeze: { type: 'bool', default: false, label: 'Freeze', hint: 'Hold the current frame.' },
    micDevice: { type: 'device', device: 'audio-input', default: '', label: 'Microphone', group: 'Sound', hint: 'The microphone for this camera\'s sound. It is opened (and asked permission for) only once one of the sound outputs is wired.' },
    gain: { type: 'number', default: 0, min: -40, max: 40, step: 0.1, unit: 'db', label: 'Input gain', group: 'Sound' },
    monitor: { type: 'bool', default: false, label: 'Hear myself', group: 'Sound', hint: 'Off by default: with speakers, hearing yourself causes feedback. Off, the Sound output is silent and the Silent tap still carries the microphone: wire the tap into a Recorder or an effect.' },
    gate: { type: 'bool', default: false, label: 'Noise gate', group: 'Sound' },
    gateThreshold: { type: 'number', default: -50, min: -90, max: -10, step: 0.5, unit: 'db', label: 'Gate level', group: 'Sound', visibleIf: (p) => !!p.gate },
    liveTick: { type: 'string', default: '', label: 'Live tick', visibleIf: () => false },
  },
  summary: (p) => (p.freeze ? 'frozen' : p.device ? 'camera' : p.facing === 'back' ? 'back camera' : p.facing === 'front' ? 'front camera' : 'default camera'),
  async render(ctx) {
    void ctx.time.seconds; // live: re-render every frame
    const host = ctx.host;
    if (!host.liveFrame) throw new Error('A live camera is not available here (exports and headless runs cannot use one). Record it first.');
    const source = cameraSource(ctx.params);
    if (host.liveBlocked?.(source)) {
      // the AR view owns the camera: nothing here, so what is merged over it shows over the phone's own camera picture
      const width = Math.max(1, Math.round(ctx.canvas.width));
      const height = Math.max(1, Math.round(ctx.canvas.height));
      const image = ctx.gpu.pass({ label: 'camera-blocked', size: { width, height, unit: ctx.unitFor(width, height) }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0); }' });
      return { image };
    }
    const maxSide = ctx.proxy < 1 ? Math.ceil(Math.max(ctx.canvas.width, ctx.canvas.height)) : 0;
    const frame = await host.liveFrame(source, maxSide, ctx.time.seconds);
    if (!frame) throw new Error('Waiting for the camera…');
    const unit = ctx.unitFor(frame.width, frame.height);
    if (!liveOrientOfNode('camera-in', ctx.params).mirror) return { image: { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit } };
    const image = ctx.gpu.pass({
      label: 'camera-mirror',
      size: { width: frame.width, height: frame.height, unit },
      textures: { src: { texture: frame.texture } },
      wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smpNearest, vec2f(1.0 - uv.x, uv.y), 0.0); }',
    });
    return { image };
  },
  // the microphone: same kernel as the Microphone node (the host feeds it; see reconcileMics in audio/engine.ts)
  audio: liveInputKernel,
});
