import { useRef, useState } from 'react';
import type { AssetsParam } from '../../engine/types';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { ACCEPT_ATTR, Thumb, fileMatches } from '../components/Thumb';
import { Popover } from '../components/fields';
import { ColorPopover } from '../components/ColorPicker';
import { hexOf, rgbOf } from '../lib/drag';
import { useAssets, useEditor, useIo } from '../store/context';

type RGB = [number, number, number];

/* ----------------------------- Palette editor ----------------------------- */

const lum = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function hslToRgb(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

export function parseHexList(text: string): RGB[] {
  const out: RGB[] = [];
  for (const m of text.matchAll(/#?\b([0-9a-f]{6})\b/gi)) {
    const rgb = rgbOf(m[1]);
    if (rgb) out.push(rgb);
  }
  return out;
}

export function PaletteEditor({ value, onChange, onStudio }: { value: RGB[]; onChange: (v: RGB[]) => void; onStudio?: () => void }) {
  const editBtn = useRef<HTMLButtonElement>(null);
  const [picking, setPicking] = useState(false);
  const colors = Array.isArray(value) ? value : [];
  const [sel, setSel] = useState(0);
  const [paste, setPaste] = useState('');
  const [steps, setSteps] = useState(8);
  const dragFrom = useRef<number | null>(null);
  const cur = colors[Math.min(sel, colors.length - 1)];
  const idx = Math.min(sel, colors.length - 1);

  const update = (i: number, c: RGB) => onChange(colors.map((x, j) => (j === i ? c : x)));
  const move = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || to >= colors.length) return;
    const next = [...colors];
    const [c] = next.splice(from, 1);
    next.splice(to, 0, c);
    onChange(next);
    setSel(to);
  };
  const gradient = () => {
    if (colors.length < 2) return;
    const a = colors[0];
    const b = colors[colors.length - 1];
    onChange(Array.from({ length: steps }, (_, i) => [0, 1, 2].map((k) => a[k] + ((b[k] - a[k]) * i) / Math.max(1, steps - 1)) as RGB));
  };
  const greys = () => onChange(Array.from({ length: steps }, (_, i) => [i / Math.max(1, steps - 1), i / Math.max(1, steps - 1), i / Math.max(1, steps - 1)] as RGB));
  const harmony = () => {
    const h = Math.random();
    onChange(Array.from({ length: steps }, (_, i) => hslToRgb((h + (i % 3) * 0.08 + i * 0.02) % 1, 0.45 + 0.4 * ((i * 37) % 10) / 10, 0.15 + (0.7 * i) / Math.max(1, steps - 1))));
  };

  return (
    <div className="rs-pal">
      <div className="rs-pal__grid">
        {colors.map((c, i) => (
          <button
            key={i}
            className={`rs-pal__sw${i === idx ? ' is-sel' : ''}`}
            style={{ background: hexOf(c) }}
            title={hexOf(c).toUpperCase()}
            draggable
            onDragStart={() => (dragFrom.current = i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => dragFrom.current !== null && move(dragFrom.current, i)}
            onClick={() => setSel(i)}
          />
        ))}
        <button className="rs-pal__sw rs-pal__add" title="Add colour" onClick={() => { onChange([...colors, cur ? [...cur] as RGB : [0.5, 0.5, 0.5]]); setSel(colors.length); }}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      {cur && (
        <div className="rs-pal__edit">
          <button ref={editBtn} className="rs-pal__cur" style={{ background: hexOf(cur) }} title="Edit this colour" aria-label="Edit colour" onClick={() => setPicking((p) => !p)} />
          {picking && <ColorPopover anchor={editBtn.current} alpha={false} extra={colors} value={[cur[0], cur[1], cur[2], 1]} onChange={(v) => update(idx, [v[0], v[1], v[2]])} onClose={() => setPicking(false)} />}
          <input
            className="rs-input rs-mono"
            style={{ width: 84 }}
            defaultValue={hexOf(cur)}
            key={hexOf(cur) + idx}
            spellCheck={false}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => { const rgb = rgbOf(e.target.value); if (rgb) update(idx, rgb); }}
          />
          <button className="rs-btn rs-btn--icon rs-btn--ghost" title="Move left" onClick={() => move(idx, idx - 1)}><Icon name="chevronLeft" /></button>
          <button className="rs-btn rs-btn--icon rs-btn--ghost" title="Move right" onClick={() => move(idx, idx + 1)}><Icon name="chevronRight" /></button>
          <button className="rs-btn rs-btn--icon rs-btn--ghost rs-btn--danger" title="Remove colour" onClick={() => { onChange(colors.filter((_, j) => j !== idx)); setSel(Math.max(0, idx - 1)); }}><Icon name="trash" /></button>
        </div>
      )}
      <div className="rs-pal__tools">
        <NumberField label="Steps" value={steps} min={2} max={64} integer defaultValue={8} onChange={setSteps} />
        <div className="rs-pal__btns">
          <button className="rs-btn" onClick={gradient} disabled={colors.length < 2} title="Fill with a gradient between the first and last colour">Gradient</button>
          <button className="rs-btn" onClick={greys} title="Greyscale ramp">Greys</button>
          <button className="rs-btn" onClick={harmony} title="Random harmonious ramp">Random</button>
          <button className="rs-btn" onClick={() => onChange([...colors].sort((a, b) => lum(a) - lum(b)))} title="Sort dark to light">Sort</button>
          <button className="rs-btn" onClick={() => onChange([...colors].reverse())} title="Reverse order">Reverse</button>
        </div>
      </div>
      <textarea
        className="rs-input rs-mono"
        rows={2}
        placeholder="Paste hex colours (#1a1c2c #5d275d …) to import"
        value={paste}
        spellCheck={false}
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => setPaste(e.target.value)}
      />
      {paste.trim() && (
        <div className="rs-pal__btns">
          <button className="rs-btn rs-btn--primary" onClick={() => { const l = parseHexList(paste); if (l.length) { onChange(l); setPaste(''); } }}>Replace with {parseHexList(paste).length}</button>
          <button className="rs-btn" onClick={() => { const l = parseHexList(paste); if (l.length) { onChange([...colors, ...l]); setPaste(''); } }}>Append</button>
        </div>
      )}
      <div className="rs-pal__count rs-caps">{colors.length} colours</div>
      {onStudio && <button className="rs-btn rs-btn--primary" onClick={onStudio}>Edit in Palette Studio</button>}
    </div>
  );
}

/* ------------------------------ Assets editor ----------------------------- */

export function AssetsEditor({ value, accept, onChange }: { value: string[]; accept: AssetsParam['accept']; onChange: (v: string[]) => void }) {
  const io = useIo();
  const ed = useEditor();
  const assets = useAssets();
  const ids = Array.isArray(value) ? value : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const fileIn = useRef<HTMLInputElement>(null);
  const dirIn = useRef<HTMLInputElement>(null);
  const libBtn = useRef<HTMLButtonElement>(null);
  const [libOpen, setLibOpen] = useState(false);
  const dragFrom = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);

  const addFiles = async (list: FileList | File[] | null) => {
    if (!list) return;
    const files = Array.from(list).filter((f) => fileMatches(f, accept));
    if (!files.length) {
      ed.toast('No matching files for this node.', 'error');
      return;
    }
    setBusy(true);
    try {
      const infos = await io.library.add(files);
      onChange([...ids, ...infos.map((i) => i.id)]);
    } catch (err) {
      ed.toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...ids];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x);
    onChange(next);
  };
  const candidates = assets.filter((a) => (accept === 'any' ? true : accept === 'image-video' ? a.kind === 'image' || a.kind === 'video' : a.kind === accept));

  return (
    <div
      className="rs-assets"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); void addFiles(e.dataTransfer.files); } }}
    >
      <div className="rs-assets__bar">
        <button className="rs-btn" onClick={() => fileIn.current?.click()} disabled={busy}><Icon name="plus" /> Files</button>
        <button className="rs-btn" onClick={() => dirIn.current?.click()} disabled={busy}><Icon name="folder" /> Folder</button>
        <button ref={libBtn} className="rs-btn" onClick={() => setLibOpen((o) => !o)} disabled={!candidates.length} title="Pick from the media library">Library</button>
        {ids.length > 0 && <button className="rs-btn rs-btn--ghost rs-btn--danger" onClick={() => onChange([])} title="Remove all">Clear</button>}
      </div>
      <input ref={fileIn} type="file" hidden multiple accept={ACCEPT_ATTR[accept]} onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
      <input
        ref={dirIn}
        type="file"
        hidden
        multiple
        {...({ webkitdirectory: '' } as Record<string, string>)}
        onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }}
      />
      {ids.length === 0 ? (
        <div className="rs-assets__empty">{busy ? 'Importing…' : 'Drop files here, or use the buttons. Several files make a batch: the graph runs once per file.'}</div>
      ) : (
        <>
          <div className="rs-assets__grid">
            {ids.map((id, i) => (
              <div
                key={`${id}:${i}`}
                className="rs-assets__cell"
                draggable
                onDragStart={() => (dragFrom.current = i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.stopPropagation(); if (dragFrom.current !== null) move(dragFrom.current, i); dragFrom.current = null; }}
              >
                <Thumb asset={byId.get(id)} size={64} />
                <span className="rs-assets__idx rs-num">{i + 1}</span>
                <button className="rs-assets__x" title="Remove" onClick={() => onChange(ids.filter((_, j) => j !== i))}><Icon name="close" size={12} /></button>
              </div>
            ))}
          </div>
          <div className="rs-assets__count rs-caps">{ids.length} file{ids.length > 1 ? 's' : ''}{ids.length > 1 ? ' · batch' : ''} · drag to reorder</div>
        </>
      )}
      {libOpen && (
        <Popover anchor={libBtn.current} onClose={() => setLibOpen(false)} width={260}>
          <div className="rs-assets__lib">
            {candidates.map((a) => (
              <button key={a.id} className="rs-assets__libitem" title={a.name} onClick={() => onChange([...ids, a.id])}>
                <Thumb asset={a} size={48} />
              </button>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}

/* ------------------------------- JSON (read-only) ------------------------- */

export function JsonEditor({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const text = (() => {
    try {
      return JSON.stringify(value, null, 1) ?? 'null';
    } catch {
      return String(value);
    }
  })();
  const count = Array.isArray(value) ? value.length : null;
  return (
    <div className="rs-json">
      {count !== null && (
        <div className="rs-json__row">
          <span className="rs-num">{count} item{count === 1 ? '' : 's'}</span>
          <button className="rs-btn rs-btn--ghost rs-btn--danger" disabled={count === 0} onClick={() => onChange([])}>Clear</button>
        </div>
      )}
      <pre className="rs-json__pre rs-mono">{text.length > 700 ? text.slice(0, 700) + '\n…' : text}</pre>
    </div>
  );
}
