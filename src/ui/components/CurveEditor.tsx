import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CurveKey, CurveValue } from '../../engine/types';
import {
  CURVE_PRESETS,
  MIN_KEY_GAP,
  addKey,
  autoTangents,
  curveBounds,
  evalCurve,
  fitToRange,
  moveKey,
  normalizeCurve,
  removeKey,
  reverse,
  sampleCurve,
  scaleTime,
  shiftTime,
  setHandles,
  setInterp,
} from '../../engine/lib/util-curve';
import { Icon } from './Icon';
import { MenuPopup, type MenuItem } from './Menu';
import { NumberField } from './NumberField';
import { useApp, useEd } from '../store/context';
import './curve.css';

type Interp = CurveKey['interp'];
const INTERPS: { id: Interp; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'hold', label: 'Hold' },
  { id: 'smooth', label: 'Smooth' },
  { id: 'bezier', label: 'Bezier' },
];

interface View {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const PAD = { l: 44, r: 12, t: 12, b: 24 };

function fitView(c: CurveValue, loop: boolean, min?: number, max?: number): View {
  const b = curveBounds(c, { loop });
  let y0 = Math.min(b.vMin, min ?? b.vMin);
  let y1 = Math.max(b.vMax, max ?? b.vMax);
  if (y1 - y0 < 1e-6) {
    y0 -= 0.5;
    y1 += 0.5;
  }
  const m = (y1 - y0) * 0.1;
  return { x0: -0.02, x1: 1.02, y0: y0 - m, y1: y1 + m };
}

/** Full curve editor: keys, bezier handles, presets, playhead. Opens as a movable, resizable panel. */
export function CurveEditor({ title, curve, min, max, onChange, onClose }: {
  title: string;
  curve: CurveValue;
  min?: number;
  max?: number;
  onChange: (c: CurveValue) => void;
  onClose: () => void;
}) {
  const { ed, io } = useApp();
  const project = useEd((s) => s.graph.project);
  const loop = project.loop;
  const c = useMemo(() => normalizeCurve(curve), [curve]);
  const [sel, setSel] = useState(0);
  /** Additional selected keys (box select / Shift-click); `sel` is the primary one shown in the numeric fields. */
  const [extra, setExtra] = useState<number[]>([]);
  const [boxRect, setBoxRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [view, setView] = useState<View>(() => fitView(c, loop, min, max));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [ghost, setGhost] = useState<CurveValue | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const latest = useRef(c);
  latest.current = c;
  const viewRef = useRef(view);
  viewRef.current = view;
  const frames = Math.max(1, Math.round(project.duration * project.fps));
  const selIdx = Math.min(sel, c.keys.length - 1);

  /* ------------------------------ coordinate maps ------------------------------ */
  const size = () => {
    const r = cv.current!.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, top: r.top };
  };
  const toPx = (t: number, v: number, s = size(), vw = viewRef.current) => ({
    x: PAD.l + ((t - vw.x0) / (vw.x1 - vw.x0)) * (s.w - PAD.l - PAD.r),
    y: PAD.t + (1 - (v - vw.y0) / (vw.y1 - vw.y0)) * (s.h - PAD.t - PAD.b),
  });
  const fromPx = (x: number, y: number, s = size(), vw = viewRef.current) => ({
    t: vw.x0 + ((x - PAD.l) / (s.w - PAD.l - PAD.r)) * (vw.x1 - vw.x0),
    v: vw.y0 + (1 - (y - PAD.t) / (s.h - PAD.t - PAD.b)) * (vw.y1 - vw.y0),
  });

  /** Handle positions in data space (explicit ones, else the automatic tangents). */
  const handlesOf = (cur: CurveValue, i: number) => {
    const auto = autoTangents(cur, { loop }).keys[i];
    const k = cur.keys[i];
    const inn = k.in ?? auto.in;
    const out = k.out ?? auto.out;
    return {
      inn: inn ? ([k.t + inn[0], k.v + inn[1]] as [number, number]) : null,
      out: out ? ([k.t + out[0], k.v + out[1]] as [number, number]) : null,
    };
  };

  /* ---------------------------------- drawing ---------------------------------- */
  const draw = useCallback(() => {
    const canvas = cv.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const r = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(r.width * dpr) || canvas.height !== Math.round(r.height * dpr)) {
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = { w: r.width, h: r.height, left: r.left, top: r.top };
    const vw = viewRef.current;
    ctx.clearRect(0, 0, s.w, s.h);
    ctx.fillStyle = '#0b0c0e';
    ctx.fillRect(0, 0, s.w, s.h);
    const P = (t: number, v: number) => toPx(t, v, s, vw);
    // grid: time in frames (or seconds), value
    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.lineWidth = 1;
    const tickEvery = frames > 48 ? Math.ceil(frames / 8) : frames > 16 ? 4 : 1;
    for (let f = 0; f <= frames; f += tickEvery) {
      const x = P(f / frames, 0).x;
      ctx.strokeStyle = f % (tickEvery * 4) === 0 ? '#2a2d33' : '#1a1c20';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, PAD.t);
      ctx.lineTo(Math.round(x) + 0.5, s.h - PAD.b);
      ctx.stroke();
      ctx.fillStyle = '#7a808b';
      ctx.fillText(String(f), x - 6, s.h - 8);
    }
    const span = vw.y1 - vw.y0;
    const step = Math.pow(10, Math.floor(Math.log10(span / 4)));
    const vstep = [1, 2, 5, 10].map((m) => m * step).find((v) => span / v <= 8) ?? step * 10;
    for (let v = Math.ceil(vw.y0 / vstep) * vstep; v <= vw.y1; v += vstep) {
      const y = P(0, v).y;
      ctx.strokeStyle = Math.abs(v) < 1e-9 ? '#3d424b' : '#1f2227';
      ctx.beginPath();
      ctx.moveTo(PAD.l, Math.round(y) + 0.5);
      ctx.lineTo(s.w - PAD.r, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = '#7a808b';
      ctx.fillText(String(Number(v.toFixed(3))), 4, y + 4);
    }
    // loop range
    ctx.strokeStyle = '#4f66f2';
    ctx.setLineDash([4, 4]);
    for (const t of [0, 1]) {
      const x = P(t, 0).x;
      ctx.beginPath();
      ctx.moveTo(x, PAD.t);
      ctx.lineTo(x, s.h - PAD.b);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const trace = (cur: CurveValue, color: string, width: number, dashed = false) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dashed ? [5, 4] : []);
      ctx.beginPath();
      const pts = sampleCurve(cur, 300, { loop });
      pts.forEach(([t, v], i) => {
        const p = P(t, v);
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    };
    if (ghost) trace(ghost, '#ffffff30', 1.5);
    trace(c, '#ffd24a', 2);
    if (loop && c.keys.length) {
      // the wrap segment: last key flows into the first
      const a = c.keys[c.keys.length - 1];
      const b = c.keys[0];
      ctx.strokeStyle = '#ffd24a90';
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(P(a.t, a.v).x, P(a.t, a.v).y);
      ctx.lineTo(P(1 + (b.t - 0), b.v).x, P(b.t, b.v).y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // keys and handles
    c.keys.forEach((k, i) => {
      const p = P(k.t, k.v);
      if (i === selIdx) {
        const h = handlesOf(c, i);
        ctx.strokeStyle = '#7b8dff';
        ctx.lineWidth = 1;
        for (const hp of [h.inn, h.out]) {
          if (!hp) continue;
          const q = P(hp[0], hp[1]);
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
          ctx.fillStyle = '#7b8dff';
          ctx.beginPath();
          ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.fillStyle = i === selIdx ? '#ffffff' : extra.includes(i) ? '#9fb0ff' : '#ffd24a';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1.5;
      ctx.fillRect(p.x - 5, p.y - 5, 10, 10);
      ctx.strokeRect(p.x - 5, p.y - 5, 10, 10);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c, view, ghost, selIdx, loop, frames, extra]);

  useLayoutEffect(() => draw(), [draw]);
  useEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [draw]);

  /* ---------------------------- playhead (no React per frame) ---------------------------- */
  useEffect(() => {
    const place = () => {
      const st = io.player.getState();
      const phase = st.totalFrames > 0 ? st.frame / st.totalFrames : 0;
      const el = head.current;
      if (!el || !cv.current) return;
      const x = toPx(phase, 0).x;
      el.style.transform = `translateX(${x}px)`;
    };
    place();
    return io.player.subscribe(place);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [io, view]);

  /* ----------------------------------- editing ----------------------------------- */
  const apply = (next: CurveValue) => onChange(next);
  const snapT = (t: number, snap: boolean) => (snap ? Math.round(t * frames) / frames : t);
  const gridStep = () => {
    const span = viewRef.current.y1 - viewRef.current.y0;
    const st = Math.pow(10, Math.floor(Math.log10(span / 8)));
    return st;
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button === 2) return;
    const s = size();
    const mx = e.clientX - s.left;
    const my = e.clientY - s.top;
    const cur = latest.current;
    // middle button pans
    if (e.button === 1) {
      const v0 = { ...viewRef.current };
      const sx = e.clientX;
      const sy = e.clientY;
      const mv = (ev: PointerEvent) => {
        const dx = ((ev.clientX - sx) / (s.w - PAD.l - PAD.r)) * (v0.x1 - v0.x0);
        const dy = ((ev.clientY - sy) / (s.h - PAD.t - PAD.b)) * (v0.y1 - v0.y0);
        setView({ x0: v0.x0 - dx, x1: v0.x1 - dx, y0: v0.y0 + dy, y1: v0.y1 + dy });
      };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
      return;
    }
    // handle hit
    const hs = handlesOf(cur, selIdx);
    const hitH = (['inn', 'out'] as const).find((w) => {
      const p = hs[w];
      if (!p) return false;
      const q = toPx(p[0], p[1], s);
      return Math.hypot(q.x - mx, q.y - my) <= 7;
    });
    if (hitH) {
      e.currentTarget.setPointerCapture(e.pointerId);
      ed.beginHold();
      setGhost(cur);
      const i = selIdx;
      const mv = (ev: PointerEvent) => {
        const k = latest.current.keys[i];
        const p = fromPx(ev.clientX - s.left, ev.clientY - s.top, s);
        let d: [number, number] = [p.t - k.t, p.v - k.v];
        if (hitH === 'inn') d = [Math.min(0, d[0]), d[1]];
        else d = [Math.max(0, d[0]), d[1]];
        const opposite = hitH === 'inn' ? 'out' : 'in';
        let next = setHandles(latest.current, i, hitH === 'inn' ? { in: d } : { out: d });
        if (!ev.altKey) next = setHandles(next, i, { [opposite]: [-d[0], -d[1]] });
        next = setInterp(next, i, 'bezier');
        apply(next);
      };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); ed.endHold(); setGhost(null); };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
      return;
    }
    // key hit
    const hit = cur.keys.findIndex((k) => {
      const q = toPx(k.t, k.v, s);
      return Math.hypot(q.x - mx, q.y - my) <= 8;
    });
    if (hit >= 0) {
      e.currentTarget.setPointerCapture(e.pointerId);
      let group = [selIdx, ...extra].includes(hit) ? [...new Set([selIdx, ...extra])] : [hit];
      if (e.shiftKey && !group.includes(hit)) group = [...new Set([selIdx, ...extra, hit])];
      setSel(hit);
      setExtra(group.filter((g) => g !== hit));
      ed.beginHold();
      setGhost(cur);
      const start = cur.keys.map((k) => ({ t: k.t, v: k.v }));
      const mv = (ev: PointerEvent) => {
        const p = fromPx(ev.clientX - s.left, ev.clientY - s.top, s);
        const t = snapT(p.t, ev.shiftKey && group.length === 1);
        const v = ev.ctrlKey || ev.metaKey ? Math.round(p.v / gridStep()) * gridStep() : p.v;
        const dt = t - start[hit].t;
        const dv = v - start[hit].v;
        let next = latest.current;
        // move right-most first when going right (and left-most first when going left) so neighbours never block
        const order = [...group].sort((a, b) => (dt > 0 ? b - a : a - b));
        for (const gi of order) next = moveKey(next, gi, start[gi].t + dt, start[gi].v + dv);
        apply(next);
      };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); ed.endHold(); setGhost(null); };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
      return;
    }
    // empty space: a click adds a key there
    const sx = e.clientX;
    const sy = e.clientY;
    const mvBox = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      setBoxRect({ x: Math.min(sx, ev.clientX) - s.left, y: Math.min(sy, ev.clientY) - s.top, w: Math.abs(ev.clientX - sx), h: Math.abs(ev.clientY - sy) });
    };
    window.addEventListener('pointermove', mvBox);
    const upAdd = (ev: PointerEvent) => {
      window.removeEventListener('pointerup', upAdd);
      window.removeEventListener('pointermove', mvBox);
      setBoxRect(null);
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 4) {
        const x0 = Math.min(sx, ev.clientX) - s.left;
        const x1 = Math.max(sx, ev.clientX) - s.left;
        const y0 = Math.min(sy, ev.clientY) - s.top;
        const y1 = Math.max(sy, ev.clientY) - s.top;
        const inside = latest.current.keys.map((k, i) => ({ i, p: toPx(k.t, k.v, s) })).filter(({ p }) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1).map(({ i }) => i);
        if (inside.length) {
          setSel(inside[0]);
          setExtra(inside.slice(1));
        }
        return;
      }
      setExtra([]);
      const p = fromPx(mx, my, s);
      if (p.t < 0 || p.t > 1) return;
      const r = addKey(latest.current, snapT(p.t, ev.shiftKey), p.v, 'smooth', { loop });
      apply(r.curve);
      setSel(r.index);
    };
    window.addEventListener('pointerup', upAdd);
  };

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const s = size();
    const p = fromPx(e.clientX - s.left, e.clientY - s.top, s);
    const k = Math.exp(e.deltaY * 0.0015);
    const v = viewRef.current;
    const zoomX = e.shiftKey || e.ctrlKey;
    setView(zoomX ? { ...v, x0: p.t - (p.t - v.x0) * k, x1: p.t + (v.x1 - p.t) * k } : { ...v, y0: p.v - (p.v - v.y0) * k, y1: p.v + (v.y1 - p.v) * k });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const el = cv.current!;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  /** Remove every selected key (highest index first so indices stay valid). */
  const removeSelected = () => {
    let next = latest.current;
    for (const i of [...new Set([selIdx, ...extra])].sort((a, b) => b - a)) next = removeKey(next, i);
    setExtra([]);
    apply(next);
  };
  /** Scale the selected keys' times (about the first one) and/or values (about their mean). */
  const scaleSelected = (ft: number, fv: number) => {
    const idx = [...new Set([selIdx, ...extra])].sort((a, b) => a - b);
    const cur = latest.current;
    const t0 = cur.keys[idx[0]].t;
    const mean = idx.reduce((a, i) => a + cur.keys[i].v, 0) / idx.length;
    let next = cur;
    const order = ft >= 1 ? [...idx].reverse() : idx;
    for (const i of order) next = moveKey(next, i, t0 + (cur.keys[i].t - t0) * ft, mean + (cur.keys[i].v - mean) * fv);
    apply(next);
  };
  const insertAtPlayhead = () => {
    const st = io.player.getState();
    const t = st.totalFrames > 0 ? st.frame / st.totalFrames : 0;
    const r = addKey(c, t, evalCurve(c, t, { loop }), 'smooth', { loop });
    apply(r.curve);
    setSel(r.index);
  };

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'SELECT') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        removeSelected();
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        e.stopPropagation();
        insertAtPlayhead();
      } else if (e.key === 'Escape') onClose();
    };
    const el = box.current!;
    el.addEventListener('keydown', key);
    return () => el.removeEventListener('keydown', key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selIdx, c]);

  const copy = () => navigator.clipboard.writeText(JSON.stringify({ rsmpsCurve: c })).then(() => ed.toast('Curve copied', 'ok'), () => ed.toast('Clipboard unavailable', 'error'));
  const paste = async () => {
    try {
      const raw = JSON.parse(await navigator.clipboard.readText());
      if (raw?.rsmpsCurve?.keys) apply(normalizeCurve(raw.rsmpsCurve));
      else ed.toast('The clipboard has no curve', 'error');
    } catch {
      ed.toast('Could not read the clipboard', 'error');
    }
  };
  const fit = () => setView(fitView(c, loop, min, max));
  const preset = (make: () => CurveValue) => {
    let n = make();
    if (min !== undefined && max !== undefined) n = fitToRange(n, min, max, { loop });
    apply(n);
    setView(fitView(n, loop, min, max));
  };

  const menuItems: MenuItem[] = [
    { head: 'Presets' },
    ...CURVE_PRESETS.map((p) => ({ label: p.label, onClick: () => preset(p.make) })),
    { sep: true },
    { label: 'Reverse', onClick: () => apply(reverse(c)) },
    { head: 'Selected keys' },
    { label: 'Scale values ×1.25', onClick: () => scaleSelected(1, 1.25) },
    { label: 'Scale values ×0.8', onClick: () => scaleSelected(1, 0.8) },
    { label: 'Scale time ×1.25', onClick: () => scaleSelected(1.25, 1) },
    { label: 'Scale time ×0.8', onClick: () => scaleSelected(0.8, 1) },
    { head: 'Whole curve' },
    { label: 'Stretch time ×1.25', onClick: () => apply(scaleTime(c, 1.25)) },
    { label: 'Compress time ×0.8', onClick: () => apply(scaleTime(c, 0.8)) },
    { label: 'Shift +1 frame', onClick: () => apply(shiftTime(c, 1 / frames)) },
    { label: 'Shift −1 frame', onClick: () => apply(shiftTime(c, -1 / frames)) },
    { sep: true },
    { label: 'Auto tangents', onClick: () => apply(autoTangents(c, { loop })) },
    { label: 'Fit to range', onClick: fit },
    { sep: true },
    { label: 'Copy curve', onClick: copy },
    { label: 'Paste curve', onClick: () => void paste() },
  ];

  // drag the panel by its header
  const move = (e: React.PointerEvent) => {
    const el = box.current!;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const mv = (ev: PointerEvent) => { el.style.left = `${ev.clientX - dx}px`; el.style.top = `${ev.clientY - dy}px`; el.style.bottom = 'auto'; el.style.transform = 'none'; };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const k = c.keys[selIdx];
  return createPortal(
    <div ref={box} className="rs-ce" tabIndex={-1} role="dialog" aria-label={`Curve editor: ${title}`}>
      <div className="rs-ce__head" onPointerDown={move}>
        <span className="rs-caps">Curve{title && title.toLowerCase() !== 'curve' ? ` · ${title}` : ''}</span>
        <span className="rs-ce__hint">click add · drag move · Shift snaps frames · Ctrl snaps value · Alt breaks handles · Del removes · I inserts at playhead</span>
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={onClose} onPointerDown={(e) => e.stopPropagation()} aria-label="Close"><Icon name="close" /></button>
      </div>
      <div className="rs-ce__bar">
        <div className="rs-ce__seg">
          {INTERPS.map((i) => (
            <button key={i.id} className={k?.interp === i.id ? 'is-on' : ''} onClick={() => apply(setInterp(c, selIdx, i.id))} title={`Segment after the selected key: ${i.label}`}>{i.label}</button>
          ))}
        </div>
        {k && (
          <>
            <div className="rs-ce__num"><NumberField label="Frame" min={0} max={frames} step={1} value={Number((k.t * frames).toFixed(2))} onChange={(v) => apply(moveKey(c, selIdx, v / frames))} /></div>
            <div className="rs-ce__num"><NumberField label="Value" step={0.01} value={Number(k.v.toFixed(4))} onChange={(v) => apply(moveKey(c, selIdx, k.t, v))} /></div>
          </>
        )}
        <button className="rs-btn" onClick={removeSelected} disabled={c.keys.length < 2} title="Delete selected keys"><Icon name="trash" /></button>
        <button className="rs-btn" onClick={fit} title="Fit the view to the curve"><Icon name="fit" /></button>
        <button className="rs-btn" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}>Presets…</button>
        <button className="rs-btn" onClick={copy}>Copy</button>
        <button className="rs-btn" onClick={() => void paste()}>Paste</button>
      </div>
      <div className="rs-ce__plot" onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
        <canvas ref={cv} className="rs-ce__cv" onPointerDown={down} />
        {boxRect && <div className="rs-ce__box" style={{ left: boxRect.x, top: boxRect.y, width: boxRect.w, height: boxRect.h }} />}
        <div ref={head} className="rs-ce__head-line" />
      </div>
      {menu && <MenuPopup x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>,
    document.body,
  );
}

export { MIN_KEY_GAP };
