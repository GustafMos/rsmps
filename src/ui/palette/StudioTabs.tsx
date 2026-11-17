import { useMemo, useRef, useState } from 'react';
import { BUILTIN_PALETTES } from '../../engine/lib/pixel-palettes';
import { NumberField } from '../components/NumberField';
import { SelectField } from '../components/fields';
import { Icon } from '../components/Icon';
import { contrastRatio, oklabToRgb, oklchToRgb, parseHex, rgbToOklab, rgbToOklch, simulateCvd, toHex, type CvdKind, type RGB } from '../lib/colorMath';
import { useApp, useAssets } from '../store/context';
import { EXPORT_FORMATS, download, exportPalette, loadSaved, parsePalette, storeSaved, swatchStripBlob, type ExportFormat, type SavedPalette } from './formats';
import { MOODS, extractColors, sampleImage, type Mood } from './extract';

type Tab = 'generate' | 'extract' | 'access' | 'io' | 'library';
const TABS: { id: Tab; label: string }[] = [
  { id: 'generate', label: 'Generate' },
  { id: 'extract', label: 'From image' },
  { id: 'access', label: 'Accessibility' },
  { id: 'io', label: 'Import / Export' },
  { id: 'library', label: 'Library' },
];

export function StudioTabs({ colors, selected, onColors }: { colors: RGB[]; selected: number; onColors: (c: RGB[]) => void }) {
  const [tab, setTab] = useState<Tab>('generate');
  return (
    <div className="rs-ps__tabs">
      <div className="rs-ps__tabbar" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="rs-ps__tabbody">
        {tab === 'generate' && <Generate colors={colors} selected={selected} onColors={onColors} />}
        {tab === 'extract' && <Extract onColors={onColors} />}
        {tab === 'access' && <Access colors={colors} />}
        {tab === 'io' && <ImportExport colors={colors} onColors={onColors} />}
        {tab === 'library' && <Library colors={colors} onColors={onColors} />}
      </div>
    </div>
  );
}

/* ------------------------------- Generate -------------------------------- */

function Generate({ colors, selected, onColors }: { colors: RGB[]; selected: number; onColors: (c: RGB[]) => void }) {
  const [a, setA] = useState(0);
  const [b, setB] = useState(Math.max(1, colors.length - 1));
  const [steps, setSteps] = useState(8);
  const ia = Math.min(a, colors.length - 1);
  const ib = Math.min(b, colors.length - 1);
  const opts = colors.map((c, i) => ({ value: String(i), label: `${i + 1}  ${toHex(c)}` }));

  const ramp = () => {
    const la = rgbToOklab(colors[ia]);
    const lb = rgbToOklab(colors[ib]);
    onColors(Array.from({ length: steps }, (_, i) => {
      const t = i / Math.max(1, steps - 1);
      return oklabToRgb([la[0] + (lb[0] - la[0]) * t, la[1] + (lb[1] - la[1]) * t, la[2] + (lb[2] - la[2]) * t]);
    }));
  };
  const lightRamp = () => {
    const [, c, h] = rgbToOklch(colors[Math.min(selected, colors.length - 1)]);
    onColors(Array.from({ length: steps }, (_, i) => {
      const t = i / Math.max(1, steps - 1);
      const L = 0.2 + 0.75 * t;
      return oklchToRgb(L, c * (0.55 + 0.9 * Math.sin(Math.PI * t) * 0.5 + 0.2), h + (t - 0.5) * 24);
    }));
  };
  return (
    <div className="rs-ps__grid2">
      <div className="rs-ps__card">
        <div className="rs-caps">Ramp between two swatches (OKLab)</div>
        <div className="rs-ps__row"><SelectField value={String(ia)} options={opts} onChange={(v) => setA(+v)} label="From" /><SelectField value={String(ib)} options={opts} onChange={(v) => setB(+v)} label="To" /></div>
        <NumberField large label="Steps" integer min={2} max={64} value={steps} defaultValue={8} onChange={setSteps} />
        <button className="rs-btn rs-btn--primary" onClick={ramp} disabled={colors.length < 2}>Replace palette with ramp</button>
      </div>
      <div className="rs-ps__card">
        <div className="rs-caps">Lightness ramp of one hue</div>
        <p className="rs-ps__hint">Uses the selected swatch&apos;s hue and chroma and walks lightness from dark to light with a gentle hue shift: ideal for pixel-art shading.</p>
        <NumberField large label="Steps" integer min={2} max={64} value={steps} defaultValue={8} onChange={setSteps} />
        <button className="rs-btn rs-btn--primary" onClick={lightRamp}>Replace palette with shading ramp</button>
      </div>
    </div>
  );
}

/* -------------------------------- Extract -------------------------------- */

function Extract({ onColors }: { onColors: (c: RGB[]) => void }) {
  const { io, ed } = useApp();
  const assets = useAssets().filter((x) => x.kind === 'image' || x.kind === 'video');
  const [src, setSrc] = useState('viewer');
  const [n, setN] = useState(6);
  const [mood, setMood] = useState<Mood>('auto');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      let drawable: CanvasImageSource & { width: number; height: number };
      if (src === 'viewer') {
        const blob = await io.player.snapshot();
        if (!blob) throw new Error('The viewer is empty. View a node that shows an image first.');
        drawable = await createImageBitmap(blob);
      } else {
        const url = await io.library.thumbnail(src);
        if (!url) throw new Error('No preview for that file.');
        const img = new Image();
        img.src = url;
        await img.decode();
        drawable = img;
      }
      const cols = extractColors(sampleImage(drawable, 128), n, mood);
      if (!cols.length) throw new Error('No opaque pixels to sample.');
      onColors(cols);
    } catch (err) {
      ed.toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rs-ps__card">
      <div className="rs-caps">Extract dominant colors</div>
      <div className="rs-ps__row">
        <SelectField large value={src} onChange={setSrc} options={[{ value: 'viewer', label: 'Current viewer frame' }, ...assets.map((a) => ({ value: a.id, label: a.name }))]} />
        <SelectField large value={mood} onChange={(v) => setMood(v as Mood)} options={MOODS.map((m) => ({ value: m.id, label: m.label }))} />
      </div>
      <NumberField large label="Colors" integer min={2} max={16} value={n} defaultValue={6} onChange={setN} />
      <button className="rs-btn rs-btn--primary" onClick={run} disabled={busy}>{busy ? 'Extracting…' : 'Extract palette'}</button>
      <p className="rs-ps__hint">Clusters a 128px downscale in OKLab. Moods bias which pixels count: colorful favors saturated, bright and dark favour lightness, muted favours grays, deep favours dark saturated.</p>
    </div>
  );
}

/* ------------------------------ Accessibility ----------------------------- */

function Access({ colors }: { colors: RGB[] }) {
  const list = colors.slice(0, 12);
  const kinds: { id: CvdKind; label: string }[] = [
    { id: 'protan', label: 'Protanopia (no red)' },
    { id: 'deutan', label: 'Deuteranopia (no green)' },
    { id: 'tritan', label: 'Tritanopia (no blue)' },
  ];
  return (
    <div className="rs-ps__card">
      <div className="rs-caps">Contrast (WCAG) {colors.length > 12 && '· first 12 swatches'}</div>
      <div className="rs-ps__contrast" style={{ gridTemplateColumns: `28px repeat(${list.length}, 1fr)` }}>
        <span />
        {list.map((c, i) => <span key={i} className="rs-ps__ch" style={{ background: toHex(c) }} />)}
        {list.map((r, i) => (
          <div key={i} style={{ display: 'contents' }}>
            <span className="rs-ps__ch" style={{ background: toHex(r) }} />
            {list.map((c, j) => {
              if (i === j) return <span key={j} className="rs-ps__cc is-self" />;
              const ratio = contrastRatio(r, c);
              const grade = ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA large' : 'fail';
              return (
                <span key={j} className={`rs-ps__cc rs-num ${grade === 'fail' ? 'is-fail' : 'is-ok'}`} style={{ background: toHex(r), color: toHex(c) }} title={`${ratio.toFixed(2)}:1 · ${grade}`}>
                  {ratio.toFixed(1)}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <p className="rs-ps__hint">Each cell shows the second color as text on the first, with its ratio. 4.5 and above passes AA for normal text, 7 passes AAA, 3 passes AA for large text.</p>
      <div className="rs-caps">Color-vision simulation</div>
      {[{ id: 'normal' as const, label: 'Normal vision' }, ...kinds].map((k) => (
        <div key={k.id} className="rs-ps__cvd">
          <span>{k.label}</span>
          <div>{colors.map((c, i) => <span key={i} style={{ background: toHex(k.id === 'normal' ? c : simulateCvd(c, k.id)) }} />)}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------- Import / Export ---------------------------- */

function ImportExport({ colors, onColors }: { colors: RGB[]; onColors: (c: RGB[]) => void }) {
  const { ed } = useApp();
  const [text, setText] = useState('');
  const [fmt, setFmt] = useState<ExportFormat>('hex-list');
  const file = useRef<HTMLInputElement>(null);
  const out = useMemo(() => exportPalette(colors, fmt), [colors, fmt]);
  const ext = EXPORT_FORMATS.find((f) => f.id === fmt)!.ext;
  const doImport = (t: string) => {
    const c = parsePalette(t);
    if (!c.length) return ed.toast('No colors found in that text.', 'error');
    onColors(c);
    setText('');
    ed.toast(`Imported ${c.length} colors`, 'ok');
  };
  return (
    <div className="rs-ps__grid2">
      <div className="rs-ps__card">
        <div className="rs-caps">Import</div>
        <textarea className="rs-input rs-mono" rows={6} value={text} spellCheck={false} placeholder="Paste hex codes, a Lospec list, or the contents of a .gpl / .pal file" onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setText(e.target.value)} />
        <div className="rs-ps__row">
          <button className="rs-btn rs-btn--primary" disabled={!text.trim()} onClick={() => doImport(text)}>Import pasted text</button>
          <button className="rs-btn" onClick={() => file.current?.click()}><Icon name="open" /> Open file…</button>
        </div>
        <input ref={file} type="file" hidden accept=".hex,.gpl,.pal,.txt,.csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) doImport(await f.text()); e.target.value = ''; }} />
      </div>
      <div className="rs-ps__card">
        <div className="rs-caps">Export</div>
        <SelectField large value={fmt} onChange={(v) => setFmt(v as ExportFormat)} options={EXPORT_FORMATS.map((f) => ({ value: f.id, label: f.label }))} />
        <textarea className="rs-input rs-mono" rows={4} readOnly value={out} />
        <div className="rs-ps__row">
          <button className="rs-btn" onClick={() => navigator.clipboard.writeText(out).then(() => ed.toast('Copied', 'ok'), () => ed.toast('Clipboard unavailable', 'error'))}>Copy</button>
          <button className="rs-btn" onClick={() => download(`palette.${ext}`, out)}>Download .{ext}</button>
          <button className="rs-btn" onClick={async () => { const b = await swatchStripBlob(colors); if (b) download('palette.png', b); }}>PNG strip</button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- Library -------------------------------- */

function Library({ colors, onColors }: { colors: RGB[]; onColors: (c: RGB[]) => void }) {
  const { ed } = useApp();
  const [saved, setSaved] = useState<SavedPalette[]>(loadSaved);
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const upd = (l: SavedPalette[]) => { setSaved(l); storeSaved(l); };
  const toRgb = (hex: string[]) => hex.map((h) => parseHex(h)?.rgb).filter((c): c is RGB => !!c);
  const match = (n: string) => n.toLowerCase().includes(q.toLowerCase());
  const row = (id: string, nm: string, hex: string[], del?: boolean) => (
    <div key={id} className="rs-ps__lib">
      <button className="rs-ps__libmain" onClick={() => onColors(toRgb(hex))} title="Load this palette">
        <span className="rs-ps__libname">{nm} <span className="rs-ps__hint">{hex.length}</span></span>
        <span className="rs-ps__libstrip">{hex.slice(0, 32).map((h, i) => <span key={i} style={{ background: h }} />)}</span>
      </button>
      {del && <button className="rs-btn rs-btn--icon rs-btn--ghost rs-btn--danger" title="Delete" onClick={() => upd(saved.filter((s) => s.id !== id))}><Icon name="trash" /></button>}
    </div>
  );
  return (
    <div className="rs-ps__card">
      <div className="rs-ps__row">
        <input className="rs-input" style={{ flex: 1 }} placeholder="Name to save the current palette as…" value={name} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setName(e.target.value)} />
        <button className="rs-btn rs-btn--primary" disabled={!name.trim()} onClick={() => { upd([{ id: `p${Date.now().toString(36)}`, name: name.trim(), colors: colors.map((c) => toHex(c)) }, ...saved]); setName(''); ed.toast('Saved to your library', 'ok'); }}>Save</button>
      </div>
      <input className="rs-input" placeholder="Search palettes…" value={q} onKeyDown={(e) => e.stopPropagation()} onChange={(e) => setQ(e.target.value)} />
      <div className="rs-ps__liblist">
        {saved.filter((s) => match(s.name)).length > 0 && <div className="rs-caps">Yours</div>}
        {saved.filter((s) => match(s.name)).map((s) => row(s.id, s.name, s.colors, true))}
        <div className="rs-caps">Built-in</div>
        {BUILTIN_PALETTES.filter((p) => match(p.name)).map((p) => row(p.id, p.name, p.colors))}
      </div>
    </div>
  );
}
