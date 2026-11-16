/**
 * Baking from the UI: progress of running bakes, and the actions behind the Bake / Re-bake / Clear buttons and "Bake selection".
 * The graph is only ever edited at the end of a bake (one undo step) and never because something upstream changed: a stale bake is
 * reported, the user decides when to bake again.
 */
import type { Io } from '../../io/api';
import type { GraphDoc } from '../../engine/types';
import { applyBakeParams, bakeSource, clearBakeParams, frozenNodes, insertCacheNodes, servesBake, type BakeStatusDeps, CACHE_TYPE } from '../lib/bake';
import { createStore } from './createStore';
import type { Editor } from './editor';

export interface BakeJob {
  frame: number;
  frames: number;
  fraction: number;
  bytes: number;
  abort: AbortController;
}

export const bakeStore = createStore<{ jobs: Record<string, BakeJob> }>({ jobs: {} });

const QUALITY_KEY = 'rsmps.ui.bakeQuality';
export type BakeQuality = 'lossless' | 'compressed';

/** Lossless by default: an exact bake is also what exports use. Compressed is much smaller on disk. */
export function getBakeQuality(): BakeQuality {
  try {
    return localStorage.getItem(QUALITY_KEY) === 'compressed' ? 'compressed' : 'lossless';
  } catch {
    return 'lossless';
  }
}
export function setBakeQuality(q: BakeQuality): void {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {
    /* lasts for this session only */
  }
}

type App = { ed: Editor; io: Io };

export function statusDeps(app: App, graph = app.ed.state.graph, job?: { fraction: number } | null): BakeStatusDeps {
  return {
    signatureOf: (node, port) => app.io.engine.signatureOf(graph, node, port),
    assetExists: (id) => !!app.io.library.assetInfo(id),
    job,
  };
}

const frozenMemo = new WeakMap<GraphDoc, Set<string>>();
const NONE = new Set<string>();

/** Ids of the nodes behind a serving bake (see frozenNodes). Computed once per graph object, so every node view can ask. */
export function frozenIds(app: Pick<App, 'io'>, graph: GraphDoc): ReadonlySet<string> {
  let set = frozenMemo.get(graph);
  if (set) return set;
  const serving = new Set<string>();
  for (const n of graph.nodes) {
    if (n.type !== CACHE_TYPE) continue;
    const src = bakeSource(graph, n.id);
    const ok = servesBake(n, {
      assetExists: (id) => !!app.io.library.assetInfo(id),
      fresh: () => !!src && n.params.bakedSignature === app.io.engine.signatureOf(graph, src.from.node, src.from.port),
    });
    if (ok) serving.add(n.id);
  }
  set = serving.size ? frozenNodes(graph, serving) : NONE;
  frozenMemo.set(graph, set);
  return set;
}

function setJob(id: string, job: BakeJob | null): void {
  bakeStore.set((s) => {
    const jobs = { ...s.jobs };
    if (job) jobs[id] = job;
    else delete jobs[id];
    return { jobs };
  });
}

/** Bake (or re-bake) one Cache / Bake node. Resolves true when the frames were stored and the node now serves them. */
export async function bakeNode(app: App, nodeId: string, quality: BakeQuality = getBakeQuality()): Promise<boolean> {
  const { ed, io } = app;
  const graph = ed.state.graph;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== CACHE_TYPE) return false;
  if (!bakeSource(graph, nodeId)) {
    ed.toast('Connect a picture to the Cache / Bake node first: there is nothing to bake.', 'info');
    return false;
  }
  if (bakeStore.get().jobs[nodeId]) return false;
  const abort = new AbortController();
  setJob(nodeId, { frame: 0, frames: 1, fraction: 0, bytes: 0, abort });
  try {
    const res = await io.bake.bake(graph, nodeId, {
      quality,
      signal: abort.signal,
      item: ed.state.item,
      onProgress: (p) => setJob(nodeId, { frame: p.frame, frames: p.frames, fraction: p.fraction, bytes: p.bytes, abort }),
    });
    // The node may have been deleted while it baked: then there is nothing to write into, and the stored frames are orphans.
    if (!ed.state.graph.nodes.some((n) => n.id === nodeId)) {
      await io.bake.unbake(nodeId);
      return false;
    }
    ed.edit((g) => applyBakeParams(g, nodeId, res.params));
    if (res.itemDependent) ed.toast(`Baked batch item ${(res.item ?? 0) + 1} only: the other items still render live.`, 'info');
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') ed.toast('Baking cancelled.', 'info');
    else ed.toast(err instanceof Error ? err.message : String(err), 'error');
    return false;
  } finally {
    setJob(nodeId, null);
  }
}

export function cancelBake(nodeId: string): void {
  bakeStore.get().jobs[nodeId]?.abort.abort();
}

/** Delete the stored frames and make the node live again. */
export async function clearBake(app: App, nodeId: string): Promise<void> {
  cancelBake(nodeId);
  try {
    await app.io.bake.unbake(nodeId);
  } catch (err) {
    app.ed.toast(err instanceof Error ? err.message : String(err), 'error');
  }
  app.ed.edit((g) => clearBakeParams(g, nodeId));
}

/** "Bake selection": a Cache / Bake node after the selected group's picture output(s), then bake them one after the other. */
export async function bakeSelection(app: App): Promise<void> {
  const { ed } = app;
  const ids = ed.state.selection;
  if (!ids.length) {
    ed.toast('Select the nodes you consider finished, then bake them.', 'info');
    return;
  }
  const res = insertCacheNodes(ed.state.graph, ed.registry, ids);
  if (!res.cacheIds.length) {
    ed.toast('Nothing to bake here: the selection has no picture output, or it already ends in a Cache / Bake node.', 'info');
    return;
  }
  ed.edit(() => res.graph);
  for (const id of res.cacheIds) if (!(await bakeNode(app, id))) break;
}
