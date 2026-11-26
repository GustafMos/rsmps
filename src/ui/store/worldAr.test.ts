// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { openWorldAr, takeMessage } from './worldAr';

/** A document with just enough in it for the overlay's buttons (the test runs without a browser). */
function stubDocument() {
  const el = () => {
    const e: Record<string, unknown> = { style: {}, children: [], textContent: '' };
    e.setAttribute = () => undefined;
    e.addEventListener = () => undefined;
    e.append = () => undefined;
    e.appendChild = () => undefined;
    e.remove = vi.fn();
    return e;
  };
  vi.stubGlobal('document', { createElement: el, body: { appendChild: () => undefined } });
}

function app(over: { worldAr?: unknown; viewed?: string | null } = {}) {
  const toast = vi.fn();
  return {
    toast,
    ctx: {
      io: { worldAr: over.worldAr },
      ed: { toast, state: { graph: { nodes: [{ id: 'n', x: 0, y: 0, params: {} }] }, viewedNodeId: over.viewed ?? null } },
    } as never,
  };
}

describe('Start AR button', () => {
  it('says so plainly when this version has no AR view', () => {
    const a = app();
    openWorldAr(a.ctx, 'n', 'n');
    expect(a.toast).toHaveBeenCalledWith(expect.stringContaining('not available'), 'error');
  });
  it('asks to view a node first and does not touch the browser', () => {
    const open = vi.fn();
    const a = app({ worldAr: { active: null, open } });
    openWorldAr(a.ctx, 'n', 'n');
    expect(open).not.toHaveBeenCalled();
    expect(a.toast).toHaveBeenCalledWith(expect.stringContaining('View the node'), 'info');
  });
  it('a refused session ends in a plain message and the app carries on', async () => {
    stubDocument();
    const open = vi.fn().mockRejectedValue(new Error('AR is not supported on this device or browser.'));
    const a = app({ worldAr: { active: null, open }, viewed: 'obj' });
    openWorldAr(a.ctx, 'n', 'n');
    await new Promise((r) => setTimeout(r, 0));
    expect(open).toHaveBeenCalledTimes(1);
    expect(a.toast).toHaveBeenCalledWith('AR is not supported on this device or browser.', 'error');
    vi.unstubAllGlobals();
  });
  it('a started session shows the overlay state and removes it, with the message, when it ends', async () => {
    stubDocument();
    let end!: (e: { error?: string }) => void;
    const handle = { state: () => ({ phase: 'aiming', hint: 'x', features: {} }), closed: new Promise((r) => (end = r)), close: vi.fn() };
    const open = vi.fn().mockResolvedValue(handle);
    const a = app({ worldAr: { active: null, open }, viewed: 'obj' });
    openWorldAr(a.ctx, 'n', 'n');
    await new Promise((r) => setTimeout(r, 0));
    end({ error: 'The AR session ended unexpectedly.' });
    await new Promise((r) => setTimeout(r, 0));
    expect(a.toast).toHaveBeenCalledWith('The AR session ended unexpectedly.', 'error');
    vi.unstubAllGlobals();
  });
  it('take messages are plain', () => {
    expect(takeMessage({ take: null, clip: null, seconds: 0, error: 'Nope.' } as never)).toEqual({ text: 'Nope.', kind: 'error' });
    expect(takeMessage({ take: {}, clip: null, seconds: 2, error: null } as never).kind).toBe('info');
  });
});
