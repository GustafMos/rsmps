import { useEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon';
import { MenuPopup, type MenuItem } from '../components/Menu';
import { compareStore, compareWithNode, currentStrip, exitCompare, patchCompare, pruneProjects, refreshLive, removeSnapshot, renameSnapshot, selectSnapshot, snapUrl, takeSnapshot } from '../store/compare';
import { useSelector } from '../store/createStore';
import { useApp, useEd, usePlayer } from '../store/context';
import { COMPARE_MODES, PLAYBACK_NOTE, overlayStyle, snapCaption, wipeLine, wipePosFromPointer } from './compare';
import './compare.css';

/** Snapshot button and compare controls: a chip in the viewer bar. */
export function CompareBar() {
  const app = useApp();
  const { ed } = app;
  const mode = useSelector(compareStore, (s) => s.mode);
  const onion = useSelector(compareStore, (s) => s.onion);
  const gain = useSelector(compareStore, (s) => s.gain);
  const angle = useSelector(compareStore, (s) => s.wipeAngle);
  const busy = useSelector(compareStore, (s) => s.busy);
  const playing = usePlayer((s) => s.playing);
  const projects = useEd((s) => s.projects);
  const [menu, setMenu] = useState<{ x: number; y: number; kind: 'mode' | 'node' } | null>(null);

  useEffect(() => pruneProjects(projects.map((p) => p.id)), [projects]);

  const nodes = ed.state.graph.nodes;
  const modeItems: MenuItem[] = [
    ...COMPARE_MODES.map((m) => ({ label: `${mode === m.id ? '✓ ' : ''}${m.label}`, onClick: () => patchCompare({ mode: m.id }) })),
    { sep: true },
    { label: 'Exit compare', onClick: () => exitCompare(), disabled: mode === 'off' },
  ];
  const nodeItems: MenuItem[] = [
    { label: 'Selected node vs its input (what did it change?)', onClick: () => void compareWithNode(app) },
    { sep: true },
    { head: 'Compare the view with…' },
    ...nodes.filter((n) => n.id !== ed.state.viewedNodeId).slice(0, 40).map((n) => ({ label: n.label || app.io.registry.get(n.type)?.title || n.type, onClick: () => void compareWithNode(app, n.id) })),
  ];
  const open = (e: React.MouseEvent, kind: 'mode' | 'node') => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: r.left, y: r.bottom + 2, kind });
  };

  return (
    <div className="rs-viewer__look rs-viewer__chip rs-cmp__bar" data-nodrag>
      <button className="rs-btn rs-btn--ghost" onClick={() => void takeSnapshot(app)} title="Snapshot of the viewer (shortcut: Shift+S, rebindable)">
        <Icon name="image" /> Snapshot
      </button>
      <button className={`rs-btn rs-btn--ghost${mode !== 'off' ? ' is-on' : ''}`} onClick={(e) => open(e, 'mode')} aria-haspopup="menu" title="Compare the live view with a snapshot">
        A/B{mode !== 'off' ? `: ${COMPARE_MODES.find((m) => m.id === mode)?.label}` : ''}
      </button>
      <button className="rs-btn rs-btn--ghost" disabled={busy} onClick={(e) => open(e, 'node')} aria-haspopup="menu" title="Compare with another node at this frame">
        Node…
      </button>
      {mode === 'wipe' && (
        <label className="rs-cmp__ctl" title="Wipe angle">
          <span className="rs-num">∠</span>
          <input type="range" min={-90} max={90} step={1} value={angle} onChange={(e) => patchCompare({ wipeAngle: Number(e.target.value) })} />
        </label>
      )}
      {mode === 'onion' && (
        <label className="rs-cmp__ctl" title="Blend">
          <span className="rs-num">mix</span>
          <input type="range" min={0} max={1} step={0.01} value={onion} onChange={(e) => patchCompare({ onion: Number(e.target.value) })} />
        </label>
      )}
      {mode === 'diff' && (
        <label className="rs-cmp__ctl" title="Gain: multiplies the difference so small changes show">
          <span className="rs-num">×{gain}</span>
          <input type="range" min={1} max={32} step={1} value={gain} onChange={(e) => patchCompare({ gain: Number(e.target.value) })} />
        </label>
      )}
      {mode !== 'off' && playing && <span className="rs-num rs-cmp__note" title={PLAYBACK_NOTE}>pause for exact</span>}
      {mode !== 'off' && (
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => exitCompare()} aria-label="Exit compare" title="Exit compare">
          <Icon name="close" size={12} />
        </button>
      )}
      {menu && <MenuPopup x={menu.x} y={menu.y} items={menu.kind === 'mode' ? modeItems : nodeItems} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * Rendered inside the viewer's transformed stage (so zoom and pan are linked): snapshot A as an <img> over the live canvas, plus the wipe
 * handle. Side by side is two panes over the whole viewer.
 */
export function CompareOverlay({ stage, box }: { stage: RefObject<HTMLDivElement | null>; box: RefObject<HTMLDivElement | null> }) {
  const app = useApp();
  const st = useSelector(compareStore, (s) => s);
  const strip = currentStrip(st, app);
  const snap = strip.find((s) => s.id === st.activeId);
  const url = snap ? snapUrl(snap.id) : null;
  const iw = usePlayer((s) => s.imageSize?.width) ?? app.ed.state.graph.project.width;
  const ih = usePlayer((s) => s.imageSize?.height) ?? app.ed.state.graph.project.height;
  const aspect = iw / Math.max(1, ih);
  const mode = snap ? st.mode : 'off';
  const style = overlayStyle({ mode, wipePos: st.wipePos, wipeAngle: st.wipeAngle, onion: st.onion, gain: st.gain, flipped: st.flipped, aspect });
  const [frame, setFrame] = useState(0);
  useEffect(() => app.io.player.subscribe((p) => setFrame(p.frame)), [app]);
  const playing = usePlayer((s) => s.playing);
  const graph = useEd((s) => s.graph);

  // the live stage: gain filter (difference) or hidden (side by side)
  useEffect(() => {
    const el = stage.current;
    const b = box.current;
    if (!el) return;
    el.style.filter = style.stageFilter === 'none' ? '' : style.stageFilter;
    b?.classList.toggle('is-cmp-side', style.hideStage);
    return () => {
      el.style.filter = '';
      b?.classList.remove('is-cmp-side');
    };
  }, [stage, box, style.stageFilter, style.hideStage]);

  // the A/B hold key: any key release (or losing focus) puts the live image back
  useEffect(() => {
    const off = () => { if (compareStore.get().flipped) patchCompare({ flipped: false }); };
    window.addEventListener('keyup', off);
    window.addEventListener('blur', off);
    return () => { window.removeEventListener('keyup', off); window.removeEventListener('blur', off); };
  }, []);

  // side by side: freeze the live image whenever paused content changes
  useEffect(() => {
    if (mode !== 'side' || playing) return;
    const t = setTimeout(() => void refreshLive(app), 160);
    return () => clearTimeout(t);
  }, [app, mode, playing, frame, graph, st.activeId]);

  const drag = (e: React.PointerEvent<SVGElement>) => {
    const el = stage.current;
    if (!el) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      patchCompare({ wipePos: wipePosFromPointer((ev.clientX - r.left) / r.width, (ev.clientY - r.top) / r.height, compareStore.get().wipeAngle, aspect) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  if (!snap || !url || mode === 'off') return null;
  const line = wipeLine(st.wipePos, st.wipeAngle, aspect);
  const stageEl = stage.current;
  const boxEl = box.current;
  return (
    <>
      {stageEl &&
        createPortal(
          <>
            {style.overlay.visible && (
              <img
                className="rs-cmp__img"
                src={url}
                alt="Snapshot A"
                draggable={false}
                style={{ opacity: style.overlay.opacity, clipPath: style.overlay.clipPath, mixBlendMode: style.overlay.mixBlendMode, imageRendering: 'auto' }}
              />
            )}
            {mode === 'wipe' && (
              <svg className="rs-cmp__wipe" viewBox="0 0 100 100" preserveAspectRatio="none" data-nodrag>
                <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} className="rs-cmp__line" vectorEffect="non-scaling-stroke" />
                <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} className="rs-cmp__hit" vectorEffect="non-scaling-stroke" onPointerDown={drag} />
              </svg>
            )}
          </>,
          stageEl,
        )}
      {boxEl && mode === 'side' &&
        createPortal(
          <div className="rs-cmp__side" data-nodrag>
            <figure><img src={url} alt="Snapshot A" draggable={false} /><figcaption>A: {snapCaption(snap)}</figcaption></figure>
            <figure>{st.liveUrl ? <img src={st.liveUrl} alt="Live B" draggable={false} /> : <div className="rs-cmp__wait">Pause to refresh the live side</div>}<figcaption>B: live{playing ? ' (paused frame)' : ''}</figcaption></figure>
          </div>,
          boxEl,
        )}
    </>
  );
}

/** Thumbnails of the snapshots of this project, at the bottom of the viewer. */
export function CompareStrip() {
  const app = useApp();
  const st = useSelector(compareStore, (s) => s);
  const strip = currentStrip(st, app);
  if (!strip.length) return null;
  return (
    <div className="rs-cmp__strip" data-nodrag role="list" aria-label="Snapshots">
      {strip.map((s) => (
        <div key={s.id} role="listitem" className={`rs-cmp__thumb${s.id === st.activeId ? ' is-on' : ''}`} title={snapCaption(s)}>
          <button className="rs-cmp__pick" onClick={() => selectSnapshot(s.id === st.activeId ? null : s.id)} aria-pressed={s.id === st.activeId}>
            <img src={snapUrl(s.id) ?? ''} alt={snapCaption(s)} draggable={false} />
            <span className="rs-num">{s.label || `f${s.frame}`}</span>
          </button>
          <button className="rs-btn rs-btn--icon rs-btn--ghost rs-cmp__x" aria-label="Rename snapshot" title="Rename" onClick={() => { const v = window.prompt('Snapshot label', s.label); if (v !== null) renameSnapshot(app, s.id, v); }}>
            <Icon name="rename" size={10} />
          </button>
          <button className="rs-btn rs-btn--icon rs-btn--ghost rs-cmp__x rs-cmp__x2" aria-label="Delete snapshot" title="Delete" onClick={() => removeSnapshot(app, s.id)}>
            <Icon name="close" size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}
