import { describe, expect, it } from 'vitest';
import { installVisualViewportVars, keyboardInset, keyboardOpen, scrollDeltaToReveal } from './keyboardAvoid';

describe('keyboardInset', () => {
  it('is the part of the layout viewport the visual viewport leaves uncovered at the bottom', () => {
    expect(keyboardInset(844, 844, 0)).toBe(0);
    expect(keyboardInset(844, 520, 0)).toBe(324);
    expect(keyboardInset(844, 500, 40)).toBe(304); // iOS scrolled the page up a little
    expect(keyboardInset(800, 900, 0)).toBe(0); // never negative
  });
  it('tells the keyboard from a shrinking address bar', () => {
    expect(keyboardOpen(60, 844)).toBe(false);
    expect(keyboardOpen(300, 844)).toBe(true);
    expect(keyboardOpen(130, 600)).toBe(true);
  });
});

describe('scrollDeltaToReveal', () => {
  it('is 0 when the field is already visible', () => {
    expect(scrollDeltaToReveal({ top: 100, bottom: 140 }, 0, 500)).toBe(0);
  });
  it('scrolls down by what the keyboard hides, plus the margin', () => {
    expect(scrollDeltaToReveal({ top: 560, bottom: 600 }, 0, 520)).toBe(600 - (520 - 12));
  });
  it('scrolls up when the field is above the visible area', () => {
    expect(scrollDeltaToReveal({ top: -30, bottom: 10 }, 0, 500)).toBe(-42);
  });
  it('accounts for the visual viewport offset', () => {
    expect(scrollDeltaToReveal({ top: 100, bottom: 140 }, 200, 400)).toBe(100 - 212);
  });
  it('shows the top of something taller than the area', () => {
    expect(scrollDeltaToReveal({ top: 50, bottom: 900 }, 0, 400)).toBe(50 - 12);
  });
});

describe('installVisualViewportVars', () => {
  it('publishes CSS variables, follows the viewport and cleans up', () => {
    const handlers: Record<string, (() => void)[]> = {};
    const vv = {
      height: 844,
      offsetTop: 0,
      addEventListener: (t: string, f: () => void) => (handlers[t] ??= []).push(f),
      removeEventListener: (t: string, f: () => void) => (handlers[t] = (handlers[t] ?? []).filter((x) => x !== f)),
    };
    const props = new Map<string, string>();
    const root = { style: { setProperty: (k: string, v: string) => props.set(k, v) }, dataset: {} as Record<string, string> } as unknown as HTMLElement;
    const win = { innerHeight: 844, visualViewport: vv, addEventListener: () => undefined, removeEventListener: () => undefined };
    const off = installVisualViewportVars(win as never, root);
    expect(props.get('--vv-h')).toBe('844px');
    expect(props.get('--kb-inset')).toBe('0px');
    vv.height = 500;
    handlers.resize.forEach((f) => f());
    expect(props.get('--vv-h')).toBe('500px');
    expect(props.get('--kb-inset')).toBe('344px');
    expect((root as unknown as { dataset: Record<string, string> }).dataset.kb).toBe('1');
    off();
    expect(handlers.resize).toHaveLength(0);
  });
});
