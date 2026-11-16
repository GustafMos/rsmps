import { describe, expect, it } from 'vitest';
import { Registry } from '../define';
import { registerBuiltins } from '../nodes';

/**
 * Labels are what the user reads on a node body and in the inspector, so they stay short: a parameter label is at most
 * MAX_LABEL characters, with no parenthetical (the explanation belongs in `hint`; units in `unit`). Enum option labels
 * and group names follow the same rule. Labels are unique inside a node + group (and option labels inside their parameter).
 */
const MAX_LABEL = 24;

/** Whole nodes that are not checked yet. Remove an entry once its labels comply. */
const SKIP_NODES: Record<string, string> = {
};

/** `node.param` -> longest option label allowed. Option labels are algorithm names that must be spelled out. */
const LONG_OPTIONS: Record<string, number> = {
  // "Diffusion · Jarvis–Judice–Ninke": the family prefix groups the dropdown and the surname chain cannot be shortened.
  'dither.algorithm': 34,
};

const defs = () => {
  const registry = new Registry();
  registerBuiltins(registry);
  return registry.list().filter((d) => !(d.id in SKIP_NODES));
};

describe('node labels', () => {
  it('every parameter label is short and has no parenthetical', () => {
    const bad: string[] = [];
    for (const d of defs()) {
      for (const [key, p] of Object.entries(d.params as Record<string, { label?: string; group?: string }>)) {
        const label = p.label ?? '';
        if (label.length > MAX_LABEL) bad.push(`${d.id}.${key}: "${label}" is ${label.length} characters`);
        if (/[()]/.test(label)) bad.push(`${d.id}.${key}: "${label}" has parentheses (use hint)`);
        const group = p.group ?? '';
        if (group.length > MAX_LABEL || /[()]/.test(group)) bad.push(`${d.id}.${key}: group "${group}" is too long or has parentheses`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('enum option labels are short and have no parenthetical', () => {
    const bad: string[] = [];
    for (const d of defs()) {
      for (const [key, p] of Object.entries(d.params as Record<string, { type: string; options?: { value: string; label: string }[] }>)) {
        if (p.type !== 'enum') continue;
        const max = LONG_OPTIONS[`${d.id}.${key}`] ?? MAX_LABEL;
        for (const o of p.options ?? []) {
          if (o.label.length > max) bad.push(`${d.id}.${key}=${o.value}: "${o.label}" is ${o.label.length} characters`);
          if (/[()]/.test(o.label)) bad.push(`${d.id}.${key}=${o.value}: "${o.label}" has parentheses`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('labels are unique inside a node + group, option labels inside a parameter', () => {
    const bad: string[] = [];
    for (const d of defs()) {
      const seen = new Map<string, string>();
      for (const [key, p] of Object.entries(d.params as Record<string, { label?: string; group?: string; type: string; options?: { label: string }[] }>)) {
        if (p.label) {
          const id = `${p.group ?? ''}|${p.label}`;
          const other = seen.get(id);
          // a param that is shown only in some modes may repeat a label of a sibling that is hidden then; that still reads as a duplicate
          if (other) bad.push(`${d.id}: "${p.label}" is used by both ${other} and ${key}${p.group ? ` (group ${p.group})` : ''}`);
          seen.set(id, key);
        }
        if (p.type === 'enum') {
          const labels = new Set<string>();
          for (const o of p.options ?? []) {
            if (labels.has(o.label)) bad.push(`${d.id}.${key}: option label "${o.label}" appears twice`);
            labels.add(o.label);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
