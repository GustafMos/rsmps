import { defineNode } from '../../define';
import type { LiveSource } from '../../types';

const SIZES: Record<string, { width: number; height: number } | undefined> = {
  auto: undefined,
  '640x480': { width: 640, height: 480 },
  '1280x720': { width: 1280, height: 720 },
  '1920x1080': { width: 1920, height: 1080 },
};

/**
 * Live webcam. The host opens the camera lazily, shares one stream between nodes using the same device and
 * closes it when nothing has asked for a frame for a few seconds. Live only: exports and headless runs have
 * no camera, so the node reports a readable error there (record the camera to a file first).
 * `liveTick` is stamped by the player so a live picture is never served from the evaluation cache; leave it alone.
 */
export default defineNode({
  id: 'camera-in',
  title: 'Webcam',
  category: 'input',
  description: 'Live picture from a webcam or other capture device (not the 3D camera; see 3D Camera). Needs camera permission. Live preview only: to export, record it first.',
  keywords: ['webcam', 'camera', 'live', 'video', 'phone', 'camera input', 'capture', 'usb camera'],
  inputs: {},
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    device: { type: 'device', device: 'video-input', default: '', label: 'Camera' },
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
    liveTick: { type: 'string', default: '', label: 'Live tick', visibleIf: () => false },
  },
  summary: (p) => (p.freeze ? 'frozen' : p.device ? 'camera' : 'default camera'),
  async render(ctx) {
    void ctx.time.seconds; // live: re-render every frame
    const host = ctx.host;
    if (!host.liveFrame) throw new Error('A live camera is not available here (exports and headless runs cannot use one). Record it first.');
    const size = SIZES[ctx.params.resolution];
    const source: LiveSource & { freeze?: boolean } = { kind: 'camera', deviceId: ctx.params.device, ...size, freeze: ctx.params.freeze };
    const maxSide = ctx.proxy < 1 ? Math.ceil(Math.max(ctx.canvas.width, ctx.canvas.height)) : 0;
    const frame = await host.liveFrame(source, maxSide);
    if (!frame) throw new Error('Waiting for the camera…');
    const unit = ctx.unitFor(frame.width, frame.height);
    if (!ctx.params.mirror) return { image: { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit } };
    const image = ctx.gpu.pass({
      label: 'camera-mirror',
      size: { width: frame.width, height: frame.height, unit },
      textures: { src: { texture: frame.texture } },
      wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smpNearest, vec2f(1.0 - uv.x, uv.y), 0.0); }',
    });
    return { image };
  },
});
