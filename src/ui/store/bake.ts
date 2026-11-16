/**
 * Baking from the UI. Baking is a process (src/ui/store/processes.ts): this file keeps the Bake-specific parts: the quality preference,
 * the frozen-region helper, "Bake selection", and thin wrappers (`bakeNode`, `cancelBake`, `clearBake`) over the generic actions so the
 * rest of the UI and the shortcuts keep working. Progress and job state live in `processStore`, not here.
 * The graph is only ever edited at the end of a bake (one undo step) and never because something upstream changed: a stale bake is
 * reported, the user decides when to bake again.
 */
import type { GraphDoc } from '../../engine/types';
import { bakeSource, frozenNodes, insertCacheNodes, servesBake, type BakeStatusDeps, CACHE_TYPE } from '../lib/bake';
import type { AppCtx } from './context';
import { cancelProcess, clearProcess, jobOf, processStore, runProcess } from './processes';

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

type App = AppCtx;

export function statusDeps(app: Pick<App, 'ed' | 'io'>, graph = app.ed.state.graph, job?: { fraction: number } | null): BakeStatusDeps {
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

/** The running bake job of a node, as the old `{ fraction }` shape the status helpers take. */
export function bakeJobOf(app: Pick<App, 'ed'>, nodeId: string): { fraction: number } | null {
  const j = jobOf(processStore.get().jobs, app.ed.state.activeProject ?? 'project', nodeId);
  return j && (j.state === 'queued' || j.state === 'running' || j.state === 'paused') ? { fraction: j.progress } : null;
}

/** Bake (or re-bake) one Cache / Bake node. Resolves true when the frames were stored and the node now serves them. */
export async function bakeNode(app: App, nodeId: string, quality: BakeQuality = getBakeQuality(), quiet = false): Promise<boolean> {
  const { ed } = app;
  const node = ed.state.graph.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== CACHE_TYPE) return false;
  if (!bakeSource(ed.state.graph, nodeId)) {
    ed.toast('Connect a picture to the Cache / Bake node first: there is nothing to bake.', 'info');
    return false;
  }
  return runProcess(app, nodeId, { options: { quality }, quiet });
}

export function cancelBake(app: App, nodeId: string): void {
  cancelProcess(app, nodeId);
}

/** Delete the stored frames and make the node live again. */
export async function clearBake(app: App, nodeId: string): Promise<void> {
  await clearProcess(app, nodeId);
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
