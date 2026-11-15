import { defineNode } from '../../define';
import { EASE_OPTIONS, ease } from '../../lib/util-ease';
import { WAVES, waveValue } from '../../lib/util-wave';

export default defineNode({
  id: 'animate',
  title: 'Animate',
  category: 'math',
  description: 'One-click animation: outputs a number that moves between From and To and loops exactly over the project length. Wire it into any number setting.',
  keywords: ['loop', 'wave', 'oscillate', 'sine', 'bounce', 'pulse', 'driver', 'lfo', 'keyframe', 'motion', 'wobble', 'noise', 'steps'],
  inputs: {},
  outputs: { value: { type: 'number', label: 'Number' } },
  params: {
    wave: { type: 'enum', default: 'sine', options: WAVES, label: 'Motion' },
    from: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'From' },
    to: { type: 'number', default: 1, min: -1000000, max: 1000000, step: 0.01, label: 'To' },
    cycles: { type: 'number', default: 1, min: 0, max: 64, step: 1, integer: true, unit: 'cycles', label: 'Repeats per loop', hint: 'Whole numbers keep the loop seamless. 0 = no motion.' },
    phase: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Start offset', hint: 'Shift where in the motion the loop begins (0..1).' },
    easing: { type: 'enum', default: 'linear', options: EASE_OPTIONS, label: 'Easing', hint: 'Reshapes the motion between From and To.' },
    steps: { type: 'number', default: 6, min: 2, max: 64, integer: true, label: 'Number of steps', visibleIf: (p) => p.wave === 'steps' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, integer: true, label: 'Seed', visibleIf: (p) => p.wave === 'noise' },
  },
  summary: (p) => `${p.wave} · ${p.from} ↔ ${p.to}${p.cycles > 1 ? ` · ×${p.cycles}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const phase = p.cycles > 0 ? ctx.time.phase : 0; // only read the clock when moving
    const t = phase * p.cycles + p.phase;
    const w = waveValue({ wave: p.wave, t, steps: p.steps, seed: p.seed, cycles: p.cycles });
    const shaped = p.wave === 'steps' || p.wave === 'square' ? w : ease(p.easing, w);
    return { value: p.from + (p.to - p.from) * shaped };
  },
});
