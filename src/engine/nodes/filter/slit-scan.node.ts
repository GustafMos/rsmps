import { defineNode } from '../../define';
import { pullFrames } from '../../lib/fx-video';
import type { ImageValue } from '../../types';

export default defineNode({
  id: 'slit-scan',
  title: 'Slit Scan',
  category: 'filter',
  description:
    'Each row (or column, or ring) of the picture shows a different moment in time: the top is now, the bottom is the past. Or let a brightness map choose the delay for every pixel. Moving things stretch into waves and smears.',
  keywords: ['slit-scan', 'time displacement', 'time warp', 'delay map', 'smear', 'stargate', 'rolling shutter', 'temporal', 'time offset', 'wave'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    timeMap: { type: 'image', label: 'Time map (optional)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    direction: {
      type: 'enum',
      default: 'rows',
      label: 'Delay grows along',
      options: [
        { value: 'rows', label: 'Rows (top to bottom)' },
        { value: 'columns', label: 'Columns (left to right)' },
        { value: 'radial', label: 'Rings (centre to edge)' },
      ],
      hint: 'Ignored while a time map is wired.',
    },
    range: { type: 'number', default: 24, min: 1, max: 600, softMax: 120, step: 1, integer: true, label: 'Delay range (frames)', hint: 'How far into the past the far end looks.' },
    slices: { type: 'number', default: 8, min: 2, max: 32, softMax: 16, step: 1, integer: true, label: 'Time slices', hint: 'Number of distinct moments used. Each one re-renders the input once.' },
    smooth: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Smooth between slices', hint: '0 = hard bands, 1 = blended.' },
    offset: { type: 'number', default: 0, min: -300, max: 300, softMax: 60, step: 1, integer: true, label: 'Start offset (frames)', hint: 'Shifts every delay. Negative = the near end already looks into the past.' },
    reverse: { type: 'bool', default: false, label: 'Reverse' },
  },
  summary: (p) => `${p.slices} slices over ${p.range} frames`,
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const n = Math.max(2, Math.round(p.slices));
    const step = p.range / (n - 1);
    const hasMap = !!ctx.in.timeMap;
    let acc: ImageValue | null = null;
    const dir = ['rows', 'columns', 'radial'].indexOf(p.direction);
    for (let k = 0; k < n; k++) {
      const frames = -Math.round(k * step) + Math.round(p.offset);
      const slice = frames === 0 ? src : await pullFrames(ctx as never, 'image', frames);
      if (!slice) continue;
      acc = gpu.pass({
        label: `slit-${k}`,
        size: src,
        format: k === n - 1 ? 'rgba8unorm' : 'rgba16float',
        textures: { slice, acc, tmap: ctx.in.timeMap ?? null },
        uniforms: { k, n, soft: p.smooth, dir, reverse: p.reverse },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  ${
    hasMap
      ? 'var pos = textureSampleLevel(tmap, smp, uv, 0.0).r;'
      : `var pos = uv.y;
  if (u.dir > 0.5 && u.dir < 1.5) { pos = uv.x; }
  if (u.dir > 1.5) { pos = clamp(length((uv - 0.5) * vec2f(u.size.x / u.size.y, 1.0)) / 0.7071, 0.0, 1.0); }`
  }
  if (u.reverse > 0.5) { pos = 1.0 - pos; }
  let s = clamp(pos, 0.0, 1.0) * (u.n - 1.0);
  let d = abs(s - u.k);
  let w = mix(f32(floor(s + 0.5) == u.k), max(0.0, 1.0 - d), u.soft);
  let c = textureSampleLevel(slice, smpNearest, uv, 0.0) * w;
  ${acc ? 'return textureSampleLevel(acc, smpNearest, uv, 0.0) + c;' : 'return c;'}
}`,
      });
    }
    return { image: acc ?? src };
  },
});
