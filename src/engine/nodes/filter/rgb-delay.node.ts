import { defineNode } from '../../define';
import { pullFrames } from '../../lib/fx-video';
import type { ImageValue } from '../../types';

export default defineNode({
  id: 'rgb-delay',
  title: 'RGB Delay',
  category: 'filter',
  description:
    'Splits the colour channels in time and space: red from a moment earlier, blue from a moment later, each optionally nudged sideways. Anything that moves gets a rainbow-edged time smear; a still picture only gets the spatial split.',
  keywords: ['chromatic', 'rgb split', 'time offset', 'channel delay', 'glitch', 'smear', 'color fringe', 'temporal', 'anaglyph', 'misregistration'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    redFrames: { type: 'number', default: -3, min: -120, max: 120, softMax: 30, step: 1, integer: true, label: 'Red frame offset', group: 'Time', hint: 'Negative = earlier, positive = later. Each different offset re-renders the input once.' },
    greenFrames: { type: 'number', default: 0, min: -120, max: 120, softMax: 30, step: 1, integer: true, label: 'Green frame offset', group: 'Time' },
    blueFrames: { type: 'number', default: 3, min: -120, max: 120, softMax: 30, step: 1, integer: true, label: 'Blue frame offset', group: 'Time' },
    redX: { type: 'number', default: 0, min: -200, max: 200, softMax: 60, step: 0.5, unit: 'px', label: 'Red shift X', group: 'Space' },
    redY: { type: 'number', default: 0, min: -200, max: 200, softMax: 60, step: 0.5, unit: 'px', label: 'Red shift Y', group: 'Space' },
    greenX: { type: 'number', default: 0, min: -200, max: 200, softMax: 60, step: 0.5, unit: 'px', label: 'Green shift X', group: 'Space' },
    greenY: { type: 'number', default: 0, min: -200, max: 200, softMax: 60, step: 0.5, unit: 'px', label: 'Green shift Y', group: 'Space' },
    blueX: { type: 'number', default: 0, min: -200, max: 200, softMax: 60, step: 0.5, unit: 'px', label: 'Blue shift X', group: 'Space' },
    blueY: { type: 'number', default: 0, min: -200, max: 200, softMax: 60, step: 0.5, unit: 'px', label: 'Blue shift Y', group: 'Space' },
  },
  summary: (p) => `R ${p.redFrames} · G ${p.greenFrames} · B ${p.blueFrames} frames`,
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const offsets = [p.redFrames, p.greenFrames, p.blueFrames].map((f) => Math.round(f));
    const spatial = [p.redX, p.redY, p.greenX, p.greenY, p.blueX, p.blueY];
    if (offsets.every((f) => f === 0) && spatial.every((v) => v === 0)) return { image: src };
    const cache = new Map<number, ImageValue | null>();
    for (const f of offsets) {
      if (cache.has(f)) continue;
      cache.set(f, f === 0 ? src : await pullFrames(ctx as never, 'image', f));
    }
    const [r, g, b] = offsets.map((f) => cache.get(f) ?? src);
    const image = ctx.gpu.pass({
      label: 'rgb-delay',
      size: src,
      textures: { fr: r, fg: g, fb: b },
      uniforms: { o: [p.redX, p.redY, p.greenX, p.greenY], ob: [p.blueX, p.blueY] },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let cr = textureSampleLevel(fr, smp, uv + vec2f(u.o.x, u.o.y) / u.size, 0.0);
  let cg = textureSampleLevel(fg, smp, uv + vec2f(u.o.z, u.o.w) / u.size, 0.0);
  let cb = textureSampleLevel(fb, smp, uv + u.ob / u.size, 0.0);
  return vec4f(cr.r, cg.g, cb.b, max(cr.a, max(cg.a, cb.a)));
}`,
    });
    return { image };
  },
});
