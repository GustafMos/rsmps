import { useEffect, useRef, useState } from 'react';
import type { CurveValue } from '../../engine/types';
import { normalizeCurve, sampleCurve, curveBounds } from '../../engine/lib/util-curve';
import { useApp, useEd } from '../store/context';
import { CurveEditor } from './CurveEditor';
import './curve.css';

/** Compact live thumbnail of a `curve` param; click opens the full editor. */
export function CurveField({ nodeId, keyName, label, value, min, max, large }: { nodeId: string; keyName: string; label: string; value: unknown; min?: number; max?: number; large?: boolean }) {
  const { ed } = useApp();
  const loop = useEd((s) => s.graph.project.loop);
  const [open, setOpen] = useState(false);
  const cv = useRef<HTMLCanvasElement>(null);
  const curve = normalizeCurve(value as CurveValue);

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(2, Math.round(r.width * dpr));
    c.height = Math.max(2, Math.round(r.height * dpr));
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const b = curveBounds(curve, { loop });
    const y0 = Math.min(b.vMin, min ?? b.vMin);
    let y1 = Math.max(b.vMax, max ?? b.vMax);
    if (y1 - y0 < 1e-6) y1 = y0 + 1;
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.strokeStyle = '#ffd24a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    sampleCurve(curve, 64, { loop }).forEach(([t, v], i) => {
      const x = 2 + t * (r.width - 4);
      const y = r.height - 2 - ((v - y0) / (y1 - y0)) * (r.height - 4);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }, [curve, loop, min, max]);

  return (
    <>
      <button className={`rs-curve${large ? ' rs-curve--lg' : ''}`} data-nodrag onClick={() => setOpen((o) => !o)} title="Edit the curve (keyframes and splines)">
        <canvas ref={cv} />
        <span>{curve.keys.length} {curve.keys.length === 1 ? 'key' : 'keys'}</span>
      </button>
      {open && <CurveEditor title={label} curve={curve} min={min} max={max} onChange={(c) => ed.setParam(nodeId, keyName, c)} onClose={() => setOpen(false)} />}
    </>
  );
}
