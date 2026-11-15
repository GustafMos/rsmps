import { useRef, useState } from 'react';
import type { ScanCorners, ScanManualInput, ScanPageReport, ScanResult } from '../../io/api';
import { NumberField } from '../components/NumberField';
import { CheckField, SelectField } from '../components/fields';
import { useApp } from '../store/context';

const PAPERS = [
  { value: 'a4', label: 'A4' },
  { value: 'a3', label: 'A3' },
  { value: 'a5', label: 'A5' },
  { value: 'letter', label: 'US Letter' },
  { value: 'legal', label: 'US Legal' },
];

type Key = keyof ScanCorners;
const KEYS: Key[] = ['tl', 'tr', 'br', 'bl'];
const LABEL: Record<Key, string> = { tl: 'TL', tr: 'TR', br: 'BR', bl: 'BL' };

const STATUS_TEXT = { ok: 'Aligned', warning: 'Usable, with warnings', failed: 'Could not be read' } as const;

/** Plain-words version of what went wrong or is worth knowing. */
function describe(p: ScanPageReport): string[] {
  const out = [...p.warnings];
  if (p.status === 'failed' && !p.warnings.length) out.push('The four corner markers were not all found. Drag the corners by hand below.');
  if (p.marksExpected > 0 && p.marksFound < p.marksExpected) out.push(`${p.marksExpected - p.marksFound} of ${p.marksExpected} "+" marks were not found; their positions were estimated from the neighbours.`);
  if (!p.used) out.push('This photo is not used: it duplicates a better photo of the same page or belongs to another printed set.');
  return out;
}

export function PageCard({ page, result, onResult, onManual }: { page: ScanPageReport; result: ScanResult; onResult: (r: ScanResult) => void; onManual?: (pageIndex: number, input: ScanManualInput) => void }) {
  const [fixing, setFixing] = useState(page.status === 'failed');
  const img = page.photoUrl ?? page.thumbnailUrl;
  const s = page.photoScale || 1;
  const w = page.photoWidth * s;
  const h = page.photoHeight * s;
  const l = page.layout;
  const lines = describe(page);
  const poly = page.corners ? KEYS.map((k) => `${page.corners![k].x * s},${page.corners![k].y * s}`).join(' ') : null;

  return (
    <article className={`rs-sc__page is-${page.status}`}>
      <div className="rs-sc__photo">
        {img ? (
          <svg viewBox={`0 0 ${w} ${h}`} className="rs-sc__svg">
            <image href={img} width={w} height={h} />
            {poly && <polygon points={poly} className="rs-sc__poly" />}
            {page.corners && KEYS.map((k) => <circle key={k} cx={page.corners![k].x * s} cy={page.corners![k].y * s} r={Math.max(5, w / 90)} className="rs-sc__corner" />)}
            {!page.corners && page.foundCorners.map((c, i) => <circle key={i} cx={c.x * s} cy={c.y * s} r={Math.max(5, w / 90)} className="rs-sc__found" />)}
          </svg>
        ) : (
          <div className="rs-empty">No preview</div>
        )}
      </div>
      <div className="rs-sc__info">
        <div className="rs-sc__head">
          <strong title={page.fileName}>{page.fileName}</strong>
          <span className={`rs-sc__chip is-${page.status}`}>{STATUS_TEXT[page.status]}</span>
        </div>
        <div className="rs-sc__meta rs-num">
          {l ? (
            <>
              Page {l.pageIndex + 1} of {l.pageCount} · frames {(page.frameRange?.[0] ?? l.firstFrame) + 1}–{(page.frameRange?.[1] ?? l.firstFrame + l.framesOnPage - 1) + 1} · {l.fps} fps · {l.columns}×{l.rows} on {l.paper.toUpperCase()}
              {page.layoutSource === 'manual' ? ' (layout entered by hand)' : ''}
            </>
          ) : (
            'Layout not decoded'
          )}
        </div>
        <div className="rs-sc__meta rs-num">
          Marks {page.marksFound}/{page.marksExpected}
          {page.skewDeg ? ` · tilt ${page.skewDeg.toFixed(1)}°` : ''}
          {page.cornersSource === 'manual' ? ' · corners set by hand' : ''}
        </div>
        {lines.length > 0 && (
          <ul className="rs-sc__warn">
            {lines.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        )}
        <button className="rs-btn" onClick={() => setFixing((f) => !f)}>{fixing ? 'Hide manual fix' : page.status === 'ok' ? 'Adjust by hand' : 'Fix by hand'}</button>
        {fixing && <ManualFix page={page} result={result} onResult={onResult} onManual={onManual} />}
      </div>
    </article>
  );
}

function ManualFix({ page, result, onResult, onManual }: { page: ScanPageReport; result: ScanResult; onResult: (r: ScanResult) => void; onManual?: (pageIndex: number, input: ScanManualInput) => void }) {
  const { ed } = useApp();
  const s = page.photoScale || 1;
  const w = page.photoWidth * s;
  const h = page.photoHeight * s;
  const [corners, setCorners] = useState<ScanCorners>(() => {
    if (page.corners) return { tl: { ...page.corners.tl }, tr: { ...page.corners.tr }, br: { ...page.corners.br }, bl: { ...page.corners.bl } };
    const pw = page.photoWidth;
    const ph = page.photoHeight;
    return { tl: { x: pw * 0.12, y: ph * 0.12 }, tr: { x: pw * 0.88, y: ph * 0.12 }, br: { x: pw * 0.88, y: ph * 0.88 }, bl: { x: pw * 0.12, y: ph * 0.88 } };
  });
  const [useCorners, setUseCorners] = useState(true);
  const [useLayout, setUseLayout] = useState(!page.layout);
  const L = page.layout;
  const [paper, setPaper] = useState<string>(L?.paper ?? 'a4');
  const [landscape, setLandscape] = useState(L?.landscape ?? false);
  const [columns, setColumns] = useState(L?.columns ?? 3);
  const [rows, setRows] = useState(L?.rows ?? 4);
  const [pageIndex, setPageIndex] = useState((L?.pageIndex ?? page.index) + 1);
  const [fps, setFps] = useState(L?.fps ?? 12);
  const [busy, setBusy] = useState(false);
  const svg = useRef<SVGSVGElement>(null);

  const drag = (k: Key, e: React.PointerEvent) => {
    e.preventDefault();
    const el = svg.current!;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = Math.min(page.photoWidth, Math.max(0, ((ev.clientX - r.left) / r.width) * page.photoWidth));
      const y = Math.min(page.photoHeight, Math.max(0, ((ev.clientY - r.top) / r.height) * page.photoHeight));
      setCorners((c) => ({ ...c, [k]: { x, y } }));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const apply = async () => {
    setBusy(true);
    const manual: ScanManualInput = { pageIndex: pageIndex - 1, fps };
    if (useCorners) manual.corners = corners;
    if (useLayout) manual.layout = { paper: paper as 'a4', landscape, columns, rows };
    try {
      onResult(await result.reanalyzePage(page.index, manual));
      onManual?.(page.index, manual);
    } catch (err) {
      ed.toast(`Could not re-analyse: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const img = page.photoUrl ?? page.thumbnailUrl;
  return (
    <div className="rs-sc__fix">
      <p className="rs-insp__hint">
        Drag the four handles onto the square corner markers of the printed page. <b>TL</b> is the marker with a small notch in its white ring (the page&apos;s top-left, even when the photo is rotated), then clockwise.
      </p>
      {img && (
        <svg ref={svg} viewBox={`0 0 ${w} ${h}`} className="rs-sc__svg rs-sc__svg--fix">
          <image href={img} width={w} height={h} />
          <polygon points={KEYS.map((k) => `${corners[k].x * s},${corners[k].y * s}`).join(' ')} className="rs-sc__poly" />
          {KEYS.map((k) => (
            <g key={k} className="rs-sc__handle" transform={`translate(${corners[k].x * s} ${corners[k].y * s})`} onPointerDown={(e) => drag(k, e)}>
              <circle r={Math.max(10, w / 45)} />
              <text y={Math.max(4, w / 120)} textAnchor="middle" fontSize={Math.max(11, w / 55)}>{LABEL[k]}</text>
            </g>
          ))}
        </svg>
      )}
      <CheckField value={useCorners} onChange={setUseCorners} label="Use these corners" />
      <CheckField value={useLayout} onChange={setUseLayout} label="Use this layout (when the data strip cannot be read)" />
      {useLayout && (
        <div className="rs-sc__layout">
          <SelectField value={paper} options={PAPERS} onChange={setPaper} label="Paper" />
          <CheckField value={landscape} onChange={setLandscape} label="Landscape" />
          <NumberField label="Columns" integer min={1} max={63} value={columns} defaultValue={3} onChange={setColumns} />
          <NumberField label="Rows" integer min={1} max={63} value={rows} defaultValue={4} onChange={setRows} />
        </div>
      )}
      <div className="rs-sc__layout">
        <NumberField label="Page number" integer min={1} max={999} value={pageIndex} defaultValue={1} onChange={setPageIndex} />
        <NumberField label="Frame rate" integer min={1} max={120} value={fps} defaultValue={12} onChange={setFps} />
      </div>
      <button className="rs-btn rs-btn--primary" onClick={apply} disabled={busy || (!useCorners && !useLayout)}>{busy ? 'Working…' : 'Re-analyse this page'}</button>
    </div>
  );
}
