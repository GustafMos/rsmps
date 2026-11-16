import { describe, expect, it } from 'vitest';
import { Registry } from '../define';
import { registerBuiltins } from '../nodes';

/** Two nodes must never look the same in the add menu: same title (ignoring case, punctuation and colour/color) or title +/- "s". */
const norm = (title: string) =>
  title
    .toLowerCase()
    .replace(/colour/g, 'color')
    .replace(/grey/g, 'gray')
    .replace(/centre/g, 'center')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function visibleDefs() {
  const registry = new Registry();
  registerBuiltins(registry);
  return registry.list().filter((d) => !d.hidden);
}

describe('node titles', () => {
  it('no two nodes share an id', () => {
    const modules = import.meta.glob('../nodes/**/*.node.ts', { eager: true }) as Record<string, Record<string, unknown>>;
    const seen = new Map<string, string>();
    for (const [path, mod] of Object.entries(modules)) {
      const r = new Registry();
      for (const id of r.registerModule(mod)) {
        expect(seen.get(id), `id "${id}" is defined in ${seen.get(id)} and ${path}`).toBeUndefined();
        seen.set(id, path);
      }
    }
    expect(seen.size).toBeGreaterThan(100);
  });

  it('no two visible nodes share a title (case, punctuation and colour/color spelling ignored)', () => {
    const byTitle = new Map<string, string>();
    for (const d of visibleDefs()) {
      const key = norm(d.title);
      expect(byTitle.get(key), `"${d.title}" (${d.id}) has the same title as ${byTitle.get(key)}`).toBeUndefined();
      byTitle.set(key, d.id);
    }
  });

  it('no visible title is another visible title plus or minus a trailing "s"', () => {
    const byTitle = new Map(visibleDefs().map((d) => [norm(d.title), d.id]));
    for (const d of visibleDefs()) {
      const key = norm(d.title);
      const other = byTitle.get(key + 's') ?? (key.endsWith('s') ? byTitle.get(key.slice(0, -1)) : undefined);
      expect(other, `"${d.title}" (${d.id}) differs from ${other} only by a trailing "s"`).toBeUndefined();
    }
  });

  it('UI titles use US spelling (Color, Gray, Center)', () => {
    for (const d of visibleDefs()) expect(d.title, d.id).not.toMatch(/colour|grey|centre/i);
  });
});
