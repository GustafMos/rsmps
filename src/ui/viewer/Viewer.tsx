import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from '../store/createStore';
import { watchStore } from '../watchdog';
import { batchCount } from '../../engine/graph';
import { CATEGORIES } from '../../engine/types';
import { Icon } from '../components/Icon';
import { trackPointer } from '../lib/drag';
import { useApp, useEd, usePlayer } from '../store/context';
import { PaintOverlay } from './PaintOverlay';
import { FrameControl } from './FrameControl';
import './viewer.css';

type Bg = 'checker' | 'dark' | 'light';

export function Viewer() {
  const { io, ed } = useApp();
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ zoom: 1, x: 0, y: 0, fit: true });
  const [zoomPct, setZoomPct] = useState(100);
  const [fit, setFit] = useState(true);
  const [bg, setBg] = useState<Bg>('checker');
  const imageSize = usePlayer((s) => s.imageSize);
  const fps = usePlayer((s) => s.fps);
  const proxy = usePlayer((s) => s.proxyPct);
  const playing = usePlayer((s) => s.playing);
  const errors = usePlayer((s) => s.errors);
  const viewedId = useEd((s) => s.viewedNodeId);
  const viewedNode = useEd((s) => s.graph.nodes.find((n) => n.id === s.viewedNodeId));
  const item = useEd((s) => s.item);
  const count = useEd((s) => batchCount(s.graph, ed.registry));
  const projW = useEd((s) => s.graph.project.width);
  const projH = useEd((s) => s.graph.project.height);
  const hasNodes = useEd((s) => s.graph.nodes.length > 0);
  const rendering = useSelector(watchStore, (s) => s.rendering);
  const timings = usePlayer((s) => s.timings);
  const slowest = useMemo(() => {
    let best = '';
    let ms = 0;
    for (const [id, t] of timings) if (t > ms) { ms = t; best = id; }
    const n = ed.state.graph.nodes.find((x) => x.id === best);
    return n ? n.label || io.registry.get(n.type)?.title || n.type : '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timings, rendering]);
  const viewedDef = viewedNode ? io.registry.get(viewedNode.type) : undefined;

  const iw = imageSize?.width ?? projW;
  const ih = imageSize?.height ?? projH;

  const apply = useCallback(() => {
    const v = view.current;
    const b = box.current;
    const s = stage.current;
    if (!b || !s) return;
    if (v.fit) {
      const z = Math.min((b.clientWidth - 32) / iw, (b.clientHeight - 32) / ih);
      v.zoom = Math.max(0.02, Math.min(z, 32));
      v.x = (b.clientWidth - iw * v.zoom) / 2;
      v.y = (b.clientHeight - ih * v.zoom) / 2;
    }
    s.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    const pct = Math.round(v.zoom * 100);
    setZoomPct((p) => (p === pct ? p : pct));
  }, [iw, ih]);

  useEffect(() => {
    io.player.setCanvas(canvas.current);
    return () => io.player.setCanvas(null);
  }, [io]);

  useEffect(() => {
    apply();
    const ro = new ResizeObserver(apply);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [apply]);

  const setFitMode = (on: boolean) => {
    view.current.fit = on;
    setFit(on);
    apply();
  };
  const zoomAt = (cx: number, cy: number, factor: number) => {
    const b = box.current!.getBoundingClientRect();
    const v = view.current;
    const mx = cx - b.left;
    const my = cy - b.top;
    const z = Math.min(64, Math.max(0.02, v.zoom * factor));
    const k = z / v.zoom;
    v.x = mx - (mx - v.x) * k;
    v.y = my - (my - v.y) * k;
    v.zoom = z;
    v.fit = false;
    setFit(false);
    apply();
  };
  const oneToOne = () => {
    const b = box.current!;
    const v = view.current;
    v.zoom = 1;
    v.x = (b.clientWidth - iw) / 2;
    v.y = (b.clientHeight - ih) / 2;
    v.fit = false;
    setFit(false);
    apply();
  };

  useEffect(() => {
    const el = box.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  });

  useEffect(() => {
    const el = box.current!;
    let over = false;
    const enter = () => (over = true);
    const leave = () => (over = false);
    const key = (e: KeyboardEvent) => {
      if (!over || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const r = el.getBoundingClientRect();
      if (e.key === 'f' || e.key === 'F' || e.key === 'Home') setFitMode(true);
      else if (e.key === '1') oneToOne();
      else if (e.key === '+' || e.key === '=') zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
      else if (e.key === '-') zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    window.addEventListener('keydown', key, true);
    return () => {
      el.removeEventListener('pointerenter', enter);
      el.removeEventListener('pointerleave', leave);
      window.removeEventListener('keydown', key, true);
    };
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-nodrag]')) return;
    if (e.button === 1 || e.button === 0) {
      const v = view.current;
      const x0 = e.clientX - v.x;
      const y0 = e.clientY - v.y;
      box.current?.classList.add('is-panning');
      trackPointer(
        e,
        (ev) => {
          v.fit = false;
          v.x = ev.clientX - x0;
          v.y = ev.clientY - y0;
          setFit(false);
          apply();
        },
        () => box.current?.classList.remove('is-panning'),
      );
    }
  };

  const err = viewedId ? errors.get(viewedId) : undefined;
  const otherErr = !err && errors.size ? [...errors][0] : undefined;
  const nodeTitle = viewedNode ? viewedNode.label || viewedDef?.title || viewedNode.type : null;
  const catColor = viewedDef ? CATEGORIES[viewedDef.category]?.color : undefined;
  const paint = useEd((s) => (s.selection.length === 1 ? s.graph.nodes.find((n) => n.id === s.selection[0] && n.type === 'paint-mask') : undefined));
  const emptyMsg = !hasNodes
    ? 'The graph is empty. Add nodes with Shift+A in the graph below.'
    : !viewedNode
      ? 'Nothing is being viewed. Click the eye on a node to see its result here.'
      : null;

  return (
    <div ref={box} className={`rs-viewer rs-viewer--${bg}`} data-panel="viewer" onPointerDown={onPointerDown} onDoubleClick={() => setFitMode(true)}>
      <div ref={stage} className="rs-viewer__stage" style={{ width: iw, height: ih, visibility: imageSize ? 'visible' : 'hidden' }}>
        <canvas ref={canvas} className="rs-viewer__canvas" style={{ width: iw, height: ih }} />
      </div>

      {emptyMsg && (
        <div className="rs-viewer__empty">
          <div>{emptyMsg}</div>
        </div>
      )}
      {!emptyMsg && !imageSize && !err && !otherErr && (
        <div className="rs-viewer__empty">
          <div>{viewedDef?.category === 'output' || !viewedDef ? 'Connect an image to see it here.' : 'This node has no image to show yet.'}</div>
        </div>
      )}
      {(err || otherErr) && (
        <div className="rs-viewer__error" role="alert" data-nodrag>
          <Icon name="warn" size={16} />
          <div>
            <strong>{err ? 'This node failed' : 'A node in the graph failed'}</strong>
            <p>{err ?? `${nameOf(ed, otherErr![0])}: ${otherErr![1]}`}</p>
          </div>
        </div>
      )}

      {rendering && (
        <div className="rs-viewer__rendering rs-viewer__chip" role="status" data-nodrag>
          <span className="rs-ps__dot" /> Rendering…{slowest ? ` (${slowest})` : ''}
        </div>
      )}
      {paint && <PaintOverlay nodeId={paint.id} stage={stage} />}

      <div className="rs-viewer__info rs-viewer__chip" data-nodrag>
        {nodeTitle ? (
          <>
            <span className="rs-viewer__dot" style={{ background: catColor }} />
            <span className="rs-viewer__name">{nodeTitle}</span>
            {imageSize && <span className="rs-num">{imageSize.width}×{imageSize.height}</span>}
            <span className="rs-num" title="Measured frames per second">{playing ? `${fps} fps` : 'paused'}</span>
            {proxy < 100 && <span className="rs-num" title="Playback proxy: the viewer renders at reduced resolution while playing" style={{ color: 'var(--yellow)' }}>proxy {proxy}%</span>}
          </>
        ) : (
          <span className="rs-viewer__name">No view</span>
        )}
      </div>

      {count > 1 && (
        <div className="rs-viewer__batch rs-viewer__chip" data-nodrag title="Batch item (Ctrl+←/→)">
          <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.setItem(item - 1)}><Icon name="chevronLeft" /></button>
          <span className="rs-num">{item + 1} / {count}</span>
          <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.setItem(item + 1)}><Icon name="chevronRight" /></button>
        </div>
      )}

      <FrameControl />
      <div className="rs-viewer__tools rs-viewer__chip" data-nodrag>
        <button className={`rs-btn rs-btn--icon rs-btn--ghost${fit ? ' is-on' : ''}`} onClick={() => setFitMode(true)} title="Fit to window (F)"><Icon name="fit" /></button>
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={oneToOne} title="100% (1)"><Icon name="one" /></button>
        <span className="rs-viewer__zoom rs-num">{zoomPct}%</span>
        <button
          className="rs-btn rs-btn--icon rs-btn--ghost"
          onClick={() => setBg((b) => (b === 'checker' ? 'dark' : b === 'dark' ? 'light' : 'checker'))}
          title={`Background: ${bg} (click to change)`}
        >
          <Icon name="grid" />
        </button>
      </div>
    </div>
  );
}

function nameOf(ed: ReturnType<typeof useApp>['ed'], id: string): string {
  const n = ed.state.graph.nodes.find((x) => x.id === id);
  return n ? n.label || ed.registry.get(n.type)?.title || n.type : id;
}
