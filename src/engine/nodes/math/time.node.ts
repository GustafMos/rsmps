import { defineNode } from '../../define';

export default defineNode({
  id: 'time',
  title: 'Time',
  category: 'math',
  description: 'The current moment as numbers: progress through the loop (0..1), frame number and seconds.',
  keywords: ['clock', 'frame', 'seconds', 'phase', 'progress', 'timeline', 'now'],
  inputs: {},
  outputs: {
    phase: { type: 'number', label: 'Loop progress (0..1)' },
    frame: { type: 'number', label: 'Frame' },
    seconds: { type: 'number', label: 'Seconds' },
  },
  params: {},
  summary: () => 'loop progress · frame · seconds',
  render(ctx) {
    return { phase: ctx.time.phase, frame: ctx.time.frame, seconds: ctx.time.seconds };
  },
});
