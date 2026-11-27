import { defineNode } from '../../define';
import { areaOf, centerOf, validRegions } from '../../lib/track-core';
import type { Region } from '../../types';

const ORDERS = [
  { value: 'as-is', label: 'Keep order' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
  { value: 'score', label: 'Best score first' },
  { value: 'left', label: 'Left to right' },
  { value: 'top', label: 'Top to bottom' },
  { value: 'center', label: 'Closest to center first' },
] as const;

/** Parse "1, 4, 9" into numbers. */
function parseIds(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/** Label rules: comma-separated words; a region passes if its label contains any plain word and none of the "!word"s. */
function labelPasses(label: string, rules: string): boolean {
  const terms = rules
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!terms.length) return true;
  const l = label.toLowerCase();
  const include = terms.filter((t) => !t.startsWith('!'));
  const exclude = terms.filter((t) => t.startsWith('!')).map((t) => t.slice(1));
  if (exclude.some((t) => t && l.includes(t))) return false;
  return include.length === 0 || include.some((t) => l.includes(t));
}

export default defineNode({
  id: 'region-filter',
  title: 'Filter Regions',
  category: 'track',
  description:
    'Keeps only some of the regions: by label, minimum score, id, or position in the list (for example only the largest, or only region number 3).',
  keywords: ['filter', 'select', 'keep', 'largest', 'label', 'id', 'score', 'only', 'pick'],
  guide: {
    does: 'Keeps only some of the regions, for example only the biggest one or only the ones called "person".',
    steps: [
      'Wire regions into Regions to filter.',
      'Choose what to keep: label, score, id or position in the list.',
      'Wire the result into any region node.',
    ],
    needs: [
      { input: 'regions', hint: 'The list of regions to pick from.' },
    ],
    seeAlso: ['track', 'region-transform'],
  },
  inputs: { regions: { type: 'regions', required: true, label: 'Regions to filter' } },
  outputs: { regions: { type: 'regions', label: 'Regions' } },
  params: {
    label: { type: 'string', default: '', label: 'Label contains', hint: 'Comma-separated words, e.g. "person, car". Put ! in front to exclude: "!blob". Empty = any.' },
    minScore: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Minimum score' },
    ids: { type: 'string', default: '', label: 'Only these ids', hint: 'Comma-separated ids from Track. Empty = any.' },
    order: { type: 'enum', default: 'as-is', options: ORDERS, label: 'Order by' },
    first: { type: 'number', default: 0, min: 0, max: 1000, step: 1, integer: true, label: 'Start at number', hint: '0 is the first region after ordering.' },
    count: { type: 'number', default: 0, min: 0, max: 1000, step: 1, integer: true, label: 'Count', hint: 'Order by Largest, start at 0, count 1 = only the largest.' },
    invert: { type: 'bool', default: false, label: 'Remove these' },
  },
  summary: (p) => {
    const bits: string[] = [];
    if (p.label) bits.push(`"${p.label}"`);
    if (p.minScore > 0) bits.push(`score ≥ ${p.minScore}`);
    if (p.ids) bits.push(`ids ${p.ids}`);
    if (p.count > 0 || p.first > 0) bits.push(`#${p.first}${p.count > 0 ? `..${p.first + p.count - 1}` : '+'}`);
    return (p.invert ? 'not ' : '') + (bits.join(' · ') || 'all');
  },
  render(ctx) {
    const p = ctx.params;
    const all = validRegions(ctx.in.regions.items);
    const ids = parseIds(p.ids);
    let kept: Region[] = all.filter((r) => r.score >= p.minScore && labelPasses(r.label, p.label) && (ids.length === 0 || ids.includes(r.id)));
    const cmp: Record<string, (a: Region, b: Region) => number> = {
      largest: (a, b) => areaOf(b.box) - areaOf(a.box),
      smallest: (a, b) => areaOf(a.box) - areaOf(b.box),
      score: (a, b) => b.score - a.score,
      left: (a, b) => centerOf(a.box)[0] - centerOf(b.box)[0],
      top: (a, b) => centerOf(a.box)[1] - centerOf(b.box)[1],
      center: (a, b) => Math.hypot(...centerOf(a.box).map((v) => v - 0.5)) - Math.hypot(...centerOf(b.box).map((v) => v - 0.5)),
    };
    if (cmp[p.order]) kept = [...kept].sort(cmp[p.order]);
    if (p.first > 0 || p.count > 0) kept = kept.slice(p.first, p.count > 0 ? p.first + p.count : undefined);
    const items = p.invert ? all.filter((r) => !kept.includes(r)) : kept;
    return { regions: { kind: 'regions', items } };
  },
});
