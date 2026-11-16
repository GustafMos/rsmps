import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createGraph } from '../engine/graph';
import type { GraphDoc } from '../engine/types';
import type { AppCtx } from './store/context';

// the store modules read localStorage / document at import time
const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal('location', { search: '', href: 'http://localhost/', reload: vi.fn(), replace: vi.fn() });

const safety = await import('./safety');
const { GUARD_KEY } = await import('../io/boot-guard');

const withNode = (g: GraphDoc, value: number): GraphDoc => ({ ...g, nodes: [{ id: 'n1', type: 'blur', x: 0, y: 0, params: { radius: value } }] });

/** The Player contract that matters here: it evaluates only when it is given a node to show. */
function mockPlayer() {
  const evaluate = vi.fn();
  const views: (string | null)[] = [];
  return {
    evaluate,
    views,
    setView: (v: { node: string | null }) => {
      views.push(v.node);
      if (v.node) evaluate(v.node);
    },
  };
}

beforeEach(() => {
  mem.clear();
  safety.safetyStore.set({ paused: false, safe: null, banner: false, slow: false, previous: null });
});

describe('safe start', () => {
  it('after an unclean run the app starts paused and never asks the player to evaluate', () => {
    mem.set(GUARD_KEY, JSON.stringify({ at: 1, phase: 'render', project: 'p', session: 'old' }));
    const d = safety.beginSafety('');
    expect(d).toMatchObject({ safe: true, reason: 'unclean' });
    expect(safety.safetyStore.get()).toMatchObject({ paused: true, banner: true, safe: 'unclean' });
    expect(mem.has(GUARD_KEY)).toBe(false); // safe mode renders nothing, so it cannot hang: the loop is broken

    const player = mockPlayer();
    const g = withNode(createGraph('x'), 1515);
    safety.pushView(player, { graph: g, node: 'n1', item: 0, itemCount: 1 }, safety.safetyStore.get().paused);
    safety.pushView(player, { graph: withNode(g, 2), node: 'n1', item: 0, itemCount: 1 }, safety.safetyStore.get().paused); // edits while paused
    expect(player.evaluate).not.toHaveBeenCalled();
    expect(player.views).toEqual([null, null]);
  });

  it('?safe starts paused too, and a clean start does not', () => {
    expect(safety.beginSafety('?safe=1').reason).toBe('url');
    mem.clear();
    expect(safety.beginSafety('').safe).toBe(false);
    expect(safety.safetyStore.get().paused).toBe(false);
    expect(mem.has(GUARD_KEY)).toBe(true); // armed until the first frame
  });

  it('resuming hands the node back to the player', () => {
    const player = mockPlayer();
    const g = withNode(createGraph('x'), 1);
    safety.pushView(player, { graph: g, node: 'n1', item: 0, itemCount: 1 }, true);
    safety.pushView(player, { graph: g, node: 'n1', item: 0, itemCount: 1 }, false);
    expect(player.evaluate).toHaveBeenCalledTimes(1);
  });

  it('the banner text names the cause', () => {
    expect(safety.safeBannerText('unclean')).toBe('RSMPS did not shut down cleanly. Rendering is paused so you can fix the graph.');
    expect(safety.safeBannerText('shift')).toMatch(/Shift/);
  });
});

describe('undo last change and restoring backups', () => {
  function fakeApp(graph: GraphDoc, backups: { id: string; at: number; graph: GraphDoc }[]) {
    const calls: unknown[][] = [];
    const ed = {
      state: { graph, activeProject: 'p1' },
      setParam: (...a: unknown[]) => calls.push(['setParam', ...a]),
      loadGraph: (...a: unknown[]) => calls.push(['loadGraph', ...a]),
    };
    const io = {
      projects: {
        listBackups: async () => backups.map(({ id, at }) => ({ id, at, name: 'x', nodes: 1, bytes: 1, sig: id })),
        loadBackup: async (_p: string, id: string) => backups.find((b) => b.id === id)?.graph ?? null,
      },
    };
    return { app: { ed, io } as unknown as AppCtx, calls };
  }
  const pending = (v: unknown, nv: unknown) => JSON.stringify({ nodeId: 'n1', key: 'radius', label: 'Blur · Radius', oldValue: v, newValue: nv, at: 1 });

  it('reverts the remembered parameter edit when the node still holds the new value', async () => {
    mem.set(safety.PENDING_STORE_KEY, pending(4, 1515));
    const { app, calls } = fakeApp(withNode(createGraph('x'), 1515), []);
    expect(await safety.undoLastChange(app)).toEqual({ kind: 'param', label: 'Blur · Radius' });
    expect(calls).toEqual([['setParam', 'n1', 'radius', 4]]);
    expect(mem.has(safety.PENDING_STORE_KEY)).toBe(false);
  });

  it('falls back to the newest backup (kept on the undo stack) when the edit is not revertible', async () => {
    mem.set(safety.PENDING_STORE_KEY, pending(4, 1515));
    const old = withNode(createGraph('old'), 4);
    const { app, calls } = fakeApp(withNode(createGraph('x'), 7), [{ id: 'b2', at: 20, graph: old }, { id: 'b1', at: 10, graph: createGraph('older') }]);
    expect(await safety.undoLastChange(app)).toEqual({ kind: 'backup', at: 20 });
    expect(calls).toEqual([['loadGraph', old, true]]);
  });

  it('reports nothing to undo when there is no edit and no backup', async () => {
    const { app } = fakeApp(createGraph('x'), []);
    expect(await safety.undoLastChange(app)).toBeNull();
  });

  it('restoreBackup loads the chosen backup with history kept, and fails cleanly for an unknown id', async () => {
    const chosen = withNode(createGraph('chosen'), 3);
    const { app, calls } = fakeApp(createGraph('x'), [{ id: 'b1', at: 1, graph: chosen }]);
    expect(await safety.restoreBackup(app, 'b1')).toBe(true);
    expect(calls).toEqual([['loadGraph', chosen, true]]);
    expect(await safety.restoreBackup(app, 'nope')).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('canRevert / parsePending / snapshotDue', () => {
    const g = withNode(createGraph('x'), 9);
    expect(safety.canRevert(safety.parsePending(pending(1, 9)), g)).toBe(true);
    expect(safety.canRevert(safety.parsePending(pending(1, 8)), g)).toBe(false);
    expect(safety.canRevert(null, g)).toBe(false);
    expect(safety.parsePending('{bad')).toBeNull();
    expect(safety.snapshotDue({ lastAt: null, now: 1, changed: true })).toBe(true);
    expect(safety.snapshotDue({ lastAt: null, now: 1, changed: false })).toBe(false);
    expect(safety.snapshotDue({ lastAt: 1000, now: 5000, changed: true })).toBe(false);
    expect(safety.snapshotDue({ lastAt: 1000, now: 40_000, changed: true })).toBe(true);
  });
});
