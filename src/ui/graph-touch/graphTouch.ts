/**
 * Touch behaviour for the node graph, added from the outside: capture-phase listeners on the graph panel (src/ui/graph/* is not edited).
 *
 *  - One finger on empty space pans (two fingers pinch / pan, which GraphView already does). The "Select" toggle gives the old
 *    behaviour back: a one-finger drag draws the selection box. A tap on empty space deselects and cancels a pending wire; a
 *    long press there opens the add menu.
 *  - Tap-tap wiring: tap an output socket, then an input socket (or the other way round). Sockets that cannot take the wire dim, the
 *    ones that can are enlarged, and a chip (GraphTouchChip) says what is pending and cancels it.
 *  - Double-tap a node: `onFocusNode` (the phone opens the Inspector for it).
 *  - Long press on a parameter row opens the node menu for that parameter.
 *  - Dragging a node, a wire or a frame toward the edge of the panel pans the view (the drag follows).
 */
import { libraryAssetName, nodeDisplayName } from '../lib/nodeTitle';
import { connectError } from '../../engine/graph';
import { showBundleSockets } from '../store/nodeView';
import { GROUP_TYPE } from '../../engine/group';
import type { SocketType } from '../../engine/types';
import { LongPress } from '../responsive/longPress';
import { createStore } from '../store/createStore';
import type { AppCtx } from '../store/context';
import { DoubleTap, edgePanVelocity, isTap } from './pure';

export interface PendingWire {
  side: 'out' | 'in';
  node: string;
  port: string;
  type: SocketType;
  /** "Media In · Image": what the chip shows. */
  label: string;
}

/** The wire waiting for its second tap. Read by the chip. */
export const wireStore = createStore<{ pending: PendingWire | null }>({ pending: null });

const SOCKET_MARKS = ['data-dim', 'data-ok', 'data-pending'] as const;

export interface GraphTouchOptions {
  /** True while the Select toggle is on: a one-finger drag on empty space is then left to the box select. */
  selectMode: () => boolean;
  /** Double-tap on a node. */
  onFocusNode: (id: string) => void;
}

/** Returns the stop function. `ctl.root` must exist (the graph is mounted). */
export function installGraphTouch(app: AppCtx, opts: GraphTouchOptions): () => void {
  const { ed, graphCtl: ctl, io } = app;
  const root = ctl.root;
  if (!root) return () => undefined;
  const reg = io.registry;

  const touches = new Map<number, { x: number; y: number }>();
  const dbl = new DoubleTap();

  /* ------------------------------ pending wire ------------------------------ */

  const sockets = () => Array.from(root.querySelectorAll<HTMLElement>('[data-sock]'));
  const clearMarks = () => {
    for (const s of sockets()) for (const m of SOCKET_MARKS) s.removeAttribute(m);
    root.classList.remove('is-tapwire');
  };
  const errorFor = (p: PendingWire, el: HTMLElement): string | null => {
    const d = el.dataset;
    if (d.port === '+' || !d.node || !d.port) return 'Not a socket you can wire to';
    if (p.side === 'out') {
      if (d.dir !== 'in') return 'Tap an input socket';
      return connectError(ed.state.level, reg, { node: p.node, port: p.port }, { node: d.node, port: d.port });
    }
    if (d.dir !== 'out') return 'Tap an output socket';
    return connectError(ed.state.level, reg, { node: d.node, port: d.port }, { node: p.node, port: p.port });
  };
  const mark = (p: PendingWire) => {
    root.classList.add('is-tapwire');
    for (const s of sockets()) {
      for (const m of SOCKET_MARKS) s.removeAttribute(m);
      if (s.dataset.node === p.node && s.dataset.port === p.port && s.dataset.dir === p.side) s.setAttribute('data-pending', '1');
      else if (errorFor(p, s)) s.setAttribute('data-dim', '1');
      else s.setAttribute('data-ok', '1');
    }
  };
  const setPending = (p: PendingWire | null) => {
    wireStore.set({ pending: p });
    // a vector wire looking for an input: the nodes show their bundle sockets (one socket for an X / Y / Z group) so one can be tapped
    showBundleSockets(!!p && p.side === 'out' && p.type === 'vector');
    if (p) {
      mark(p);
      // sockets that only just appeared (the bundle sockets) are marked once they are in the page
      requestAnimationFrame(() => {
        if (wireStore.get().pending === p) mark(p);
      });
    } else clearMarks();
  };
  const describe = (el: HTMLElement): PendingWire => {
    const n = ed.state.level.nodes.find((x) => x.id === el.dataset.node);
    const def = n && reg.get(n.type);
    const title = n ? nodeDisplayName(n, def, libraryAssetName(io.library)) : '';
    return { side: el.dataset.dir === 'out' ? 'out' : 'in', node: el.dataset.node!, port: el.dataset.port!, type: (el.dataset.type ?? 'image') as SocketType, label: `${title} · ${el.dataset.port}` };
  };
  /** A tap on a socket while a wire is pending. */
  const tapTarget = (p: PendingWire, el: HTMLElement) => {
    const same = el.dataset.node === p.node && el.dataset.port === p.port && el.dataset.dir === p.side;
    if (same) return setPending(null);
    if (p.side === 'out' && el.dataset.dir === 'out' && ed.canJoin(p, { node: el.dataset.node!, port: el.dataset.port! })) {
      setPending(null);
      swallowNextClick();
      ed.mergeOutputs(p, { node: el.dataset.node!, port: el.dataset.port! }); // two outputs: a new Stack / Mixer / Combine
      return;
    }
    if (el.dataset.dir === p.side) return setPending(describe(el)); // same kind of socket: start from this one instead
    const err = errorFor(p, el);
    if (err) {
      ed.toast(err, 'error');
      return;
    }
    const slot = el.dataset.slot !== undefined ? Number(el.dataset.slot) : undefined;
    const from = p.side === 'out' ? { node: p.node, port: p.port } : { node: el.dataset.node!, port: el.dataset.port! };
    const to = p.side === 'out' ? { node: el.dataset.node!, port: el.dataset.port! } : { node: p.node, port: p.port };
    setPending(null);
    ed.connect(from, to, slot);
  };
  /** A join / add selects the new node and its toolbar can pop up under the finger: the tap's own click must not press it. */
  const swallowNextClick = () => {
    const stop = (ev: Event) => {
      ev.stopPropagation();
      ev.preventDefault();
    };
    window.addEventListener('click', stop, true);
    setTimeout(() => window.removeEventListener('click', stop, true), 450);
  };
  const dropMergeToast = () => {
    for (const t of ed.state.toasts) if (t.text.startsWith('Click another output to ')) ed.dismissToast(t.id);
  };

  /* ------------------------------ edge auto-pan ------------------------------ */

  let drag: { id: number; x: number; y: number; moved: boolean } | null = null;
  let raf = 0;
  const loop = () => {
    raf = 0;
    if (!drag || !drag.moved) return;
    const r = root.getBoundingClientRect();
    const v = edgePanVelocity(drag.x, drag.y, r);
    if (v.dx || v.dy) {
      ctl.needsFit = false;
      ctl.view.x += v.dx;
      ctl.view.y += v.dy;
      ctl.applyView();
      // the drag handlers work from the pointer position: tell them the view moved under a still finger
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: drag.id, pointerType: 'touch', clientX: drag.x, clientY: drag.y, buttons: 1, bubbles: true, isPrimary: true }));
    }
    raf = requestAnimationFrame(loop);
  };

  /* ------------------------------ background pan / tap ------------------------------ */

  type Bg = { id: number; x0: number; y0: number; lx: number; ly: number; moved: boolean; t0: number; lp: LongPress };
  let bg: Bg | null = null;
  const endBg = () => {
    bg?.lp.cancel();
    bg = null;
    root.classList.remove('is-panning');
  };

  /* ------------------------------ param long press ------------------------------ */

  const paramLp = new LongPress({
    delay: 560,
    onFire: (x, y) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      const nodeId = el?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
      const paramKey = el?.closest<HTMLElement>('[data-param-key]')?.dataset.paramKey;
      if (!nodeId || !paramKey) return;
      if (!ed.state.selection.includes(nodeId)) ed.select([nodeId]);
      ed.openContextMenu({ clientX: x, clientY: y, nodeId, paramKey });
    },
  });

  /* ------------------------------ pointer events ------------------------------ */

  let suppressDbl = 0;
  const dblclick = (e: MouseEvent) => {
    if (Date.now() < suppressDbl) e.stopPropagation();
  };
  let sockTap: { el: HTMLElement; x: number; y: number; t: number; id: number } | null = null;
  let nodeTap: { id: string; x: number; y: number; t: number; pid: number; ok: boolean } | null = null;

  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size > 1) {
      // two fingers: GraphView pinches; drop everything single-finger of ours
      endBg();
      paramLp.cancel();
      drag = null;
      sockTap = null;
      nodeTap = null;
      return;
    }
    const t = e.target as HTMLElement;
    if (t.closest('.rs-graph__bar, .rs-seltb, .rs-graph__crumbs, .rs-sp, .rs-graph__touchbar')) return;
    if (ed.state.addMenu || ed.state.contextMenu) {
      ed.openAddMenu(null);
      ed.openContextMenu(null);
    }
    const sock = t.closest<HTMLElement>('[data-sock]');
    const nodeEl = t.closest<HTMLElement>('[data-node-id]');
    const pending = wireStore.get().pending;

    if (sock) {
      if (pending) {
        e.stopPropagation();
        e.preventDefault();
        tapTarget(pending, sock);
        return;
      }
      sockTap = { el: sock, x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      return; // the normal wire drag starts; a tap is recognised on release
    }

    if (pending && !nodeEl) {
      // tap elsewhere cancels the wire (handled on release for the background; here nothing else to do)
    }

    if (t.closest('[data-param-key]')) paramLp.start(e.clientX, e.clientY, e.pointerId);

    if (nodeEl && !t.closest('[data-nodrag], input, select, button')) {
      nodeTap = { id: nodeEl.dataset.nodeId!, x: e.clientX, y: e.clientY, t: e.timeStamp, pid: e.pointerId, ok: true }; // the title too: on touch a double tap focuses (renaming lives in the Inspector)
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      return;
    }
    if (t.closest('[data-frame-head]')) {
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      return;
    }
    if (t.closest('[data-node-id], [data-edge], [data-nodrag]')) return;

    // empty space
    if (opts.selectMode()) return; // the box select takes it
    e.preventDefault();
    e.stopPropagation();
    ctl.root?.focus({ preventScroll: true });
    const lp = new LongPress({
      onFire: (x, y) => {
        setPending(null);
        ed.openAddMenu({ clientX: x, clientY: y, world: ctl.toWorld(x, y), context: true });
      },
    });
    bg = { id: e.pointerId, x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, t0: e.timeStamp, lp };
    lp.start(e.clientX, e.clientY, e.pointerId);
  };

  const move = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    paramLp.move(e.clientX, e.clientY, e.pointerId);
    if (drag && e.pointerId === drag.id) {
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (!drag.moved && nodeTap && Math.hypot(e.clientX - nodeTap.x, e.clientY - nodeTap.y) > 8) drag.moved = true;
      if (!drag.moved && sockTap && Math.hypot(e.clientX - sockTap.x, e.clientY - sockTap.y) > 8) drag.moved = true;
      if (!drag.moved && !nodeTap && !sockTap && e.isTrusted) drag.moved = true;
      if (drag.moved && !raf && e.isTrusted) raf = requestAnimationFrame(loop);
    }
    if (bg && e.pointerId === bg.id && touches.size === 1) {
      const dx = e.clientX - bg.lx;
      const dy = e.clientY - bg.ly;
      bg.lx = e.clientX;
      bg.ly = e.clientY;
      if (!bg.moved && Math.hypot(e.clientX - bg.x0, e.clientY - bg.y0) > 6) {
        bg.moved = true;
        bg.lp.cancel();
        root.classList.add('is-panning');
      }
      if (bg.moved) {
        ctl.needsFit = false;
        ctl.view.x += dx;
        ctl.view.y += dy;
        ctl.applyView();
      }
    }
  };

  const up = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    touches.delete(e.pointerId);
    paramLp.cancel();
    if (bg && e.pointerId === bg.id) {
      const wasTap = e.type === 'pointerup' && !bg.moved && !bg.lp.fired && isTap(e.timeStamp - bg.t0, 0);
      endBg();
      if (wasTap) {
        if (wireStore.get().pending) setPending(null);
        else if (ed.state.selection.length || ed.state.selectedFrame) ed.select([]);
      }
    }
    if (sockTap && e.pointerId === sockTap.id) {
      const s = sockTap;
      sockTap = null;
      if (e.type === 'pointerup' && isTap(e.timeStamp - s.t, Math.hypot(e.clientX - s.x, e.clientY - s.y))) {
        // the normal handler has just run (it only knows "merge two outputs"): replace its effect with tap-tap wiring
        setTimeout(() => {
          ctl.pendingOut = null;
          dropMergeToast();
          if (s.el.isConnected && s.el.dataset.port !== '+') setPending(describe(s.el));
        }, 0);
      }
    }
    if (nodeTap && e.pointerId === nodeTap.pid) {
      const n = nodeTap;
      nodeTap = null;
      const pend = wireStore.get().pending;
      if (e.type === 'pointerup' && pend && pend.side === 'out' && n.id !== pend.node && isTap(e.timeStamp - n.t, Math.hypot(e.clientX - n.x, e.clientY - n.y)) && ed.multiTarget(pend, n.id)) {
        setPending(null);
        swallowNextClick();
        ed.addToNode(pend, n.id); // a tap on a node body: add the pending output to it
      } else if (e.type === 'pointerup' && n.ok && isTap(e.timeStamp - n.t, Math.hypot(e.clientX - n.x, e.clientY - n.y))) {
        const node = ed.state.level.nodes.find((x) => x.id === n.id);
        if (node && node.type !== GROUP_TYPE && dbl.tap(e.timeStamp, e.clientX, e.clientY, n.id)) {
          suppressDbl = Date.now() + 700; // the title's own double-click (rename) must not open as well
          opts.onFocusNode(n.id);
        }
      } else dbl.reset();
    }
    if (drag && e.pointerId === drag.id) {
      drag = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  root.addEventListener('pointerdown', down, true);
  root.addEventListener('dblclick', dblclick, true);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);

  // a project switch or an edit that removes the pending socket's node ends the pending wire
  const unsub = ed.store.subscribe(() => {
    const p = wireStore.get().pending;
    if (p && !ed.state.level.nodes.some((n) => n.id === p.node)) setPending(null);
  });

  return () => {
    root.removeEventListener('pointerdown', down, true);
    root.removeEventListener('dblclick', dblclick, true);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    unsub();
    endBg();
    paramLp.cancel();
    if (raf) cancelAnimationFrame(raf);
    setPending(null);
  };
}
