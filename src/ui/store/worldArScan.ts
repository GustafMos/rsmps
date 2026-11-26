/**
 * The "Start scan" button of the 3D Scan node: opens the AR view in scan mode and puts the finished scan (its photos are already
 * in Media) into the node's `scan` param as one undo step.
 */
import { qualitySummary } from '../../engine/lib/scan-coverage';
import type { WorldArScanOutcome } from '../../io/world-ar/controller';
import { createArOverlay } from '../worldAr/overlay';
import type { AppCtx } from './context';

type Ctx = Pick<AppCtx, 'io' | 'ed'>;

/** The toast after a scan was saved. Pure. */
export function scanMessage(r: WorldArScanOutcome): { text: string; kind: 'ok' | 'error' | 'info' } {
  if (!r.scan) return { text: r.error ?? 'No photos were taken, so nothing was saved.', kind: 'error' };
  const n = r.scan.shots.length;
  const q = qualitySummary(r.scan, r.rejected);
  const base = `Scan saved: ${n} photo${n === 1 ? '' : 's'}, coverage ${Math.round(q.coverage * 100)}%. ${q.verdict.text}.`;
  return { text: r.error ? `${base} ${r.error}` : base, kind: r.error || q.verdict.level !== 'good' ? 'info' : 'ok' };
}

/**
 * Open the scan view. MUST be called straight from the button press (nothing is awaited before `io.worldAr.open`), so the question
 * about replacing an earlier scan is asked in the panel BEFORE this is called.
 */
export function openScan(app: Ctx, nodeId: string): void {
  const { io, ed } = app;
  const ar = io.worldAr;
  if (!ar) return ed.toast('The AR view is not available in this version of the app.', 'error');
  if (ar.active) return ed.toast('The AR view is already open.', 'info');
  const overlay = createArOverlay(document, { scan: true });
  const save = (r: WorldArScanOutcome) => {
    const m = scanMessage(r);
    ed.toast(m.text, m.kind);
    if (!r.scan) return;
    ed.beginHold(); // the scan param: one undo step
    ed.setParam(nodeId, 'scan', r.scan);
    ed.endHold();
  };
  ar.open({
    graph: () => ed.state.graph,
    node: nodeId,
    card: { mode: 'upright', width: 0.5 },
    overlay: overlay.root,
    onState: (s) => overlay.update(s),
    onTake: () => undefined,
    scan: { onScan: save },
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
