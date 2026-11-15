import { defineNode } from '../../define';

/** Small integer hash → 0..1. Deterministic across runs and machines. */
function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export default defineNode({
  id: 'random',
  title: 'Random Number',
  category: 'math',
  description: 'A repeatable random number in a range. The same seed always gives the same value; optionally a different one for every file in a batch.',
  keywords: ['rand', 'noise', 'seed', 'variation', 'jitter', 'chance'],
  inputs: {},
  outputs: { value: { type: 'number', label: 'Number' } },
  params: {
    min: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'Smallest' },
    max: { type: 'number', default: 1, min: -1000000, max: 1000000, step: 0.01, label: 'Largest' },
    seed: { type: 'number', default: 1, min: 0, max: 99999, integer: true, label: 'Seed', hint: 'Change it to get another value. Use different seeds on different Random nodes.' },
    perItem: { type: 'bool', default: false, label: 'Different for each batch file' },
    whole: { type: 'bool', default: false, label: 'Whole numbers only' },
  },
  summary: (p) => `${p.min}..${p.max} · seed ${p.seed}${p.perItem ? ' · per file' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const item = p.perItem ? ctx.item.index : 0;
    const r = hash01(p.seed * 7919 + 13, item + 1);
    let v: number;
    if (p.whole) {
      const lo = Math.ceil(Math.min(p.min, p.max));
      const hi = Math.floor(Math.max(p.min, p.max));
      v = hi < lo ? Math.round(p.min) : lo + Math.min(hi - lo, Math.floor(r * (hi - lo + 1)));
    } else v = p.min + (p.max - p.min) * r;
    return { value: v };
  },
});
