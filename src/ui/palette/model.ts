import { hsvToRgb, rgbToHsv, type HSV, type RGB } from '../lib/colorMath';

export interface Swatch {
  h: number;
  s: number;
  v: number;
  locked?: boolean;
}

export type RuleId = 'analogous' | 'monochromatic' | 'triad' | 'complementary' | 'split' | 'tetradic' | 'square' | 'compound' | 'shades' | 'custom';

export interface Rule {
  id: RuleId;
  label: string;
  /** Hue offsets of a fixed-hue rule (extra swatches become tints/shades of these). */
  offsets?: number[];
  help: string;
}

export const RULES: Rule[] = [
  { id: 'analogous', label: 'Analogous', help: 'Neighboring hues, 30° apart.' },
  { id: 'monochromatic', label: 'Monochromatic', help: 'One hue, varying saturation and brightness.' },
  { id: 'triad', label: 'Triad', offsets: [0, 120, 240], help: 'Three hues evenly spaced.' },
  { id: 'complementary', label: 'Complementary', offsets: [0, 180], help: 'Opposite hues.' },
  { id: 'split', label: 'Split complementary', offsets: [0, 150, 210], help: 'A hue and the two neighbors of its opposite.' },
  { id: 'tetradic', label: 'Double split', offsets: [0, 30, 180, 210], help: 'Two complementary pairs, close together.' },
  { id: 'square', label: 'Square', offsets: [0, 90, 180, 270], help: 'Four hues evenly spaced.' },
  { id: 'compound', label: 'Compound', offsets: [0, 15, 180, 195, 330], help: 'Complementary plus analogous neighbors.' },
  { id: 'shades', label: 'Shades', help: 'One hue and saturation, from light to dark.' },
  { id: 'custom', label: 'Custom', help: 'Free handles: drag each swatch anywhere.' },
];

export const ruleOf = (id: RuleId): Rule => RULES.find((r) => r.id === id)!;
export const fixedCount = (id: RuleId): number | null => ruleOf(id).offsets?.length ?? null;

export interface StudioState {
  rule: RuleId;
  base: number;
  swatches: Swatch[];
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mod = (n: number, m: number) => ((n % m) + m) % m;

/** Recompute every unlocked swatch from the base swatch according to the rule. */
export function regenerate(st: StudioState, count = st.swatches.length): StudioState {
  if (st.rule === 'custom') return st;
  const n = Math.max(2, Math.min(16, count));
  const bi = Math.min(st.base, n - 1);
  const base = st.swatches[Math.min(st.base, st.swatches.length - 1)] ?? { h: 220, s: 0.7, v: 0.85 };
  const rule = ruleOf(st.rule);
  const out: Swatch[] = [];
  const step = 0.6 / Math.max(1, n - 1);
  for (let i = 0; i < n; i++) {
    const old = st.swatches[i];
    if (i === bi) {
      out.push({ h: base.h, s: base.s, v: base.v, locked: old?.locked });
      continue;
    }
    if (old?.locked) {
      out.push(old);
      continue;
    }
    const d = i - bi;
    let s: Swatch;
    if (st.rule === 'analogous') s = { h: mod(base.h + d * 30, 360), s: base.s, v: base.v };
    else if (st.rule === 'monochromatic') s = { h: base.h, s: clamp(base.s - d * step * 0.6, 0.05, 1), v: clamp(base.v + d * step, 0.08, 1) };
    else if (st.rule === 'shades') s = { h: base.h, s: base.s, v: clamp(base.v - d * (0.85 / Math.max(1, n - 1)), 0.05, 1) };
    else {
      const offs = rule.offsets!;
      const k = offs[mod(d, offs.length)];
      const level = Math.floor(Math.abs(d) / offs.length);
      s = { h: mod(base.h + k, 360), s: clamp(base.s * (1 - 0.12 * level)), v: clamp(base.v * (1 - 0.2 * level), 0.1, 1) };
    }
    out.push(s);
  }
  return { ...st, base: bi, swatches: out };
}

export const swatchRgb = (s: Swatch): RGB => hsvToRgb([s.h, s.s, s.v]);
export const swatchFromRgb = (c: RGB, keep?: Swatch): Swatch => {
  const [h, s, v]: HSV = rgbToHsv(c);
  return { h: s < 0.001 || v < 0.001 ? (keep?.h ?? 0) : h, s, v, locked: keep?.locked };
};

export function fromColors(colors: RGB[]): StudioState {
  const list = colors.length ? colors : ([[0.31, 0.4, 0.95]] as RGB[]);
  return { rule: 'custom', base: 0, swatches: list.slice(0, 64).map((c) => swatchFromRgb(c)) };
}

export function triadStart(): StudioState {
  return regenerate({ rule: 'triad', base: 0, swatches: [{ h: 222, s: 0.75, v: 0.9 }] }, 3);
}
