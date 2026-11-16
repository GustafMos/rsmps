import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetInfo } from '../../engine/types';
import type { ScanPoint, TexturePreview } from '../../io/api';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { CheckField, TextField } from '../components/fields';
import { useApp } from '../store/context';

type Quad = [ScanPoint, ScanPoint, ScanPoint, ScanPoint];
const INSET = 0.08;

/**
 * "Scan a texture": no markers needed. Choose a photo of paper, tape, scribbles..., drag the four corners over the part to keep,
 * optionally make it seamless, and save it to the Textures shelf (an ordinary persisted media-library group). The Paper / Texture
 * Overlay node picks it from the library.
 */
export function TextureScan({ onClose }: { onClose: () => void }) {
  const { io, ed } = useApp();
  const fileIn = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null); // normalised 0..1 in the photo
  const [seamless, setSeamless] = useState(false);
  const [strength, setStrength] = useState(1);
  const [name, setName] = useState('Paper texture');
  const [preview, setPreview] = useState<TexturePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [shelf, setShelf] = useState<AssetInfo[]>(() => io.library.textures());
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);

  useEffect(() => io.library.subscribe(() => setShelf(io.library.textures())), [io]);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);
  useEffect(() => () => preview?.dispose(), [preview]);

  const choose = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setSrc((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(f); });
    setQuad([{ x: INSET, y: INSET }, { x: 1 - INSET, y: INSET }, { x: 1 - INSET, y: 1 - INSET }, { x: INSET, y: 1 - INSET }]);
    setPreview(null);
    setName(f.name.replace(/\.[^.]+$/, '') || 'Texture');
  };

  const move = useCallback((e: React.PointerEvent) => {
    if (drag.current === null || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setQuad((q) => (q ? (q.map((p, i) => (i === drag.current ? { x, y } : p)) as Quad) : q));
  }, []);

  const make = async () => {
    if (!file || !quad || !size) return;
    setBusy(true);
    try {
      const px = quad.map((p) => ({ x: p.x * size.w, y: p.y * size.h })) as Quad;
      const p = await io.scan.makeTexture(file, { quad: px, seamless, seamlessStrength: strength });
      setPreview(p);
    } catch (err) {
      ed.toast(`Could not make the texture: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const info = await io.library.addTexture(name.trim() || 'Texture', preview.blob);
      ed.toast(`"${info.name}" is on your Textures shelf. Pick it in a Paper / Texture Overlay node.`, 'ok');
    } catch (err) {
      ed.toast(`Could not save the texture: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rs-sc__frames">
      <div className="rs-sc__bar">
        <div>
          <h2>Scan a texture</h2>
          <p>Photograph paper, tape, pencil scribbles… no markers needed. Crop it straight, optionally make it tile, keep it on your Textures shelf.</p>
        </div>
        <span className="rs-sc__spacer" />
        <button className="rs-btn" onClick={() => fileIn.current?.click()}><Icon name="plus" /> {file ? 'Another photo…' : 'Choose a photo…'}</button>
        <button className="rs-btn rs-btn--ghost" onClick={onClose}>Back</button>
        <input ref={fileIn} type="file" hidden accept="image/*" onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
      </div>

      {src && quad && (
        <div
          ref={box}
          style={{ position: 'relative', maxWidth: 560, touchAction: 'none', userSelect: 'none' }}
          onPointerMove={move}
          onPointerUp={() => { drag.current = null; }}
          onPointerLeave={() => { drag.current = null; }}
        >
          <img src={src} alt="Photo to crop" style={{ width: '100%', display: 'block' }} draggable={false} onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          <svg viewBox="0 0 1 1" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
            <polygon points={quad.map((p) => `${p.x},${p.y}`).join(' ')} fill="#4f66f222" stroke="var(--select)" strokeWidth={0.004} vectorEffect="non-scaling-stroke" />
          </svg>
          {quad.map((p, i) => (
            <div
              key={i}
              role="slider"
              aria-label={['Top left', 'Top right', 'Bottom right', 'Bottom left'][i] + ' corner'}
              onPointerDown={(e) => { drag.current = i; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
              style={{ position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: 18, height: 18, marginLeft: -9, marginTop: -9, borderRadius: 9, background: '#ffd24acc', border: '2px solid #000', cursor: 'grab' }}
            />
          ))}
        </div>
      )}

      {file && (
        <div className="rs-sc__opts">
          <CheckField value={seamless} onChange={setSeamless} label="Make seamless (tiles without a visible seam)" />
          {seamless && <NumberField large label="Blend reach" min={0.1} max={1} step={0.05} value={strength} defaultValue={1} onChange={setStrength} />}
          <button className="rs-btn" onClick={() => void make()} disabled={busy}>{busy ? 'Working…' : 'Crop and preview'}</button>
        </div>
      )}

      {preview && (
        <div className="rs-sc__opts" style={{ alignItems: 'flex-start' }}>
          <div style={{ width: 280, border: '1px solid var(--line-strong)', backgroundImage: `url(${preview.url})`, backgroundSize: '50%', aspectRatio: '1' }} title={`${preview.width}×${preview.height}px, shown tiled 2×2`} />
          <div className="rs-sc__info">
            <span className="rs-sc__meta">{preview.width}×{preview.height}px (shown tiled so you can check the seams)</span>
            <TextField large value={name} onChange={setName} placeholder="Name on the Textures shelf" />
            <button className="rs-btn rs-btn--primary" onClick={() => void save()} disabled={busy}>Save to Textures shelf</button>
          </div>
        </div>
      )}

      <div className="rs-caps">Textures shelf</div>
      {shelf.length === 0 ? (
        <div className="rs-empty" style={{ border: '1px dashed var(--line-strong)' }}>Your shelf is empty. Nothing is bundled: scan a piece of paper, tape or scribbles above and it will appear here. Use it in a Paper / Texture Overlay node.</div>
      ) : (
        <div className="rs-sc__strip">{shelf.map((t) => <ShelfThumb key={t.id} asset={t} onRemove={() => void io.library.remove(t.id)} />)}</div>
      )}
    </section>
  );
}

function ShelfThumb({ asset, onRemove }: { asset: AssetInfo; onRemove: () => void }) {
  const { io } = useApp();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { let live = true; void io.library.thumbnail(asset.id).then((u) => live && setUrl(u)); return () => { live = false; }; }, [io, asset.id]);
  return (
    <div title={`${asset.name} (${asset.width}×${asset.height}) - click to remove`} onClick={() => { if (window.confirm(`Remove "${asset.name}" from your Textures shelf?`)) onRemove(); }} style={{ cursor: 'pointer' }}>
      {url ? <img src={url} alt={asset.name} draggable={false} /> : <div className="rs-sc__gap">{asset.name}</div>}
    </div>
  );
}
