/**
 * Safe reload and crash recovery (UI side). One place owns:
 *  - the boot guard (see src/io/boot-guard.ts): an unclean last run, Shift at start, `?safe` or "Reload in safe mode" start with
 *    rendering PAUSED;
 *  - the pause toggle (also available all the time): while paused, edits change the graph but nothing is evaluated (the viewed node is
 *    withheld from the player, and the engine stops an evaluation that is in flight at the next node);
 *  - good-frame backups (rolling, via ProjectStore.recordBackup) and "undo the last change".
 * The pure parts are in boot-guard.ts / backups.ts and the helpers below, which are unit-tested.
 */
import type { GraphDoc } from '../engine/types';
import { BootGuard, urlWantsSafe, type BootDecision, type GuardMarker, type SafeReason, type StorageLike } from '../io/boot-guard';
import { MIN_BACKUP_GAP_MS } from '../io/backups';
import type { AppCtx } from './store/context';
import { createStore } from './store/createStore';

export const RENDER_LIMIT_MS = 15_000;
export const SLOW_NOTICE_MS = 5_000;

export interface SafetyState {
  /** Rendering is off: nothing is evaluated. */
  paused: boolean;
  /** Why the app started paused (null: normal start, or paused by hand). */
  safe: SafeReason | null;
  /** The start-up banner is still showing. */
  banner: boolean;
  /** An edit has been rendering for a while (see watchdog.ts). */
  slow: boolean;
  previous: GuardMarker | null;
}

export const safetyStore = createStore<SafetyState>({ paused: false, safe: null, banner: false, slow: false, previous: null });

/* ------------------------------------------------ pure helpers ------------------------------------------------ */

/** The node the player may be asked to show: nothing while rendering is paused. */
export function viewNodeFor(paused: boolean, viewed: string | null): string | null {
  return paused ? null : viewed;
}

/**
 * The ONE way the UI hands a view to the player. While paused the viewed node is withheld, so the player has nothing to evaluate
 * (the graph itself is still passed: edits, audio graph and project settings stay in step).
 */
export function pushView(
  player: Pick<import('../io/api').Player, 'setView'>,
  view: { graph: GraphDoc; node: string | null; item: number; itemCount: number; activeOutput?: string | null; selection?: readonly string[] },
  paused: boolean,
): void {
  player.setView({ ...view, node: viewNodeFor(paused, view.node) });
}

/** Banner text for how the app got into safe mode. */
export function safeBannerText(reason: SafeReason | null): string {
  switch (reason) {
    case 'unclean':
      return 'RSMPS did not shut down cleanly. Rendering is paused so you can fix the graph.';
    case 'shift':
      return 'Started in safe mode (Shift was held). Rendering is paused so you can fix the graph.';
    case 'url':
      return 'Started in safe mode. Rendering is paused so you can fix the graph.';
    case 'manual':
      return 'Reloaded in safe mode. Rendering is paused so you can fix the graph.';
    default:
      return 'Rendering is paused.';
  }
}

export interface PendingChange {
  nodeId: string;
  key: string;
  label: string;
  oldValue: unknown;
  newValue: unknown;
  at: number;
}

export function parsePending(raw: string | null): PendingChange | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Partial<PendingChange>;
    if (!p || typeof p.nodeId !== 'string' || typeof p.key !== 'string') return null;
    return { nodeId: p.nodeId, key: p.key, label: typeof p.label === 'string' ? p.label : p.key, oldValue: p.oldValue, newValue: p.newValue, at: typeof p.at === 'number' ? p.at : 0 };
  } catch {
    return null;
  }
}

/** Can the last parameter edit be reverted in this graph (the node still exists and still holds the new value)? */
export function canRevert(p: PendingChange | null, graph: GraphDoc): p is PendingChange {
  if (!p) return false;
  const n = graph.nodes.find((x) => x.id === p.nodeId);
  return !!n && JSON.stringify(n.params[p.key]) === JSON.stringify(p.newValue);
}

/**
 * Decide whether a good-frame snapshot should be written now. `lastAt`: when the last one was written; `graph` differs from the last
 * snapshot; a trailing snapshot is allowed once the gap has passed.
 */
export function snapshotDue(input: { lastAt: number | null; now: number; changed: boolean; gapMs?: number }): boolean {
  if (!input.changed) return false;
  return input.lastAt === null || input.now - input.lastAt >= (input.gapMs ?? MIN_BACKUP_GAP_MS);
}

/* --------------------------------------------------- state --------------------------------------------------- */

const storage: StorageLike | null = (() => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
})();
const noStorage: StorageLike = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };

export const guard = new BootGuard(storage ?? noStorage);
export const PENDING_STORE_KEY = 'rsmps.pendingEdit';

/** Shift held while the page started (any key event with Shift down before the app finished booting). */
let shiftSeen = false;
if (typeof document !== 'undefined') {
  const onKey = (e: KeyboardEvent) => {
    if (e.shiftKey || e.key === 'Shift') shiftSeen = true;
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);
}

/** Decide how this start goes and put the answer in the store. Call once, before the first `setView`. */
export function beginSafety(search: string = typeof location === 'undefined' ? '' : location.search): BootDecision {
  const d = guard.begin({ shift: shiftSeen, urlSafe: urlWantsSafe(search) });
  safetyStore.set({ paused: d.safe, safe: d.reason, banner: d.safe, slow: false, previous: d.previous });
  return d;
}

export function isPaused(): boolean {
  return safetyStore.get().paused;
}

/** Turn rendering off or on. Edits keep applying to the graph; nothing is evaluated while paused. */
export function setPaused(app: AppCtx, paused: boolean): void {
  const s = safetyStore.get();
  if (s.paused === paused) return;
  if (paused) {
    app.io.player.pause(); // stop the transport; the view is withheld by the sync in Root.tsx
    guard.enterSafe();
    safetyStore.set({ ...s, paused: true, slow: false });
  } else {
    guard.resume();
    safetyStore.set({ ...s, paused: false, safe: null, banner: false, slow: false });
  }
}

export function togglePaused(app: AppCtx): void {
  setPaused(app, !safetyStore.get().paused);
}

/** Resume from the start-up banner. A `?safe` address is stripped by reloading (the player reads it once, at load). */
export function resumeRendering(app: AppCtx): void {
  if (typeof location !== 'undefined' && urlWantsSafe(location.search)) {
    const url = new URL(location.href);
    url.searchParams.delete('safe');
    guard.resume();
    location.replace(url.toString());
    return;
  }
  setPaused(app, false);
}

/** Next start is a safe start; reload now. */
export function reloadInSafeMode(app?: AppCtx): void {
  const finish = () => {
    guard.requestSafeStart();
    location.reload();
  };
  if (app) void app.io.projects.flush().then(finish, finish);
  else finish();
}

export function reloadNormally(app?: AppCtx): void {
  const finish = () => {
    if (urlWantsSafe(location.search)) {
      const url = new URL(location.href);
      url.searchParams.delete('safe');
      location.replace(url.toString());
    } else location.reload();
  };
  if (app) void app.io.projects.flush().then(finish, finish);
  else finish();
}

export function dismissBanner(): void {
  safetyStore.set((s) => ({ ...s, banner: false }));
}

/** The remembered last parameter edit (survives a restart: it is only cleared when its render finished). */
export function lastChange(): PendingChange | null {
  try {
    return parsePending(localStorage.getItem(PENDING_STORE_KEY));
  } catch {
    return null;
  }
}

export function clearLastChange(): void {
  try {
    localStorage.removeItem(PENDING_STORE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * "Undo last change": put the last edited parameter back; if that edit is unknown (a structural edit, or the change was not
 * remembered) restore the newest good backup instead. Resolves what was done, or null when there was nothing to undo.
 */
export async function undoLastChange(app: AppCtx): Promise<{ kind: 'param'; label: string } | { kind: 'backup'; at: number } | null> {
  const { ed, io } = app;
  const p = lastChange();
  if (canRevert(p, ed.state.graph)) {
    ed.setParam(p.nodeId, p.key, p.oldValue);
    clearLastChange();
    return { kind: 'param', label: p.label };
  }
  const id = ed.state.activeProject;
  if (!id) return null;
  const list = await io.projects.listBackups(id);
  const newest = list[0];
  if (!newest) return null;
  const g = await io.projects.loadBackup(id, newest.id);
  if (!g) return null;
  ed.loadGraph(g, true);
  clearLastChange();
  return { kind: 'backup', at: newest.at };
}

/** Restore one backup into the open project (undoable: the current graph goes on the undo stack). */
export async function restoreBackup(app: AppCtx, backupId: string): Promise<boolean> {
  const { ed, io } = app;
  const id = ed.state.activeProject;
  if (!id) return false;
  const g = await io.projects.loadBackup(id, backupId);
  if (!g) return false;
  ed.loadGraph(g, true);
  clearLastChange();
  return true;
}

/* ------------------------------------------------- the runtime ------------------------------------------------- */

/**
 * Hook the guard, the engine abort and the good-frame backups to the running app. Returns a disposer.
 * Call after the editor exists (and after `beginSafety`).
 */
export function installSafety(app: AppCtx): () => void {
  const { ed, io } = app;
  const off: (() => void)[] = [];

  io.engine.shouldAbort = (quality) => quality === 'preview' && safetyStore.get().paused;
  off.push(() => {
    io.engine.shouldAbort = null;
  });

  // Active project known: put it in the marker. An empty / nothing-to-show project has no first frame: do not wait for one.
  guard.setProject(ed.state.activeProject);
  const idleTimer = setTimeout(() => {
    if (!ed.state.viewedNodeId) guard.renderDone();
  }, 3000);
  off.push(() => clearTimeout(idleTimer));

  let lastGraph = ed.state.graph;
  let lastViewed = ed.state.viewedNodeId;
  let seen = io.player.getState();
  let lastBackupAt: number | null = null;
  let lastBackedGraph: GraphDoc | null = null;
  let goodGraph: GraphDoc | null = null;
  let pendingRender = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let project = ed.state.activeProject;

  const flushBackup = () => {
    timer = undefined;
    const id = ed.state.activeProject;
    if (!id || !goodGraph || pendingRender || goodGraph === lastBackedGraph || id !== project) return;
    const g = goodGraph;
    lastBackedGraph = g;
    lastBackupAt = Date.now();
    void io.projects.recordBackup(id, g);
  };

  off.push(
    ed.store.subscribe(() => {
      const s = ed.state;
      if (s.activeProject !== project) {
        project = s.activeProject;
        goodGraph = null;
        lastBackedGraph = null;
        lastBackupAt = null;
        guard.setProject(project);
      }
      if (s.graph === lastGraph && s.viewedNodeId === lastViewed) return;
      lastGraph = s.graph;
      lastViewed = s.viewedNodeId;
      if (safetyStore.get().paused || s.switching || !s.viewedNodeId) return;
      pendingRender = true;
      guard.renderStart();
    }),
  );

  // Resume: the held-back view is shown again, which starts a render
  let wasPaused = safetyStore.get().paused;
  off.push(
    safetyStore.subscribe(() => {
      const p = safetyStore.get().paused;
      if (wasPaused && !p && ed.state.viewedNodeId) {
        pendingRender = true;
        guard.renderStart();
      }
      wasPaused = p;
    }),
  );

  off.push(
    io.player.subscribe((st) => {
      const finished = st.timings !== seen.timings || st.errors !== seen.errors;
      seen = st;
      if (!finished || safetyStore.get().paused) return;
      pendingRender = false;
      guard.renderDone();
      const viewed = ed.state.viewedNodeId;
      if (!viewed || st.errors.has(viewed) || !st.imageSize) return; // not a good frame
      goodGraph = ed.state.graph;
      const due = snapshotDue({ lastAt: lastBackupAt, now: Date.now(), changed: goodGraph !== lastBackedGraph });
      if (due) flushBackup();
      else if (goodGraph !== lastBackedGraph && timer === undefined) timer = setTimeout(flushBackup, MIN_BACKUP_GAP_MS);
    }),
  );

  // An orderly exit is not a crash. (A hung or killed page never gets here, which is the point.)
  const leave = () => guard.leave();
  window.addEventListener('pagehide', leave);
  off.push(() => window.removeEventListener('pagehide', leave));
  off.push(() => timer !== undefined && clearTimeout(timer));

  return () => off.forEach((f) => f());
}
