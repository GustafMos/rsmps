import { defineNode } from '../../define';
import { evalCurve, presetEaseInOut } from '../../lib/util-curve';

export const LOOP_MODES = [
  { value: 'project', label: 'Follow the project loop switch' },
  { value: 'always', label: 'Always loop (end flows into start)' },
  { value: 'never', label: 'Never (hold the end values)' },
] as const;

export default defineNode({
  id: 'keyframes',
  title: 'Keyframes',
  category: 'math',
  description: 'Draw an animation as a curve with keyframes: steps, straight lines, smooth splines or bezier handles. Repeats whole times per loop. Wire a number into Position to use the curve as a shaping function instead of time.',
  keywords: ['curve', 'spline', 'bezier', 'animation', 'timeline', 'ease', 'graph editor', 'keyframe', 'transfer function', 'envelope'],
  inputs: { time: { type: 'number', label: 'Position (0..1)' } },
  outputs: { value: { type: 'number', label: 'Number' } },
  params: {
    curve: { type: 'curve', default: presetEaseInOut(), label: 'Curve' },
    repeat: { type: 'number', default: 1, min: 1, max: 256, softMax: 32, step: 1, integer: true, unit: 'cycles', label: 'Repeats per loop', hint: 'Plays the whole curve this many times in one project loop.' },
    scale: { type: 'number', default: 1, min: -1000000, max: 1000000, step: 0.01, label: 'Multiply' },
    offset: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'Add' },
    loop: { type: 'enum', default: 'project', options: LOOP_MODES, label: 'At the end' },
  },
  summary: (p) => `${p.curve.keys.length} keys${p.repeat > 1 ? ` · ×${p.repeat}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const wired = ctx.in.time;
    let t: number;
    let loop: boolean;
    if (typeof wired === 'number') {
      // The clock is not read at all: the result depends only on the wired number.
      t = wired;
      loop = p.loop === 'always';
    } else {
      const u = ctx.time.phase * p.repeat;
      t = p.repeat > 1 ? u - Math.floor(u) : u;
      loop = p.loop === 'always' || (p.loop === 'project' && ctx.time.loop);
    }
    return { value: evalCurve(p.curve, t, { loop }) * p.scale + p.offset };
  },
});
