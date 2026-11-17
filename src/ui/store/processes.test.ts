import { describe, expect, it, vi } from 'vitest';

const mem = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const { Editor } = await import('./editor');
const { Registry } = await import('../../engine/define');
const { registerBuiltins } = await import('../../engine/nodes');
const { addNode, createGraph } = await import('../../engine/graph');
const { nodeAtPath } = await import('../../engine/group');
const { processLabel, processResultOf } = await import('../../engine/process');
const { cancelProcess, clearProcess, jobOf, processSelection, processStore, runProcess } = await import('./processes');
import type { GraphDoc, ProcessResult } from '../../engine/types';
import type { Io, ProcessJob } from '../../io/api';
import type { AppCtx } from './context';

/** Process panels inside open groups: the UI store works on full path ids and writes results into the nested node. */
const registry = new Registry();
registerBuiltins(registry);

const RESULT: ProcessResult = { signature: 'sig-1', items: { tracks: { kind: 'blob', id: 'asset-1', bytes: 10, mime: 'application/json' }, frames: { kind: 'sequence', id: 'asset-2', bytes: 0, frames: 1, fps: 30, width: 4, height: 4 } }, meta: {}, bytes: 10, createdAt: 1, seconds: 0 };

function setup() {
  const pending = new Map<string, { resolve: (r: ProcessResult) => void; reject: (e: unknown) => void }>();
  const log: string[] = [];
  const jobs: ProcessJob[] = [];
  let auto = false;
  const processes = {
    run: (_g: GraphDoc, node: string) => {
      log.push(`run ${node}`);
      jobs.push({ id: `j${jobs.length}`, project: 'p', node, title: 'Process', label: node, state: 'running', progress: 0.5, gpu: false, queuedAt: 0 });
      processStore.set({ jobs: [...jobs] });
      return new Promise<ProcessResult>((resolve, reject) => {
        pending.set(node, { resolve, reject });
        if (auto) resolve(RESULT);
      });
    },
    cancel: (node: string) => {
      log.push(`cancel ${node}`);
      pending.get(node)?.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    },
    dismiss: (node: string) => {
      log.push(`dismiss ${node}`);
      const i = jobs.findIndex((j) => j.node === node);
      if (i >= 0) jobs.splice(i, 1);
      processStore.set({ jobs: [...jobs] });
    },
    clear: async (node: string) => void log.push(`clear ${node}`),
    status: () => ({ state: 'none' }),
  };
  const io = { registry, library: { list: () => [] }, player: { getState: () => ({ seconds: 0 }) }, processes } as unknown as Io;
  const ed = new Editor(io);
  let g: GraphDoc = createGraph('t');
  const track = addNode(g, registry, 'track', { x: 0, y: 0 });
  g = track.graph;
  const cache = addNode(g, registry, 'cache', { x: 300, y: 0 });
  g = cache.graph;
  ed.loadGraph(g);
  const gid = ed.groupNodes('group', [track.node.id, cache.node.id])!;
  ed.setGroupInfo(gid, { title: 'Rig' });
  const app = { ed, io } as unknown as AppCtx;
  return {
    app,
    ed,
    log,
    pending,
    setAuto: (v: boolean) => (auto = v),
    gid,
    trackId: track.node.id,
    cacheId: cache.node.id,
    trackFull: `${gid}/${track.node.id}`,
    cacheFull: `${gid}/${cache.node.id}`,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('process panels inside groups', () => {
  it('start, progress and finish of an inner node write the result into the nested node (one undo step)', async () => {
    const { app, ed, log, pending, trackFull, trackId, gid } = setup();
    expect(ed.state.graph.nodes.some((n) => n.id === trackId)).toBe(false); // it is not a top-level node any more
    const before = ed.state.graph;
    const p = runProcess(app, trackFull);
    await tick();
    expect(log).toEqual([`run ${trackFull}`]);
    expect(jobOf(processStore.get().jobs, 'project', trackFull)).toBeNull(); // the mock job belongs to project "p"
    expect(jobOf(processStore.get().jobs, 'p', trackFull)?.progress).toBe(0.5);
    pending.get(trackFull)!.resolve(RESULT);
    expect(await p).toBe(true);
    const inner = nodeAtPath(ed.state.graph, trackFull)!;
    expect(processResultOf(inner, registry.get('track')!)?.signature).toBe('sig-1');
    expect(ed.state.graph.nodes.find((n) => n.id === gid)).toBeDefined();
    expect(log).toContain(`dismiss ${trackFull}`);
    // undo removes exactly that
    ed.undo();
    expect(processResultOf(nodeAtPath(ed.state.graph, trackFull)!, registry.get('track')!)).toBeNull();
    expect(ed.state.graph).not.toBe(before === ed.state.graph ? null : before); // history moved
    ed.redo();
    expect(processResultOf(nodeAtPath(ed.state.graph, trackFull)!, registry.get('track')!)?.signature).toBe('sig-1');
  });

  it('cancel goes to the path id and leaves the node untouched', async () => {
    const { app, ed, log, cacheFull } = setup();
    const p = runProcess(app, cacheFull);
    await tick();
    cancelProcess(app, cacheFull);
    expect(await p).toBe(false);
    expect(log).toContain(`cancel ${cacheFull}`);
    expect(processResultOf(nodeAtPath(ed.state.graph, cacheFull)!, registry.get('cache')!)).toBeNull();
  });

  it('clear removes the stored data and the handle of the nested node', async () => {
    const { app, ed, log, setAuto, trackFull } = setup();
    setAuto(true);
    expect(await runProcess(app, trackFull, { quiet: true })).toBe(true);
    expect(processResultOf(nodeAtPath(ed.state.graph, trackFull)!, registry.get('track')!)).not.toBeNull();
    await clearProcess(app, trackFull);
    expect(log).toContain(`clear ${trackFull}`);
    expect(processResultOf(nodeAtPath(ed.state.graph, trackFull)!, registry.get('track')!)).toBeNull();
  });

  it('a plain id that is not at the top level does nothing (callers convert with fullId)', async () => {
    const { app, log, trackId } = setup();
    expect(await runProcess(app, trackId)).toBe(false);
    expect(log).toEqual([]);
  });

  it('"Process selected nodes" works on the selection of the open group', async () => {
    const { app, ed, log, setAuto, gid, trackId, cacheId, trackFull, cacheFull } = setup();
    setAuto(true);
    ed.enterGroup(gid);
    ed.select([trackId, cacheId]);
    await processSelection(app);
    expect(log.filter((l) => l.startsWith('run ')).sort()).toEqual([`run ${trackFull}`, `run ${cacheFull}`].sort());
    expect(processResultOf(nodeAtPath(ed.state.graph, trackFull)!, registry.get('track')!)?.signature).toBe('sig-1');
    expect(processResultOf(nodeAtPath(ed.state.graph, cacheFull)!, registry.get('cache')!)?.signature).toBe('sig-1');
  });

  it('labels read "Group name › Node"', () => {
    const { ed, trackFull, trackId, gid } = setup();
    expect(processLabel(ed.state.graph, registry, trackFull)).toBe('Rig › Track');
    expect(processLabel(ed.state.graph, registry, gid)).toBe('Rig');
    void trackId;
  });
});
