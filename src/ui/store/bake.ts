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
import { groupBakeProblem, groupData, groupDefOf, GROUP_TYPE, hasGroups, nodeAtPath } from '../../engine/group';
import { withProcessResult } from '../../engine/process';
import { isActiveJob } from '../lib/process';

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
  for (const n of graph.nodes) {
    if (n.type !== GROUP_TYPE || !n.params.__process) continue;
    if (app.io.processes.status(graph, n.id)?.state === 'done') serving.add(n.id);
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
  // `nodeId` is a full path id; what is wired is read on the flattened document (a Cache inside a group may be fed from outside it).
  const node = nodeAtPath(ed.state.graph, nodeId);
  if (!node || node.type !== CACHE_TYPE) return false;
  const doc = hasGroups(ed.state.graph) && app.io.engine.flatView ? app.io.engine.flatView(ed.state.graph).graph : ed.state.graph;
  if (!bakeSource(doc, nodeId)) {
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

/**
 * "Bake selection" (Ctrl+Shift+B): the cache region. The selected nodes become one group (one undo step) and the group's outputs are baked:
 * a named, collapsible region that costs nothing once baked and goes live again when anything inside or before it changes. A single
 * selected group is baked as it is; a single Cache / Bake node is baked as before. (Cache / Bake nodes after the selection, the older way,
 * stay available as `bakeSelectionWithCacheNodes` in the node menu.)
 */
export async function bakeSelection(app: App): Promise<void> {
  const { ed } = app;
  const ids = ed.state.selection;
  if (!ids.length) {
    ed.toast('Select the nodes you consider finished, then bake them.', 'info');
    return;
  }
  const level = ed.state.level;
  const only = ids.length === 1 ? level.nodes.find((n) => n.id === ids[0]) : undefined;
  if (only?.type === CACHE_TYPE) {
    await bakeNode(app, ed.fullId(only.id));
    return;
  }
  if (only?.type === GROUP_TYPE) {
    await bakeGroup(app, only.id);
    return;
  }
  const gid = ed.groupNodes('group', ids);
  if (!gid) return;
  ed.setGroupInfo(gid, { title: 'Baked region' });
  await bakeGroup(app, gid);
}

/** Bake a group node of the shown level: its outputs are rendered once and stored (one undo step when done). Resolves true when stored. */
export async function bakeGroup(app: App, levelId: string): Promise<boolean> {
  const { ed, io } = app;
  const node = ed.state.level.nodes.find((n) => n.id === levelId);
  if (!node || node.type !== GROUP_TYPE) return false;
  const problem = groupBakeProblem(groupData(node));
  if (problem) {
    ed.toast(problem, 'info');
    return false;
  }
  const full = ed.fullId(levelId);
  const project = ed.state.activeProject ?? 'project';
  if (isActiveJob(jobOf(processStore.get().jobs, project, full))) return false;
  try {
    const result = await io.processes.run(ed.state.graph, full, { projectId: project, item: ed.state.item });
    if (ed.state.activeProject !== null && ed.state.activeProject !== project) {
      ed.toast('The bake finished in another project. Bake it again there to use it.', 'info');
      return false;
    }
    ed.edit((g) => withProcessResult(g, ed.registry, full, result));
    io.processes.dismiss(full, project);
    ed.toast(`${node.label || groupDefOf(node).title}: baked`, 'ok', [{ label: 'View', run: () => ed.setViewed(full) }]);
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      io.processes.dismiss(full, project);
      ed.toast('Bake canceled.', 'info');
    } else ed.toast(`Bake failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return false;
  }
}

/** Forget a group's bake (the stored frames are deleted): the inside is calculated live again. */
export async function clearGroupBake(app: App, levelId: string): Promise<void> {
  const { ed, io } = app;
  const full = ed.fullId(levelId);
  const project = ed.state.activeProject ?? 'project';
  try {
    await io.processes.clear(full, project);
  } catch (err) {
    ed.toast(err instanceof Error ? err.message : String(err), 'error');
  }
  io.processes.dismiss(full, project);
  ed.edit((g) => withProcessResult(g, ed.registry, full, null));
}

/** The older "Bake selection": a Cache / Bake node after the selected group's picture output(s), then bake them one after the other. */
export async function bakeSelectionWithCacheNodes(app: App): Promise<void> {
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
