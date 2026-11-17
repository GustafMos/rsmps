/**
 * Viewer snapshots and A/B compare state (see ../viewer/compare.ts for the pure parts). Snapshot pixels are kept as compressed PNG blobs in
 * memory per open project (never in the graph document); they go when their project is closed. Uses only the Editor / Player public API.
 */
import type { ImageValue } from '../../engine/types';
import { imageToBlob } from '../../io/encode';
import type { AppCtx } from './context';
import { createStore } from './createStore';
import { SNAPSHOT_CAP, firstImageInputSource, stripAdd, stripRemove, stripRename, type CompareMode, type Snap } from '../viewer/compare';

export interface CompareState {
  byProject: Record<string, Snap[]>;
  /** The snapshot that is snapshot A in the comparison, or null. */
  activeId: string | null;
  mode: CompareMode;
  wipePos: number;
  wipeAngle: number;
  onion: number;
  gain: number;
  /** Toggle mode: the A/B key is held. */
  flipped: boolean;
  /** Side by side: a frozen copy of the live image (refreshed while paused). */
  liveUrl: string | null;
  busy: boolean;
}

export const compareStore = createStore<CompareState>({
  byProject: {},
  activeId: null,
  mode: 'off',
  wipePos: 0.5,
  wipeAngle: 0,
  onion: 0.5,
  gain: 4,
  flipped: false,
  liveUrl: null,
  busy: false,
});

const blobs = new Map<string, Blob>();
const urls = new Map<string, string>();
const used = new Map<string, number>();
let counter = 0;

export const snapUrl = (id: string): string | null => {
  let u = urls.get(id);
  if (!u) {
    const b = blobs.get(id);
    if (!b) return null;
    u = URL.createObjectURL(b);
    urls.set(id, u);
  }
  return u;
};

function release(s: Snap): void {
  const u = urls.get(s.id);
  if (u) URL.revokeObjectURL(u);
  urls.delete(s.id);
  blobs.delete(s.id);
  used.delete(s.id);
}

export const patchCompare = (p: Partial<CompareState>): void => compareStore.set((s) => ({ ...s, ...p }));

export function currentStrip(s: CompareState, app: AppCtx): Snap[] {
  const pid = app.ed.state.activeProject;
  return (pid && s.byProject[pid]) || [];
}

async function sizeOf(blob: Blob): Promise<{ width: number; height: number }> {
  try {
    const bmp = await createImageBitmap(blob);
    const r = { width: bmp.width, height: bmp.height };
    bmp.close();
    return r;
  } catch {
    return { width: 0, height: 0 };
  }
}

function add(app: AppCtx, blob: Blob, meta: Omit<Snap, 'id' | 't' | 'width' | 'height'> & { width: number; height: number }): Snap | null {
  const pid = app.ed.state.activeProject;
  if (!pid) return null;
  const snap: Snap = { ...meta, id: `snap${Date.now().toString(36)}${(++counter).toString(36)}`, t: Date.now() };
  blobs.set(snap.id, blob);
  used.set(snap.id, snap.t);
  compareStore.set((s) => {
    const change = stripAdd(s.byProject[pid] ?? [], snap, used, SNAPSHOT_CAP);
    for (const e of change.evicted) release(e);
    const activeGone = change.evicted.some((e) => e.id === s.activeId);
    return { ...s, byProject: { ...s.byProject, [pid]: change.strip }, activeId: activeGone ? null : s.activeId };
  });
  return snap;
}

function nodeName(app: AppCtx, id: string | null): string {
  const n = id ? app.ed.state.graph.nodes.find((x) => x.id === id) : undefined;
  return n ? n.label || app.io.registry.get(n.type)?.title || n.type : 'View';
}

/** Snapshot of what the viewer shows now (the displayed pixels at their current preview scale). */
export async function takeSnapshot(app: AppCtx, label = ''): Promise<Snap | null> {
  const blob = await app.io.player.snapshot();
  if (!blob) {
    app.ed.toast('Nothing to snapshot: view a node that has an image.', 'info');
    return null;
  }
  const st = app.io.player.getState();
  const dims = await sizeOf(blob);
  const viewed = app.ed.state.viewedNodeId;
  const snap = add(app, blob, {
    frame: st.frame,
    nodeId: viewed,
    nodeName: nodeName(app, viewed),
    label,
    ...dims,
    previewPct: st.pixelSize > 1 ? 100 : Math.round(st.proxy * 100),
    kind: 'view',
  });
  if (snap) {
    app.ed.toast(`Snapshot saved (frame ${snap.frame}).`, 'ok');
    if (compareStore.get().mode === 'off') patchCompare({ activeId: snap.id, mode: 'wipe' });
    else patchCompare({ activeId: snap.id });
  }
  return snap;
}

export function selectSnapshot(id: string | null): void {
  if (id) used.set(id, Date.now());
  patchCompare({ activeId: id, mode: id ? (compareStore.get().mode === 'off' ? 'wipe' : compareStore.get().mode) : 'off' });
}

export function removeSnapshot(app: AppCtx, id: string): void {
  const pid = app.ed.state.activeProject;
  if (!pid) return;
  const s = compareStore.get();
  const gone = (s.byProject[pid] ?? []).find((x) => x.id === id);
  if (gone) release(gone);
  compareStore.set((st) => ({ ...st, byProject: { ...st.byProject, [pid]: stripRemove(st.byProject[pid] ?? [], id) }, ...(st.activeId === id ? { activeId: null, mode: 'off' as CompareMode } : {}) }));
}

export function renameSnapshot(app: AppCtx, id: string, label: string): void {
  const pid = app.ed.state.activeProject;
  if (!pid) return;
  compareStore.set((st) => ({ ...st, byProject: { ...st.byProject, [pid]: stripRename(st.byProject[pid] ?? [], id, label) } }));
}

/** Drop snapshots of projects that are no longer open ("cleared with the project"). */
export function pruneProjects(openIds: readonly string[]): void {
  const s = compareStore.get();
  const open = new Set(openIds);
  const gone = Object.keys(s.byProject).filter((k) => !open.has(k));
  if (!gone.length) return;
  const by = { ...s.byProject };
  for (const k of gone) {
    for (const sn of by[k]) release(sn);
    delete by[k];
  }
  patchCompare({ byProject: by });
}

/**
 * Snapshot of ANOTHER node at the current frame, as snapshot A. The node is evaluated once, off screen (the same one-off evaluation the
 * template thumbnails use) at the frame and preview scale the viewer shows now, then encoded like any snapshot. The viewer is never
 * pointed at that node, so nothing flickers, and a slow node is simply waited for.
 */
export async function snapshotOfNode(app: AppCtx, nodeId: string, label = ''): Promise<Snap | null> {
  if (compareStore.get().busy) return null;
  const { ed, io } = app;
  patchCompare({ busy: true });
  try {
    const st = io.player.getState();
    const g = ed.state.graph;
    const proxy = st.pixelSize > 1 ? 1 / st.pixelSize : st.proxy;
    const value = (await io.evaluate(g, nodeId, { seconds: st.frame / Math.max(1, g.project.fps), item: ed.state.item, proxy })) as ImageValue | null;
    if (!value || value.kind !== 'image') {
      ed.toast('That node has no image to compare.', 'info');
      return null;
    }
    const blob = await imageToBlob(io.engine.gpu, value, 'image/png');
    const dims = await sizeOf(blob);
    return add(app, blob, { frame: st.frame, nodeId, nodeName: nodeName(app, nodeId), label, ...dims, previewPct: st.pixelSize > 1 ? 100 : Math.round(st.proxy * 100), kind: 'node' });
  } catch (err) {
    ed.toast(`Could not evaluate that node: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return null;
  } finally {
    patchCompare({ busy: false });
  }
}

/**
 * Compare the viewed node (live, B) with another node (A, evaluated once at this frame). With no `otherId` the suggestion is used:
 * the first image input of the viewed node, i.e. "what did this node change".
 */
export async function compareWithNode(app: AppCtx, otherId?: string): Promise<void> {
  const { ed, io } = app;
  const live = ed.state.viewedNodeId;
  if (!live) return void ed.toast('View a node first.', 'info');
  const other = otherId ?? firstImageInputSource(ed.state.graph, io.registry, live);
  if (!other) return void ed.toast('This node has no image input to compare with. Pick a node instead.', 'info');
  if (other === live) return void ed.toast('Pick a different node to compare with.', 'info');
  const snap = await snapshotOfNode(app, other, 'before');
  if (snap) patchCompare({ activeId: snap.id, mode: 'wipe' });
}

/** Side by side: freeze the live image (needs the player paused to be exact). */
export async function refreshLive(app: AppCtx): Promise<void> {
  const blob = await app.io.player.snapshot();
  if (!blob) return;
  const old = compareStore.get().liveUrl;
  patchCompare({ liveUrl: URL.createObjectURL(blob) });
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
}

export function exitCompare(): void {
  const old = compareStore.get().liveUrl;
  if (old) URL.revokeObjectURL(old);
  patchCompare({ mode: 'off', activeId: null, liveUrl: null, flipped: false });
}
