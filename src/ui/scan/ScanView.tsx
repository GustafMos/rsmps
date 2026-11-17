import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetInfo } from '../../engine/types';
import type { ScanPageState, ScanProgressHooks, ScanResult } from '../../io/api';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { CheckField, SelectField, TextField } from '../components/fields';
import { useApp } from '../store/context';
import { PageCard } from './PageCard';
import { useEd } from '../store/context';
import { emptySession, loadSession, photoFiles, saveSession, type ScanSession } from './session';
import { MenuButton } from '../components/Menu';
import { QUICK_KINDS, buildQuickGraph, type QuickKind } from './quickExport';
import { TextureScan } from './TextureScan';
import { PhoneScanLine, PhoneScanPanel } from './PhoneScanPanel';
import { encodeSpriteJpeg, type PhoneScanController } from '../../io/phone-scan';
import './scan.css';

/** Per-photo state while a scan runs: what each page card shows before its result exists. */
interface Progress {
  names: string[];
  states: ScanPageState[];
  completed: number;
  total: number;
  concurrency: number;
}

const STATE_TEXT: Record<ScanPageState, string> = { queued: 'Queued', scanning: 'Scanning…', done: 'Done', failed: 'Failed', cancelled: 'Canceled' };

export function ScanView() {
  const { io, ed } = useApp();
  const [progress, setProgress] = useState<Progress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Hooks for one scan run: progress into state, and a controller that Cancel and leaving the tab abort. */
  const track = useCallback((): ScanProgressHooks => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    return {
      signal: ac.signal,
      onProgress: (e) => {
        if (ac.signal.aborted) return;
        setProgress((p) => {
          const same = p && p.total === e.total;
          const states: ScanPageState[] = same ? p.states.slice() : Array.from({ length: e.total }, () => 'queued' as const);
          const names = same ? p.names.slice() : Array.from({ length: e.total }, () => '');
          states[e.index] = e.state;
          names[e.index] = e.fileName;
          return { names, states, completed: e.completed, total: e.total, concurrency: e.concurrency };
        });
      },
    };
  }, []);
  const finishTracking = () => {
    abortRef.current = null;
    setProgress(null);
  };
  const [result, setResult] = useState<ScanResult | null>(null);
  const ref = useRef<ScanResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [textureMode, setTextureMode] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [phoneToken, setPhoneToken] = useState('');
  const phoneController = useRef<PhoneScanController | null>(null);
  /** Timing chosen in the Frames section: baked into the hidden working sequence, so the "Scanned frames" source plays with the right holds. */
  const timing = useRef<{ shootOn: number; holds: (number | null)[] }>({ shootOn: 1, holds: [] });
  const timingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileIn = useRef<HTMLInputElement>(null);
  const addIn = useRef<HTMLInputElement>(null);
  const tabId = useEd((s) => s.activeProject);
  const tabName = useEd((s) => s.projects.find((p) => p.id === s.activeProject)?.name ?? 'Scan');
  const session = useRef<ScanSession>(emptySession());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const persist = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { if (tabId) saveSession(io, tabId, session.current); }, 500);
  }, [io, tabId]);
  const onOptions = useCallback((o: Record<string, unknown>) => { session.current.options = { ...session.current.options, ui: o }; persist(); }, [persist]);

  /** Keep the hidden working sequence (what the scan project's graph reads) in step with the analysis. */
  const attach = useCallback(async (r: ScanResult) => {
    if (!tabId) return;
    try {
      // one hidden sequence per paper layer (a single one for ordinary sheets)
      const count = r.layerFrames?.length ?? 1;
      for (let layer = 0; layer < count; layer++) {
        const asset = await io.scan.attach(tabId, r, { name: tabName, fps: r.report.fps || 12, layer, shootOn: timing.current.shootOn, holds: timing.current.holds.map((h) => h ?? 0) });
        if (layer === 0) {
          session.current.committedAssetId = asset.id;
          // the clean-up graph may already exist: keep its length in step with the holds
          if (ed.state.graph.nodes.length) ed.setProject({ duration: asset.duration });
        }
      }
      persist();
    } catch (err) {
      ed.toast(`Could not prepare the frames for clean-up: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }, [io, ed, tabId, tabName, persist]);
  const onTiming = useCallback((t: { shootOn: number; holds: (number | null)[] }) => {
    const changed = t.shootOn !== timing.current.shootOn || JSON.stringify(t.holds) !== JSON.stringify(timing.current.holds);
    timing.current = t;
    if (changed && ref.current) {
      clearTimeout(timingTimer.current);
      timingTimer.current = setTimeout(() => { if (ref.current) void attach(ref.current); }, 500);
    }
  }, [attach]);
  const [restoredOptions, setRestoredOptions] = useState<Record<string, unknown>>({});

  // reopen a saved scan (also after a page reload)
  useEffect(() => {
    if (!tabId) return;
    let live = true;
    void loadSession(io, tabId).then(async (s) => {
      if (!live) return;
      session.current = s;
      if (!s.photos.length) return;
      setRestoredOptions((s.options?.ui as Record<string, unknown>) ?? {});
      setBusy('Restoring your scan…');
      try {
        const r = await io.scan.restore(s, track());
        if (live) replace(r);
        else r.dispose();
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) ed.toast(`Could not restore the scan: ${err instanceof Error ? err.message : String(err)}`, 'error');
      } finally {
        if (live) {
          setBusy(null);
          finishTracking();
        }
      }
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // dispose object URLs when leaving the tab
  useEffect(() => () => ref.current?.dispose(), []);
  // closing the Scan tab stops a scan in progress: queued photos are dropped and running ones terminated
  useEffect(() => () => abortRef.current?.abort(), []);

  const replace = useCallback((r: ScanResult | null) => {
    const old = ref.current;
    ref.current = r;
    setResult(r);
    if (old && old !== r) setTimeout(() => old.dispose(), 0);
  }, []);

  const analyze = async (list: FileList | File[], append = false) => {
    const added = Array.from(list).filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|heic|tiff?)$/i.test(f.name));
    if (!added.length) return ed.toast('Choose photos or scans (JPEG, PNG, WebP…) of the printed sheets.', 'error');
    // a next round adds its photos to the ones already analysed; frames are placed by their printed numbers, later rounds replace earlier ones
    const files = append ? [...photoFiles(session.current), ...added] : added;
    setBusy(`Looking for the page markers in ${files.length} photo${files.length === 1 ? '' : 's'}…`);
    try {
      const r = await io.scan.analyze(files, session.current.options.analyze, track());
      replace(r);
      session.current = { ...session.current, photos: files.map((f) => ({ name: f.name, blob: f })), manual: append ? session.current.manual : {} };
      persist();
      await attach(r);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') ed.toast('Scan canceled.', 'ok');
      else ed.toast(`Scan failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(null);
      finishTracking();
    }
  };

  /** Scan with phone: photos from the linked phone join this scan project through the same parallel pool as "Add photos…". */
  const phoneLive = useRef({ track, attach, replace, persist });
  phoneLive.current = { track, attach, replace, persist };
  useEffect(() => {
    const store = io.phone.scan;
    if (!phoneToken || !store) return;
    const { controller, detach } = store.attach(phoneToken, {
      scan: io.scan,
      current: () => ref.current,
      adopt: async (r, files, mode) => {
        const live = phoneLive.current;
        live.replace(r);
        const photos = files.map((f) => ({ name: f.name, blob: f as Blob }));
        session.current = mode === 'append' ? { ...session.current, photos: [...session.current.photos, ...photos] } : { ...session.current, photos, manual: {} };
        live.persist();
        await live.attach(r);
      },
      previousFiles: () => photoFiles(session.current),
      hooks: () => phoneLive.current.track(),
      busy: (on) => {
        if (on) setBusy('Scanning photos from your phone…');
        else {
          setBusy(null);
          finishTracking();
        }
      },
      analyzeOptions: () => session.current.options.analyze,
      encodeSprite: encodeSpriteJpeg,
    });
    phoneController.current = controller;
    return () => {
      phoneController.current = null;
      detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [io, phoneToken]);

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
          <button className="rs-btn" onClick={() => ed.openDialog('blankSheets')} title="Blank frame boxes for animation drawn on paper"><Icon name="export" /> Blank sheets…</button>
          <button className="rs-btn" onClick={() => setTextureMode((m) => !m)} title="Crop a photo into a texture for the Textures shelf"><Icon name="image" /> Texture…</button>
          <button className="rs-btn" onClick={openPrint} title="Go to the Output node's Print settings"><Icon name="export" /> Print settings…</button>
          <button className="rs-btn rs-btn--primary" onClick={() => fileIn.current?.click()} disabled={!!busy}><Icon name="plus" /> {result ? 'Replace photos…' : 'Choose photos…'}</button>
          <button className={`rs-btn${phoneOpen ? ' is-on' : ''}`} onClick={() => setPhoneOpen((o) => !o)} title="Photograph the sheets with your phone: the photos come straight in, no uploading"><Icon name="plug" /> Scan with phone…</button>
          {result && <button className="rs-btn" onClick={() => addIn.current?.click()} disabled={!!busy} title="Photos of a next-round sheet join this scan project"><Icon name="plus" /> Add photos…</button>}
          <input ref={addIn} type="file" hidden multiple accept="image/*" onChange={(e) => { if (e.target.files) void analyze(e.target.files, true); e.target.value = ''; }} />
          <input ref={fileIn} type="file" hidden multiple accept="image/*" onChange={(e) => { if (e.target.files) void analyze(e.target.files); e.target.value = ''; }} />
        </header>

        {phoneOpen && <PhoneScanPanel token={phoneToken} onToken={setPhoneToken} onClose={() => setPhoneOpen(false)} />}
        {phoneToken && <PhoneScanLine token={phoneToken} hasResult={!!result} onPreview={() => phoneController.current?.requestPreview()} />}

        {busy && (
          <div className="rs-sc__busy" role="status">
            <div className="rs-dlg__bar">
              <div style={progress ? { width: `${Math.round((100 * progress.completed) / Math.max(1, progress.total))}%` } : { width: '100%', animation: 'rs-sc-pulse 1.2s steps(8) infinite' }} />
            </div>
            <span>{progress ? `Scanning ${progress.completed} of ${progress.total} (${progress.concurrency} at a time)` : busy}</span>
            {progress && <button className="rs-btn" onClick={() => abortRef.current?.abort()}>Cancel</button>}
          </div>
        )}
        {progress && (
          <ul className="rs-sc__queue" aria-label="Photos being scanned">
            {progress.states.map((st, i) => (
              <li key={i} className={`is-${st}`}>
                <span className="rs-sc__queuename" title={progress.names[i]}>{progress.names[i]}</span>
                <span className="rs-sc__chip">{STATE_TEXT[st]}</span>
              </li>
            ))}
          </ul>
        )}

        {textureMode && <TextureScan onClose={() => setTextureMode(false)} />}

        {!result && !busy && !textureMode && (
          <div className="rs-empty rs-sc__empty">
            <Icon name="image" size={28} />
            <strong>Drop photos or scans of your printed pages here</strong>
            <span>Pages can be in any order. Each page needs its four corner markers in the picture.</span>
            <span>
              <button className="rs-btn" onClick={() => ed.openDialog('blankSheets')} title="Empty frame boxes with scan markers, for animation drawn entirely on paper"><Icon name="export" /> Print blank sheets…</button>{' '}
              <button className="rs-btn" onClick={() => setPhoneOpen(true)} title="Photograph the sheets with your phone: the photos come straight in, no uploading"><Icon name="plug" /> Scan with phone…</button>{' '}
              <button className="rs-btn" onClick={() => setTextureMode(true)} title="Crop a photo of paper, tape or scribbles into a texture; no markers needed"><Icon name="image" /> Scan a texture…</button>
            </span>
          </div>
        )}

        {result && (
          <>
            <Summary result={result} />
            <section className="rs-sc__pages">
              {result.report.pages.map((p) => (
                <PageCard key={`${p.index}:${p.fileName}`} page={p} result={result} onResult={(r) => { replace(r); void attach(r); }} onManual={(pageIndex, input) => { session.current.manual = { ...session.current.manual, [pageIndex]: input }; persist(); }} />
              ))}
            </section>
            <Frames result={result} defaultName={tabName} initial={restoredOptions} onOptions={onOptions} onTiming={onTiming} onDone={() => { replace(null); session.current = emptySession(); persist(); }} />
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

function Frames({ result, defaultName, initial, onOptions, onTiming, onDone }: { result: ScanResult; defaultName: string; initial: Record<string, unknown>; onOptions: (o: Record<string, unknown>) => void; onTiming: (t: { shootOn: number; holds: (number | null)[] }) => void; onDone: () => void }) {
  const { io, ed } = useApp();
  const r = result.report;
  const total = Math.max(r.totalFrames, result.frames.length);
  const num = (k: string, d: number) => (typeof initial[k] === 'number' ? (initial[k] as number) : d);
  const [name, setName] = useState(defaultName);
  useEffect(() => setName(defaultName), [defaultName]);
  const [fps, setFps] = useState(num('fps', r.fps || 12));
  const [drawingOnly, setDrawingOnly] = useState(initial.drawingOnly === true);
  const [threshold, setThreshold] = useState(num('threshold', 0.12));
  const [softness, setSoftness] = useState(num('softness', 0.1));
  const [missing, setMissing] = useState<'repeat' | 'blank' | 'skip'>((initial.missing as 'repeat') ?? 'repeat');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<AssetInfo | null>(null);
  const [upscale, setUpscale] = useState(num('upscale', 1));
  const [loops, setLoops] = useState(num('loops', 1));
  
  const [exporting, setExporting] = useState(false);
  const isScan = true;
  const [shootOn, setShootOn] = useState(num('shootOn', 1));
  const [holds, setHolds] = useState<(number | null)[]>(Array.isArray(initial.holds) ? (initial.holds as (number | null)[]) : []);
  useEffect(() => onTiming({ shootOn, holds }), [shootOn, holds, onTiming]);
  useEffect(() => onOptions({ fps, drawingOnly, threshold, softness, missing, upscale, loops, shootOn, holds }), [fps, drawingOnly, threshold, softness, missing, upscale, loops, shootOn, holds, onOptions]);
  const setHold = (i: number, v: number | null) => setHolds((h) => { const n = h.slice(); while (n.length <= i) n.push(null); n[i] = v; return n; });
  const layers = r.layerCount ?? 1;
  const [round, setRound] = useState<{ open: boolean; frames: number; onion: 'faint' | 'blue'; strength: number; mode: 'append' | 'replace' }>({ open: false, frames: 12, onion: 'faint', strength: 30, mode: 'append' });
  const printRound = async () => {
    const layout = r.pages.find((p) => p.used && p.layout)?.layout;
    if (!layout) return ed.toast('The sheets could not be read, so the next round cannot be laid out the same way.', 'error');
    try {
      const files = await io.scan.printNextRound(result, { frames: round.mode === 'replace' ? undefined : round.frames, columns: layout.columns, rows: layout.rows, paper: layout.paper, orientation: layout.landscape ? 'landscape' : 'portrait', gutterMm: layout.gutterMm, fps: r.fps || 12, onion: round.onion, onionStrength: round.strength, mode: round.mode, name: defaultName, aspect: { width: r.frameWidthPx || 4, height: r.frameHeightPx || 3 } });
      io.exporter.download(files);
      ed.toast('Next round ready. Draw, photograph, and add the photos here: they join this scan project.', 'ok');
    } catch (err) {
      ed.toast(`Could not print the next round: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  /** Recovered frames straight to a file, without touching the open project. The temporary asset is removed afterwards unless kept. */
  const quickExport = async (kind: QuickKind) => {
    setExporting(true);
    let asset = done;
    const temp = !asset;
    try {
      if (isScan && ed.ensureScanGraph()) {
        // through the scan project's own graph, so the Quick settings (upscale, contrast…) apply; a copy carries this export's type
        const g = ed.state.graph;
        const outNode = g.nodes.find((n) => n.label === 'Export') ?? g.nodes.find((n) => ed.registry.get(n.type)?.category === 'output');
        if (!outNode) throw new Error('The scan graph has no output.');
        const fr = g.project.fps || fps;
        const kp: Record<QuickKind, Record<string, unknown>> = { mp4: { kind: 'video', codec: 'avc' }, webm: { kind: 'video', codec: 'vp9' }, sequence: { kind: 'sequence' }, spritesheet: { kind: 'spritesheet' } };
        const doc = { ...g, project: { ...g.project, loop: false, duration: g.project.duration * (kind === 'mp4' || kind === 'webm' ? Math.max(1, loops) : 1) }, nodes: g.nodes.map((n) => (n.id === outNode.id ? { ...n, params: { ...n.params, ...kp[kind], scale: upscale > 1 ? upscale : n.params.scale, name: (name.trim() || 'Scan').replace(/[\\/:*?"<>|]+/g, '_') } } : n)) };
        void fr;
        await ed.runExportGraph(doc, [outNode.id], 'current', 0, kind === 'sequence');
        return;
      }
      asset ??= await io.scan.commit(result, { name: name.trim() || 'Scan', fps, drawingOnly: drawingOnly && (kind === 'sequence' || kind === 'spritesheet'), threshold, softness, missing, keepOnlyDrawing: true, shootOn, holds: holds.map((h) => h ?? 0) });
      const { graph, outId } = buildQuickGraph(io, asset, kind, { fps, upscale, loops, name: name.trim() || 'Scan' });
      const ok = await ed.runExportGraph(graph, [outId], 'current', 0, kind === 'sequence');
      if (temp && asset) {
        const id = asset.id;
        const info = asset;
        let kept = false;
        const drop = setTimeout(() => { if (!kept) void io.library.remove(id); }, ok ? 20500 : 0);
        if (ok) ed.toast('Exported. The scan is not kept in the media library.', 'ok', [{ label: 'Also add to media library', run: () => { kept = true; clearTimeout(drop); setDone(info); } }]);
      }
    } catch (err) {
      ed.toast(`Export failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      if (temp && asset) void io.library.remove(asset.id);
    } finally {
      setExporting(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    try {
      const asset = await io.scan.commit(result, { name: name.trim() || 'Scan', fps, drawingOnly, threshold, softness, missing, keepOnlyDrawing: true, shootOn, holds: holds.map((h) => h ?? 0) });
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
    void ed.openAssetInNewProject(done.id, name.trim() || 'Scan');
  };

  return (
    <section className="rs-sc__frames">
      <div className="rs-caps">Recovered frames</div>
      <FlipBook result={result} total={total} fps={fps} />
      <div className="rs-sc__strip">
        {Array.from({ length: total }, (_, i) => {
          const url = result.frameUrls[i];
          const thumb = url ? <img src={url} alt={`Frame ${i + 1}`} title={`Frame ${i + 1}`} draggable={false} /> : <div className="rs-sc__gap" title={`Frame ${i + 1} is missing`}>{i + 1}</div>;
          return (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              {thumb}
              <input type="number" min={1} max={48} placeholder={String(shootOn)} value={holds[i] ?? ''} aria-label={`Hold for drawing ${i + 1}`} title="Frames to hold this drawing (empty = the shoot-on rate)" style={{ width: 44 }} onChange={(e) => setHold(i, e.target.value === '' ? null : Math.max(1, Math.min(48, Math.round(Number(e.target.value)))))} />
            </div>
          );
        })}
      </div>
      <div className="rs-sc__opts">
        <SelectField large value={String(shootOn)} onChange={(v) => setShootOn(Number(v))} options={[{ value: '1', label: 'Shoot on ones' }, { value: '2', label: 'Shoot on twos' }, { value: '3', label: 'Shoot on threes' }, { value: '4', label: 'Shoot on fours' }]} />
        <span className="rs-insp__hint">The number under a drawing holds just that drawing for that many frames. {layers > 1 ? `${layers} paper layers found: the clean-up graph stacks them with transparency.` : ''}</span>
      </div>
      <div className="rs-sc__opts">
        <button className="rs-btn" onClick={() => setRound((o) => ({ ...o, open: !o.open }))}>Print next round…</button>
        {round.open && (
          <>
            <SelectField large value={round.mode} onChange={(v) => setRound((o) => ({ ...o, mode: v as 'append' | 'replace' }))} options={[{ value: 'append', label: 'Continue: new frames after the last' }, { value: 'replace', label: 'Redo: same frames again (ink over pencil)' }]} />
            {round.mode === 'append' && <NumberField large label="New frames" integer min={1} max={500} value={round.frames} defaultValue={12} onChange={(v) => setRound((o) => ({ ...o, frames: v }))} />}
            <SelectField large value={round.onion} onChange={(v) => setRound((o) => ({ ...o, onion: v as 'faint' | 'blue' }))} options={[{ value: 'faint', label: 'Previous drawing faint gray' }, { value: 'blue', label: 'Previous drawing non-photo blue' }]} />
            <NumberField large label="Strength %" integer min={5} max={100} value={round.strength} defaultValue={30} onChange={(v) => setRound((o) => ({ ...o, strength: v }))} />
            <button className="rs-btn rs-btn--primary" onClick={() => void printRound()}>Download sheets</button>
          </>
        )}
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
      <div className="rs-sc__opts">
        <NumberField large label="Pixel upscale ×" integer min={1} max={4} value={upscale} defaultValue={1} onChange={setUpscale} />
        <NumberField large label="Video loops" integer min={1} max={50} value={loops} defaultValue={1} onChange={setLoops} />
      </div>
      <div className="rs-sc__exportrow">
        <div className="rs-top__split">
          <button className="rs-btn rs-btn--primary" disabled={exporting || r.recoveredFrames === 0} onClick={() => void quickExport('mp4')} title="Straight to an MP4 file; nothing is added to your project">{exporting ? 'Exporting…' : 'Export as video'}</button>
          <MenuButton className="rs-btn rs-btn--primary rs-top__caret" title="Other formats" items={QUICK_KINDS.map((k) => ({ label: k.label, onClick: () => void quickExport(k.id) }))}><Icon name="chevronDown" size={12} /></MenuButton>
        </div>
        <span className="rs-insp__hint">Uses the frame rate, upscale and loop count above. &quot;Drawing only&quot; applies to PNG sequence and spritesheet.</span>
      </div>
      {done ? (
        <div className="rs-sc__done">
          <span>Added &quot;{done.name}&quot; ({done.width}×{done.height}).</span>
          <button className="rs-btn rs-btn--primary" onClick={toEdit}>Open in a new project</button>
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
        <li><b>Draw</b> in the frames, in any color. Keep clear of the black <b>+</b> marks, the four square corner markers and the small data strip at the top.</li>
        <li><b>Photograph</b> each sheet flat, in even light without hard shadows, with all four corner markers in the picture. Rotation and phone perspective are fixed automatically. Do not photograph the back of the paper.</li>
        <li><b>Add the photos here.</b> Any order. Pages that fail can be fixed by dragging the four corners and entering the paper, columns and rows you printed with.</li>
        <li><b>Add to media library.</b> The frames become an animation you can use in a Media In node. &quot;Drawing only&quot; keeps just the ink on transparent.</li>
      </ol>
    </div>
  );
}
