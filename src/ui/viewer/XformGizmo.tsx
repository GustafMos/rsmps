import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { AnyNodeDef, CameraValue } from '../../engine/types';
import { trackPointer } from '../lib/drag';
import { physicsOf } from '../../engine/lib/physics/objects';
import { cameraOf, drivenParams, OBJECT_KEYS, OBJECT_RADIUS, patchIsNoop, resetPatch, transformOf, type ResetKind } from '../lib/xform3d';
import { useApp, useEd, usePlayer } from '../store/context';
import { sdfPictureScene } from '../lib/sdf-view';
import { chainOf, IDENTITY_FRAME, modHint, reachOf, toLocal, toWorld, composeFrames, frameOfPlace } from './sdfHandles';
import { loadSdfView, type SdfView } from './sdfView';
import {
  angleStep,
  axisTriad,
  clampTo,
  depthFactorForDrag,
  depthFactorForWheel,
  dragDepth,
  dragMove,
  dragScale,
  isRectilinear,
  lensOf,
  projectPoint,
  roundTo,
  screenAngle,
  screenRadius,
  turnRoll,
  turnTrackball,
  type Euler,
  type Lens,
  type V3,
} from './gizmoMath';

/** 'off' = the handles are put away (press the lit button again): the whole picture pans and zooms as if they were not there. */
export type GizmoMode = 'move' | 'turn' | 'size' | 'off';
const MODES: { id: Exclude<GizmoMode, 'off'>; label: string; title: string; reset: ResetKind; resetTitle: string }[] = [
  { id: 'move', label: 'Move', title: 'Drag the object to move it. The round handle beside it pushes it away or pulls it closer.', reset: 'position', resetTitle: 'Back to the middle' },
  { id: 'turn', label: 'Turn', title: 'Drag on the object to turn it freely. Drag the outer ring to roll it. This sets the starting angles; any Spin is added on top.', reset: 'rotation', resetTitle: 'No rotation: 0, 0, 0' },
  { id: 'size', label: 'Size', title: 'Drag the corner handle away from the object to make it larger.', reset: 'size', resetTitle: 'Normal size' },
];
const MODE_KEY = 'rsmps.ui.gizmoMode';
/** Finger-sized: every handle is at least this many CSS pixels across. */
const TOUCH = 44;

const readMode = (): GizmoMode => {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (m === 'move' || m === 'turn' || m === 'size' || m === 'off') return m;
  } catch {
    /* storage unavailable */
  }
  return 'move';
};

interface Rect {
  l: number;
  t: number;
  w: number;
  h: number;
  bw: number;
  bh: number;
}

/**
 * Handles on the picture for a node of the 3D family (see lib/xform3d.ts): drag the object where you want it, turn it, size it,
 * with a mouse or a finger. A drag that starts on a handle belongs to the handle (the handles carry `data-nodrag`, which both the
 * viewer's own panning and the touch gestures in responsive/viewerTouch.ts respect); anywhere else the viewer pans and zooms as always.
 *
 * The handle positions come from the node's own camera maths (gizmoMath.ts), not from the pixels, so they are right even before the
 * picture has caught up, and a whole drag is one undo step.
 */
export function XformGizmo({ nodeId, def, stage, width, height }: { nodeId: string; def: AnyNodeDef; stage: RefObject<HTMLDivElement | null>; width: number; height: number }) {
  const { ed, io } = useApp();
  const node = useEd((s) => s.level.nodes.find((n) => n.id === nodeId));
  const edges = useEd((s) => s.level.edges);
  const nodesHere = useEd((s) => s.level.nodes);
  const path = useEd((s) => s.path);
  const playing = usePlayer((s) => s.playing);
  // the paused playhead (the store for React leaves the clock out on purpose; while playing we do not follow it either, see below)
  const [seconds, setSeconds] = useState(() => io.player.getState().seconds);
  useEffect(() => io.player.subscribe((s) => { if (!s.playing) setSeconds(s.seconds); }), [io]);
  const [mode, setModeState] = useState<GizmoMode>(readMode);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cam, setCam] = useState<{ edge: string; value: CameraValue | null } | null>(null);
  const [busy, setBusy] = useState(false); // a handle is being dragged
  const root = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ wheel?: (factor: number) => void } | null>(null);

  const setMode = (m: GizmoMode) => {
    setModeState(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* storage unavailable */ }
  };

  // params with the defaults filled in (an older project may not have every key yet), exactly what the node itself renders with
  const params = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const [k, p] of Object.entries(def.params as Record<string, { default: unknown }>)) out[k] = node?.params[k] ?? p.default;
    return out;
  }, [def, node?.params]);
  // A body of the Physics node moves this object: at the START (paused at the beginning) the handles edit where it starts, anywhere else they are locked
  const physLink = useMemo(() => physicsOf({ edges, nodes: nodesHere } as never, nodeId), [edges, nodesHere, nodeId]);
  const physAtStart = !!physLink && !playing && seconds <= (typeof physLink.phys.params.startAt === 'number' ? physLink.phys.params.startAt : 0) + 1e-6;
  const wired = useMemo(() => {
    const out = drivenParams(def, edges.filter((e) => e.to.node === nodeId && !(physAtStart && physLink?.how === 'motion' && e.to.port === 'xform@motion')).map((e) => e.to.port));
    return out;
  }, [edges, nodeId, def, physAtStart, physLink]);
  const camEdge = edges.find((e) => e.to.node === nodeId && e.to.port === 'camera');

  // Where the picture is on screen right now. Read every frame: the viewer pans and zooms without telling anyone.
  useEffect(() => {
    let raf = 0;
    const read = () => {
      raf = requestAnimationFrame(read);
      const r = stage.current?.getBoundingClientRect();
      const o = root.current?.parentElement?.getBoundingClientRect();
      if (!r || !o || !r.width || !r.height) return;
      const next = { l: r.left - o.left, t: r.top - o.top, w: r.width, h: r.height, bw: o.width, bh: o.height };
      setRect((cur) => (cur && (Object.keys(next) as (keyof Rect)[]).every((k) => Math.abs(cur[k] - next[k]) < 0.25) ? cur : next));
    };
    read();
    return () => cancelAnimationFrame(raf);
  }, [stage]);

  // A wired Camera: ask the engine what it gives right now (it may be animated or driven by other nodes). Not during a drag: the
  // drag works with the camera it started with, and the camera does not depend on the object being moved.
  const camFrom = camEdge ? `${camEdge.from.node}:${camEdge.from.port}` : '';
  const graph = useEd((s) => s.graph);
  useEffect(() => {
    if (!camEdge) {
      setCam(null);
      return;
    }
    if (dragging.current) return;
    let dead = false;
    const id = path.length ? [...path, camEdge.from.node].join('/') : camEdge.from.node;
    io.evaluate(graph, id, { port: camEdge.from.port, seconds: io.player.getState().seconds, item: ed.state.item })
      .then((v) => { if (!dead) setCam({ edge: camFrom, value: v && typeof v === 'object' && 'kind' in v && v.kind === 'camera' ? (v as CameraValue) : null }); })
      .catch(() => { if (!dead) setCam({ edge: camFrom, value: null }); });
    return () => { dead = true; };
    // while playing the clock stands still here on purpose: one evaluation per shown frame would only get in the player's way
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camFrom, graph, seconds, playing, busy]);

  // An SDF Shape / SDF Move inside a scene: the scene's tree and camera for this moment (what is above the node, and how the picture looks)
  const isSdf = def.id === 'sdf-shape' || def.id === 'sdf-transform';
  const viewed = useEd((s) => s.viewedNodeId);
  const [sdfView, setSdfView] = useState<SdfView | null | 'none'>(null);
  useEffect(() => {
    if (!isSdf) return;
    if (dragging.current) return; // what is above the node does not change while it is dragged
    const scene = sdfPictureScene(graph, viewed, ed.registry);
    if (!scene) {
      setSdfView('none');
      return;
    }
    let dead = false;
    loadSdfView(io, graph, scene, { seconds: io.player.getState().seconds, item: ed.state.item, width, height })
      .then((v) => { if (!dead) setSdfView(v ?? 'none'); })
      .catch(() => { if (!dead) setSdfView('none'); });
    return () => { dead = true; };
    // the clock stands still while playing on purpose (see the camera above)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSdf, graph, viewed, seconds, playing, busy, width, height]);
  const fullId = [...path, nodeId].join('/');
  const chain = useMemo(() => (isSdf && sdfView && sdfView !== 'none' ? chainOf(sdfView.root, fullId) : null), [isSdf, sdfView, fullId]);
  const frame = chain?.frame ?? IDENTITY_FRAME;

  const camPending = !!camEdge && cam?.edge !== camFrom;
  const lens: Lens | null = useMemo(() => {
    if (isSdf) return sdfView && sdfView !== 'none' && chain ? lensOf(sdfView.camera, width, height) : null;
    return camPending ? null : lensOf(cameraOf(params, camEdge ? (cam?.value ?? null) : null, width, height), width, height);
  }, [isSdf, sdfView, chain, params, cam, camEdge, camPending, width, height]);

  // Alt + wheel over a handle (or the wheel while the object is held): push away / pull closer. Caught before the viewer's own zoom.
  const live = useRef<{ depth: (f: number) => void } | null>(null);
  useEffect(() => {
    const box = root.current?.parentElement;
    if (!box) return;
    const wheel = (e: WheelEvent) => {
      const onHandle = !!(e.target as Element | null)?.closest?.('.rs-giz__h');
      const held = dragging.current?.wheel;
      if (!held && !(onHandle && e.altKey)) return;
      e.preventDefault();
      e.stopPropagation();
      const f = depthFactorForWheel(e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY);
      if (held) held(f);
      else live.current?.depth(f);
    };
    box.addEventListener('wheel', wheel, { capture: true, passive: false });
    return () => box.removeEventListener('wheel', wheel, { capture: true });
  }, []);

  const t = transformOf(def);
  if (!node || !t || t.kind !== 'object') return <div ref={root} className="rs-giz" />;

  const num = (k: string) => Number(params[k]) || 0;
  const pos: V3 = [num('posX'), num('posY'), num('posZ')];
  const rot: Euler = [num('rotX'), num('rotY'), num('rotZ')];
  const size = Math.max(0.001, num(OBJECT_KEYS.scale));
  const range = (k: string): [number, number] => {
    const p = (def.params as Record<string, { min?: number; max?: number }>)[k];
    return [p?.min ?? -Infinity, p?.max ?? Infinity];
  };
  const off = { move: OBJECT_KEYS.pos.some((k) => wired.has(k)), turn: OBJECT_KEYS.rot.some((k) => wired.has(k)), size: wired.has(OBJECT_KEYS.scale), off: true };
  const key = (what: string) => `giz:${nodeId}:${what}`;

  // `pos` is what the node's own numbers say (in the space of what is above it); the handle lives at `posW`, where the picture shows it
  const posW: V3 = isSdf ? toWorld(frame, pos) : pos;
  const parentR = frame.R;
  const writePos = (w: V3, k: string) => {
    const p = isSdf ? toLocal(frame, w) : w;
    ed.setObjectPose(nodeId, Object.fromEntries(OBJECT_KEYS.pos.map((name, i) => [name, roundTo(clampTo(p[i], ...range(name)), 3)])), k);
  };
  const writeRot = (r: Euler, k: string) => ed.setObjectPose(nodeId, Object.fromEntries(OBJECT_KEYS.rot.map((name, i) => [name, roundTo(clampTo(r[i], ...range(name)), 1)])), k);
  const frameOf = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  live.current = lens && !off.move ? { depth: (f) => writePos(dragDepth(lens, posW, f), key('depth')) } : null;

  /** Common start of every handle drag: the drag is ours alone, and all its edits are one undo step. */
  const begin = (e: React.PointerEvent, onMove: (ev: PointerEvent) => void, wheel?: (factor: number) => void) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.stopPropagation();
    e.preventDefault();
    ed.beginHold();
    dragging.current = { wheel };
    setBusy(true);
    trackPointer(e.nativeEvent, onMove, () => {
      dragging.current = null;
      setBusy(false);
      ed.endHold();
    });
  };

  const startMove = (e: React.PointerEvent) => {
    if (!lens || off.move) return;
    const st = { p0: posW, grab: frameOf(e), now: frameOf(e), cur: posW };
    begin(
      e,
      (ev) => {
        st.now = frameOf(ev);
        const p = dragMove(lens, st.p0, st.grab, st.now);
        if (!p) return;
        st.cur = p;
        writePos(p, key('move'));
      },
      (factor) => {
        // the wheel while holding the object: change its distance and carry on dragging from there
        st.cur = dragDepth(lens, st.cur, factor);
        st.p0 = st.cur;
        st.grab = st.now;
        writePos(st.cur, key('move'));
      },
    );
  };
  const startDepth = (e: React.PointerEvent) => {
    if (!lens || off.move) return;
    const p0 = posW;
    const y0 = e.clientY;
    begin(e, (ev) => writePos(dragDepth(lens, p0, depthFactorForDrag(ev.clientY - y0)), key('move')));
  };
  const startTrackball = (e: React.PointerEvent, radius: number) => {
    if (!lens || off.turn) return;
    const [x0, y0] = [e.clientX, e.clientY];
    const st = { near: rot };
    begin(e, (ev) => {
      st.near = turnTrackball(lens, rot, ev.clientX - x0, ev.clientY - y0, radius, st.near, parentR);
      writeRot(st.near, key('turn'));
    });
  };
  const startRoll = (e: React.PointerEvent, cx: number, cy: number) => {
    if (!lens || off.turn) return;
    const o = root.current!.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => screenAngle(o.left + cx, o.top + cy, ev.clientX, ev.clientY);
    const st = { last: at(e), total: 0, near: rot };
    begin(e, (ev) => {
      const a = at(ev);
      st.total += angleStep(st.last, a);
      st.last = a;
      st.near = turnRoll(lens, rot, st.total, st.near, parentR);
      writeRot(st.near, key('turn'));
    });
  };
  const startSize = (e: React.PointerEvent, cx: number, cy: number) => {
    if (off.size) return;
    const o = root.current!.getBoundingClientRect();
    const dist = (ev: { clientX: number; clientY: number }) => Math.hypot(ev.clientX - o.left - cx, ev.clientY - o.top - cy);
    const d0 = dist(e);
    begin(e, (ev) => ed.setParams(nodeId, { [OBJECT_KEYS.scale]: roundTo(dragScale(size, d0, dist(ev), ...range(OBJECT_KEYS.scale)), 3) }, key('size')));
  };

  const active = MODES.find((m) => m.id === mode);
  const sdfNote = !isSdf ? null : sdfView === 'none' ? 'The picture of the scene is not shown' : sdfView && !chain ? 'Not connected to the Scene Output' : chain ? modHint(chain.mods) : null;
  const resetNow = active ? resetPatch(t, active.reset, wired) : {};
  const bar = (
    <div className="rs-giz__bar rs-viewer__chip" data-nodrag onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {MODES.map((m) => (
        <button key={m.id} className={`rs-btn rs-btn--ghost${m.id === mode ? ' is-on' : ''}`} aria-pressed={m.id === mode} title={`${m.title}${m.id === mode ? ' Press again to put the handles away.' : ''}`} onClick={() => setMode(m.id === mode ? 'off' : m.id)}>{m.label}</button>
      ))}
      {active && <span className="rs-giz__sep" />}
      {!active ? null : off[mode] ? (
        physLink && !physAtStart && edges.some((e) => e.to.node === nodeId && e.to.port === 'xform@motion') ? (
          <span className="rs-giz__note" title="Physics moves this object while the animation plays. Go to the start (time 0) to change where it starts.">Driven by Physics: go to the start to move it</span>
        ) : (
          <span className="rs-giz__note" title="This setting is driven by another node. Disconnect the wire in the inspector to set it by hand.">Driven by a wire</span>
        )
      ) : (
        <button className="rs-btn rs-btn--ghost" title={active.resetTitle} disabled={patchIsNoop(params, resetNow)} onClick={() => ed.setParams(nodeId, resetNow, key('reset'))}>Reset</button>
      )}
      {sdfNote && <span className="rs-giz__note" title={sdfNote}>{sdfNote}</span>}
    </div>
  );

  if (!rect || !lens) return <div ref={root} className="rs-giz">{bar}</div>;

  const pr = projectPoint(lens, posW);
  const shortPx = Math.min(rect.w, rect.h);
  // What the node covers, in the world: a shape or an SDF Move reaches as far as its own sphere (its size is live: the tree is from before the drag)
  let reach: { c: V3; r: number } | null = null;
  if (isSdf && chain) {
    const own = frameOfPlace({ pos, rot, scale: size });
    const kids = chain.node.t === 'shape' ? reachOf({ ...chain.node, pos: [0, 0, 0], scale: 1 }) : reachOf(chain.node.t === 'move' ? { ...chain.node, pos: [0, 0, 0], rot: [0, 0, 0], matrix: undefined, scale: 1 } : chain.node);
    const whole = composeFrames(frame, own);
    reach = { c: toWorld(whole, kids.center), r: Number.isFinite(kids.radius) ? kids.radius * whole.s : OBJECT_RADIUS * whole.s };
  }
  // the handle circle is as large as the object looks, but never too small for a finger nor larger than the pane
  const R = clampTo(screenRadius(lens, reach ? reach.c : posW, reach ? reach.r : OBJECT_RADIUS * size) * shortPx, 40, Math.max(40, Math.min(rect.bw, rect.bh) * 0.4));
  // the quiet outline that says which shape the handles belong to (as large as the shape really looks, down to a small dot)
  const pc = reach ? projectPoint(lens, reach.c) : null;
  const outline = reach && pc && pc.visible ? { x: clampTo(rect.l + pc.x * rect.w, -200, rect.bw + 200), y: clampTo(rect.t + pc.y * rect.h, -200, rect.bh + 200), r: Math.max(8, screenRadius(lens, reach.c, reach.r) * shortPx) } : null;
  // an object that has left the pane keeps its handle at the edge, so it can always be dragged back
  const cx = clampTo(rect.l + pr.x * rect.w, 24, Math.max(24, rect.bw - 24));
  const cy = clampTo(rect.t + pr.y * rect.h, 24, Math.max(24, rect.bh - 24));
  const diag = Math.SQRT1_2;
  const hx = clampTo(cx + (R + TOUCH / 2 + 4) * diag, TOUCH / 2, rect.bw - TOUCH / 2);
  const hy = clampTo(cy + (R + TOUCH / 2 + 4) * diag, TOUCH / 2, rect.bh - TOUCH / 2);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const triad = axisTriad(lens, rot, parentR);

  return (
    <div ref={root} className={`rs-giz${busy ? ' is-busy' : ''}`} data-mode={mode} data-exact={isRectilinear(lens) ? 'yes' : 'no'}>
      {outline && (
        <svg className="rs-giz__svg rs-giz__svg--quiet" width={rect.bw} height={rect.bh} viewBox={`0 0 ${rect.bw} ${rect.bh}`} pointerEvents="none">
          <circle className="rs-giz__pick rs-giz__pick--under" cx={outline.x} cy={outline.y} r={outline.r} />
          <circle className="rs-giz__pick" cx={outline.x} cy={outline.y} r={outline.r} />
        </svg>
      )}
      {pr.visible && !off[mode] && (
        <svg className="rs-giz__svg" width={rect.bw} height={rect.bh} viewBox={`0 0 ${rect.bw} ${rect.bh}`}>
          {mode === 'move' && (
            <>
              <g className="rs-giz__h rs-giz__h--move" data-nodrag data-giz="move" transform={`translate(${cx} ${cy})`} onPointerDown={startMove} onDoubleClick={stop}>
                <title>Drag to move the object. Alt + mouse wheel: push away or pull closer.</title>
                <circle className="rs-giz__hit" r={Math.max(R, TOUCH / 2)} />
                <circle className="rs-giz__line rs-giz__line--under" r={R} />
                <circle className="rs-giz__line" r={R} />
                <path className="rs-giz__glyph rs-giz__glyph--under" d="M-14 0h28 M0 -14v28 M-14 0l5 -5 M-14 0l5 5 M14 0l-5 -5 M14 0l-5 5 M0 -14l-5 5 M0 -14l5 5 M0 14l-5 -5 M0 14l5 -5" />
                <path className="rs-giz__glyph" d="M-14 0h28 M0 -14v28 M-14 0l5 -5 M-14 0l5 5 M14 0l-5 -5 M14 0l-5 5 M0 -14l-5 5 M0 -14l5 5 M0 14l-5 -5 M0 14l5 -5" />
              </g>
              <g className="rs-giz__h rs-giz__h--depth" data-nodrag data-giz="depth" transform={`translate(${hx} ${hy})`} onPointerDown={startDepth} onDoubleClick={stop}>
                <title>Depth: drag up to push the object away, down to pull it closer.</title>
                <circle className="rs-giz__hit" r={TOUCH / 2} />
                <circle className="rs-giz__knob" r={15} />
                <path className="rs-giz__glyph rs-giz__glyph--dark" d="M0 -9v18 M0 -9l-4 4 M0 -9l4 4 M0 9l-4 -4 M0 9l4 -4" />
              </g>
            </>
          )}
          {mode === 'turn' && (
            <>
              <g className="rs-giz__h rs-giz__h--roll" data-nodrag data-giz="roll" transform={`translate(${cx} ${cy})`} onPointerDown={(e) => startRoll(e, cx, cy)} onDoubleClick={stop}>
                <title>Drag round the ring to roll the object.</title>
                <circle className="rs-giz__hitring" r={R + TOUCH / 2} strokeWidth={TOUCH} />
                <circle className="rs-giz__line rs-giz__line--under" r={R + TOUCH / 2} />
                <circle className="rs-giz__line rs-giz__line--ring" r={R + TOUCH / 2} />
              </g>
              <g className="rs-giz__h rs-giz__h--ball" data-nodrag data-giz="ball" transform={`translate(${cx} ${cy})`} onPointerDown={(e) => startTrackball(e, R)} onDoubleClick={stop}>
                <title>Drag to turn the object: the side facing you follows the pointer.</title>
                <circle className="rs-giz__hit" r={R} />
                <circle className="rs-giz__line rs-giz__line--under" r={R} />
                <circle className="rs-giz__line" r={R} />
                {triad.map(([ax, ay], i) => (
                  <g key={i} className={`rs-giz__axis rs-giz__axis--${'xyz'[i]}`}>
                    <line className="rs-giz__axisunder" x2={ax * R * 0.8} y2={ay * R * 0.8} />
                    <line x2={ax * R * 0.8} y2={ay * R * 0.8} />
                    <text x={ax * R * 0.8 + ax * 9} y={ay * R * 0.8 + ay * 9 + 4} textAnchor="middle">{'XYZ'[i]}</text>
                  </g>
                ))}
              </g>
            </>
          )}
          {mode === 'size' && (
            <>
              <g transform={`translate(${cx} ${cy})`} pointerEvents="none">
                <circle className="rs-giz__line rs-giz__line--under" r={R} />
                <circle className="rs-giz__line" r={R} />
              </g>
              <g className="rs-giz__h rs-giz__h--size" data-nodrag data-giz="size" transform={`translate(${cx + R * diag} ${cy + R * diag})`} onPointerDown={(e) => startSize(e, cx, cy)} onDoubleClick={stop}>
                <title>Drag away from the object to make it larger, towards it to make it smaller.</title>
                <circle className="rs-giz__hit" r={TOUCH / 2} />
                <rect className="rs-giz__knob" x={-9} y={-9} width={18} height={18} />
              </g>
            </>
          )}
        </svg>
      )}
      {bar}
    </div>
  );
}
