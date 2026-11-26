/**
 * The "Start AR" button of the World AR Camera node: opens `io.worldAr` on what the viewer shows, and puts a finished recording
 * into the graph (the take into the node, the camera clip into a new Media In node next to it).
 */
import type { CardMode } from '../../engine/lib/xr-math';
import type { WorldArTake } from '../../io/world-ar/controller';
import { createArOverlay } from '../worldAr/overlay';
import type { AppCtx } from './context';

type Ctx = Pick<AppCtx, 'io' | 'ed'>;

/** The toast for a saved recording. Pure. */
export function takeMessage(t: WorldArTake): { text: string; kind: 'ok' | 'error' | 'info' } {
  if (!t.take) return { text: t.error ?? 'Nothing was recorded.', kind: 'error' };
  const secs = `${t.seconds.toFixed(1)} s`;
  if (t.clip) return { text: `AR take saved (${secs}). The camera clip was added as a Media In node: merge the object over it.`, kind: 'ok' };
  if (t.error) return { text: `AR take saved (${secs}), movement only. ${t.error}`, kind: 'info' };
  return { text: `AR take saved (${secs}), movement only: this browser did not hand the camera picture to the page.`, kind: 'info' };
}

/**
 * Open the AR view. MUST be called straight from the button press: the browser only starts an AR session while the press counts,
 * so nothing is awaited before `io.worldAr.open`.
 * `nodeId` / `fullId`: the World AR Camera node whose button was pressed (it receives the take).
 */
export function openWorldAr(app: Ctx, nodeId: string, fullId: string): void {
  const { io, ed } = app;
  const ar = io.worldAr;
  if (!ar) return ed.toast('The AR view is not available in this version of the app.', 'error');
  if (ar.active) return ed.toast('The AR view is already open.', 'info');
  const node = ed.state.graph.nodes.find((n) => n.id === nodeId) ?? null;
  // what stands in the room is what the viewer shows; with nothing viewed, this camera's own first user cannot be guessed
  const shown = ed.state.viewedNodeId && ed.state.viewedNodeId !== fullId ? ed.state.viewedNodeId : null;
  if (!shown) return ed.toast('View the node you want to see in the room first (the eye on a node, for example your 3D Object), then press Start AR.', 'info');
  const overlay = createArOverlay();
  const params = node?.params ?? {};
  const saveTake = (t: WorldArTake) => {
    const m = takeMessage(t);
    ed.toast(m.text, m.kind);
    if (!t.take) return;
    ed.beginHold(); // the take and its clip node: one undo step
    ed.setParam(nodeId, 'take', t.take);
    ed.setParam(nodeId, 'startAt', 0);
    if (t.clip) ed.addNodeAt('media-in', { x: (node?.x ?? 0) - 40, y: (node?.y ?? 0) + 220 }, undefined, { assets: [t.clip.id] });
    ed.endHold();
  };
  ar.open({
    graph: () => ed.state.graph,
    node: shown,
    card: { mode: (params.cardMode as CardMode) ?? 'upright', width: Number(params.cardWidth ?? 0.5) || 0.5 },
    overlay: overlay.root,
    onState: (s) => overlay.update(s),
    onTake: saveTake,
  }).then(
    (handle) => {
      overlay.attach(handle);
      overlay.update(handle.state());
      void handle.closed.then((end) => {
        overlay.remove();
        if (end.error) ed.toast(end.error, 'error');
      });
    },
    (err) => {
      overlay.remove();
      ed.toast(err instanceof Error ? err.message : String(err), 'error');
    },
  );
}
