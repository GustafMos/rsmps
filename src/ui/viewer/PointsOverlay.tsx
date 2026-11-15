import { useEffect, useRef, useState, type RefObject } from 'react';
import { useApp, useEd } from '../store/context';

type Pt = [number, number];

function valid(raw: unknown): Pt[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is Pt => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]]);
}

/** Catmull-Rom through the points (closed paths wrap): the same shape the node travels along. */
function splinePath(pts: Pt[], closed: boolean, W: number, H: number): string {
  const n = pts.length;
  if (n < 2) return '';
  const segs = closed ? n : n - 1;
  const at = (k: number): Pt => {
    if (closed) return pts[((k % n) + n) % n];
    if (k < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (k >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    return pts[k];
  };
  const cr = (a: number, b: number, c: number, d: number, s: number) => 0.5 * (2 * b + (-a + c) * s + (2 * a - 5 * b + 4 * c - d) * s * s + (-a + 3 * b - 3 * c + d) * s * s * s);
  let d = '';
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j <= 12; j++) {
      const s = j / 12;
      const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
      const x = cr(p0[0], p1[0], p2[0], p3[0], s) * W;
      const y = cr(p0[1], p1[1], p2[1], p3[1], s) * H;
      d += `${d ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }
  }
  return d;
}

/**
 * Point editor for any node with a `points` json param (a list of [x, y] in 0..1 frame coordinates) and a `closed`
 * bool, detected by shape. Drag points, click to add, Delete removes the selected point.
 */
export function PointsOverlay({ nodeId, stage }: { nodeId: string; stage: RefObject<HTMLDivElement | null> }) {
  const { ed } = useApp();
  const raw = useEd((s) => s.graph.nodes.find((n) => n.id === nodeId)?.params.points);
  const closed = useEd((s) => !!s.graph.nodes.find((n) => n.id === nodeId)?.params.closed);
  const pts = valid(raw);
  const ptsRef = useRef(pts);
  ptsRef.current = pts;
  const [rect, setRect] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const read = () => {
      const r = stage.current?.getBoundingClientRect();
      const o = root.current?.parentElement?.getBoundingClientRect();
      if (!r || !o) return;
      setRect((cur) => (cur && Math.abs(cur.l - (r.left - o.left)) < 0.5 && Math.abs(cur.t - (r.top - o.top)) < 0.5 && Math.abs(cur.w - r.width) < 0.5 && Math.abs(cur.h - r.height) < 0.5 ? cur : { l: r.left - o.left, t: r.top - o.top, w: r.width, h: r.height }));
    };
    read();
    const id = setInterval(read, 120);
    return () => clearInterval(id);
  }, [stage]);

  const write = (next: Pt[]) => ed.setParam(nodeId, 'points', next.map((p) => [Number(p[0].toFixed(4)), Number(p[1].toFixed(4))]));

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel !== null && ptsRef.current.length > 1) {
        e.preventDefault();
        e.stopImmediatePropagation();
        write(ptsRef.current.filter((_, i) => i !== sel));
        setSel(null);
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, nodeId]);

  if (!rect) return <div ref={root} className="rs-pts" />;
  const norm = (cx: number, cy: number): Pt => {
    const r = stage.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (cx - r.left) / r.width)), Math.min(1, Math.max(0, (cy - r.top) / r.height))];
  };
  const drag = (i: number, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setSel(i);
    const el = e.currentTarget as Element;
    el.setPointerCapture(e.pointerId);
    ed.beginHold();
    const mv = (ev: PointerEvent) => write(ptsRef.current.map((p, k) => (k === i ? norm(ev.clientX, ev.clientY) : p)));
    const up = () => {
      el.removeEventListener('pointermove', mv as EventListener);
      el.removeEventListener('pointerup', up);
      ed.endHold();
    };
    el.addEventListener('pointermove', mv as EventListener);
    el.addEventListener('pointerup', up);
  };
  const add = (e: React.PointerEvent) => {
    e.stopPropagation();
    const p = norm(e.clientX, e.clientY);
    // insert after the nearest segment start so the path order stays natural
    let best = ptsRef.current.length - 1;
    let bd = Infinity;
    ptsRef.current.forEach((q, i) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    const next = [...ptsRef.current];
    next.splice(best + 1, 0, p);
    write(next);
    setSel(best + 1);
  };

  return (
    <div ref={root} className="rs-pts">
      <svg className="rs-pts__svg" style={{ left: rect.l, top: rect.t, width: rect.w, height: rect.h }} viewBox={`0 0 ${rect.w} ${rect.h}`}>
        <rect width={rect.w} height={rect.h} fill="transparent" onPointerDown={add} style={{ cursor: 'copy' }} />
        <path d={splinePath(pts, closed, rect.w, rect.h)} fill="none" stroke="#000" strokeWidth={4} opacity={0.6} pointerEvents="none" />
        <path d={splinePath(pts, closed, rect.w, rect.h)} fill="none" stroke="#ffd24a" strokeWidth={2} pointerEvents="none" />
        {pts.map((p, i) => (
          <g key={i} transform={`translate(${p[0] * rect.w} ${p[1] * rect.h})`} onPointerDown={(e) => drag(i, e)} style={{ cursor: 'grab' }}>
            <circle r={9} fill={i === sel ? '#fff' : '#ffd24a'} stroke="#000" strokeWidth={2} />
            <text y={4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#000" pointerEvents="none">{i + 1}</text>
          </g>
        ))}
      </svg>
      <div className="rs-pts__hint rs-viewer__chip">Motion path: click adds a point · drag moves · Del removes</div>
    </div>
  );
}
