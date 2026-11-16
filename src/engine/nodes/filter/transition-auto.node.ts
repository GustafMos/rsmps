import { defineNode } from '../../define';
import { runTransition, transitionParams, type TransitionSettings } from '../../lib/fx-transition';

const EASES = ['linear', 'smooth', 'in', 'out'];
const ease = (e: string, x: number) => (e === 'smooth' ? x * x * (3 - 2 * x) : e === 'in' ? x * x : e === 'out' ? 1 - (1 - x) * (1 - x) : x);

export default defineNode({
  id: 'transition-auto',
  title: 'Morph / Transition (timed)',
  category: 'filter',
  description:
    'Morph / Transition that times itself over the project loop: A, then the change from A to B, then B. Tick "Come back to A" and it plays back again so the loop repeats seamlessly. It animates by design; use Morph / Transition with your own Progress number for full control.',
  keywords: ['transition', 'morph', 'timed', 'auto', 'loop', 'ping pong', 'dissolve', 'wipe', 'dither', 'between two clips'],
  inputs: {
    a: { type: 'image', required: true, label: 'A (from)' },
    b: { type: 'image', required: true, label: 'B (to)' },
    map: { type: 'image', label: 'Map (optional)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    ...transitionParams,
    start: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.005, unit: 'norm', label: 'Starts at', group: 'Timing', hint: 'Position in the loop where the change begins. Before this you see A.' },
    duration: { type: 'number', default: 0.25, min: 0.005, max: 1, step: 0.005, unit: 'norm', label: 'Takes', group: 'Timing', hint: 'Share of the loop the change lasts.' },
    ease: { type: 'enum', default: 'smooth', label: 'Easing', group: 'Timing', options: [{ value: 'linear', label: 'Even' }, { value: 'smooth', label: 'Smooth' }, { value: 'in', label: 'Slow start' }, { value: 'out', label: 'Slow end' }] },
    pingPong: { type: 'bool', default: true, label: 'Come back to A (loops seamlessly)', group: 'Timing', hint: 'After holding B, the change plays again in reverse. Off: B stays until the loop restarts with a jump back to A.' },
    holdB: { type: 'number', default: 0.15, min: 0, max: 1, step: 0.005, unit: 'norm', label: 'Hold B for', group: 'Timing', visibleIf: (p) => p.pingPong === true },
  },
  summary: (p) => `${p.mode} · ${Math.round(p.start * 100)}% for ${Math.round(p.duration * 100)}%`,
  render(ctx) {
    const p = ctx.params as unknown as TransitionSettings & { start: number; duration: number; ease: string; pingPong: boolean; holdB: number };
    const phase = ctx.time.phase;
    const d = Math.max(0.005, p.duration);
    const forward = Math.max(0, Math.min(1, (phase - p.start) / d));
    let x = forward;
    if (p.pingPong) {
      const backStart = p.start + d + p.holdB;
      const back = Math.max(0, Math.min(1, (phase - backStart) / d));
      x = phase >= backStart ? 1 - back : forward;
    }
    void EASES;
    return { image: runTransition(ctx.gpu, ctx.in.a, ctx.in.b, ctx.in.map, p, ease(p.ease, x)) };
  },
});
