import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetInfo } from '../../engine/types';
import type { ScanResult } from '../../io/api';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { CheckField, SelectField, TextField } from '../components/fields';
import { useApp } from '../store/context';
import { PageCard } from './PageCard';
import './scan.css';

export function ScanView() {
  const { io, ed } = useApp();
  const [result, setResult] = useState<ScanResult | null>(null);
  const ref = useRef<ScanResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);

  // dispose object URLs when leaving the tab
  useEffect(() => () => ref.current?.dispose(), []);

  const replace = useCallback((r: ScanResult | null) => {
    const old = ref.current;
    ref.current = r;
    setResult(r);
    if (old && old !== r) setTimeout(() => old.dispose(), 0);
  }, []);

  const analyze = async (list: FileList | File[]) => {
    const files = Array.from(list).filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|tiff?)$/i.test(f.name));
    if (!files.length) return ed.toast('Choose photos or scans (JPEG, PNG, WebP…) of the printed sheets.', 'error');
    setBusy(`Looking for the page markers in ${files.length} photo${files.length === 1 ? '' : 's'}…`);
    try {
      replace(await io.scan.analyze(files));
    } catch (err) {
      ed.toast(`Scan failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const openPrint = () => {
    const out = io.registry.list().find((d) => d.category === 'output' && ((d.params as Record<string, { options?: { value: string }[] }>).kind?.options ?? []).some((o) => o.value === 'print'));
    const existing = ed.state.graph.nodes.find((n) => n.type === out?.id);
    let id = existing?.id ?? null;
    if (!id && out) id = ed.addNodeAt(out.id, { x: 400, y: 0 });
    if (!id) return ed.toast('No output node supports printing.', 'error');
    ed.setParam(id, 'kind', 'print');
    ed.select([id]);
    ed.setPrefs({ rightOpen: true });
    ed.setMode('edit');
  };

  return (
    <div
      className={`rs-sc${over ? ' is-drop' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); if (e.dataTransfer.files.length) { e.preventDefault(); void analyze(e.dataTransfer.files); } }}
    >
      <div className="rs-sc__main">
        <header className="rs-sc__bar">
          <div>
            <h2>Scan back</h2>
            <p>Photograph the printed sheets, and get your frames back as an animation.</p>
          </div>
          <span className="rs-sc__spacer" />
          <button className="rs-btn" onClick={openPrint} title="Go to the Output node's Print settings"><Icon name="export" /> Print settings…</button>
          <button className="rs-btn rs-btn--primary" onClick={() => fileIn.current?.click()} disabled={!!busy}><Icon name="plus" /> {result ? 'Replace photos…' : 'Choose photos…'}</button>
          <input ref={fileIn} type="file" hidden multiple accept="image/*" onChange={(e) => { if (e.target.files) void analyze(e.target.files); e.target.value = ''; }} />
        </header>

        {busy && (
          <div className="rs-sc__busy" role="status">
            <div className="rs-dlg__bar"><div style={{ width: '100%', animation: 'rs-sc-pulse 1.2s steps(8) infinite' }} /></div>
            <span>{busy}</span>
          </div>
        )}

        {!result && !busy && (
          <div className="rs-empty rs-sc__empty">
            <Icon name="image" size={28} />
            <strong>Drop photos or scans of your printed pages here</strong>
            <span>Pages can be in any order. Each page needs its four corner markers in the picture.</span>
          </div>
        )}

        {result && (
          <>
            <Summary result={result} />
            <section className="rs-sc__pages">
              {result.report.pages.map((p) => (
                <PageCard key={`${p.index}:${p.fileName}`} page={p} result={result} onResult={replace} />
              ))}
            </section>
            <Frames result={result} onDone={() => { replace(null); }} />
          </>
        )}
      </div>
      <aside className="rs-sc__help">
        <Help />
      </aside>
    </div>
  );
}

function Summary({ result }: { result: ScanResult }) {
  const r = result.report;
  return (
    <section className={`rs-sc__summary${r.complete ? ' is-ok' : ''}`}>
      <strong className="rs-num">{r.recoveredFrames} of {r.totalFrames || '?'} frames recovered</strong>
      <span className="rs-num">{r.pageCount} page{r.pageCount === 1 ? '' : 's'} · {r.fps} fps · {r.frameWidthPx}×{r.frameHeightPx}px</span>
      {r.missingPages.length > 0 && <span className="rs-sc__bad">Missing page{r.missingPages.length > 1 ? 's' : ''}: {r.missingPages.map((n) => n + 1).join(', ')}</span>}
      {r.warnings.map((w, i) => <span key={i} className="rs-sc__bad">{w}</span>)}
    </section>
  );
}

function Frames({ result, onDone }: { result: ScanResult; onDone: () => void }) {
  const { io, ed } = useApp();
  const r = result.report;
  const total = Math.max(r.totalFrames, result.frames.length);
  const [name, setName] = useState(`Scan ${new Date().toLocaleDateString()}`);
  const [fps, setFps] = useState(r.fps || 12);
  const [drawingOnly, setDrawingOnly] = useState(false);
  const [threshold, setThreshold] = useState(0.12);
  const [softness, setSoftness] = useState(0.1);
  const [missing, setMissing] = useState<'repeat' | 'blank' | 'skip'>('repeat');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<AssetInfo | null>(null);

  const commit = async () => {
    setBusy(true);
    try {
      const asset = await io.scan.commit(result, { name: name.trim() || 'Scan', fps, drawingOnly, threshold, softness, missing });
      setDone(asset);
      ed.toast(`Added "${asset.name}" to the media library`, 'ok');
    } catch (err) {
      ed.toast(`Could not add to the library: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const toEdit = () => {
    if (!done) return;
    ed.setMode('edit');
    ed.addAssetNode([done.id], { x: 0, y: 240 });
  };

  return (
    <section className="rs-sc__frames">
      <div className="rs-caps">Recovered frames</div>
      <FlipBook result={result} total={total} fps={fps} />
      <div className="rs-sc__strip">
        {Array.from({ length: total }, (_, i) => {
          const url = result.frameUrls[i];
          return url ? <img key={i} src={url} alt={`Frame ${i + 1}`} title={`Frame ${i + 1}`} draggable={false} /> : <div key={i} className="rs-sc__gap" title={`Frame ${i + 1} is missing`}>{i + 1}</div>;
        })}
      </div>
      <div className="rs-sc__opts">
        <TextField large value={name} onChange={setName} placeholder="Name in the media library" />
        <NumberField large label="Frame rate" integer min={1} max={120} value={fps} defaultValue={r.fps || 12} onChange={setFps} />
        <SelectField large value={missing} onChange={(v) => setMissing(v as 'repeat')} options={[{ value: 'repeat', label: 'Missing frames: repeat the previous one' }, { value: 'blank', label: 'Missing frames: leave blank' }, { value: 'skip', label: 'Missing frames: skip them' }]} />
        <CheckField value={drawingOnly} onChange={setDrawingOnly} label="Drawing only: ink on a transparent background" />
        {drawingOnly && (
          <>
            <NumberField large label="Paper threshold" min={0} max={1} step={0.01} value={threshold} defaultValue={0.12} onChange={setThreshold} />
            <NumberField large label="Edge softness" min={0} max={1} step={0.01} value={softness} defaultValue={0.1} onChange={setSoftness} />
          </>
        )}
      </div>
      {done ? (
        <div className="rs-sc__done">
          <span>Added &quot;{done.name}&quot; ({done.width}×{done.height}).</span>
          <button className="rs-btn rs-btn--primary" onClick={toEdit}>Back to Edit with a Media In node</button>
          <button className="rs-btn" onClick={() => setDone(null)}>Stay here</button>
          <button className="rs-btn rs-btn--ghost" onClick={onDone}>Start over</button>
        </div>
      ) : (
        <button className="rs-btn rs-btn--primary" onClick={commit} disabled={busy || r.recoveredFrames === 0}>{busy ? 'Adding…' : 'Add to media library'}</button>
      )}
    </section>
  );
}

function FlipBook({ result, total, fps }: { result: ScanResult; total: number; fps: number }) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing || total === 0) return;
    const id = setInterval(() => setI((n) => (n + 1) % total), 1000 / Math.max(1, fps));
    return () => clearInterval(id);
  }, [playing, total, fps]);
  const url = result.frameUrls[Math.min(i, total - 1)];
  return (
    <div className="rs-sc__flip">
      <div className="rs-sc__screen">{url ? <img src={url} alt={`Frame ${i + 1}`} draggable={false} /> : <span className="rs-sc__bad">Frame {i + 1} is missing</span>}</div>
      <div className="rs-sc__flipbar">
        <button className={`rs-btn rs-btn--icon${playing ? ' is-on' : ''}`} onClick={() => setPlaying((p) => !p)} title={playing ? 'Pause' : 'Play as a flip-book'}><Icon name={playing ? 'pause' : 'play'} /></button>
        <input type="range" min={0} max={Math.max(0, total - 1)} value={Math.min(i, Math.max(0, total - 1))} onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }} aria-label="Frame" />
        <span className="rs-num">{Math.min(i, total - 1) + 1} / {total} · {fps} fps</span>
      </div>
    </div>
  );
}

function Help() {
  return (
    <div className="rs-sc__helpbody">
      <div className="rs-caps">How to print and photograph</div>
      <ol>
        <li><b>Print.</b> In an Output node choose <i>Export as: Print sheets</i>. Pick paper, frames across and down, and a frame guide (full, faded, outlines or blank).</li>
        <li><b>Print at 100% (&quot;Actual size&quot;).</b> Never fit-to-page: the markers are placed for the exact paper size.</li>
        <li><b>Draw</b> in the frames, in any colour. Keep clear of the black <b>+</b> marks, the four square corner markers and the small data strip at the top.</li>
        <li><b>Photograph</b> each sheet flat, in even light without hard shadows, with all four corner markers in the picture. Rotation and phone perspective are fixed automatically. Do not photograph the back of the paper.</li>
        <li><b>Add the photos here.</b> Any order. Pages that fail can be fixed by dragging the four corners and entering the paper, columns and rows you printed with.</li>
        <li><b>Add to media library.</b> The frames become an animation you can use in a Media In node. &quot;Drawing only&quot; keeps just the ink on transparent.</li>
      </ol>
    </div>
  );
}
