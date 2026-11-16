/**
 * Process mode in the UI: the mirror of the scheduler's jobs (UI state only: progress never touches the graph or any cache), the
 * actions behind Process / Cancel / Clear and "Process selected nodes", and the installer that wires hints (rendering paused, dragging),
 * results of projects that were not open when a job finished, and the "ready" toast.
 * The graph is only edited when a job FINISHES (one undo step, the result handle) or is cleared; never because something changed.
 */
import { processNodes, processOrder, withProcessResult } from '../../engine/process';
import type { ProcessResult } from '../../engine/types';
import type { ProcessJob } from '../../io/api';
import { isActiveJob } from '../lib/process';
import { safetyStore } from '../safety';
import type { AppCtx } from './context';
import { createStore } from './createStore';

export const processStore = createStore<{ jobs: ProcessJob[] }>({ jobs: [] });

/** The newest job of a node in the active project (any state), or null. */
export function jobOf(jobs: readonly ProcessJob[], project: string | null, node: string): ProcessJob | null {
  let found: ProcessJob | null = null;
  for (const j of jobs) if (j.node === node && (project === null || j.project === project)) found = j;
  return found;
}

/** Results of jobs that finished while their project was not the open one: applied when it is opened again. */
const stash = new Map<string, ProcessResult>();

const projectOf = (app: Pick<AppCtx, 'ed'>): string => app.ed.state.activeProject ?? 'project';

function applyResult(app: AppCtx, project: string, nodeId: string, result: ProcessResult, quiet: boolean): void {
  const { ed, io } = app;
  const node = ed.state.graph.nodes.find((n) => n.id === nodeId);
  const def = node && ed.registry.get(node.type);
  if (ed.state.activeProject !== project && ed.state.activeProject !== null) {
    stash.set(`${project}:${nodeId}`, result);
    ed.toast(`${def?.process?.title ?? 'A process'} finished in another project. Open it to use the result.`, 'info');
    return;
  }
  if (!node || !def?.process) {
    // The node was deleted while it ran: the stored data is an orphan.
    void io.processes.clear(nodeId, project);
    return;
  }
  ed.edit((g) => withProcessResult(g, ed.registry, nodeId, result));
  io.processes.dismiss(nodeId, project);
  if (typeof result.meta.item === 'number') ed.toast(`Processed batch item ${result.meta.item + 1} only: the other items still show the stand-in.`, 'info');
  if (!quiet) {
    ed.toast(`${node.label || def.title}: ${def.process.title.toLowerCase()} ready`, 'ok', [{ label: 'View', run: () => ed.setViewed(nodeId) }]);
  }
}

/**
 * Run (or re-run) the process of one node. Resolves true when the result was stored and written into the node.
 * `options` go to the job (Bake: { quality }). `quiet` = no "ready" toast (batches report once themselves).
 */
export async function runProcess(app: AppCtx, nodeId: string, opts: { options?: Record<string, unknown>; quiet?: boolean } = {}): Promise<boolean> {
  const { ed, io } = app;
  const graph = ed.state.graph;
  const node = graph.nodes.find((n) => n.id === nodeId);
  const def = node && ed.registry.get(node.type);
  if (!node || !def?.process) return false;
  const project = projectOf(app);
  if (isActiveJob(jobOf(processStore.get().jobs, project, nodeId))) return false;
  try {
    const result = await io.processes.run(graph, nodeId, { projectId: project, item: ed.state.item, options: opts.options });
    applyResult(app, project, nodeId, result, !!opts.quiet);
    return true;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') {
      io.processes.dismiss(nodeId, project);
      ed.toast(`${def.process.title} cancelled.`, 'info');
    } else ed.toast(`${def.process.title} failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return false;
  }
}

export function cancelProcess(app: AppCtx, nodeId: string): void {
  app.io.processes.cancel(nodeId, projectOf(app));
}

/** Delete the stored data and forget the result: the node goes back to its stand-in. */
export async function clearProcess(app: AppCtx, nodeId: string): Promise<void> {
  const { ed, io } = app;
  try {
    await io.processes.clear(nodeId, projectOf(app));
  } catch (err) {
    ed.toast(err instanceof Error ? err.message : String(err), 'error');
  }
  io.processes.dismiss(nodeId, projectOf(app));
  ed.edit((g) => withProcessResult(g, ed.registry, nodeId, null));
}

/** "Process selected nodes": every selected node that has a process and is not done, deepest first (a downstream process depends on an upstream one). */
export async function processSelection(app: AppCtx): Promise<void> {
  const { ed, io } = app;
  const ids = ed.state.selection;
  const graph = ed.state.graph;
  const mine = processNodes(graph, ed.registry, ids);
  if (!mine.length) {
    ed.toast('Select nodes that have a process (Cache / Bake, Track...) to process them.', 'info');
    return;
  }
  const todo = mine.filter((n) => {
    const st = io.processes.status(graph, n.id);
    return !st || st.state !== 'done';
  });
  if (!todo.length) {
    ed.toast('Everything selected is already processed.', 'info');
    return;
  }
  // Upstream first: an upstream result changes the signature of what is after it.
  const order = processOrder(graph, ed.registry, todo.map((n) => n.id)).filter((id) => todo.some((n) => n.id === id));
  let done = 0;
  for (const id of order) {
    if (!(await runProcess(app, id, { quiet: true }))) break;
    done++;
  }
  if (done) ed.toast(`${done} process${done === 1 ? '' : 'es'} finished`, 'ok');
}

/** Hook the scheduler to the UI. Call once after the editor exists (next to installSafety). Returns a disposer. */
export function installProcesses(app: AppCtx): () => void {
  const { ed, io } = app;
  const off: (() => void)[] = [];

  // 1. Mirror of the job list. Progress events are coalesced (a job reports every frame); every state change goes through at once.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    timer = undefined;
    processStore.set({ jobs: io.processes.jobs() });
  };
  off.push(
    io.processes.subscribe((e) => {
      if (e.type === 'progress') {
        timer ??= setTimeout(publish, 120);
        return;
      }
      if (timer) clearTimeout(timer);
      publish();
    }),
  );
  off.push(() => timer && clearTimeout(timer));
  publish();

  // 2. Hold jobs back while rendering is paused (safe mode) and while the user drags something.
  const syncPaused = () => io.processes.setHint('paused', safetyStore.get().paused);
  syncPaused();
  off.push(safetyStore.subscribe(syncPaused));
  let release: ReturnType<typeof setTimeout> | undefined;
  const down = () => {
    if (release) clearTimeout(release);
    release = undefined;
    io.processes.setHint('interacting', true);
  };
  const up = () => {
    release ??= setTimeout(() => {
      release = undefined;
      io.processes.setHint('interacting', false);
    }, 250);
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    off.push(() => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      if (release) clearTimeout(release);
    });
  }

  // 3. Results of jobs that finished while another project was open.
  let project = ed.state.activeProject;
  off.push(
    ed.store.subscribe(() => {
      if (ed.state.activeProject === project) return;
      project = ed.state.activeProject;
      if (!project) return;
      const mine = [...stash.keys()].filter((k) => k.startsWith(`${project}:`));
      if (!mine.length) return;
      setTimeout(() => {
        for (const k of mine) {
          const result = stash.get(k);
          stash.delete(k);
          const nodeId = k.slice(`${project}:`.length);
          if (result && ed.state.activeProject === project && ed.state.graph.nodes.some((n) => n.id === nodeId)) {
            ed.edit((g) => withProcessResult(g, ed.registry, nodeId, result));
            io.processes.dismiss(nodeId, project ?? undefined);
          }
        }
      }, 200);
    }),
  );

  // 4. Nodes that opted in with `process.auto`: start when stale or never run, a moment after the last edit (never when the last run failed:
  //    the failed record stays until the user acts, so an auto process cannot loop).
  let autoTimer: ReturnType<typeof setTimeout> | undefined;
  let seenGraph = ed.state.graph;
  const autoRun = () => {
    autoTimer = undefined;
    const graph = ed.state.graph;
    for (const n of graph.nodes) {
      if (n.bypass || !ed.registry.get(n.type)?.process?.auto) continue;
      const job = jobOf(processStore.get().jobs, projectOf(app), n.id);
      if (isActiveJob(job) || job?.state === 'failed') continue;
      const st = io.processes.status(graph, n.id);
      if (st && (st.state === 'none' || st.state === 'stale' || st.state === 'missing')) void runProcess(app, n.id, { quiet: true });
    }
  };
  off.push(
    ed.store.subscribe(() => {
      if (ed.state.graph === seenGraph) return;
      seenGraph = ed.state.graph;
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = setTimeout(autoRun, 800);
    }),
  );
  off.push(() => autoTimer && clearTimeout(autoTimer));

  return () => off.forEach((f) => f());
}
