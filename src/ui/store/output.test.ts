import { describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const { OutputController, outputHtml, WINDOW_NAME, DEFAULT_OPTS } = await import('./output');

describe('output window', () => {
  it('the popup document has a video, a copy canvas, a blackout layer and the key hints', () => {
    const html = outputHtml();
    expect(html).toContain('<video id="v"');
    expect(html).toContain('<canvas id="c"');
    expect(html).toContain('id="black"');
    expect(html).toMatch(/F or double-click: full screen/);
    expect(WINDOW_NAME).toBe('rsmps-output');
  });

  it('tells the user how to allow pop-ups when the browser blocks it, and stays closed', () => {
    vi.stubGlobal('window', { open: () => null, addEventListener: () => undefined, removeEventListener: () => undefined });
    const msgs: string[] = [];
    const out = new OutputController((m) => msgs.push(m));
    expect(out.open()).toBe(false);
    expect(out.store.get().open).toBe(false);
    expect(msgs[0]).toMatch(/Allow pop-ups/);
  });

  it('options are remembered, validated when loaded, and default to a black, sharp, fitted picture', () => {
    expect(DEFAULT_OPTS).toMatchObject({ fit: 'fit', sharp: true, bg: '#000000', clean: false, display: 'auto' });
    const out = new OutputController(() => undefined);
    out.setOpts({ fit: 'native', bg: '#00b140', display: '2' });
    expect(JSON.parse(mem.get('rsmps.output.opts')!)).toMatchObject({ fit: 'native', bg: '#00b140', display: '2' });
    mem.set('rsmps.output.opts', JSON.stringify({ fit: 'weird', bg: 'red; background:url(x)', display: '9', clean: true }));
    const again = new OutputController(() => undefined);
    expect(again.store.get().opts).toMatchObject({ fit: 'fit', bg: '#000000', display: 'auto', clean: true });
  });

  it('blackout and freeze are plain toggles that need no window to be remembered', () => {
    const out = new OutputController(() => undefined);
    out.setBlackout();
    out.setFreeze();
    expect(out.store.get()).toMatchObject({ blackout: true, freeze: true });
    out.setBlackout(false);
    expect(out.store.get().blackout).toBe(false);
  });
});
