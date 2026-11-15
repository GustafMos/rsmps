/**
 * Pointer gestures for the node graph. Everything here works on refs and CSS transforms; the
 * store is only touched when a gesture ends (or when selection changes).
 */
import type { DragEvent as RDragEvent, MouseEvent as RMouseEvent, PointerEvent as RPointerEvent } from 'react';
import { connectError, disconnect, inputType, outputType, wiresInto } from '../../engine/graph';
import type { AppCtx } from '../store/context';
import { trackPointer } from '../lib/drag';
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
import type { SocketType } from '../../engine/types';

const THRESHOLD = 3;
export const ASSET_MIME = 'application/x-rsmps-asset';

export type Gestures = ReturnType<typeof createGestures>;

export function createGestures(app: AppCtx) {
  const { ed, io, graphCtl: ctl } = app;
  const reg = io.registry;

  const cls = (name: string, on: boolean) => ctl.root?.classList.toggle(name, on);
  const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

  function updateEdges(offsets: ReadonlyMap<string, { dx: number; dy: number }>) {
    const g = ed.state.graph;
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
    if (additive) {
      ed.select([id], 'toggle');
      if (!ed.state.selection.includes(id)) return;
    } else if (!before.includes(id)) ed.select([id]);
    else deferSingle = before.length > 1;

    const g0 = ed.state.graph;
    const ids = [...ed.state.selection];
    const idSet = new Set(ids);
    const nodes = ids.map((i) => g0.nodes.find((n) => n.id === i)!).filter(Boolean);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const rects = nodeRects(g0, reg);
    const single = nodes.length === 1 ? nodes[0] : null;
    const connected = g0.edges.some((ed2) => idSet.has(ed2.from.node) || idSet.has(ed2.to.node));
    const polylines = single && !connected ? edgePolylines(g0, reg) : null;
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
        if (!moved) cls('is-dragging', true);
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
          const def = reg.get(single.type);
          for (const [eid, pts] of polylines) {
            const d = distToPolyline(c, pts);
            if (d < bestD && def && edgeAccepts(eid, single.type)) {
              best = eid;
              bestD = d;
            }
          }
          setInsert(best);
        }
      },
      () => {
        cls('is-dragging', false);
        const ins = insert;
        setInsert(null);
        if (!moved) {
          if (deferSingle) ed.select([id]);
          return;
        }
        const first = offsets.values().next().value;
        if (first && first.dx === 0 && first.dy === 0 && !ins) return;
        ed.finishDrag(offsets, ins);
      },
    );
  }

  function edgeAccepts(edgeId: string, nodeType: string): boolean {
    const g = ed.state.graph;
    const edge = g.edges.find((x) => x.id === edgeId);
    const def = reg.get(nodeType);
    if (!edge || !def || Object.keys(def.outputs).length === 0) return false;
    const ft = outputType(g, reg, edge.from.node, edge.from.port);
    return !!ft && inputsAccepting(def, ft).some((p) => p in def.inputs);
  }

  function startFrameDrag(e: RPointerEvent, frameId: string) {
    ed.selectFrame(frameId);
    const g0 = ed.state.graph;
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
    const g = ed.state.graph;
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
    const fpos = socketWorld(fnode, layoutFor(g, fnode, reg.get(fnode.type)), fixed.side === 'out' ? 'out' : 'in', fixed.port);

    // dim everything that cannot accept this wire
    const sockets = Array.from(ctl.root!.querySelectorAll<HTMLElement>('[data-sock]'));
    const errorFor = (el: HTMLElement): string | null => {
      const d = el.dataset.dir;
      const n = el.dataset.node!;
      const p = el.dataset.port!;
      if (fixed.side === 'out') {
        if (d !== 'in') return 'Drop on an input socket';
        return connectError(g, reg, { node: fixed.node, port: fixed.port }, { node: n, port: p });
      }
      if (d !== 'out') return 'Drop on an output socket';
      return connectError(g, reg, { node: n, port: p }, { node: fixed.node, port: fixed.port });
    };
    /** Dropping an output on another output merges them (image/mask -> Merge, audio -> Mixer). */
    const mergeTarget = (el: HTMLElement): boolean => {
      if (fixed.side !== 'out' || detached || el.dataset.dir !== 'out' || el.dataset.node === fixed.node) return false;
      const t = el.dataset.type as SocketType;
      const vis = (x: SocketType) => x === 'image' || x === 'mask';
      if (vis(fixed.type) && vis(t)) return !!reg.get('merge');
      return fixed.type === 'audio' && t === 'audio' && !!reg.get('mixer');
    };
    for (const s of sockets) if (errorFor(s) && !mergeTarget(s)) s.dataset.dim = '1';
    cls('is-wiring', true);
    const path = ctl.pending;
    path?.setAttribute('class', `rs-wire rs-wire--${fixed.type} is-pending`);
    let target: HTMLElement | null = null;
    let hoverId: string | null = null;
    let hoverTimer: ReturnType<typeof setTimeout> | undefined;
    let mergeTo: HTMLElement | null = null;
    let moved = false;

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
            if (nid && nid !== fixed.node && !ed.state.socketPicker) {
              hoverTimer = setTimeout(() => {
                if (compatibleSockets(ed.state.graph, reg, nid, { node: fixed.node, port: fixed.port }).length) ed.openSocketPicker({ node: nid, from: fixed, x: ev.clientX + 14, y: ev.clientY + 14 });
              }, 500);
            }
          }
        }
        if (target && target !== found?.el) {
          delete target.dataset.ok;
          delete target.dataset.bad;
        }
        mergeTo?.removeAttribute('data-merge');
        mergeTo = found?.merge ? found.el : null;
        if (mergeTo) mergeTo.dataset.merge = fixed.type === 'audio' ? 'mix' : 'merge';
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
      (ev) => {
        clearTimeout(hoverTimer);
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
        if (mergeTo) {
          ed.mergeOutputs({ node: fixed.node, port: fixed.port }, { node: mergeTo.dataset.node!, port: mergeTo.dataset.port! });
          return;
        }
        if (target) {
          const to = { node: target.dataset.node!, port: target.dataset.port! };
          const from = fixed.side === 'out' ? { node: fixed.node, port: fixed.port } : to;
          const dst = fixed.side === 'out' ? to : { node: fixed.node, port: fixed.port };
          const slot = target.dataset.slot !== undefined ? Number(target.dataset.slot) : undefined;
          if (detached) ed.edit((gr) => ed.connectSlot(disconnect(gr, detached!), from, dst, slot));
          else ed.connect(from, dst, slot);
          return;
        }
        if (!moved) {
          if (fixed.side === 'out' && !detached) {
            ctl.pendingOut = { node: fixed.node, port: fixed.port };
            ed.toast('Click another output to merge the two (the first one ends up on top).', 'info');
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
        if (fixed.side === 'out' && !detached && bodyNode && bodyNode !== fixed.node) {
          const list = compatibleSockets(ed.state.graph, reg, bodyNode, { node: fixed.node, port: fixed.port });
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
    const rects = nodeRects(ed.state.graph, reg);
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
    const g = ed.state.graph;
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
      (ev) => {
        if (line) line.style.display = 'none';
        const short = dist(ev.clientX, ev.clientY, e.clientX, e.clientY) < 4;
        const kill: string[] = [];
        for (const [id, pts] of polys) {
          if (short ? distToPolyline(a, pts) < 8 / ctl.view.zoom : polylineCrosses(pts, a, b)) kill.push(id);
        }
        if (kill.length) ed.edit((gr) => ({ ...gr, edges: gr.edges.filter((x) => !kill.includes(x.id)) }));
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
    trackPointer(e, () => undefined, (ev) => {
      if (dist(ev.clientX, ev.clientY, e.clientX, e.clientY) > 4) return;
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

  /** Touch / pen: press and hold (~500 ms, without moving) opens the context menu or the add menu. */
  function armLongPress(e: RPointerEvent) {
    const nodeEl = (e.target as HTMLElement).closest<HTMLElement>('[data-node-id]');
    const edgeId = (e.target as HTMLElement).closest<HTMLElement>('[data-edge]')?.getAttribute('data-edge');
    const x0 = e.clientX;
    const y0 = e.clientY;
    const t = window.setTimeout(() => {
      off();
      if (nodeEl) {
        const id = nodeEl.dataset.nodeId!;
        if (!ed.state.selection.includes(id)) ed.select([id]);
        ed.openContextMenu({ clientX: x0, clientY: y0, nodeId: id });
      } else if (edgeId) ed.openContextMenu({ clientX: x0, clientY: y0, nodeId: null, edgeId });
      else ed.openAddMenu({ clientX: x0, clientY: y0, world: ctl.toWorld(x0, y0), context: true });
    }, 500);
    const mv = (ev: PointerEvent) => {
      if (dist(ev.clientX, ev.clientY, x0, y0) > 6) off();
    };
    function off() {
      clearTimeout(t);
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', off);
      window.removeEventListener('pointercancel', off);
    }
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', off);
    window.addEventListener('pointercancel', off);
  }

  /* -------------------------------- dispatch ------------------------------- */

  return {
    onPointerDown(e: RPointerEvent<HTMLElement>) {
      ctl.root?.focus({ preventScroll: true });
      ctl.pointer = { x: e.clientX, y: e.clientY };
      if (ed.state.addMenu || ed.state.contextMenu) {
        ed.openAddMenu(null);
        ed.openContextMenu(null);
      }
      const t = e.target as HTMLElement;
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
        ed.mergeOutputs(pend, { node: sock.dataset.node!, port: sock.dataset.port! });
        return;
      }
      if (sock) {
        e.preventDefault();
        startWire(e, sock);
        return;
      }
      const nodeEl = t.closest<HTMLElement>('[data-node-id]');
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
        const files = Array.from(e.dataTransfer.files);
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
  const g = ed.state.graph;
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
