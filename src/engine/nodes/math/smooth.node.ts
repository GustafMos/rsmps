import { defineNode } from '../../define';
import { angleDelta, easeSeq, gatherHistory, planHistory, slewSeq, springKernel, springSettle, unwrapSeq } from '../../lib/util-history';

export default defineNode({
  id: 'smooth',
  title: 'Smooth / Interpolate',
  category: 'math',
  description: 'Glide toward a number instead of jumping to it, so stepped values (MIDI notes, loudness, sliders) do not make things teleport. Looks at the recent past of the number, so it needs no stored state.',
  keywords: ['interpolate', 'ease', 'lag', 'glide', 'portamento', 'slew', 'spring', 'average', 'filter', 'follow', 'midi', 'inertia', 'damping'],
  inputs: { value: { type: 'number', required: true, label: 'Number' } },
  outputs: { value: { type: 'number', label: 'Number' } },
  params: {
    mode: {
      type: 'enum',
      default: 'ease',
      options: [
        { value: 'ease', label: 'Ease (follow with a delay)' },
        { value: 'linear', label: 'Average over time' },
        { value: 'spring', label: 'Spring' },
        { value: 'slew', label: 'Limit speed of change' },
      ],
      label: 'Style',
    },
    rise: { type: 'number', default: 0.2, min: 0, max: 600, softMax: 10, step: 0.01, unit: 's', label: 'Rise time', hint: 'Seconds to cover about 63% of an upward jump. 0 = instant.', visibleIf: (p) => p.mode === 'ease' },
    fall: { type: 'number', default: 0.2, min: 0, max: 600, softMax: 10, step: 0.01, unit: 's', label: 'Fall time', hint: 'Same for downward jumps. 0 = instant.', visibleIf: (p) => p.mode === 'ease' },
    time: { type: 'number', default: 0.2, min: 0, max: 600, softMax: 10, step: 0.01, unit: 's', label: 'Average over', hint: '0 = no smoothing.', visibleIf: (p) => p.mode === 'linear' },
    stiffness: { type: 'number', default: 2, min: 0.05, max: 100, softMax: 20, step: 0.05, unit: 'hz', label: 'Stiffness', hint: 'Natural speed of the spring in swings per second. Higher = snappier.', visibleIf: (p) => p.mode === 'spring' },
    bounce: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Bounce', hint: '0 = settles without overshoot, 1 = wobbles for a long time.', visibleIf: (p) => p.mode === 'spring' },
    riseRate: { type: 'number', default: 1, min: 0, max: 1000000, softMax: 1000, step: 0.1, label: 'Max rise per second', hint: '0 = no limit.', visibleIf: (p) => p.mode === 'slew' },
    fallRate: { type: 'number', default: 1, min: 0, max: 1000000, softMax: 1000, step: 0.1, label: 'Max fall per second', hint: '0 = no limit.', visibleIf: (p) => p.mode === 'slew' },
    history: { type: 'number', default: 2, min: 0.1, max: 600, softMax: 4, step: 0.1, unit: 's', label: 'Look back', hint: 'How far into the past to follow. Jumps bigger than rate × this are caught up instantly.', visibleIf: (p) => p.mode === 'slew' },
    wrapAngle: { type: 'bool', default: false, label: 'Turn the short way round', hint: 'For angles: glides across the wrap point instead of spinning backwards through the whole circle.' },
    period: { type: 'number', default: 360, min: 0.0001, max: 1000000, step: 1, label: 'Full circle', visibleIf: (p) => p.wrapAngle === true },
    loopAware: { type: 'bool', default: true, label: 'Loop with the project', hint: 'In a looping project the past of the first frames comes from the end, so exports loop cleanly. Live signals do not loop: turn off for MIDI/audio.' },
  },
  summary: (p) => {
    switch (p.mode) {
      case 'linear':
        return `average ${p.time}s`;
      case 'spring':
        return `spring ${p.stiffness} Hz · bounce ${p.bounce}`;
      case 'slew':
        return `limit ↑${p.riseRate}/s ↓${p.fallRate}/s`;
      default:
        return `ease ↑${p.rise}s ↓${p.fall}s`;
    }
  },
  async render(ctx) {
    const p = ctx.params;
    const cur = ctx.in.value;
    const passThrough =
      (p.mode === 'ease' && p.rise <= 0 && p.fall <= 0) ||
      (p.mode === 'linear' && Math.round(p.time * ctx.time.fps) <= 1) ||
      (p.mode === 'slew' && p.riseRate <= 0 && p.fallRate <= 0);
    if (passThrough) return { value: cur };
    const fps = ctx.time.fps;
    const clock = { frame: ctx.time.frame, fps, duration: ctx.time.duration, loop: ctx.time.loop };

    // How far back to look, and (for spring) the kernel.
    let windowSeconds: number;
    let zeta = 1;
    let omega = 1;
    if (p.mode === 'ease') windowSeconds = 4 * Math.max(p.rise, p.fall);
    else if (p.mode === 'linear') windowSeconds = (Math.round(p.time * fps) - 1) / fps;
    else if (p.mode === 'spring') {
      omega = 2 * Math.PI * p.stiffness;
      zeta = 1 - 0.9 * p.bounce;
      windowSeconds = Math.min(30, springSettle(omega, zeta));
    } else windowSeconds = p.history;
    const plan = planHistory(windowSeconds * fps, fps);
    const newestFirst = await gatherHistory((seconds) => ctx.pull('value', { seconds }), cur, clock, plan, p.loopAware);
    if (!newestFirst || newestFirst.every((v) => v === cur)) return { value: cur };

    let seq = newestFirst.slice().reverse(); // oldest first
    let base = 0;
    if (p.wrapAngle) {
      seq = unwrapSeq(seq, p.period);
      base = seq[seq.length - 1];
    }
    let y: number;
    if (p.mode === 'ease') y = easeSeq(seq, plan.dt, p.rise, p.fall);
    else if (p.mode === 'linear') {
      let sum = 0;
      for (const v of seq) sum += v;
      y = sum / seq.length;
    } else if (p.mode === 'spring') {
      const k = springKernel(seq.length, plan.dt, omega, zeta);
      y = 0;
      for (let i = 0; i < seq.length; i++) y += k[i] * seq[seq.length - 1 - i];
    } else y = slewSeq(seq, plan.dt, p.riseRate, p.fallRate);

    // Back to the input's own range: within half a circle of the current value.
    if (p.wrapAngle) y = cur + angleDelta(y - base, p.period);
    return { value: y };
  },
});
