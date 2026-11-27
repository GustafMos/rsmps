/**
 * Pointer gestures for the node graph. Everything here works on refs and CSS transforms; the
 * store is only touched when a gesture ends (or when selection changes).
 */
import type { DragEvent as RDragEvent, MouseEvent as RMouseEvent, PointerEvent as RPointerEvent } from 'react';
import { connectError, disconnect, inputType, outputType, wiresInto } from '../../engine/graph';
import { defOf, GROUP_IN, GROUP_OUT, GROUP_TYPE, NEW_PORT } from '../../engine/group';
import { NODE_FILE_EXT, NODE_FILE_MAX_BYTES } from '../../io/node-presets';
import type { AppCtx } from '../store/context';
import { LongPress } from '../responsive/longPress';
import { abortAllTracking, trackPointer } from '../lib/drag';
import {
  boundsOf,
  distToPolyline,
  edgeEndpoints,
  edgePolylines,
  frameRects,
  nodeRects,
  polylineCrosses,
  rectsIntersect,
  type Rect,
} from '../lib/geometry';
import { layoutFor, socketWorld, wirePath } from '../lib/layout';
import { inputsAccepting } from '../lib/sockets';
import { compatibleSockets } from '../lib/compat';
import { wireError } from '../lib/wireConvert';
import type { SocketType } from '../../engine/types';
import { wireStore } from '../graph-touch/graphTouch';
import { showBundleSockets } from '../store/nodeView';

const THRESHOLD = 3;
export const ASSET_MIME = 'application/x-rsmps-asset';

export type Gestures = ReturnType<typeof createGestures>;

export function createGestures(app: AppCtx) {
  const { ed, io, graphCtl: ctl } = app;
  const reg = io.registry;

  const cls = (name: string, on: boolean) => ctl.root?.classList.toggle(name, on);
  const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

  function updateEdges(offsets: ReadonlyMap<string, { dx: number; dy: number }>) {
    const g = ed.state.level;
    for (const e of g.edges) {
      if (!offsets.has(e.from.node) && !offsets.has(e.to.node)) continue;
      const ep = edgeEndpoints(g, reg, e, offsets);
      const els = ctl.edgeEls.get(e.id);
      if (ep && els) {
        const d = wirePath(ep.from, ep.to);
        els.forEach((p) => p.setAttribute('d', d));
      }
    }
  }

  function clearSpace() {
    ctl.spaceDown = false;
    ctl.spaceCode = null;
    cls('is-space', false);
  }

  /** Back to idle: every transient gesture flag, class and preview. Idempotent; called after anything that can swallow pointerup. */
  function reset() {
    abortAllTracking();
    clearSpace();
    for (const c of ['is-panning', 'is-dragging', 'is-wiring', 'is-boxing', 'is-drop']) cls(c, false);
    if (ctl.box) ctl.box.style.display = 'none';
    if (ctl.cut) ctl.cut.style.display = 'none';
    if (ctl.hint) ctl.hint.style.display = 'none';
    ctl.pending?.removeAttribute('d');
    ctl.pendingOut = null;
    if (!wireStore.get().pending) showBundleSockets(false);
    ctl.root?.querySelectorAll('.is-insert').forEach((x) => x.classList.remove('is-insert'));
    ctl.edgeEls.forEach((els) => els.forEach((p) => (p.style.display = '')));
  }

  /* ------------------------------- panning -------------------------------- */

  function startPan(e: RPointerEvent) {
    ctl.needsFit = false;
    const v0 = { ...ctl.view };
    const x0 = e.clientX;
    const y0 = e.clientY;
    cls('is-panning', true);
    ctl.spaceUsed = true;
    trackPointer(e, (ev) => {
      ctl.view.x = v0.x + ev.clientX - x0;
      ctl.view.y = v0.y + ev.clientY - y0;
      ctl.applyView();
    }, () => cls('is-panning', false));
  }

  /* ----------------------------- node dragging ---------------------------- */

  function startNodeDrag(e: RPointerEvent, id: string) {
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (e.ctrlKey && e.shiftKey) {
      ed.setViewed(id);
      return;
    }
    const before = ed.state.selection;
    let deferSingle = false;
    // Shift-drag on a single node detaches it from its chain (decided by movement; a plain Shift-click still toggles selection)
    const shiftDrag = e.shiftKey && !e.ctrlKey && !e.metaKey;
    let toggledOff = false;
    if (additive) {
      ed.select([id], 'toggle');
      if (!ed.state.selection.includes(id)) {
        if (!shiftDrag) return;
        toggledOff = true;
      }
    } else if (!before.includes(id)) ed.select([id]);
    else deferSingle = before.length > 1;

    const g0 = ed.state.level;
    const ids = [...ed.state.selection];
    const idSet = new Set(ids);
    const nodes = ids.map((i) => g0.nodes.find((n) => n.id === i)!).filter(Boolean);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const rects = nodeRects(g0, reg);
    const single = nodes.length === 1 ? nodes[0] : null;
    const connected = g0.edges.some((ed2) => idSet.has(ed2.from.node) || idSet.has(ed2.to.node));
    const canDetach = shiftDrag && (toggledOff || ids.length === 1);
    let detach = false;
    const polylines = single && (!connected || canDetach) ? edgePolylines(g0, reg) : null;
    const hintAt = (ev: PointerEvent, text: string | null) => {
      const h = ctl.hint;
      if (!h) return;
      if (!text) { h.style.display = 'none'; return; }
      h.textContent = text;
      h.style.display = 'block';
      h.style.left = `${ev.clientX + 14}px`;
      h.style.top = `${ev.clientY + 14}px`;
    };
    let moved = false;
    let insert: string | null = null;
    let offsets = new Map<string, { dx: number; dy: number }>();

    const setInsert = (edgeId: string | null) => {
      if (edgeId === insert) return;
      if (insert) ctl.edgeEls.get(insert)?.[1]?.classList.remove('is-insert');
      insert = edgeId;
      if (insert) ctl.edgeEls.get(insert)?.[1]?.classList.add('is-insert');
    };

    trackPointer(
      e,
      (ev) => {
        if (!moved && dist(ev.clientX, ev.clientY, x0, y0) < THRESHOLD) return;
        if (!moved) {
          cls('is-dragging', true);
          if (canDetach && toggledOff) ed.select([id]); // the Shift-click toggled it off: this is a drag, keep it selected
          detach = canDetach && connected;
        }
        moved = true;
        const dx = Math.round((ev.clientX - x0) / ctl.view.zoom);
        const dy = Math.round((ev.clientY - y0) / ctl.view.zoom);
        offsets = new Map(ids.map((i) => [i, { dx, dy }]));
        for (const n of nodes) {
          const el = ctl.nodeEls.get(n.id);
          if (el) el.style.transform = `translate(${n.x + dx}px, ${n.y + dy}px)`;
        }
        updateEdges(offsets);
        if (single && polylines) {
          const r = rects.get(single.id)!;
          const c = { x: r.x + dx + r.w / 2, y: r.y + dy + r.h / 2 };
          let best: string | null = null;
          let bestD = 28 / ctl.view.zoom;
          const def = defOf(reg, single);
          for (const [eid, pts] of polylines) {
            const ed2 = g0.edges.find((x) => x.id === eid);
            if (detach && ed2 && (ed2.from.node === single.id || ed2.to.node === single.id)) continue; // its own wires go away when it is detached
            const d = distToPolyline(c, pts);
            if (d < bestD && def && edgeAccepts(eid, single)) {
              best = eid;
              bestD = d;
            }
          }
          setInsert(best);
          hintAt(ev, best ? 'Insert here' : detach ? 'Shift: move out of chain' : null);
        }
      },
      () => {
        cls('is-dragging', false);
        if (ctl.hint) ctl.hint.style.display = 'none';
        const ins = insert;
        setInsert(null);
        if (!moved) {
          if (deferSingle) ed.select([id]);
          return;
        }
        const first = offsets.values().next().value;
        if (first && first.dx === 0 && first.dy === 0 && !ins) return;
        ed.finishDrag(offsets, ins, detach ? id : undefined);
      },
    );
  }

  function edgeAccepts(edgeId: string, node: { type: string; params: Record<string, unknown> }): boolean {
    const g = ed.state.level;
    const edge = g.edges.find((x) => x.id === edgeId);
    const def = defOf(reg, node);
    if (!edge || !def || Object.keys(def.outputs).length === 0) return false;
    const ft = outputType(g, reg, edge.from.node, edge.from.port);
    return !!ft && inputsAccepting(def, ft).some((p) => p in def.inputs);
  }

  function startFrameDrag(e: RPointerEvent, frameId: string) {
    ed.selectFrame(frameId);
    const g0 = ed.state.level;
    const members = g0.nodes.filter((n) => n.frame === frameId);
    const fr = frameRects(g0, reg).get(frameId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    let offsets = new Map<string, { dx: number; dy: number }>();
    trackPointer(
      e,
      (ev) => {
        if (!moved && dist(ev.clientX, ev.clientY, x0, y0) < THRESHOLD) return;
        moved = true;
        const dx = Math.round((ev.clientX - x0) / ctl.view.zoom);
        const dy = Math.round((ev.clientY - y0) / ctl.view.zoom);
        offsets = new Map(members.map((n) => [n.id, { dx, dy }]));
        for (const n of members) {
          const el = ctl.nodeEls.get(n.id);
          if (el) el.style.transform = `translate(${n.x + dx}px, ${n.y + dy}px)`;
        }
        const fe = ctl.frameEls.get(frameId);
        if (fe && fr) fe.style.transform = `translate(${fr.x + dx}px, ${fr.y + dy}px)`;
        updateEdges(offsets);
      },
      () => {
        if (moved) ed.finishDrag(offsets, null);
      },
    );
  }

  /* -------------------------------- wiring -------------------------------- */

  function startWire(e: RPointerEvent, sock: HTMLElement) {
    const g = ed.state.level;
    const node = sock.dataset.node!;
    const port = sock.dataset.port!;
    const dir = sock.dataset.dir as 'in' | 'out';
    let fixed: { side: 'out' | 'in'; node: string; port: string; type: SocketType };
    let detached: string | null = null;
    if (dir === 'out') {
      const t = outputType(g, reg, node, port);
      if (!t) return;
      fixed = { side: 'out', node, port, type: t };
    } else {
      const it = inputType(g, reg, node, port);
      if (!it) return;
      const slotAttr = sock.dataset.slot;
      const existing = slotAttr !== undefined ? wiresInto(g, node, port)[Number(slotAttr)] : !it.multi ? g.edges.find((x) => x.to.node === node && x.to.port === port) : undefined;
      if (existing) {
        const t = outputType(g, reg, existing.from.node, existing.from.port);
        if (!t) return;
        fixed = { side: 'out', node: existing.from.node, port: existing.from.port, type: t };
        detached = existing.id;
        ctl.edgeEls.get(existing.id)?.forEach((p) => (p.style.display = 'none'));
      } else fixed = { side: 'in', node, port, type: it.type };
    }
    const fnode = g.nodes.find((n) => n.id === fixed.node)!;
    const fpos = socketWorld(fnode, layoutFor(g, fnode, defOf(reg, fnode)), fixed.side === 'out' ? 'out' : 'in', fixed.port);

    // dim everything that cannot accept this wire
    const sockets = Array.from(ctl.root!.querySelectorAll<HTMLElement>('[data-sock]'));
    const errorFor = (el: HTMLElement): string | null => {
      const d = el.dataset.dir;
      const n = el.dataset.node!;
      const p = el.dataset.port!;
      // the "+" socket of an open group's boundary: a new port of whatever type is dragged onto it
      if (p === NEW_PORT) return (fixed.side === 'out' && n === GROUP_OUT && d === 'in') || (fixed.side === 'in' && n === GROUP_IN && d === 'out') ? null : 'Drop on a socket of the right side';
      if (fixed.side === 'out') {
        if (d !== 'in') return 'Drop on an input socket';
        return wireError(g, reg, { node: fixed.node, port: fixed.port }, { node: n, port: p });
      }
      if (d !== 'out') return 'Drop on an output socket';
      return wireError(g, reg, { node: n, port: p }, { node: fixed.node, port: fixed.port });
    };
    /** Dropping an output on another output always makes a NEW node joining them (image/mask -> Stack Layers, audio -> Mixer, sdf -> SDF Combine). */
    const mergeTarget = (el: HTMLElement): boolean => {
      if (fixed.side !== 'out' || detached || el.dataset.dir !== 'out' || el.dataset.node === fixed.node) return false;
      const t = el.dataset.type as SocketType;
      const vis = (x: SocketType) => x === 'image' || x === 'mask';
      if (vis(fixed.type) && vis(t)) return !!reg.get('stack');
      if (fixed.type === 'sdf' && t === 'sdf') return !!reg.get('sdf-combine');
      return fixed.type === 'audio' && t === 'audio' && !!reg.get('mixer');
    };
    for (const s of sockets) if (errorFor(s) && !mergeTarget(s)) s.dataset.dim = '1';
    cls('is-wiring', true);
    // a vector wire being dragged: the nodes show their bundle sockets (one socket for an X / Y / Z group) so one can be hit
    showBundleSockets(fixed.side === 'out' && (fixed.type === 'vector' || fixed.type === 'motion'));
    const path = ctl.pending;
    path?.setAttribute('class', `rs-wire rs-wire--${fixed.type} is-pending`);
    let target: HTMLElement | null = null;
    let hoverId: string | null = null;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    let mergeTo: HTMLElement | null = null;
    let moved = false;
    let addEl: HTMLElement | null = null; // the node body the wire would be added to
    const held = { node: fixed.node, port: fixed.port };

    const findTarget = (ev: PointerEvent): { el: HTMLElement; err: string | null; merge?: boolean } | null => {
      const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const s = hit?.closest<HTMLElement>('[data-sock], [data-insp-sock]');
      if (s) return { el: s, err: errorFor(s), merge: mergeTarget(s) };
      if (fixed.side === 'in') {
        const nodeEl = hit?.closest<HTMLElement>('[data-node-id]');
        const cand = nodeEl && Array.from(nodeEl.querySelectorAll<HTMLElement>('[data-sock]')).find((c) => !errorFor(c));
        if (cand) return { el: cand, err: null };
      }
      return null;
    };

    const draw = (ev: PointerEvent) => {
      const w = ctl.toWorld(ev.clientX, ev.clientY);
      let end = w;
      if (target) {
        const r = target.getBoundingClientRect();
        end = ctl.toWorld(r.left + r.width / 2, r.top + r.height / 2);
      }
      path?.setAttribute('d', fixed.side === 'out' ? wirePath(fpos, end) : wirePath(end, fpos));
    };
    draw(e.nativeEvent);

    trackPointer(
      e,
      (ev) => {
        moved = moved || dist(ev.clientX, ev.clientY, e.clientX, e.clientY) > THRESHOLD;
        const found = findTarget(ev);
        // hovering a node body for a moment opens the picker of every compatible socket (hidden params included)
        if (fixed.side === 'out' && !detached) {
          const h = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
          const nid = !found ? (h?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? null) : null;
          const inPicker = !!h?.closest('.rs-sp');
          if (nid !== hoverId && !inPicker) {
            hoverId = nid;
            clearTimeout(hoverTimer);
            if (ed.state.socketPicker && ed.state.socketPicker.node !== nid) ed.openSocketPicker(null);
            if (nid && nid !== fixed.node && !ed.state.socketPicker && !(ed.multiTarget(held, nid) && !ed.multiTarget(held, nid)!.error)) {
              hoverTimer = setTimeout(() => {
                if (compatibleSockets(ed.state.level, reg, nid, { node: fixed.node, port: fixed.port }).length) ed.openSocketPicker({ node: nid, from: fixed, x: ev.clientX + 14, y: ev.clientY + 14 });
              }, 500);
            }
          }
        }
        // over a node body that has a multi-wire input: dropping adds to that node (a badge says so), unlike the join badge on an output socket
        const bodyEl = fixed.side === 'out' && !detached && !found ? (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-node-id]') ?? null : null;
        const add = bodyEl?.dataset.nodeId ? ed.multiTarget(held, bodyEl.dataset.nodeId) : null;
        const addNext = add && !add.error ? bodyEl : null;
        if (addEl && addEl !== addNext) addEl.removeAttribute('data-add-to');
        addEl = addNext;
        if (addEl && add) addEl.dataset.addTo = add.label;
        if (target && target !== found?.el) {
          delete target.dataset.ok;
          delete target.dataset.bad;
        }
        mergeTo?.removeAttribute('data-merge');
        mergeTo = found?.merge ? found.el : null;
        if (mergeTo) mergeTo.dataset.merge = fixed.type === 'audio' ? 'mix' : fixed.type === 'sdf' ? 'combine' : 'stack';
        target = found && !found.err ? found.el : null;
        if (found?.el && !found.merge) {
          if (found.err) found.el.dataset.bad = '1';
          else found.el.dataset.ok = '1';
        }
        if (ctl.hint) {
          if (found?.err && !found.merge) {
            ctl.hint.textContent = found.err;
            ctl.hint.style.display = 'block';
            ctl.hint.style.left = `${ev.clientX + 14}px`;
            ctl.hint.style.top = `${ev.clientY + 14}px`;
          } else ctl.hint.style.display = 'none';
        }
        draw(ev);
      },
      (ev, cancelled) => {
        clearTimeout(hoverTimer);
        addEl?.removeAttribute('data-add-to');
        sockets.forEach((s) => {
          delete s.dataset.dim;
          delete s.dataset.merge;
          delete s.dataset.ok;
          delete s.dataset.bad;
        });
        cls('is-wiring', false);
        if (ctl.hint) ctl.hint.style.display = 'none';
        path?.removeAttribute('d');
        if (detached) ctl.edgeEls.get(detached)?.forEach((p) => (p.style.display = ''));
        if (cancelled) return;
        if (mergeTo) {
          if (ed.state.socketPicker) ed.openSocketPicker(null);
          ed.mergeOutputs({ node: fixed.node, port: fixed.port }, { node: mergeTo.dataset.node!, port: mergeTo.dataset.port! });
          return;
        }
        if (target) {
          const to = { node: target.dataset.node!, port: target.dataset.port! };
          const from = fixed.side === 'out' ? { node: fixed.node, port: fixed.port } : to;
          const dst = fixed.side === 'out' ? to : { node: fixed.node, port: fixed.port };
          const slot = target.dataset.slot !== undefined ? Number(target.dataset.slot) : undefined;
          if (detached) ed.editLevel((gr) => ed.connectSlot(disconnect(gr, detached!), from, dst, slot));
          else ed.connect(from, dst, slot);
          return;
        }
        if (!moved) {
          if (fixed.side === 'out' && !detached) {
            ctl.pendingOut = { node: fixed.node, port: fixed.port };
            ed.toast('Click another output to join the two, or a node to add this to it.', 'info');
          }
          return;
        }
        const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const pick = hit?.closest<HTMLElement>('[data-pick]');
        const pk = ed.state.socketPicker;
        if (pk && pick) {
          ed.openSocketPicker(null);
          ed.connect({ node: fixed.node, port: fixed.port }, { node: pk.node, port: pick.dataset.pick! });
          return;
        }
        if (pk && hit?.closest('.rs-sp')) return;
        const bodyNode = hit?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
        // dropped on a node's body: it becomes one more wire of that node's multi input (Stack layer, Mixer input, ...). Nodes without one fall through.
        if (!detached && fixed.side === 'out' && bodyNode && ed.multiTarget(held, bodyNode)) {
          if (ed.state.socketPicker) ed.openSocketPicker(null);
          ed.addToNode(held, bodyNode);
          return;
        }
        // dropped on the body of an open group's boundary: a new group port
        if (!detached && ((fixed.side === 'out' && bodyNode === GROUP_OUT) || (fixed.side === 'in' && bodyNode === GROUP_IN))) {
          if (fixed.side === 'out') ed.connect({ node: fixed.node, port: fixed.port }, { node: GROUP_OUT, port: NEW_PORT });
          else ed.connect({ node: GROUP_IN, port: NEW_PORT }, { node: fixed.node, port: fixed.port });
          return;
        }
        if (fixed.side === 'out' && !detached && bodyNode && bodyNode !== fixed.node) {
          const list = compatibleSockets(ed.state.level, reg, bodyNode, { node: fixed.node, port: fixed.port });
          if (list.length === 1) ed.connect({ node: fixed.node, port: fixed.port }, { node: bodyNode, port: list[0].port });
          else if (list.length === 0) ed.toast('Nothing on that node accepts this wire.', 'error');
          else ed.openSocketPicker({ node: bodyNode, from: fixed, x: ev.clientX + 10, y: ev.clientY + 10 });
          return;
        }
        const onSocket = hit?.closest('[data-sock]');
        if (onSocket) {
          const err = errorFor(onSocket as HTMLElement);
          if (err) ed.toast(err, 'error');
          return;
        }
        if (hit?.closest('[data-node-id]')) return;
        if (detached) {
          ed.disconnect(detached);
          return;
        }
        ed.openAddMenu({ clientX: ev.clientX, clientY: ev.clientY, world: ctl.toWorld(ev.clientX, ev.clientY), link: fixed });
      },
    );
  }

  /* ------------------------------ box select ------------------------------ */

  function startBox(e: RPointerEvent) {
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const base = additive ? [...ed.state.selection] : [];
    const rects = nodeRects(ed.state.level, reg);
    const r0 = ctl.rect();
    const x0 = e.clientX - r0.left;
    const y0 = e.clientY - r0.top;
    let moved = false;
    trackPointer(
      e,
      (ev) => {
        const x = ev.clientX - r0.left;
        const y = ev.clientY - r0.top;
        if (!moved && dist(x, y, x0, y0) < THRESHOLD) return;
        if (!moved) cls('is-boxing', true);
        moved = true;
        const b = ctl.box;
        if (b) {
          b.style.display = 'block';
          b.style.left = `${Math.min(x, x0)}px`;
          b.style.top = `${Math.min(y, y0)}px`;
          b.style.width = `${Math.abs(x - x0)}px`;
          b.style.height = `${Math.abs(y - y0)}px`;
        }
        const a = ctl.toWorld(Math.min(ev.clientX, e.clientX), Math.min(ev.clientY, e.clientY));
        const c = ctl.toWorld(Math.max(ev.clientX, e.clientX), Math.max(ev.clientY, e.clientY));
        const box: Rect = { x: a.x, y: a.y, w: c.x - a.x, h: c.y - a.y };
        const hits: string[] = [];
        for (const [id, r] of rects) if (rectsIntersect(box, r)) hits.push(id);
        ed.select([...new Set([...base, ...hits])]);
      },
      () => {
        cls('is-boxing', false);
        if (ctl.box) ctl.box.style.display = 'none';
        if (!moved && !additive) ed.select([]);
      },
    );
  }

  /* -------------------------- right button / cutting ----------------------- */

  function startCut(e: RPointerEvent) {
    const g = ed.state.level;
    const polys = edgePolylines(g, reg);
    const a = ctl.toWorld(e.clientX, e.clientY);
    const r0 = ctl.rect();
    const line = ctl.cut;
    let b = a;
    const show = (cx: number, cy: number) => {
      if (!line) return;
      line.setAttribute('x1', String(e.clientX - r0.left));
      line.setAttribute('y1', String(e.clientY - r0.top));
      line.setAttribute('x2', String(cx - r0.left));
      line.setAttribute('y2', String(cy - r0.top));
      line.style.display = 'block';
    };
    trackPointer(
      e,
      (ev) => {
        b = ctl.toWorld(ev.clientX, ev.clientY);
        show(ev.clientX, ev.clientY);
      },
      (ev, cancelled) => {
        if (line) line.style.display = 'none';
        if (cancelled) return;
        const short = dist(ev.clientX, ev.clientY, e.clientX, e.clientY) < 4;
        const kill: string[] = [];
        for (const [id, pts] of polys) {
          if (short ? distToPolyline(a, pts) < 8 / ctl.view.zoom : polylineCrosses(pts, a, b)) kill.push(id);
        }
        if (kill.length) ed.editLevel((gr) => ({ ...gr, edges: gr.edges.filter((x) => !kill.includes(x.id)) }));
      },
    );
  }

  function startRight(e: RPointerEvent) {
    if (e.ctrlKey || e.metaKey) {
      startCut(e);
      return;
    }
    const target = e.target as HTMLElement;
    const nodeEl = target.closest<HTMLElement>('[data-node-id]');
    const edgeId = target.closest<HTMLElement>('[data-edge]')?.getAttribute('data-edge');
    trackPointer(e, () => undefined, (ev, cancelled) => {
      if (cancelled || dist(ev.clientX, ev.clientY, e.clientX, e.clientY) > 4) return;
      if (!nodeEl && edgeId) {
        ed.openContextMenu({ clientX: ev.clientX, clientY: ev.clientY, nodeId: null, edgeId });
      } else if (nodeEl) {
        const id = nodeEl.dataset.nodeId!;
        if (!ed.state.selection.includes(id)) ed.select([id]);
        ed.openContextMenu({ clientX: ev.clientX, clientY: ev.clientY, nodeId: id, paramKey: target.closest<HTMLElement>('[data-param-key]')?.dataset.paramKey });
      } else {
        ed.openAddMenu({ clientX: ev.clientX, clientY: ev.clientY, world: ctl.toWorld(ev.clientX, ev.clientY), context: true });
      }
    });
  }

  /**
   * Touch / pen: press and hold (500 ms, without moving more than 8 px: the shared `LongPress` recogniser) opens the same menu a right-click
   * does at that point: node, wire or the add menu on the background. A second finger (pinch) or any other pointer ends the press.
   * Parameter rows and wire taps are handled by the touch layer (src/ui/graph-touch/graphTouch.ts); this one never runs for the mouse.
   */
  function armLongPress(e: RPointerEvent) {
    const nodeEl = (e.target as HTMLElement).closest<HTMLElement>('[data-node-id]');
    const edgeId = (e.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.getAttribute('data-edge');
    const lp = new LongPress({
      onFire: (x0, y0) => {
        off();
        if (nodeEl) {
          const id = nodeEl.dataset.nodeId!;
          if (!ed.state.selection.includes(id)) ed.select([id]);
          ed.openContextMenu({ clientX: x0, clientY: y0, nodeId: id });
        } else if (edgeId) ed.openContextMenu({ clientX: x0, clientY: y0, nodeId: null, edgeId });
        else ed.openAddMenu({ clientX: x0, clientY: y0, world: ctl.toWorld(x0, y0), context: true });
      },
    });
    const mv = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId || !lp.move(ev.clientX, ev.clientY, ev.pointerId)) off();
    };
    const other = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) off();
    };
    function off() {
      lp.cancel();
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', off);
      window.removeEventListener('pointercancel', off);
      window.removeEventListener('pointerdown', other, true);
    }
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', off);
    window.addEventListener('pointercancel', off);
    window.addEventListener('pointerdown', other, true);
    lp.start(e.clientX, e.clientY, e.pointerId);
  }

  /* -------------------------------- dispatch ------------------------------- */

  return {
    reset,
    onPointerDown(e: RPointerEvent<HTMLElement>) {
      ctl.root?.focus({ preventScroll: true });
      ctl.pointer = { x: e.clientX, y: e.clientY };
      if (ed.state.addMenu || ed.state.contextMenu) {
        ed.openAddMenu(null);
        ed.openContextMenu(null);
      }
      const t = e.target as HTMLElement;
      // Space-pan only counts while the key is really down (a lost keyup must not leave the graph stuck in pan mode)
      if (ctl.spaceDown && !(ctl.spaceCode && ctl.keysDown.has(ctl.spaceCode))) clearSpace();
      if (e.button === 1 || (e.button === 0 && ctl.spaceDown)) {
        e.preventDefault();
        startPan(e);
        return;
      }
      if (e.button === 2) {
        e.preventDefault();
        startRight(e);
        return;
      }
      if (e.button !== 0) return;
      if (e.pointerType !== 'mouse') armLongPress(e);
      if (e.altKey) {
        startCut(e);
        return;
      }
      if (t.closest('[data-nodrag]')) {
        const nodeEl = t.closest<HTMLElement>('[data-node-id]');
        if (nodeEl && !ed.state.selection.includes(nodeEl.dataset.nodeId!)) ed.select([nodeEl.dataset.nodeId!]);
        return;
      }
      const sock = t.closest<HTMLElement>('[data-sock]');
      const pend = ctl.pendingOut;
      ctl.pendingOut = null;
      if (sock && pend && sock.dataset.dir === 'out' && sock.dataset.node !== pend.node) {
        e.preventDefault();
        if (ed.state.socketPicker) ed.openSocketPicker(null);
        ed.mergeOutputs(pend, { node: sock.dataset.node!, port: sock.dataset.port! });
        return;
      }
      if (sock) {
        e.preventDefault();
        startWire(e, sock);
        return;
      }
      const nodeEl = t.closest<HTMLElement>('[data-node-id]');
      if (nodeEl && pend && nodeEl.dataset.nodeId !== pend.node && ed.multiTarget(pend, nodeEl.dataset.nodeId!)) {
        e.preventDefault();
        ed.addToNode(pend, nodeEl.dataset.nodeId!);
        return;
      }
      if (nodeEl) {
        e.preventDefault();
        startNodeDrag(e, nodeEl.dataset.nodeId!);
        return;
      }
      const head = t.closest<HTMLElement>('[data-frame-head]');
      if (head) {
        e.preventDefault();
        startFrameDrag(e, head.dataset.frameHead!);
        return;
      }
      e.preventDefault();
      startBox(e);
    },

    onDoubleClick(e: RMouseEvent<HTMLElement>) {
      // double-click a group node (not its title, which renames it): open it
      const el = e.target as HTMLElement;
      const nodeId = el.closest?.('[data-node-id]')?.getAttribute('data-node-id');
      if (nodeId && !el.closest('.rs-node__title, [data-nodrag], input, select, button')) {
        const n = ed.state.level.nodes.find((x) => x.id === nodeId);
        if (n?.type === GROUP_TYPE) {
          ed.enterGroup(nodeId);
          return;
        }
      }
      const edgeId = (e.target as HTMLElement).closest?.('[data-edge]')?.getAttribute('data-edge');
      if (edgeId && reg.get('reroute')) ed.addReroute(edgeId, ctl.toWorld(e.clientX, e.clientY));
    },

    onPointerMove(e: RPointerEvent<HTMLElement>) {
      ctl.pointer = { x: e.clientX, y: e.clientY };
    },

    onDragOver(e: RDragEvent<HTMLElement>) {
      const types = Array.from(e.dataTransfer.types);
      if (types.includes(ASSET_MIME) || types.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        cls('is-drop', true);
      }
    },
    onDragLeave() {
      cls('is-drop', false);
    },
    async onDrop(e: RDragEvent<HTMLElement>) {
      cls('is-drop', false);
      const at = ctl.toWorld(e.clientX, e.clientY);
      const raw = e.dataTransfer.getData(ASSET_MIME);
      if (raw) {
        e.preventDefault();
        try {
          const ids = JSON.parse(raw) as string[];
          placeAssets(ids, at);
        } catch {
          /* ignore */
        }
        return;
      }
      if (e.dataTransfer.files.length) {
        e.preventDefault();
        const all = Array.from(e.dataTransfer.files);
        // saved group nodes (.rsmps-node.json): validated (data only) and added as an editable copy
        const nodeFiles = all.filter((f) => f.name.toLowerCase().endsWith(NODE_FILE_EXT));
        let y = at.y;
        for (const f of nodeFiles) {
          try {
            if (f.size > NODE_FILE_MAX_BYTES) throw new Error('This file is too large for a saved node.');
            const parsed = io.nodePresets.parse(await f.text());
            ed.addGroupNode(io.nodePresets.instantiate(parsed), { x: Math.round(at.x), y: Math.round(y) });
            y += 160;
            ed.toast(`Added "${parsed.name}"`, 'ok', [{ label: 'Keep in add menu', run: () => void io.nodePresets.importFile(f).then(() => ed.toast(`"${parsed.name}" is in the add menu under its category`, 'ok'), (err) => ed.toast(err instanceof Error ? err.message : String(err), 'error')) }]);
          } catch (err) {
            ed.toast(`${f.name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
          }
        }
        const files = all.filter((f) => !nodeFiles.includes(f));
        if (!files.length) return;
        try {
          const infos = await io.library.add(files);
          placeAssets(infos.map((i) => i.id), at);
        } catch (err) {
          ed.toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
      }
    },
  };

  function placeAssets(ids: string[], at: { x: number; y: number }) {
    const lib = io.library.list();
    const byKind = new Map<string, string[]>();
    for (const id of ids) {
      const k = lib.find((a) => a.id === id)?.kind;
      if (k) byKind.set(k, [...(byKind.get(k) ?? []), id]);
    }
    // images and videos share one node
    const groups = new Map<string, string[]>();
    for (const [k, v] of byKind) {
      const key = k === 'video' ? 'image' : k;
      groups.set(key, [...(groups.get(key) ?? []), ...v]);
    }
    let y = at.y;
    for (const v of groups.values()) {
      ed.addAssetNode(v, { x: Math.round(at.x), y: Math.round(y) });
      y += 150;
    }
  }
}

/** Frame the whole graph (or the selection) in the viewport. */
export function frameGraph(app: AppCtx, selectionOnly = false): void {
  const { ed, io, graphCtl } = app;
  const g = ed.state.level;
  const rects = nodeRects(g, io.registry);
  const sel = new Set(ed.state.selection);
  const list = [...rects].filter(([id]) => !selectionOnly || !sel.size || sel.has(id)).map(([, r]) => r);
  const b = boundsOf(list);
  if (!b) {
    graphCtl.view = { x: 80, y: 80, zoom: 1 };
    graphCtl.applyView();
    return;
  }
  graphCtl.fit(b);
}
