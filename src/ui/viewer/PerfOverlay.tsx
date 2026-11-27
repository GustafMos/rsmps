import { useEffect, useMemo, useState } from 'react';
import pkg from '../../../package.json';
import { nodeAtPath } from '../../engine/group';
import { ESTIMATE_NOTE, buildReport, panelLines, type PerfSnapshot } from '../../io/perf';
import { createStore, useSelector } from '../store/createStore';
import { useApp } from '../store/context';

type App = ReturnType<typeof useApp>;

/** Performance readout: off by default, never saved with the project. */
export const perfStore = createStore<{ on: boolean }>({ on: false });

/** Turn the readout on or off. The player only measures while it is on, whichever tab is showing. */
export function setPerfPanel(io: App['io'], on: boolean): void {
  perfStore.set({ on });
  io.player.setPerf(on);
}

function nameResolver(app: App): (id: string) => string {
  return (id) => {
    const n = nodeAtPath(app.ed.state.graph, id);
    if (!n) return id;
    return n.label || app.io.registry.get(n.type)?.title || n.type;
  };
}

/** The text that "Copy performance report" puts on the clipboard (types of nodes only: no file names, node names or media names). */
export function performanceReport(app: App, snapshot: PerfSnapshot): string {
  return buildReport({
    snapshot,
    nameOf: nameResolver(app),
    nodeTypes: app.ed.state.graph.nodes.map((n) => n.type),
    userAgent: navigator.userAgent,
    appVersion: pkg.version,
  });
}

/** Copy to the clipboard; when the browser refuses, the caller shows the text to select by hand. Returns true when copied. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The newest numbers about twice a second while the readout is on. */
export function usePerfSnapshot(io: App['io'], on: boolean): PerfSnapshot | null {
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);
  useEffect(() => {
    if (!on) {
      setSnap(null);
      return;
    }
    const tick = () => setSnap(io.player.perfSnapshot());
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [io, on]);
  return snap;
}

export function PerfOverlay() {
  const app = useApp();
  const { io } = app;
  const on = useSelector(perfStore, (s) => s.on);
  const snap = usePerfSnapshot(io, on);
  const [note, setNote] = useState('');
  const [shown, setShown] = useState('');
  const nameOf = useMemo(() => nameResolver(app), [app]);
  if (!on) return null;

  const copy = async () => {
    const s = io.player.perfSnapshot();
    if (!s) return;
    const text = performanceReport(app, s);
    if (await copyText(text)) {
      setShown('');
      setNote('The performance report was copied. Paste it into a message.');
    } else {
      setShown(text);
      setNote('Your browser did not allow copying. The report is below: select it all and copy it.');
    }
  };

  return (
    <div className="rs-perf" data-nodrag data-perf-panel role="region" aria-label="Performance">
      <div className="rs-perf__head">
        <strong>Performance</strong>
        <button className="rs-btn rs-btn--ghost" onClick={() => setPerfPanel(io, false)} aria-label="Close the performance readout">Close</button>
      </div>
      {snap ? (
        <ul className="rs-perf__lines" data-perf-lines>
          {panelLines(snap, nameOf).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : (
        <div className="rs-perf__lines">Measuring…</div>
      )}
      <div className="rs-perf__note">{ESTIMATE_NOTE}</div>
      <button className="rs-btn" onClick={() => void copy()}>Copy performance report</button>
      {note && <div className="rs-perf__note" role="status">{note}</div>}
      {shown && <textarea className="rs-input" aria-label="Performance report" data-perf-report-text readOnly rows={8} value={shown} onFocus={(e) => e.currentTarget.select()} autoFocus />}
    </div>
  );
}
