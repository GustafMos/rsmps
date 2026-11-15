import { defineNode } from '../../define';
import { CURVE_OPTIONS, ease } from '../../lib/util-ease';
import { mod } from '../../lib/util-time';

export default defineNode({
  id: 'loop',
  title: 'Make Loop',
  category: 'time',
  description: 'Make any animation or video repeat without a visible jump: the start of the loop is cross-faded with the footage that comes after the end.',
  keywords: ['seamless', 'loop', 'repeat', 'crossfade', 'video', 'gif', 'cycle', 'endless'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    blend: { type: 'number', default: 0.5, min: 0, max: 30, step: 0.05, unit: 's', label: 'Blend length', hint: 'Seconds at the start of the loop that fade in from the footage after the end. Longer = smoother but more ghosting.' },
    curve: { type: 'enum', default: 'ease-in-out', options: CURVE_OPTIONS, label: 'Fade shape' },
  },
  summary: (p) => `${p.blend}s blend`,
  async render(ctx) {
    const p = ctx.params;
    if (p.blend <= 0) return { image: ctx.in.image };
    const { fps, duration } = ctx.time;
    const total = Math.max(1, Math.round(duration * fps));
    const frame = ctx.time.frame;
    const wrappedFrame = mod(frame, total);
    const t = wrappedFrame / fps;
    const blend = Math.min(p.blend, duration);
    // Past the end of the project the loop simply starts over.
    const current = wrappedFrame === frame ? ctx.in.image : await ctx.pull('image', { seconds: t });
    if (!current || t >= blend) return { image: current };
    // Inside the blend window: fade from the footage that follows the end (t + duration) into the real start.
    const head = await ctx.pull('image', { seconds: t + duration });
    if (!head) return { image: current };
    const image = ctx.gpu.pass({
      label: 'loop-blend',
      size: current,
      textures: { ta: head, tb: current },
      uniforms: { k: ease(p.curve, t / blend) },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = textureSampleLevel(ta, smp, uv, 0.0);
  let b = textureSampleLevel(tb, smpNearest, uv, 0.0);
  return mix(a, b, u.k);
}`,
    });
    return { image };
  },
});
