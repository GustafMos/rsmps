import { defineNode } from '../../define';
import { liveInputKernel } from '../../audio/live-input';
import { phoneSource } from '../../lib/live-source';

/**
 * A phone's camera, streamed to this computer through the QR-code phone link (needs the dev server in LAN mode:
 * `npm run dev:lan`, see docs/LIVE_INPUT.md). `session` is the pairing token the app fills in when you scan the code;
 * `liveTick` is stamped by the player so the live picture is never served from the evaluation cache. Leave both alone.
 * Live preview only: the Record button in the inspector saves the picture as a clip in Media, which exports.
 */
export default defineNode({
  id: 'phone-camera',
  title: 'Phone Camera',
  category: 'input',
  requires: ['local-server'],
  description: 'Live picture from a phone camera, linked by scanning a QR code. Needs the app started with "npm run dev:lan" and both devices on the same Wi-Fi. Live preview only.',
  keywords: ['phone', 'mobile', 'camera', 'qr', 'live', 'webcam', 'stream'],
  inputs: {},
  outputs: {
    image: { type: 'image', label: 'Image' },
    audio: { type: 'audio', label: 'Sound' },
    tap: { type: 'audio', label: 'Silent tap (always live)' },
  },
  params: {
    session: { type: 'string', default: '', label: 'Session', visibleIf: () => false },
    mirror: { type: 'bool', default: false, label: 'Mirror', hint: 'Flip horizontally.' },
    freeze: { type: 'bool', default: false, label: 'Freeze', hint: 'Hold the current frame.' },
    rotate: {
      type: 'enum',
      default: 'auto',
      label: 'Rotate',
      hint: 'Auto uses the picture as the phone sends it (phones usually report their orientation).',
      options: [
        { value: 'auto', label: 'Auto' },
        { value: '0', label: '0°' },
        { value: '90', label: '90° clockwise' },
        { value: '180', label: '180°' },
        { value: '270', label: '270° clockwise' },
      ],
    },
    gain: { type: 'number', default: 0, min: -40, max: 40, step: 0.1, unit: 'db', label: 'Input gain', group: 'Sound' },
    monitor: { type: 'bool', default: false, label: 'Hear the phone', group: 'Sound', hint: 'Off by default: a phone near the speakers feeds back. Use headphones.' },
    gate: { type: 'bool', default: false, label: 'Noise gate', group: 'Sound' },
    gateThreshold: { type: 'number', default: -50, min: -90, max: -10, step: 0.5, unit: 'db', label: 'Gate level', group: 'Sound', visibleIf: (p) => !!p.gate },
    latencyMs: { type: 'number', default: 150, min: 0, max: 1000, step: 1, label: 'Link delay ms', group: 'Sound', hint: 'How late the phone sound arrives (WiFi + WebRTC, typically 100-300 ms). A Timeline recording this sound moves the take earlier by this much so it lines up.' },
    liveTick: { type: 'string', default: '', label: 'Live tick', visibleIf: () => false },
  },
  summary: (p) => (p.session ? 'linked' : 'not linked'),
  async render(ctx) {
    void ctx.time.seconds; // live: re-render every frame
    const host = ctx.host;
    if (!host.liveFrame) throw new Error('A phone camera is not available here (exports and headless runs cannot use one). Record it first.');
    const source = phoneSource(ctx.params);
    if (!source) throw new Error('Not linked to a phone yet. Use "Link a phone" in the inspector and scan the QR code.');
    const maxSide = ctx.proxy < 1 ? Math.ceil(Math.max(ctx.canvas.width, ctx.canvas.height)) : 0;
    const frame = await host.liveFrame(source, maxSide);
    if (!frame) throw new Error('Waiting for the phone picture…');
    const turns = ctx.params.rotate === 'auto' ? 0 : Number(ctx.params.rotate) / 90;
    const swap = turns % 2 === 1;
    const width = swap ? frame.height : frame.width;
    const height = swap ? frame.width : frame.height;
    const unit = ctx.unitFor(width, height);
    if (turns === 0 && !ctx.params.mirror) return { image: { kind: 'image', texture: frame.texture, width, height, unit } };
    const image = ctx.gpu.pass({
      label: 'phone-camera-orient',
      size: { width, height, unit },
      textures: { src: { texture: frame.texture } },
      uniforms: { turns, mirror: ctx.params.mirror },
      wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var o = uv;
  if (u.mirror > 0.5) { o.x = 1.0 - o.x; }
  var s = o;
  if (u.turns > 2.5) { s = vec2f(1.0 - o.y, o.x); }
  else if (u.turns > 1.5) { s = vec2f(1.0 - o.x, 1.0 - o.y); }
  else if (u.turns > 0.5) { s = vec2f(o.y, 1.0 - o.x); }
  return textureSampleLevel(src, smpNearest, s, 0.0);
}`,
    });
    return { image };
  },
  // The phone's microphone (set up by the app through AudioEngine.setLiveStream). Live only: silent in exports.
  audio: liveInputKernel,
});
