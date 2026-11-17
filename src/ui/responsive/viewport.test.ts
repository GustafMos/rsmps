import { describe, expect, it } from 'vitest';
import { QUERIES, classify } from './breakpoints';
import { createViewportStore } from './viewport';

/** A fake matchMedia: queries are keyed by their text and flipped by hand. */
function fakeMatchMedia(initial: Partial<Record<keyof typeof QUERIES, boolean>>) {
  const state = new Map<string, boolean>(Object.entries(QUERIES).map(([k, q]) => [q, !!initial[k as keyof typeof QUERIES]]));
  const handlers = new Map<string, Set<() => void>>();
  const mm = (q: string) => ({
    get matches() {
      return !!state.get(q);
    },
    addEventListener: (_: string, fn: () => void) => {
      (handlers.get(q) ?? handlers.set(q, new Set()).get(q)!).add(fn);
    },
    removeEventListener: (_: string, fn: () => void) => {
      handlers.get(q)?.delete(fn);
    },
  });
  const set = (k: keyof typeof QUERIES, v: boolean) => {
    state.set(QUERIES[k], v);
    handlers.get(QUERIES[k])?.forEach((f) => f());
  };
  return { mm: mm as never, set, listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0) };
}

describe('classify', () => {
  it('uses width, and height for coarse landscape phones', () => {
    expect(classify(390, 844, true)).toBe('phone');
    expect(classify(639, 900, false)).toBe('phone');
    expect(classify(640, 900, false)).toBe('tablet');
    expect(classify(844, 390, true)).toBe('phone'); // landscape phone
    expect(classify(844, 390, false)).toBe('tablet'); // a short desktop window is not a phone
    expect(classify(1023, 700, false)).toBe('tablet');
    expect(classify(1024, 600, false)).toBe('desktop');
    expect(classify(1180, 820, true)).toBe('desktop'); // tablet in landscape, tall enough
  });
});

describe('viewport store', () => {
  it('reads the class from the queries and follows changes', () => {
    const f = fakeMatchMedia({ tablet: true, coarse: true });
    const s = createViewportStore(f.mm);
    expect(s.snapshot().cls).toBe('tablet');
    let calls = 0;
    const off = s.subscribe(() => calls++);
    f.set('phone', true);
    expect(s.snapshot().cls).toBe('phone');
    f.set('phone', false);
    f.set('tablet', false);
    expect(s.snapshot().cls).toBe('desktop');
    expect(calls).toBe(3);
    off();
    expect(f.listeners()).toBe(0);
  });
  it('keeps the same snapshot object while nothing changed, and tracks coarse / reduced motion', () => {
    const f = fakeMatchMedia({});
    const s = createViewportStore(f.mm);
    const a = s.snapshot();
    s.subscribe(() => undefined);
    f.set('landscape', true);
    f.set('landscape', true);
    const b = s.snapshot();
    expect(b).not.toBe(a);
    f.set('landscape', true);
    expect(s.snapshot()).toBe(b);
    f.set('coarse', true);
    f.set('reducedMotion', true);
    expect(s.snapshot()).toMatchObject({ coarse: true, reducedMotion: true, landscape: true });
  });
  it('is a desktop without matchMedia', () => {
    expect(createViewportStore(undefined).snapshot()).toMatchObject({ cls: 'desktop', coarse: false });
  });
});
