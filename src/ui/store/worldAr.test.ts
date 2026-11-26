// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { openWorldAr, saveVideoAfter, takeMessage } from './worldAr';
import { getLive } from './live';

vi.mock('./live', () => ({ getLive: vi.fn() }));

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

describe('Start AR and the camera', () => {
  it('opens the view through the controller, which is what lets go of the camera', () => {
    const open = vi.fn(() => new Promise(() => undefined));
    const a = app({ worldAr: { active: null, open }, viewed: 'x' });
    stubDocument();
    openWorldAr(a.ctx, 'n', 'n');
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe('the finished video after the AR view closed', () => {
  const setup = (busy: (string | null)[], saveVideo = true) => {
    const toast = vi.fn();
    const start = vi.fn(async () => true);
    const queue = [...busy];
    vi.mocked(getLive).mockReturnValue({ worldArVideo: { busy: () => (queue.length ? queue.shift()! : null), start } } as never);
    const ctx = { io: {}, ed: { toast, state: { graph: { nodes: [{ id: 'n', x: 0, y: 0, params: { saveVideo } }] } } } } as never;
    return { toast, start, ctx };
  };
  it('starts once everything is free, and says it is making the video', async () => {
    const t = setup(['Close the AR view first.', 'An export is already running.']);
    await saveVideoAfter(t.ctx, 'n', 'n', { tookTake: true, recorded: true }, 0);
    expect(t.start).toHaveBeenCalledWith('n');
    expect(t.toast).toHaveBeenCalledWith(expect.stringContaining('Making the finished video'), 'info');
  });
  it('a take without a camera clip says plainly that no video was made', async () => {
    const t = setup([]);
    await saveVideoAfter(t.ctx, 'n', 'n', { tookTake: true, recorded: false }, 0);
    expect(t.start).not.toHaveBeenCalled();
    expect(t.toast).toHaveBeenCalledWith(expect.stringContaining('No finished video was made'), 'info');
  });
  it('Save video off, or nothing recorded: nothing happens; a failure to start is shown', async () => {
    const off = setup([], false);
    await saveVideoAfter(off.ctx, 'n', 'n', { tookTake: true, recorded: true }, 0);
    expect(off.start).not.toHaveBeenCalled();
    const none = setup([]);
    await saveVideoAfter(none.ctx, 'n', 'n', { tookTake: false, recorded: false }, 0);
    expect(none.toast).not.toHaveBeenCalled();
    const bad = setup([]);
    bad.start.mockRejectedValue(new Error('boom'));
    await saveVideoAfter(bad.ctx, 'n', 'n', { tookTake: true, recorded: true }, 0);
    expect(bad.toast).toHaveBeenCalledWith(expect.stringContaining('could not be started: boom'), 'error');
  });
});
