import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Icon } from '../components/Icon';
import { useApp, useEd } from '../store/context';
import { createGestures, frameGraph } from './gestures';
import { NodeView } from './NodeView';
import { Wires } from './Wires';
import { Frames } from './Frames';
import { SelectionToolbar } from './SelectionToolbar';
import { PresetRow } from '../components/PresetRow';
import './graph.css';

export function GraphView() {
  const app = useApp();
  const { ed, graphCtl: ctl } = app;
  const nodes = useEd((s) => s.graph.nodes);
  const docRev = useEd((s) => s.docRev);
  const debug = useEd((s) => s.prefs.debug);
  const gridSnap = useEd((s) => s.prefs.gridSnap !== false);
  const root = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const pending = useRef<SVGPathElement>(null);
  const hint = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const cut = useRef<SVGLineElement>(null);
  const gestures = useMemo(() => createGestures(app), [app]);
  const zoomPct = useSyncExternalStore(ctl.subscribeZoom, ctl.getZoomPct);

  useEffect(() => {
    ctl.root = root.current;
    ctl.layer = layer.current;
    ctl.pending = pending.current;
    ctl.hint = hint.current;
    ctl.box = box.current;
    ctl.cut = cut.current;
    ctl.applyView();
    const el = root.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const k = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      ctl.zoomAt(e.clientX, e.clientY, k);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    // frame the graph as soon as the panel has a real size (it may be 0x0 when first mounted)
    const ro = new ResizeObserver(() => {
      if (ctl.needsFit && el.clientWidth > 50 && el.clientHeight > 50) {
        ctl.needsFit = false;
        frameGraph(app);
      } else ctl.applyView();
    });
    ro.observe(el);
    return () => {
      el.removeEventListener('wheel', wheel);
      ro.disconnect();
      ctl.root = ctl.layer = null;
    };
  }, [ctl, app]);

  // Native drag-and-drop, focus loss and tab switches swallow pointerup / keyup: drop back to idle on each of them
  useEffect(() => {
    const reset = () => gestures.reset();
    const hidden = () => document.hidden && reset();
    const names = ['dragstart', 'dragend', 'drop', 'pointercancel'] as const;
    names.forEach((n) => window.addEventListener(n, reset, true));
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && reset();
    window.addEventListener('keydown', esc);
    window.addEventListener('blur', reset); // not captured: field blurs inside the page must not end a gesture
    document.addEventListener('visibilitychange', hidden);
    return () => {
      names.forEach((n) => window.removeEventListener(n, reset, true));
      window.removeEventListener('blur', reset);
      window.removeEventListener('keydown', esc);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [gestures]);

  // frame the graph whenever a different document is loaded
  useEffect(() => {
    ctl.needsFit = true;
    const id = requestAnimationFrame(() => {
      if (root.current && root.current.clientWidth > 50) {
        ctl.needsFit = false;
        frameGraph(app);
      }
    });
    return () => cancelAnimationFrame(id);
  }, [docRev, app, ctl]);

  return (
    <div
      ref={root}
      className="rs-graph"
      tabIndex={0}
      data-panel="graph"
      onPointerDown={gestures.onPointerDown}
      onPointerMove={gestures.onPointerMove}
      onPointerEnter={() => (ctl.hovering = true)}
      onPointerLeave={() => (ctl.hovering = false)}
      onDoubleClick={gestures.onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={gestures.onDragOver}
      onDragLeave={gestures.onDragLeave}
      onDrop={gestures.onDrop}
    >
      <div ref={layer} className="rs-graph__layer">
        <Frames />
        <Wires />
        {nodes.map((n) => (
          <NodeView key={n.id} node={n} />
        ))}
        <svg className="rs-wires rs-wires--pending" width="1" height="1">
          <path ref={pending} className="rs-wire is-pending" />
        </svg>
      </div>
      <div ref={box} className="rs-graph__box" />
      <SelectionToolbar />
      <svg className="rs-graph__overlay">
        <line ref={cut} className="rs-wire is-cut" style={{ display: 'none', stroke: 'var(--danger)', strokeWidth: 2 }} />
      </svg>
      <div ref={hint} className="rs-graph__hint" />

      <div className="rs-graph__bar" data-nodrag onPointerDown={(e) => e.stopPropagation()}>
        <button
          className="rs-btn rs-btn--primary"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            ed.openAddMenu({ clientX: r.left, clientY: r.bottom + 4, world: ctl.toWorld(r.left + 120, r.bottom + 80) });
          }}
          title="Add node (Shift+A)"
        >
          <Icon name="plus" /> Add
        </button>
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => frameGraph(app)} title="Frame all (F / Home)">
          <Icon name="focus" />
        </button>
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.autoLayout(true)} title="Auto-layout (L): arranges the selection, or everything">
          <Icon name="layout" />
        </button>
        <button className={`rs-btn rs-btn--icon rs-btn--ghost${gridSnap ? ' is-on' : ''}`} aria-pressed={gridSnap} onClick={() => ed.setPrefs({ gridSnap: !gridSnap })} title={gridSnap ? 'Grid snap on: dropped nodes snap to an 8 px grid' : 'Grid snap off'}>
          <Icon name="grid" />
        </button>
        <button className={`rs-btn rs-btn--icon rs-btn--ghost${debug ? ' is-on' : ''}`} onClick={() => ed.setPrefs({ debug: !debug })} title="Show per-node render time">
          <Icon name="search" />
        </button>
        <span className="rs-graph__zoom rs-num">{zoomPct}%</span>
      </div>

      {nodes.length === 0 && (
        <div className="rs-graph__empty">
          <div>
            Empty graph.
            <br />
            Press <span className="rs-kbd">Shift+A</span> to add a node, or drag media here from the library.
            <PresetRow />
          </div>
        </div>
      )}
    </div>
  );
}
