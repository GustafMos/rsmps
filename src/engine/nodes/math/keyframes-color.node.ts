import { defineNode } from '../../define';
import { evalCurve, presetLinear } from '../../lib/util-curve';
import { mixColors } from '../../lib/util-color';
import { LOOP_MODES } from './keyframes.node';

export default defineNode({
  id: 'keyframes-color',
  title: 'Color Keyframes',
  category: 'math',
  description: 'Animate a colour through a list of colour stops over the loop, blended smoothly in perceptual (OKLab) space. An optional curve controls the pace.',
  keywords: ['gradient', 'color animation', 'colour cycle', 'palette', 'ramp', 'fade', 'hue shift', 'keyframe'],
  inputs: { time: { type: 'number', label: 'Position (0..1)' } },
  outputs: { color: { type: 'color', label: 'Color' } },
  params: {
    palette: {
      type: 'palette',
      default: [
        [0.1, 0.12, 0.35],
        [0.95, 0.45, 0.25],
        [1, 0.9, 0.5],
      ],
      label: 'Color stops',
    },
    pace: { type: 'curve', default: presetLinear(), label: 'Pace', hint: 'Position along the stops (0 = first colour, 1 = last) over the loop. A straight line = even speed.' },
    repeat: { type: 'number', default: 1, min: 1, max: 256, softMax: 32, step: 1, integer: true, unit: 'cycles', label: 'Repeats per loop' },
    loop: { type: 'enum', default: 'project', options: LOOP_MODES, label: 'At the end', hint: 'When looping, the last colour fades back into the first.' },
  },
  summary: (p) => `${p.palette.length} colours${p.repeat > 1 ? ` · ×${p.repeat}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const stops = p.palette.length ? p.palette : [[0, 0, 0] as [number, number, number]];
    const wired = ctx.in.time;
    let t: number;
    let loop: boolean;
    if (typeof wired === 'number') {
      t = wired;
      loop = p.loop === 'always';
    } else {
      const u = ctx.time.phase * p.repeat;
      t = p.repeat > 1 ? u - Math.floor(u) : u;
      loop = p.loop === 'always' || (p.loop === 'project' && ctx.time.loop);
    }
    const pos = Math.min(1, Math.max(0, evalCurve(p.pace, t, { loop: false })));
    const list = loop && stops.length > 1 ? [...stops, stops[0]] : stops;
    if (list.length === 1) return { color: [list[0][0], list[0][1], list[0][2], 1] };
    const f = pos * (list.length - 1);
    const i = Math.min(list.length - 2, Math.floor(f));
    const a = list[i];
    const b = list[i + 1];
    return { color: mixColors([a[0], a[1], a[2], 1], [b[0], b[1], b[2], 1], f - i, 'oklab') };
  },
});
