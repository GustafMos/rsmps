import { useRef, useState } from 'react';
import { batchCount, outputNodes } from '../../engine/graph';
import { CheckField } from '../components/fields';
import { useApp, useEd } from '../store/context';
import { Dialog } from './Dialog';

export function ExportDialog() {
  const { io, ed } = useApp();
  const graph = useEd((s) => s.graph);
  const selection = useEd((s) => s.selection);
  const item = useEd((s) => s.item);
  const outputs = outputNodes(graph, io.registry);
  const count = batchCount(graph, io.registry);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(outputs.map((o) => o.id)));
  const [items, setItems] = useState<'current' | 'all'>(count > 1 ? 'all' : 'current');
  const [zip, setZip] = useState(true);
  const [progress, setProgress] = useState<{ fraction: number; label: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const running = progress !== null;

  const selectedOutputs = outputs.filter((o) => selection.includes(o.id));
  const toggle = (id: string) =>
    setChosen((c) => {
      const n = new Set(c);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const start = async () => {
    const ac = new AbortController();
    abort.current = ac;
    setProgress({ fraction: 0, label: 'Starting…' });
    try {
      const files = await io.exporter.run({
        graph,
        outputs: chosen.size === outputs.length ? [] : [...chosen],
        items,
        item,
        zip,
        signal: ac.signal,
        onProgress: (p) => setProgress({ fraction: p.fraction, label: p.label }),
      });
      if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      io.exporter.download(files);
      ed.toast(`Exported ${files.length} file${files.length === 1 ? '' : 's'}`, 'ok');
      ed.openDialog(null);
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) ed.toast('Export cancelled', 'info');
      else ed.toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      setProgress(null);
    } finally {
      abort.current = null;
    }
  };

  const close = () => {
    abort.current?.abort();
    ed.openDialog(null);
  };

  return (
    <Dialog
      title="Export"
      onClose={close}
      footer={
        <>
          <button className="rs-btn" onClick={close}>{running ? 'Cancel' : 'Close'}</button>
          <button className="rs-btn rs-btn--primary" onClick={start} disabled={running || chosen.size === 0}>
            Export {chosen.size} output{chosen.size === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      {outputs.length === 0 ? (
        <p className="rs-dlg__note">There is no Output node in this graph. Add one (Shift+A → Output) and connect your result to it.</p>
      ) : (
        <>
          <div className="rs-dlg__sec">
            <div className="rs-dlg__row">
              <span className="rs-caps">Outputs</span>
              <span className="rs-dlg__spacer" />
              <button className="rs-btn rs-btn--ghost" disabled={running} onClick={() => setChosen(new Set(outputs.map((o) => o.id)))}>All</button>
              <button className="rs-btn rs-btn--ghost" disabled={running || !selectedOutputs.length} onClick={() => setChosen(new Set(selectedOutputs.map((o) => o.id)))}>Selected</button>
            </div>
            <div className="rs-dlg__list">
              {outputs.map((o) => (
                <CheckField key={o.id} value={chosen.has(o.id)} onChange={() => toggle(o.id)} label={o.label || io.registry.get(o.type)?.title || o.type} disabled={running} />
              ))}
            </div>
          </div>
          <div className="rs-dlg__sec">
            <span className="rs-caps">What to render</span>
            <div className="rs-dlg__seg">
              <button className={`rs-btn${items === 'current' ? ' is-on' : ''}`} disabled={running} onClick={() => setItems('current')}>Current item{count > 1 ? ` (${item + 1})` : ''}</button>
              <button className={`rs-btn${items === 'all' ? ' is-on' : ''}`} disabled={running || count < 2} onClick={() => setItems('all')}>Whole batch{count > 1 ? ` (${count})` : ''}</button>
            </div>
            <CheckField value={zip} onChange={setZip} label="Pack into a ZIP when there is more than one file" disabled={running} />
          </div>
          {progress && (
            <div className="rs-dlg__progress">
              <div className="rs-dlg__bar"><div style={{ width: `${Math.round(progress.fraction * 100)}%` }} /></div>
              <div className="rs-dlg__row">
                <span className="rs-mono">{progress.label}</span>
                <span className="rs-dlg__spacer" />
                <span className="rs-num">{Math.round(progress.fraction * 100)}%</span>
                <button className="rs-btn rs-btn--danger" onClick={() => abort.current?.abort()}>Cancel</button>
              </div>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
