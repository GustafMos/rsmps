import { defineNode } from '../../define';
import { blendSlices, pullSliceFrames } from '../../lib/time-slices';

export default defineNode({
  id: 'time-displace',
  title: 'Time Displace',
  category: 'time',
  description:
    'Every pixel shows its own moment: a map picture (brightness) decides how far into the past or future each pixel looks. Dark areas show now, bright areas show the far end of the range. Use a gradient for a slit scan, noise or a mask for ghostly, melting time.',
  keywords: ['time displacement', 'slit scan', 'delay map', 'time map', 'temporal', 'smear', 'ghost', 'rolling shutter', 'warp time'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    map: { type: 'image', required: true, label: 'Map (brightness = time)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    range: { type: 'number', default: 1, min: 0, max: 60, softMax: 10, step: 0.05, unit: 's', label: 'Range', hint: 'Time offset of a white map pixel. Black = now.' },
    direction: {
      type: 'enum',
      default: 'past',
      label: 'Looks into the',
      options: [
        { value: 'past', label: 'Past' },
        { value: 'future', label: 'Future' },
      ],
    },
    slices: { type: 'number', default: 16, min: 2, max: 128, softMax: 64, step: 1, integer: true, label: 'Time slices', hint: 'Distinct moments used. Cost per frame: one input pull per distinct frame (none for a still input) and one GPU pass per 8 slices.' },
    smooth: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Smooth slices', hint: '0 = hard bands, 1 = blended.' },
    invert: { type: 'bool', default: false, label: 'Invert map' },
  },
  summary: (p) => `${p.slices} slices · ${p.range}s ${p.direction}`,
  async render(ctx) {
    const p = ctx.params;
    const n = Math.max(2, Math.round(p.slices));
    const fps = ctx.time.fps;
    const sign = p.direction === 'future' ? 1 : -1;
    const offsets = Array.from({ length: n }, (_, k) => sign * Math.round((k / (n - 1)) * p.range * fps));
    const slices = await pullSliceFrames(ctx as never, 'image', offsets);
    // A still input (or a zero range) shows the same picture in every slice: nothing to blend.
    if (slices.every((s) => s === slices[0])) return { image: ctx.in.image };
    return { image: blendSlices(ctx.gpu, slices, { map: ctx.in.map, soft: p.smooth, reverse: p.invert, label: 'time-displace' }) };
  },
});
