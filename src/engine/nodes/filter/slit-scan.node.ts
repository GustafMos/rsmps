import { defineNode } from '../../define';
import { blendSlices, pullSliceFrames } from '../../lib/time-slices';

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
        { value: 'rows', label: 'Rows' },
        { value: 'columns', label: 'Columns' },
        { value: 'radial', label: 'Rings' },
      ],
      hint: 'Ignored while a time map is wired.',
    },
    range: { type: 'number', default: 24, min: 1, max: 600, softMax: 120, step: 1, integer: true, label: 'Delay range', hint: 'How far into the past the far end looks.' },
    slices: { type: 'number', default: 8, min: 2, max: 64, softMax: 32, step: 1, integer: true, label: 'Time slices', hint: 'Number of distinct moments used. Cost: one input pull per distinct frame (none when the input is a still) and one GPU pass per 8 slices.' },
    smooth: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Smooth slices', hint: '0 = hard bands, 1 = blended.' },
    offset: { type: 'number', default: 0, min: -300, max: 300, softMax: 60, step: 1, integer: true, label: 'Start offset', hint: 'Shifts every delay. Negative = the near end already looks into the past.' },
    reverse: { type: 'bool', default: false, label: 'Reverse' },
  },
  summary: (p) => `${p.slices} slices over ${p.range} frames`,
  async render(ctx) {
    const p = ctx.params;
    const n = Math.max(2, Math.round(p.slices));
    const step = p.range / (n - 1);
    const offsets = Array.from({ length: n }, (_, k) => -Math.round(k * step) + Math.round(p.offset));
    const slices = await pullSliceFrames(ctx as never, 'image', offsets);
    // Every slice is the same picture (a still): the blend weights sum to 1, so the result is the input itself.
    if (slices.every((s) => s === slices[0])) return { image: ctx.in.image };
    const dir = ['rows', 'columns', 'radial'].indexOf(p.direction);
    return { image: blendSlices(ctx.gpu, slices, { dir, map: ctx.in.timeMap ?? null, soft: p.smooth, reverse: p.reverse, label: 'slit-scan' }) };
  },
});
