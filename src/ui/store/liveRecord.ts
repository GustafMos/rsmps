/**
 * The Record button of the live picture inputs (Webcam, Phone Camera, URL / Stream): starts and stops `io.liveRecorder` for a node
 * and says what happened in a toast. The clip lands in Media; the graph is not rewired.
 */
import { defaultParams } from '../../engine/engine';
import { nodeAtPath } from '../../engine/group';
import { isLivePictureType, liveOrientOfNode, liveSourceOfNode, liveTakeLabel, type LiveSourceRequest } from '../../engine/lib/live-source';
import type { LiveRecordFinish } from '../../io/api';
import type { AppCtx } from './context';

type Ctx = Pick<AppCtx, 'io' | 'ed'>;

/** The node's params with defaults applied, or null when it is gone or is not a live picture input. */
function liveParams({ io, ed }: Ctx, fullId: string): { type: string; params: Record<string, unknown> } | null {
  const node = nodeAtPath(ed.state.graph, fullId);
  if (!node || !isLivePictureType(node.type)) return null;
  const def = io.registry.get(node.type);
  return { type: node.type, params: { ...(def ? defaultParams(def) : {}), ...node.params } };
}

/** The live source of a node as it is set up right now (null: not set up, or not a live picture node). */
export function liveSourceOf(app: Ctx, fullId: string): LiveSourceRequest | null {
  const n = liveParams(app, fullId);
  return n ? liveSourceOfNode(n.type, n.params) : null;
}

/** Record / Stop for one node. Only one recording runs at a time. */
export function toggleLiveRecord(app: Ctx, fullId: string): void {
  const { io, ed } = app;
  const rec = io.liveRecorder;
  if (rec.state === 'saving') return ed.toast('The last recording is still being saved.', 'info');
  if (rec.state === 'recording') {
    if (rec.nodeId === fullId) void rec.stop();
    else ed.toast('Another node is being recorded. Stop that recording first.', 'info');
    return;
  }
  const n = liveParams(app, fullId);
  if (!n) return;
  try {
    rec.start({
      nodeId: fullId,
      fps: ed.state.graph.project.fps,
      label: liveTakeLabel(n.type),
      source: () => {
        const now = liveParams(app, fullId);
        return now ? liveSourceOfNode(now.type, now.params) : 'gone';
      },
      orient: () => {
        const now = liveParams(app, fullId);
        return now ? liveOrientOfNode(now.type, now.params) : { mirror: false, turns: 0 };
      },
    });
  } catch (err) {
    ed.toast(`Could not start recording: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

/** The toast for a finished recording. Pure. */
export function finishMessage(f: LiveRecordFinish): { text: string; kind: 'ok' | 'error' } {
  if (!f.result) return { text: `Recording failed: ${f.error ?? 'nothing was saved'}`, kind: 'error' };
  const why = f.reason === 'limit' ? 'The recording reached its limit. ' : f.reason === 'gone' ? 'The node was removed, so the recording stopped. ' : f.reason === 'switch' ? 'The project changed, so the recording stopped. ' : f.reason === 'error' ? 'The recording stopped early. ' : '';
  return { text: `${why}Saved ${f.result.name} to Media (${f.result.seconds.toFixed(1)} s)`, kind: 'ok' };
}

/** Toasts for every recording that ends (Stop, the limit, a deleted node, a project switch). Returns the uninstaller. */
export function installLiveRecord({ io, ed }: Ctx): () => void {
  return io.liveRecorder.onFinished((f) => {
    const m = finishMessage(f);
    ed.toast(m.text, m.kind);
  });
}
