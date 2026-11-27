/**
 * The "Start AR" button of the World AR Camera node: opens `io.worldAr` on what the viewer shows, and puts a finished recording
 * into the graph (the take into the node, the camera clip into a new Media In node next to it).
 */
import type { CardMode } from '../../engine/lib/xr-math';
import type { WorldArTake } from '../../io/world-ar/controller';
import { createArOverlay } from '../worldAr/overlay';
import { createArEditHost } from './arEdit';
import type { AppCtx } from './context';
import { getLive } from './live';

type Ctx = Pick<AppCtx, 'io' | 'ed'>;

/** The toast for a saved recording. Pure. */
export function takeMessage(t: WorldArTake): { text: string; kind: 'ok' | 'error' | 'info' } {
  if (!t.take) return { text: t.error ?? 'Nothing was recorded.', kind: 'error' };
  const secs = `${t.seconds.toFixed(1)} s`;
  const rate = t.rate?.clamped ? ` Recorded at ${t.rate.fps} frames per second: the phone's AR camera does not deliver ${t.rate.asked}.` : '';
  if (t.clip) return { text: `AR take saved (${secs}). The camera clip was added as a Media In node. "Save as video" on the AR node makes a finished file with the object over it.${rate}`, kind: 'ok' };
  if (t.error) return { text: `AR take saved (${secs}), movement only. ${t.error}${rate}`, kind: 'info' };
  return { text: `AR take saved (${secs}), movement only: this browser did not hand the camera picture to the page.${rate}`, kind: 'info' };
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
  let recorded = false;
  let tookTake = false;
  const saveTake = (t: WorldArTake) => {
    const m = takeMessage(t);
    ed.toast(m.text, m.kind);
    if (!t.take) return;
    tookTake = true;
    recorded = !!t.clip;
    ed.beginHold(); // the take and its clip node: one undo step
    // the take remembers its camera clip and what was shown, so the video can be made later, also after a reload
    ed.setParam(nodeId, 'take', { ...t.take, ...(t.clip ? { clipAsset: t.clip.id } : {}), shown });
    ed.setParam(nodeId, 'startAt', 0);
    if (t.clip) ed.addNodeAt('media-in', { x: (node?.x ?? 0) - 40, y: (node?.y ?? 0) + 220 }, undefined, { assets: [t.clip.id] });
    ed.endHold();
  };
  ar.open({
    graph: () => ed.state.graph,
    node: shown,
    recordRate: params.recordRate && params.recordRate !== 'project' ? Number(params.recordRate) || null : null,
    card: { mode: (params.cardMode as CardMode) ?? 'upright', width: Number(params.cardWidth ?? 0.5) || 0.5 },
    overlay: overlay.root,
    edit: createArEditHost(app, nodeId),
    onState: (s) => overlay.update(s),
    onTake: saveTake,
  }).then(
    (handle) => {
      overlay.attach(handle);
      overlay.update(handle.state());
      void handle.closed.then(async (end) => {
        overlay.remove();
        if (end.error) ed.toast(end.error, 'error');
        // the AR session is over (the take and its clip are stored, the camera and the GPU are free): render the video now
        await saveVideoAfter(app, fullId, nodeId, { tookTake, recorded });
      });
    },
    (err) => {
      overlay.remove();
      ed.toast(err instanceof Error ? err.message : String(err), 'error');
    },
  );
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * After the AR view closed (Exit, the phone's Back button, or the system ending the session): make the finished video of the
 * recording when the node's "Save video" is on. Never silent: whenever no video is started, a plain message says why.
 */
export async function saveVideoAfter(app: Ctx, fullId: string, nodeId: string, o: { tookTake: boolean; recorded: boolean }, wait = 250): Promise<void> {
  const { ed } = app;
  try {
    const node = ed.state.graph.nodes.find((n) => n.id === nodeId);
    if (!o.tookTake || node?.params.saveVideo === false) return;
    if (!o.recorded) {
      ed.toast('No finished video was made: the phone did not hand the camera picture over, so there is only the movement. Press "Save object alone as video" on the World AR Camera node if you want the object over black.', 'info');
      return;
    }
    const video = getLive(app).worldArVideo;
    // the camera, the GPU or another render may still be letting go for a moment: wait up to 10 s before refusing
    for (let i = 0; i < 40 && video.busy(); i++) await sleep(wait);
    ed.toast('Making the finished video now: the camera picture with the object over it. It is saved to your downloads and to Media when it is ready. Keep this page open.', 'info');
    await video.start(fullId);
  } catch (err) {
    ed.toast(`The video could not be started: ${err instanceof Error ? err.message : String(err)}. Press "Save as video" on the World AR Camera node to try again.`, 'error');
  }
}
