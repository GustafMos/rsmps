import { defineNode } from '../../define';
import { pastFrame } from '../../lib/util-history';

export default defineNode({
  id: 'delay-value',
  title: 'Delay Number',
  category: 'math',
  description: 'The number (or the vector) as it was a moment ago. Wire the same number through several delays to make things follow the leader.',
  keywords: ['delay', 'lag', 'follow the leader', 'offset', 'echo', 'previous', 'stagger', 'trail'],
  inputs: { value: { type: 'number', label: 'Number' }, vector: { type: 'vector', label: 'Vector' } },
  outputs: { value: { type: 'number', label: 'Number' }, vector: { type: 'vector', label: 'Vector' } },
  params: {
    amount: { type: 'number', default: 0.25, min: 0, max: 36000, softMax: 30, step: 0.01, label: 'Delay' },
    units: {
      type: 'enum',
      default: 'seconds',
      options: [
        { value: 'seconds', label: 'Seconds' },
        { value: 'frames', label: 'Frames' },
      ],
      label: 'Delay in',
    },
    loopAware: { type: 'bool', default: true, label: 'Loop with project', hint: 'In a looping project the start borrows from the end. Turn off for live signals.' },
  },
  summary: (p) => `${p.amount} ${p.units}`,
  async render(ctx) {
    const p = ctx.params;
    const fps = ctx.time.fps;
    const back = Math.round(p.units === 'frames' ? p.amount : p.amount * fps);
    if (back <= 0 || (ctx.in.value === null && ctx.in.vector === null)) return { value: ctx.in.value, vector: ctx.in.vector };
    const clock = { frame: ctx.time.frame, fps, duration: ctx.time.duration, loop: ctx.time.loop };
    const frame = pastFrame(clock, back, p.loopAware);
    const seconds = frame / fps;
    return {
      value: ctx.in.value === null ? null : ((await ctx.pull('value', { seconds })) ?? ctx.in.value),
      vector: ctx.in.vector === null ? null : ((await ctx.pull('vector', { seconds })) ?? ctx.in.vector),
    };
  },
});
