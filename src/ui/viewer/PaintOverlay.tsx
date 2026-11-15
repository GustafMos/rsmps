import { useEffect, useRef, useState, type RefObject } from 'react';
import { setParam } from '../../engine/graph';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { trackPointer } from '../lib/drag';
import { useApp } from '../store/context';

/**
 * Brush for the paint-mask node (the one permitted node-specific UI). Strokes are stored as
 * { points: [x, y][] in 0..1 image space, radius: fraction of image width, add: boolean }.
 */
interface Stroke {
  points: [number, number][];
  radius: number;
  add: boolean;
}

export function PaintOverlay({ nodeId, stage }: { nodeId: string; stage: RefObject<HTMLDivElement | null> }) {
  const { ed } = useApp();
  const [radius, setRadius] = useState(0.03);
  const [add, setAdd] = useState(true);
  const cursor = useRef<HTMLDivElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const readStrokes = (): { list: Stroke[]; wrap: boolean } => {
    const node = ed.state.graph.nodes.find((n) => n.id === nodeId);
    const v = node?.params.strokes;
    if (Array.isArray(v)) return { list: v as Stroke[], wrap: false };
    if (v && typeof v === 'object' && Array.isArray((v as { strokes?: unknown }).strokes)) return { list: (v as { strokes: Stroke[] }).strokes, wrap: true };
    return { list: [], wrap: false };
  };
  const write = (list: Stroke[], wrap: boolean) => {
    const node = ed.state.graph.nodes.find((n) => n.id === nodeId);
    const value = wrap ? { ...(node?.params.strokes as object), strokes: list } : list;
    ed.commit(setParam(ed.state.graph, nodeId, 'strokes', value));
  };

  const norm = (cx: number, cy: number): [number, number] | null => {
    const r = stage.current?.getBoundingClientRect();
    if (!r) return null;
    return [(cx - r.left) / r.width, (cy - r.top) / r.height];
  };

  const moveCursor = (e: { clientX: number; clientY: number; altKey?: boolean }) => {
    const r = stage.current?.getBoundingClientRect();
    const c = cursor.current;
    const o = root.current?.getBoundingClientRect();
    if (!r || !c || !o) return;
    const d = radius * 2 * r.width;
    c.style.width = c.style.height = `${d}px`;
    c.style.transform = `translate(${e.clientX - o.left - d / 2}px, ${e.clientY - o.top - d / 2}px)`;
    c.style.display = 'block';
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const erase = e.altKey ? add : !add;
    const stroke: Stroke = { points: [], radius, add: !erase };
    const cv = preview.current;
    const o = root.current?.getBoundingClientRect();
    const sr = stage.current?.getBoundingClientRect();
    if (cv && o) {
      cv.width = o.width;
      cv.height = o.height;
    }
    const push = (cx: number, cy: number) => {
      const p = norm(cx, cy);
      if (!p) return;
      const last = stroke.points[stroke.points.length - 1];
      if (last && Math.hypot(last[0] - p[0], last[1] - p[1]) < radius * 0.25) return;
      stroke.points.push(p);
      const ctx = cv?.getContext('2d');
      if (ctx && o && sr) {
        ctx.clearRect(0, 0, cv!.width, cv!.height);
        ctx.lineCap = ctx.lineJoin = 'round';
        ctx.lineWidth = radius * 2 * sr.width;
        ctx.strokeStyle = stroke.add ? 'rgba(123,141,255,0.55)' : 'rgba(255,92,108,0.55)';
        ctx.beginPath();
        stroke.points.forEach(([x, y], i) => {
          const px = sr.left - o.left + x * sr.width;
          const py = sr.top - o.top + y * sr.height;
          i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        });
        if (stroke.points.length === 1) ctx.lineTo(sr.left - o.left + stroke.points[0][0] * sr.width + 0.01, sr.top - o.top + stroke.points[0][1] * sr.height);
        ctx.stroke();
      }
    };
    push(e.clientX, e.clientY);
    trackPointer(
      e,
      (ev) => {
        push(ev.clientX, ev.clientY);
        moveCursor(ev);
      },
      () => {
        preview.current?.getContext('2d')?.clearRect(0, 0, preview.current.width, preview.current.height);
        if (stroke.points.length) {
          const { list, wrap } = readStrokes();
          write([...list, stroke], wrap);
        }
      },
    );
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || e.ctrlKey || e.metaKey) return;
      if (e.key === '[') setRadius((r) => Math.max(0.004, r * 0.8));
      if (e.key === ']') setRadius((r) => Math.min(0.5, r * 1.25));
      if (e.key === 'x' || e.key === 'X') setAdd((a) => !a);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  return (
    <div
      ref={root}
      className="rs-paint"
      onPointerDown={down}
      onPointerMove={moveCursor}
      onPointerLeave={() => cursor.current && (cursor.current.style.display = 'none')}
    >
      <canvas ref={preview} className="rs-paint__preview" />
      <div ref={cursor} className={`rs-paint__cursor${add ? '' : ' is-erase'}`} />
      <div className="rs-paint__bar rs-viewer__chip" data-nodrag onPointerDown={(e) => e.stopPropagation()}>
        <Icon name="brush" />
        <button className={`rs-btn${add ? ' is-on' : ''}`} onClick={() => setAdd(true)} title="Paint (X toggles)">Paint</button>
        <button className={`rs-btn${!add ? ' is-on' : ''}`} onClick={() => setAdd(false)} title="Erase (X toggles, or hold Alt)">Erase</button>
        <div style={{ width: 150 }}>
          <NumberField label="Size" value={radius} min={0.004} max={0.5} step={0.001} defaultValue={0.03} onChange={setRadius} title="[ and ] change the size" />
        </div>
        <button
          className="rs-btn rs-btn--ghost rs-btn--danger"
          onClick={() => {
            const { wrap } = readStrokes();
            write([], wrap);
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
