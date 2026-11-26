import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { nodeAtPath } from '../../engine/group';
import { useSelector } from '../store/createStore';
import { watchStore } from '../watchdog';
import { batchCount } from '../../engine/graph';
import { CATEGORIES } from '../../engine/types';
import { Icon } from '../components/Icon';
import { MenuPopup, type MenuItem } from '../components/Menu';
import { missingCapabilities } from '../lib/requirements';
import { trackPointer } from '../lib/drag';
import { useApp, useEd, usePlayer } from '../store/context';
import { safetyStore } from '../safety';
import { getLive } from '../store/live';
import { recordLabel, recorderForViewer, recorderSettings } from '../store/recorder';
import { PaintOverlay } from './PaintOverlay';
import { PointsOverlay } from './PointsOverlay';
import { FrameControl, useFrameMenuItems } from './FrameControl';
import { Loupe } from './Loupe';
import { CompareBar, CompareOverlay, CompareStrip, useCompareMenus } from './CompareUi'; // snapshots + A/B compare
import { useFoldLevel } from './useFoldLevel';
import { viewerMore } from './viewerMore';
import { useViewportClass } from '../responsive/viewport';
import './viewer.css';

type Bg = 'checker' | 'dark' | 'light';

export function Viewer() {
  const { io, ed } = useApp();
  const live = getLive({ io, ed });
  const outOpen = useSelector(live.output.store, (s) => s.open);
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const backing = useRef<HTMLDivElement>(null); // transparency checker: screen-space, so its squares keep one on-screen size at any zoom
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef({ zoom: 1, x: 0, y: 0, fit: true });
  const [zoomPct, setZoomPct] = useState(100);
  const [fit, setFit] = useState(true);
  const [snap, setSnap] = useState(true);
  const snapRef = useRef(true);
  const [loupe, setLoupe] = useState<0 | 1 | 2>(0);
  const [zHeld, setZHeld] = useState(false);
  const [hintOff, setHintOff] = useState(false);
  const hintCounted = useRef(false);
  const [bg, setBg] = useState<Bg>('checker');
  const imageSize = usePlayer((s) => s.imageSize);
  const fps = usePlayer((s) => s.fps);
  const proxy = usePlayer((s) => s.proxyPct);
  const pixelSize = usePlayer((s) => s.pixelSize);
  const lastProxy = usePlayer((s) => s.lastProxyPct);
  const fullRes = usePlayer((s) => s.fullRes);
  const renderPaused = useSelector(safetyStore, (s) => s.paused);
  // With an Output pixel size the player renders on the art grid on purpose: that is not a playback proxy.
  const previewPct = pixelSize > 1 ? 100 : proxy;
  // What "Keep this look" uses: the scale the preview shows now, else the last playback proxy seen, else 25 %.
  const keepPct = previewPct < 100 ? previewPct : (lastProxy ?? 25);
  const playing = usePlayer((s) => s.playing);
  const errors = usePlayer((s) => s.errors);
  const viewedId = useEd((s) => s.viewedNodeId);
  // the viewed node may be inside a group (its id is then a path: group/inner)
  const viewedNode = useEd((s) => (s.viewedNodeId ? (nodeAtPath(s.graph, s.viewedNodeId) ?? undefined) : undefined));
  const canFull = !!viewedNode && !renderPaused;
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
      let z = Math.min((b.clientWidth - 32) / iw, (b.clientHeight - 32) / ih);
      if (snapRef.current && z >= 1) z = Math.floor(z); // whole-pixel zoom keeps pixels even squares
      v.zoom = Math.max(0.02, Math.min(z, 32));
      v.x = (b.clientWidth - iw * v.zoom) / 2;
      v.y = (b.clientHeight - ih * v.zoom) / 2;
    }
    s.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
    const k = backing.current;
    if (k) Object.assign(k.style, { left: `${v.x}px`, top: `${v.y}px`, width: `${iw * v.zoom}px`, height: `${ih * v.zoom}px` });
    // nearest-neighbour only when enlarging; shrinking with it aliases fine detail into fake chunky pixels
    if (canvas.current) canvas.current.style.imageRendering = v.zoom >= 1 ? 'pixelated' : 'auto';
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
      if (e.key === 'f' || e.key === 'F' || e.key === 'Home' || e.key === '0') setFitMode(true);
      else if (e.key === 'z' || e.key === 'Z') setZHeld(true);
      else if (e.key === '1') oneToOne();
      else if (e.key === '+' || e.key === '=') zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
      else if (e.key === '-') zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    el.addEventListener('pointerenter', enter);
    el.addEventListener('pointerleave', leave);
    const zup = (e: KeyboardEvent) => (e.key === 'z' || e.key === 'Z') && setZHeld(false);
    window.addEventListener('keyup', zup, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keyup', zup, true);
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

  const hintCount = (() => { try { return Number(localStorage.getItem('rsmps.ui.zoomHint') ?? '0'); } catch { return 0; } })();
  const showHint = !!imageSize && zoomPct < 100 && !hintOff && hintCount < 3;
  useEffect(() => {
    if (showHint && !hintCounted.current) {
      hintCounted.current = true;
      try { localStorage.setItem('rsmps.ui.zoomHint', String(hintCount + 1)); } catch { /* ignore */ }
    }
  }, [showHint, hintCount]);
  const reqFor = (id: string) => {
    const n = ed.state.graph.nodes.find((x) => x.id === id);
    return missingCapabilities(io, n && io.registry.get(n.type))[0];
  };
  const rawErr = viewedId ? errors.get(viewedId) : undefined;
  const rawOther = !rawErr && errors.size ? [...errors][0] : undefined;
  const reqErr = (rawErr && viewedId ? reqFor(viewedId) : undefined) ?? (rawOther ? reqFor(rawOther[0]) : undefined);
  const err = rawErr && reqErr && viewedId && reqFor(viewedId) ? reqErr.explanation : rawErr;
  const otherErr = rawOther && reqErr && !rawErr ? ([rawOther[0], reqErr.explanation] as [string, string]) : rawOther;
  const nodeTitle = viewedNode ? viewedNode.label || viewedDef?.title || viewedNode.type : null;
  const catColor = viewedDef ? CATEGORIES[viewedDef.category]?.color : undefined;
  const paint = useEd((s) => (s.selection.length === 1 ? s.graph.nodes.find((n) => n.id === s.selection[0] && n.type === 'paint-mask') : undefined));
  // any selected node with a `points` json param and a `closed` bool gets the on-viewer path editor (detected by shape)
  const pointsNode = useEd((s) => {
    if (s.selection.length !== 1) return undefined;
    const n = s.graph.nodes.find((x) => x.id === s.selection[0]);
    const d = n && io.registry.get(n.type);
    const ps = d?.params as Record<string, { type: string }> | undefined;
    return n && ps?.points?.type === 'json' && ps?.closed?.type === 'bool' && n.params.mode !== 'curves' ? n : undefined;
  });
  const emptyMsg = !hasNodes
    ? 'The graph is empty. Add nodes with Shift+A in the graph below.'
    : !viewedNode
      ? 'Nothing is being viewed. Click the eye on a node to see its result here.'
      : null;

  /**
   * Fold level (priority+): 0 = every control inline; 1 = pixel size, snap, magnifier and background fold into the "…" menu; 2 = frame and batch
   * too; 3 = Snapshot / A/B / Node… become one icon button and the readouts shrink; 4 = Output joins the "…" menu and Full res / Keep this look
   * lose their labels; 5 = those two fold too. On a phone (6) the bar keeps only the name and preview scale: the header's "…" holds the rest.
   */
  const bar = useRef<HTMLDivElement>(null);
  const phone = useViewportClass() === 'phone';
  const cmp = useCompareMenus();
  const measured = useFoldLevel(bar, 5, `${nodeTitle}|${count > 1}|${cmp.mode}|${fullRes}|${hasNodes}`);
  const level = phone ? 6 : measured;
  const [more, setMore] = useState<{ x: number; y: number } | null>(null);
  const frameItems = useFrameMenuItems({ frame: level >= 2, pix: level >= 1 });
  const openOutput = (x: number, y: number) => live.ui.set((s) => ({ ...s, outputMenu: { x, y } }));
  const moreItems: MenuItem[] = [];
  if (level >= 5) {
    moreItems.push(
      { head: 'Render' },
      { label: 'Full res', disabled: !canFull, onClick: () => io.player.renderFullFrame() },
      { label: 'Keep this look', disabled: !viewedNode, onClick: () => ed.keepPreviewLook(keepPct) },
    );
  }
  if (level >= 4) moreItems.push({ label: 'Output window…', onClick: () => openOutput(Math.max(8, window.innerWidth - 300), 90) });
  if (level >= 5) moreItems.push(...cmp.foldItems);
  if (level >= 2 && count > 1) moreItems.push({ head: `Batch item ${item + 1} / ${count}` }, { label: 'Previous item', onClick: () => ed.setItem(item - 1) }, { label: 'Next item', onClick: () => ed.setItem(item + 1) });
  moreItems.push(...frameItems);
  if (level >= 1) {
    moreItems.push(
      { head: 'View' },
      ...(phone ? [{ label: 'Fit to window', onClick: () => setFitMode(true) }, { label: 'Actual pixels (100%)', onClick: oneToOne }] : []),
      { label: `${snap ? '✓ ' : ''}Snap Fit to whole pixels (1:n)`, onClick: () => { snapRef.current = !snap; setSnap(!snap); apply(); } },
      { label: `Magnifier: ${loupe === 2 ? '2×' : loupe === 1 ? '1×' : 'off'} (click for next)`, onClick: () => setLoupe((l) => ((l + 1) % 3) as 0 | 1 | 2) },
      { label: `Background: ${bg} (click for next)`, onClick: () => setBg((b) => (b === 'checker' ? 'dark' : b === 'dark' ? 'light' : 'checker')) },
    );
  }
  useEffect(() => {
    if (phone) viewerMore.set({ items: moreItems });
  });
  useEffect(() => () => viewerMore.set({ items: [] }), []);

  return (
    <div className="rs-viewer-wrap" data-panel="viewer">
    <div ref={bar} className="rs-viewer__bar" data-fold={level}>
      <div className="rs-viewer__info rs-viewer__chip" data-nodrag>
        {nodeTitle ? (
          <>
            <span className="rs-viewer__dot" style={{ background: catColor }} />
            <span className="rs-viewer__name">{nodeTitle}</span>
            {imageSize && <span className="rs-num">{imageSize.width}×{imageSize.height}</span>}
            <span className="rs-num" title="Measured frames per second">{playing ? `${fps} fps` : 'paused'}</span>
            <span
              className="rs-num"
              title={previewPct < 100 ? 'Preview scale: the whole graph is rendered at this share of the full resolution (the playback proxy), then enlarged' : 'Preview scale: full resolution'}
              style={previewPct < 100 ? { color: 'var(--yellow)' } : undefined}
            >
              <span className="rs-viewer__long">Preview </span>{previewPct}%
            </span>
            {fullRes === 'rendering' && <span className="rs-viewer__spin" role="status" aria-label="Rendering the full-resolution frame" title="Rendering the full-resolution frame…" />}
            {fullRes === 'shown' && <span className="rs-viewer__badge" title="This is the current frame rendered once at final quality. It stays until you change frame, graph or view, or press play.">Full res</span>}
          </>
        ) : (
          <span className="rs-viewer__name">No view</span>
        )}
      </div>

      {count > 1 && level < 2 && !phone && (
        <div className="rs-viewer__batch rs-viewer__chip" data-nodrag title="Batch item (Ctrl+←/→)">
          <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.setItem(item - 1)} aria-label="Previous batch item"><Icon name="chevronLeft" /></button>
          <span className="rs-num">{item + 1} / {count}</span>
          <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.setItem(item + 1)} aria-label="Next batch item"><Icon name="chevronRight" /></button>
        </div>
      )}

      {level < 5 && (
      <div className={`rs-viewer__look rs-viewer__chip${level >= 4 ? ' rs-viewer__look--icons' : ''}`} data-nodrag>
        <button
          className={`rs-btn rs-btn--ghost${fullRes !== 'off' ? ' is-on' : ''}`}
          disabled={!canFull}
          onClick={() => io.player.renderFullFrame()}
          title="Render this frame once at full resolution and final quality, whatever the preview scale (shortcut: Shift+R, rebindable)"
        >
          <Icon name="focus" /><span className="rs-viewer__btxt"> Full res</span>
        </button>
        <button
          className="rs-btn rs-btn--ghost"
          disabled={!viewedNode}
          onClick={() => ed.keepPreviewLook(keepPct)}
          title="Adds a Render Scale node before the output so the export looks like this preview"
        >
          <Icon name="pin" /><span className="rs-viewer__btxt"> Keep this look</span>
        </button>
        {level < 4 && (
        <button
          className={`rs-btn rs-btn--ghost${outOpen ? ' is-on' : ''}`}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); live.ui.set((s) => ({ ...s, outputMenu: { x: r.left, y: r.bottom + 2 } })); }}
          aria-haspopup="menu"
          title="Output window for a projector or second monitor, blackout and freeze, MIDI mappings (Ctrl+Shift+O opens it)"
        >
          <Icon name="maximize" /> Output
        </button>
        )}
      </div>
      )}

      {!phone && (level < 5 || cmp.mode !== 'off') && <CompareBar compact={level >= 3} />}
      {!phone && <FrameControl frame={level < 2} pix={level < 1} />}
      {!phone && (
      <div className="rs-viewer__tools rs-viewer__chip" data-nodrag>
        <button className={`rs-btn rs-btn--ghost rs-viewer__fitbtn${fit ? ' is-on' : ''}`} onClick={() => setFitMode(true)} title="Fit to window (F or 0)"><Icon name="fit" /> Fit</button>
        <button className={`rs-btn rs-viewer__actual${zoomPct === 100 && !fit ? ' is-on' : ''}`} onClick={oneToOne} title="Actual pixels, 100% (1)">100%</button>
        {level < 1 && (
          <>
            <button className={`rs-btn rs-btn--ghost${snap ? ' is-on' : ''}`} onClick={() => { snapRef.current = !snap; setSnap(!snap); apply(); }} title="Snap Fit to whole-pixel zoom (1×, 2×, 3×…) when the image is smaller than the pane">1:n</button>
            <button className={`rs-btn rs-btn--ghost${loupe || zHeld ? ' is-on' : ''}`} onClick={() => setLoupe((l) => ((l + 1) % 3) as 0 | 1 | 2)} title="Magnifier: off → 200% → 100% (or hold Z)"><Icon name="search" />{loupe === 2 ? ' 2×' : loupe === 1 ? ' 1×' : ''}</button>
          </>
        )}
        <span className="rs-viewer__zoom rs-num" title={fit ? 'Fitted to the pane' : 'Manual zoom'}>{fit ? `Fit · ${zoomPct}%` : `${zoomPct}%`}</span>
        {level < 1 && (
          <button
            className="rs-btn rs-btn--icon rs-btn--ghost"
            onClick={() => setBg((b) => (b === 'checker' ? 'dark' : b === 'dark' ? 'light' : 'checker'))}
            title={`Background: ${bg} (click to change)`}
          >
            <Icon name="grid" />
          </button>
        )}
        {level > 0 && (
          <button className="rs-btn rs-btn--icon rs-btn--ghost" title="More view controls" aria-label="More view controls" aria-haspopup="menu" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMore({ x: r.left, y: r.bottom + 2 }); }}>…</button>
        )}
      </div>
      )}
      {more && <MenuPopup x={more.x} y={more.y} items={moreItems} onClose={() => setMore(null)} />}
    </div>
    <div ref={box} className={`rs-viewer rs-viewer--${bg}`} onPointerDown={onPointerDown} onDoubleClick={() => setFitMode(true)}>
      <div ref={backing} className="rs-viewer__backing" style={{ visibility: imageSize ? 'visible' : 'hidden' }} />
      <div ref={stage} className="rs-viewer__stage" style={{ width: iw, height: ih, visibility: imageSize ? 'visible' : 'hidden' }}>
        <canvas ref={canvas} className="rs-viewer__canvas" style={{ width: iw, height: ih }} />
        <CompareOverlay stage={stage} box={box} />
      </div>
      <ViewerRecordButton />

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
            <strong>{reqErr ? reqErr.label : err ? 'This node failed' : 'A node in the graph failed'}</strong>
            <p>{err ?? (reqErr ? `${nameOf(ed, otherErr![0])}: ${otherErr![1]}` : `${nameOf(ed, otherErr![0])}: ${otherErr![1]}`)}</p>
          </div>
        </div>
      )}

      {rendering && (
        <div className="rs-viewer__rendering rs-viewer__chip" role="status" data-nodrag>
          <span className="rs-ps__dot" /> Rendering…{slowest ? ` (${slowest})` : ''}
        </div>
      )}
      <Loupe active={loupe > 0 || zHeld} scale={loupe === 1 ? 1 : 2} box={box} stage={stage} />
      {showHint && (
        <div className="rs-viewer__scaled rs-viewer__chip" role="status" data-nodrag>
          Preview is scaled down to {zoomPct}%: press <span className="rs-kbd">1</span> for actual pixels
          <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => { setHintOff(true); try { localStorage.setItem('rsmps.ui.zoomHint', '9'); } catch { /* ignore */ } }} title="Do not show again"><Icon name="close" size={12} /></button>
        </div>
      )}
      <CompareStrip />
      {pointsNode && <PointsOverlay nodeId={pointsNode.id} stage={stage} />}
      {paint && <PaintOverlay nodeId={paint.id} stage={stage} />}

    </div>
    </div>
  );
}

function nameOf(ed: ReturnType<typeof useApp>['ed'], id: string): string {
  const n = ed.state.graph.nodes.find((x) => x.id === id);
  return n ? n.label || ed.registry.get(n.type)?.title || n.type : id;
}

/**
 * Record / Stop in the corner of the viewer, shown while the project has a Recorder node: the same button as the one in the
 * Recorder's settings, so a take can be started without leaving the picture.
 */
function ViewerRecordButton() {
  const { io, ed } = useApp();
  const recorder = getLive({ io, ed }).recorder;
  const ui = useSelector(recorder.store, (s) => s);
  // identity of the Recorder to use, as a string so the selector result is stable between renders
  const pick = useEd((s) => {
    const r = recorderForViewer(s.graph.nodes, s.viewedNodeId);
    return r ? r.id : '';
  });
  const params = useEd((s) => s.graph.nodes.find((n) => n.id === pick)?.params);
  if (!pick || !params) return null;
  // while a take runs the button belongs to the node being recorded, whichever that is
  const target = ui.phase !== 'idle' && ui.nodeId ? ui.nodeId : pick;
  const mine = ui.nodeId === target;
  const recording = mine && ui.phase === 'recording';
  // A smooth take is rendered after Stop: the button then shows how far that is, and a tap on it cancels (the raw clip is kept).
  const rendering = mine && ui.phase === 'rendering';
  return (
    <button
      className={`rs-viewer__rec${recording ? ' is-on' : ''}`}
      disabled={ui.phase === 'saving'}
      title={rendering ? 'The effects are being rendered onto the recording. Press to cancel: the raw camera clip stays in Media' : recording ? (ui.smooth ? 'Stop: the clip is then rendered and saved' : 'Stop and save the clip') : 'Record through the Recorder node: shows it in the viewer, starts playback and records picture and sound'}
      aria-label={rendering ? 'Cancel rendering' : recording ? 'Stop recording' : 'Record'}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onClick={() => (rendering ? recorder.cancelRender() : recorder.toggle(target, recorderSettings(params)))}
    >
      <span className="rs-viewer__recdot" />
      {recordLabel(ui, mine)}
      {rendering && <span className="rs-viewer__reccancel">Cancel</span>}
    </button>
  );
}
