/** Small-screen helpers for the node graph that need the editor but not the graph's own files: legible framing and compact nodes. */
import type { AppCtx } from '../store/context';
import { frameGraph } from '../graph/gestures';
import { legibleView } from './pure';

/** Below this zoom node titles are too small to read on a phone. */
export const MIN_LEGIBLE_ZOOM = 0.8;

/**
 * "Frame all", then, if that made everything tiny, zoom in to a readable size around the selected node (or the first node, left to
 * right). Whole-graph overviews are what the pinch gesture is for; this is the default view.
 */
export function frameLegible(app: AppCtx, min = MIN_LEGIBLE_ZOOM): void {
  const { ed, graphCtl: ctl } = app;
  const r = ctl.rect();
  if (r.width < 50 || r.height < 50) return; // the panel is hidden (another tab): framing now would fit the graph into nothing
  frameGraph(app);
  const nodes = ed.state.level.nodes;
  const sel = nodes.find((n) => ed.state.selection.includes(n.id));
  const first = sel ?? [...nodes].sort((a, b) => a.x - b.x || a.y - b.y)[0];
  const focus = first ? { x: first.x + 100, y: first.y + 40 } : undefined;
  const v = legibleView(ctl.view, { width: r.width, height: r.height }, min, focus);
  if (v === ctl.view) return;
  ctl.view.x = v.x;
  ctl.view.y = v.y;
  ctl.view.zoom = v.zoom;
  ctl.fitView = null; // a panel resize must not refit over this
  ctl.applyView();
}

const COMPACT_KEY = 'rsmps.ui.phoneCompact';

function compactSeen(projectId: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(COMPACT_KEY) ?? '[]') as string[]).includes(projectId);
  } catch {
    return false;
  }
}
function markCompactSeen(projectId: string): void {
  try {
    const l = (JSON.parse(localStorage.getItem(COMPACT_KEY) ?? '[]') as string[]).filter((x) => x !== projectId);
    l.push(projectId);
    localStorage.setItem(COMPACT_KEY, JSON.stringify(l.slice(-40)));
  } catch {
    /* ignore */
  }
}

/** Collapse every expanded node to title + sockets (one undo step), or expand them all when none is expanded. */
export function toggleCompactAll(app: AppCtx): void {
  const { ed } = app;
  const nodes = ed.state.level.nodes.filter((n) => !n.type.startsWith('@'));
  const open = nodes.filter((n) => !n.collapsed);
  if (open.length) ed.toggleCollapse(open.map((n) => n.id));
  else if (nodes.length) ed.toggleCollapse(nodes.map((n) => n.id));
}

/**
 * First time a project is opened on a phone: collapse its nodes (params live in the Inspector tab there). Remembered per project, so
 * expanding them again is respected. Returns true when it collapsed something.
 */
export function compactOnFirstOpen(app: AppCtx): boolean {
  const { ed } = app;
  const id = ed.state.activeProject;
  if (!id || ed.state.path.length || compactSeen(id)) return false;
  const open = ed.state.level.nodes.filter((n) => !n.collapsed);
  markCompactSeen(id);
  if (!open.length) return false;
  ed.toggleCollapse(open.map((n) => n.id));
  return true;
}
