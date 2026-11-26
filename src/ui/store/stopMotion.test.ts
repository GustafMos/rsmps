// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Io } from '../../io/api';
import type { Shot } from '../../engine/lib/stop-motion';
import type { Editor } from './editor';
import { StopMotionController, countdown, stopMotionForSelection, stopMotionSettings, type StopMotionEnv } from './stopMotion';

function setup(opts: { grabMs?: number; nullGrab?: boolean; input?: 'camera-in' | 'media-in' | null; params?: Record<string, unknown> } = {}) {
  const toasts: string[] = [];
  const grabs: { maxSide: number | undefined; mime: string | undefined }[] = [];
  const added: string[] = [];
  const params: Record<string, unknown> = { shots: [], ...opts.params };
  const nodes = [
    { id: 'sm', type: 'stop-motion', params },
    ...(opts.input === null ? [] : [{ id: 'cam', type: opts.input ?? 'camera-in', params: {} }]),
  ];
  const graph = {
    project: { fps: 30 },
    nodes,
    edges: opts.input === null ? [] : [{ id: 'e1', from: { node: 'cam', port: 'image' }, to: { node: 'sm', port: 'image' } }],
  };
  const sets: [string, unknown][] = [];
  const ed = {
    state: { graph },
    setParam: (id: string, key: string, value: unknown) => {
      sets.push([key, value]);
      nodes.find((n) => n.id === id)!.params[key] = value;
    },
    toast: (m: string) => void toasts.push(m),
  } as unknown as Editor;
  let finished: ((f: unknown) => void) | null = null;
  const rec = {
    state: 'idle' as 'idle' | 'recording' | 'saving',
    started: 0,
    start() {
      rec.state = 'recording';
      rec.started++;
    },
    stop: async () => {
      rec.state = 'idle';
      finished?.({ reason: 'stop', nodeId: 'cam', result: { asset: { id: 'clip1' }, seconds: 1.5 } });
      return null;
    },
    onFinished: (fn: (f: unknown) => void) => ((finished = fn), () => (finished = null)),
  };
  let n = 0;
  const io = {
    player: {
      grabNode: vi.fn(async (_id: string, _port: string | undefined, maxSide?: number, mime?: string) => {
        grabs.push({ maxSide, mime });
        if (opts.grabMs) await new Promise((r) => setTimeout(r, opts.grabMs));
        return opts.nullGrab ? null : new Blob(['x'], { type: mime ?? 'image/png' });
      }),
    },
    library: { add: async (files: File[]) => files.map((f) => (added.push(f.name), { id: `a${++n}`, name: f.name })) },
    liveRecorder: rec,
  } as unknown as Io;
  const locks = { got: 0, released: 0 };
  const env: StopMotionEnv = {
    now: () => performance.now(),
    later: (ms, fn) => {
      const t = setTimeout(fn, Math.max(0, ms));
      return () => clearTimeout(t);
    },
    wakeLock: async () => {
      locks.got++;
      return () => void locks.released++;
    },
  };
  const c = new StopMotionController(ed, io, env);
  const shots = () => params.shots as Shot[];
  return { c, shots, toasts, grabs, added, sets, locks, rec, io, ed };
}

describe('Stop Motion controller: manual shots', () => {
  it('Take picture adds a shot; Undo last removes it; the edits are param edits', async () => {
    const t = setup();
    expect(await t.c.take('sm')).toBe(true);
    expect(await t.c.take('sm')).toBe(true);
    expect(await t.c.take('sm')).toBe(true);
    expect(t.shots().map((s) => s.asset)).toEqual(['a1', 'a2', 'a3']);
    expect(t.added).toEqual(['Stop motion shot 1.png', 'Stop motion shot 2.png', 'Stop motion shot 3.png']);
    expect(t.sets.every(([k]) => k === 'shots')).toBe(true);
    t.c.undoLast('sm');
    expect(t.shots().length).toBe(2);
  });

  it('delete, move, duplicate, hold, retake and clear', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) await t.c.take('sm');
    t.c.move('sm', 2, -1);
    expect(t.shots().map((s) => s.asset)).toEqual(['a1', 'a3', 'a2']);
    t.c.duplicate('sm', 0);
    expect(t.shots().map((s) => s.asset)).toEqual(['a1', 'a1', 'a3', 'a2']);
    t.c.hold('sm', 1, 3);
    expect(t.shots()[1]).toEqual({ asset: 'a1', kind: 'still', hold: 3 });
    t.c.remove('sm', 0);
    expect(t.shots().length).toBe(3);
    expect(await t.c.retake('sm', 0)).toBe(true);
    expect(t.shots()[0]).toEqual({ asset: 'a4', kind: 'still', hold: 3 });
    t.c.clearAll('sm');
    expect(t.shots()).toEqual([]);
  });

  it('says what to do when nothing is wired in or the grab fails', async () => {
    const none = setup({ input: null });
    expect(await none.c.take('sm')).toBe(false);
    expect(none.toasts[0]).toMatch(/Wire a Webcam/);
    const bad = setup({ nullGrab: true });
    expect(await bad.c.take('sm')).toBe(false);
    expect(bad.shots()).toEqual([]);
    expect(bad.toasts[0]).toMatch(/no picture/);
  });

  it('the shot size setting scales the grab and stores a JPEG', async () => {
    const t = setup({ params: { shotSize: '720' } });
    await t.c.take('sm');
    expect(t.grabs[0]).toEqual({ maxSide: 720, mime: 'image/jpeg' });
    expect(t.added[0]).toBe('Stop motion shot 1.jpg');
    const full = setup();
    await full.c.take('sm');
    expect(full.grabs[0]).toEqual({ maxSide: 0, mime: 'image/png' });
  });

  it('settings and the viewer pick', () => {
    expect(stopMotionSettings({})).toEqual({ every: 2, limit: 0, maxSide: 0 });
    expect(stopMotionSettings({ interval: 0.01, stopAfter: 3.7, shotSize: '1080' })).toEqual({ every: 0.2, limit: 3, maxSide: 1080 });
    const nodes = [{ id: 'a', type: 'stop-motion', params: {} }, { id: 'b', type: 'stop-motion', params: {} }, { id: 'c', type: 'blur', params: {} }];
    expect(stopMotionForSelection(nodes, ['b'])?.id).toBe('b');
    expect(stopMotionForSelection(nodes, ['a', 'b'])?.id).toBe('b'); // the primary (last) one
    expect(stopMotionForSelection(nodes, ['b', 'c'])).toBeNull(); // primary is not a Stop Motion
    expect(stopMotionForSelection(nodes, [])).toBeNull(); // nothing selected: no viewer buttons
    expect(stopMotionForSelection([], ['a'])).toBeNull();
  });
});

describe('Stop Motion controller: record snippet', () => {
  it('start and stop make one clip shot with its length', async () => {
    const t = setup();
    t.c.toggleSnippet('sm');
    expect(t.rec.started).toBe(1);
    expect(t.c.store.get().snippet).toBe('recording');
    t.c.toggleSnippet('sm');
    await vi.waitFor(() => expect(t.shots().length).toBe(1));
    expect(t.shots()[0]).toEqual({ asset: 'clip1', kind: 'clip', seconds: 1.5 });
    expect(t.c.store.get().snippet).toBe('idle');
  });

  it('needs a live picture wired straight in', () => {
    const t = setup({ input: 'media-in' });
    t.c.toggleSnippet('sm');
    expect(t.rec.started).toBe(0);
    expect(t.toasts[0]).toMatch(/Record snippet needs/);
  });
});

describe('Stop Motion controller: Auto shoot', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('N ticks give N shots at the right times, drift free', async () => {
    const t = setup({ params: { interval: 2 }, grabMs: 300 });
    const t0 = performance.now();
    const times: number[] = [];
    t.io.player.grabNode = vi.fn(async () => {
      times.push(Math.round(performance.now() - t0));
      await new Promise((r) => setTimeout(r, 300));
      return new Blob(['x'], { type: 'image/png' });
    });
    t.c.startAuto('sm');
    await vi.advanceTimersByTimeAsync(6400);
    expect(times).toEqual([0, 2000, 4000, 6000]); // 300 ms grabs do not push later pictures back
    expect(t.shots().length).toBe(4);
    expect(t.c.store.get().auto.count).toBe(4);
    expect(countdown(t.c.store.get().auto, performance.now())).toBe(2);
    t.c.stopAuto();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.shots().length).toBe(4);
  });

  it('a grab slower than the interval skips ticks instead of queueing', async () => {
    const t = setup({ params: { interval: 1 }, grabMs: 2500 });
    t.c.startAuto('sm');
    await vi.advanceTimersByTimeAsync(2600); // first picture done at 2500; ticks 1 and 2 are over
    expect(t.shots().length).toBe(1);
    await vi.advanceTimersByTimeAsync(600); // next due tick is at 3000, its grab ends at 5500
    expect(t.io.player.grabNode).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2500);
    expect(t.shots().length).toBe(2);
    t.c.stopAuto();
  });

  it('Stop after ends the run and releases the wake lock', async () => {
    const t = setup({ params: { interval: 1, stopAfter: 3 } });
    t.c.startAuto('sm');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.shots().length).toBe(3);
    expect(t.c.store.get().auto.running).toBe(false);
    expect(t.locks).toEqual({ got: 1, released: 1 });
  });

  it('Stop releases the wake lock and takes no more pictures', async () => {
    const t = setup({ params: { interval: 1 } });
    t.c.toggleAuto('sm');
    await vi.advanceTimersByTimeAsync(2500);
    expect(t.locks.got).toBe(1);
    expect(t.locks.released).toBe(0);
    t.c.toggleAuto('sm');
    expect(t.locks.released).toBe(1);
    const n = t.shots().length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.shots().length).toBe(n);
  });

  it('keeps shooting when the node is deselected, and grabs the source (never the Stop Motion output, so no onion skin is baked in)', async () => {
    const t = setup({ params: { interval: 1 } });
    (t.ed.state as unknown as { selection: string[] }).selection = ['sm'];
    t.c.toggleAuto('sm');
    await vi.advanceTimersByTimeAsync(1500);
    const before = t.shots().length;
    expect(before).toBeGreaterThan(0);
    (t.ed.state as unknown as { selection: string[] }).selection = []; // the user clicks the empty graph
    await vi.advanceTimersByTimeAsync(3000);
    expect(t.c.store.get().auto.running).toBe(true);
    expect(t.shots().length).toBeGreaterThan(before);
    const grabbed = (t.io.player.grabNode as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0]);
    expect(new Set(grabbed)).toEqual(new Set(['cam']));
    t.c.toggleAuto('sm');
  });

  it('gives up after three failed grabs in a row', async () => {
    const t = setup({ params: { interval: 1 }, nullGrab: true });
    t.c.startAuto('sm');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.c.store.get().auto.running).toBe(false);
    expect(t.toasts.some((m) => /Auto shoot stopped/.test(m))).toBe(true);
  });
});
