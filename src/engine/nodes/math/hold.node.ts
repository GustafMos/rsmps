import { defineNode } from '../../define';
import { MAX_PULLS, pastFrame } from '../../lib/util-history';
import { mod } from '../../lib/util-time';

export default defineNode({
  id: 'hold',
  title: 'Sample & Hold / Steps',
  category: 'math',
  description: 'Update a number only now and then and keep it still in between: every few frames, or whenever a trigger number goes above 0.5 (for example a MIDI note).',
  keywords: ['sample and hold', 'steps', 'stepped', 'stop motion', 'quantize', 'latch', 'trigger', 'stutter', 'freeze'],
  inputs: {
    value: { type: 'number', required: true, label: 'Number' },
    trigger: { type: 'number', label: 'Trigger' },
  },
  outputs: { value: { type: 'number', label: 'Number' } },
  params: {
    mode: {
      type: 'enum',
      default: 'frames',
      options: [
        { value: 'frames', label: 'Every few frames' },
        { value: 'trigger', label: 'When the trigger fires' },
      ],
      label: 'Update',
    },
    every: { type: 'number', default: 4, min: 1, max: 100000, softMax: 240, step: 1, integer: true, label: 'Every N frames', visibleIf: (p) => p.mode === 'frames' },
    window: { type: 'number', default: 4, min: 0.1, max: 60, softMax: 10, step: 0.1, unit: 's', label: 'Look back', hint: 'If no trigger happened this recently the value stays at what it was at the start of this window.', visibleIf: (p) => p.mode === 'trigger' },
    loopAware: { type: 'bool', default: true, label: 'Loop with project', hint: 'Steps follow the loop and triggers wrap around it. Turn off for live signals.' },
  },
  summary: (p) => (p.mode === 'frames' ? `every ${p.every} frames` : 'on trigger'),
  async render(ctx) {
    const p = ctx.params;
    const cur = ctx.in.value;
    const fps = ctx.time.fps;
    const clock = { frame: ctx.time.frame, fps, duration: ctx.time.duration, loop: ctx.time.loop };
    const wraps = p.loopAware && clock.loop;
    const valueBack = async (back: number) => (back === 0 ? cur : ((await ctx.pull('value', { seconds: pastFrame(clock, back, p.loopAware) / fps })) ?? cur));

    if (p.mode === 'frames') {
      if (p.every <= 1) return { value: cur };
      const total = Math.max(1, Math.round(clock.duration * fps));
      const back = (wraps ? mod(clock.frame, total) : clock.frame) % p.every;
      return { value: await valueBack(back) };
    }

    // Trigger mode: walk back in chunks to the most recent rising edge (above 0.5 after a frame at or below it).
    const trig = ctx.in.trigger;
    if (trig === null || trig === undefined) return { value: cur };
    const maxBack = Math.min(MAX_PULLS * 4, Math.ceil(p.window * fps));
    const known: number[] = [trig]; // known[k] = trigger value k frames ago
    const chunk = 16;
    let found = -1;
    for (let start = 0; start <= maxBack && found < 0; start += chunk) {
      const ks: number[] = [];
      for (let k = known.length; k <= Math.min(maxBack + 1, start + chunk); k++) ks.push(k);
      const vals = await Promise.all(ks.map(async (k) => (await ctx.pull('trigger', { seconds: pastFrame(clock, k, p.loopAware) / fps })) ?? 0));
      known.push(...vals);
      for (let k = start; k <= Math.min(maxBack, start + chunk - 1); k++) {
        const startOfTime = !wraps && clock.frame - k <= 0;
        if (known[k] > 0.5 && (known[k + 1] <= 0.5 || startOfTime)) {
          found = k;
          break;
        }
      }
    }
    return { value: await valueBack(found >= 0 ? found : maxBack) };
  },
});
