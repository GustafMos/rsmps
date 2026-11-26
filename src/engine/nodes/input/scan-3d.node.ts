import { defineNode } from '../../define';
import { normalizeScan } from '../../lib/scan-data';
import type { ImageValue } from '../../types';

/**
 * 3D Scan: holds the photos of a scan taken with the phone's AR view (the hidden `scan` param, see lib/scan-data.ts) and shows them.
 * The photos live in Media; this node only READS params and assets. Its Picture is a deterministic slideshow of the photos spread
 * over the project's loop (the first photo is on screen at the start of the loop and the slideshow wraps with it), or one chosen photo.
 * A scan with no photos gives a plain dark picture with a ring, never an error.
 */
export default defineNode({
  id: 'scan-3d',
  title: '3D Scan',
  category: 'input',
  description:
    'Experimental. Holds a 3D scan: the photos taken walking around an object with the phone\'s AR view (Android Chrome), together with where the phone was for each one and how much of the object they cover. The picture is a slideshow of the photos. Open the inspector and press Start scan.',
  keywords: ['3d scan', 'scan', 'photogrammetry', 'colmap', 'capture', 'photos', 'ar', 'webxr', 'coverage', 'object', 'reconstruction', 'turntable', 'phone'],
  inputs: {},
  outputs: {
    image: { type: 'image', label: 'Picture' },
    shots: { type: 'number', label: 'Shots' },
  },
  params: {
    scan: { type: 'json', default: null, label: 'Scan', visibleIf: () => false },
    show: {
      type: 'enum',
      default: 'slideshow',
      label: 'Show',
      hint: 'The slideshow plays every photo once per loop of the project. One photo holds the chosen photo still.',
      options: [
        { value: 'slideshow', label: 'Slideshow of the photos' },
        { value: 'one', label: 'One photo' },
      ],
    },
    photo: { type: 'number', default: 1, min: 1, max: 9999, step: 1, integer: true, label: 'Photo number', hint: 'Which photo to show (1 is the first taken).', visibleIf: (p) => p.show === 'one' },
  },
  summary: (p) => {
    const n = normalizeScan(p.scan).shots.length;
    return n ? `${n} photos` : 'no scan yet';
  },
  async render(ctx) {
    const scan = normalizeScan(ctx.params.scan);
    const n = scan.shots.length;
    if (n === 0) {
      // no photos yet: a plain dark picture with a ring, so the viewer shows something clear instead of an error
      const image = ctx.gpu.pass({
        label: 'scan-empty',
        size: ctx.canvas,
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = (uv - vec2f(0.5)) * vec2f(u.size.x / max(u.size.y, 1.0), 1.0);
  let r = length(c);
  let ring = smoothstep(0.205, 0.215, r) * (1.0 - smoothstep(0.225, 0.235, r));
  let base = vec3f(0.11, 0.12, 0.14);
  return vec4f(mix(base, vec3f(0.42, 0.45, 0.5), ring), 1.0);
}`,
      });
      return { image, shots: 0 };
    }
    const index = ctx.params.show === 'one' ? Math.min(n, Math.max(1, Math.round(ctx.params.photo))) - 1 : Math.min(n - 1, Math.floor(ctx.time.phase * n));
    const shot = scan.shots[index];
    const info = ctx.host.assetInfo(shot.asset);
    if (!info) throw new Error('A photo of this scan is missing from Media. Scan again, or bring the photos back into Media.');
    const long = Math.max(info.width, info.height);
    const maxSide = ctx.proxy < 0.999 ? Math.ceil(long * ctx.proxy) : 0;
    const frame = await ctx.host.assetFrame(shot.asset, 0, maxSide);
    if (!frame) throw new Error(`Could not read a photo of the scan (${info.name}).`);
    const image: ImageValue = { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit: ctx.unitFor(frame.width, frame.height) };
    return { image, shots: n };
  },
});
