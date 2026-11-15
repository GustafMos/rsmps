import { defineNode } from '../../define';
import { validRegions } from '../../lib/track-core';

export default defineNode({
  id: 'region-crop',
  title: 'Crop To Region',
  category: 'track',
  description:
    'Cuts the image down to one region and outputs it at a fixed size: a "follow cam" that stays on a tracked subject, or a way to extract a subject as its own picture. Put Track before it for smooth movement.',
  keywords: ['crop', 'follow', 'cam', 'zoom', 'extract', 'subject', 'region', 'frame', 'reframe'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    regions: { type: 'regions', required: true, label: 'Regions' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    index: { type: 'number', default: 0, min: 0, max: 63, step: 1, integer: true, label: 'Region number', hint: '0 = the first region in the list.' },
    id: { type: 'number', default: -1, min: -1, max: 100000, step: 1, integer: true, label: 'Or region with id', hint: '-1 = use the region number instead.' },
    width: { type: 'number', default: 256, min: 1, max: 4096, step: 1, integer: true, label: 'Output width (pixels)' },
    height: { type: 'number', default: 256, min: 1, max: 4096, step: 1, integer: true, label: 'Output height (pixels)' },
    padding: { type: 'number', default: 0.15, min: 0, max: 3, step: 0.01, label: 'Space around the region', hint: 'Fraction of the region size added on each side.' },
    keepInside: { type: 'bool', default: true, label: 'Stay inside the frame', hint: 'Slides the window back when it would leave the picture.' },
    missing: {
      type: 'enum',
      default: 'full',
      options: [
        { value: 'full', label: 'Show the whole frame' },
        { value: 'empty', label: 'Transparent' },
      ],
      label: 'If the region is missing',
    },
  },
  summary: (p) => `${p.width}×${p.height} · ${p.id >= 0 ? `id ${p.id}` : `#${p.index}`}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const items = validRegions(ctx.in.regions.items);
    const r = p.id >= 0 ? items.find((x) => x.id === p.id) : items[p.index];
    const outW = Math.max(1, Math.round(p.width));
    const outH = Math.max(1, Math.round(p.height));
    const size = { width: outW, height: outH, unit: ctx.unitFor(outW, outH) };
    if (!r && p.missing === 'empty') {
      return { image: ctx.gpu.pass({ label: 'region-crop-empty', size, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0); }' }) };
    }
    const box = r ? r.box : ([0, 0, 1, 1] as const);
    // Work in source texels so the window gets the output's aspect ratio in real pixels.
    const bw = Math.max(1e-4, (box[2] - box[0]) * src.width) * (1 + (r ? 2 * p.padding : 0));
    const bh = Math.max(1e-4, (box[3] - box[1]) * src.height) * (1 + (r ? 2 * p.padding : 0));
    let cx = ((box[0] + box[2]) / 2) * src.width;
    let cy = ((box[1] + box[3]) / 2) * src.height;
    const aspect = outW / outH;
    let w = bw;
    let h = bh;
    if (bw / bh < aspect) w = bh * aspect;
    else h = bw / aspect;
    if (p.keepInside) {
      const k = Math.min(1, src.width / w, src.height / h);
      w *= k;
      h *= k;
      cx = Math.min(src.width - w / 2, Math.max(w / 2, cx));
      cy = Math.min(src.height - h / 2, Math.max(h / 2, cy));
    }
    const taps = Math.min(6, Math.max(1, Math.ceil(Math.max(w / outW, h / outH))));
    const image = ctx.gpu.pass({
      label: 'region-crop',
      size,
      textures: { src },
      uniforms: { win: [(cx - w / 2) / src.width, (cy - h / 2) / src.height, w / src.width, h / src.height], taps },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let n = i32(u.taps);
  let stp = vec2f(u.win.z, u.win.w) / u.size;
  var acc = vec4f(0.0);
  for (var j = 0; j < n; j++) {
    for (var i = 0; i < n; i++) {
      let o = (vec2f(f32(i), f32(j)) + 0.5) / u.taps - 0.5;
      let s = vec2f(u.win.x, u.win.y) + uv * vec2f(u.win.z, u.win.w) + o * stp;
      let inside = s.x >= 0.0 && s.y >= 0.0 && s.x <= 1.0 && s.y <= 1.0;
      if (inside) { acc += textureSampleLevel(src, smp, s, 0.0); }
    }
  }
  return acc / (u.taps * u.taps);
}`,
    });
    return { image };
  },
});
