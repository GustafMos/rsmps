/**
 * Touch gestures for the viewer, added from the outside (Viewer.tsx keeps its mouse-only code): two fingers pinch-zoom and pan,
 * double-tap toggles Fit and 100 %. One finger still pans through the viewer's own pointer handler.
 *
 * The viewer's zoom and pan state is private, so the gestures are expressed in the events it already understands: a pinch becomes
 * wheel events (it zooms about the pointer), a two-finger pan becomes a synthetic one-pointer drag that is re-based every frame, and
 * the double-tap presses its own Fit / 100% buttons. Nothing here reaches into the viewer.
 */
import { DoubleTap, isTap } from '../graph-touch/pure';

const WHEEL_RATE = 0.0015; // Viewer: zoom factor = exp(-deltaY * 0.0015)
const SYNTH_ID = 90001;

/** The wheel delta that zooms the viewer by `ratio`. */
export function wheelDeltaForZoom(ratio: number): number {
  return -Math.log(Math.max(0.01, ratio)) / WHEEL_RATE;
}

export function installViewerTouch(box: HTMLElement): () => void {
  const pts = new Map<number, { x: number; y: number }>();
  const dbl = new DoubleTap(320, 40);
  let injecting = false;
  let two: { ids: [number, number]; mid: { x: number; y: number }; dist: number } | null = null;
  let tap: { x: number; y: number; t: number; id: number } | null = null;
  let suppressDbl = 0;

  const send = (type: string, x: number, y: number, target: EventTarget) => {
    injecting = true;
    try {
      target.dispatchEvent(new PointerEvent(type, { pointerId: SYNTH_ID, pointerType: 'touch', isPrimary: false, button: 0, buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    } finally {
      injecting = false;
    }
  };
  const measure = (ids: [number, number]) => {
    const a = pts.get(ids[0])!;
    const b = pts.get(ids[1])!;
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const endTwo = () => {
    if (!two) return;
    send('pointercancel', two.mid.x, two.mid.y, window);
    two = null;
  };

  const down = (e: PointerEvent) => {
    if (injecting || e.pointerType === 'mouse') return;
    if ((e.target as HTMLElement).closest('[data-nodrag], .rs-paint, .rs-pts')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2 && !two) {
      const ids = [...pts.keys()] as [number, number];
      // the first finger's own pan ends here: the pinch takes over
      injecting = true;
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: ids[0], pointerType: 'touch', bubbles: true }));
      injecting = false;
      const m = measure(ids);
      two = { ids, ...m };
      send('pointerdown', m.mid.x, m.mid.y, box);
      tap = null;
      dbl.reset();
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (pts.size > 2 || two) {
      e.stopPropagation();
      return;
    }
    tap = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
  };

  const move = (e: PointerEvent) => {
    if (injecting || e.pointerType === 'mouse') return;
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!two || !two.ids.includes(e.pointerId)) return;
    const next = measure(two.ids);
    // pan first (the synthetic drag is anchored at the previous midpoint), then zoom about the new midpoint: the picture follows the fingers
    send('pointermove', next.mid.x, next.mid.y, window);
    if (two.dist > 8 && next.dist > 8 && Math.abs(next.dist - two.dist) > 0.5) {
      box.dispatchEvent(new WheelEvent('wheel', { deltaY: wheelDeltaForZoom(next.dist / two.dist), deltaMode: 0, clientX: next.mid.x, clientY: next.mid.y, bubbles: true, cancelable: true }));
    }
    // re-base the drag: the zoom moved the picture, so the next pan must start from where it is now
    send('pointercancel', next.mid.x, next.mid.y, window);
    send('pointerdown', next.mid.x, next.mid.y, box);
    two = { ids: two.ids, ...next };
    e.stopPropagation();
    e.preventDefault();
  };

  const up = (e: PointerEvent) => {
    if (injecting || e.pointerType === 'mouse') return;
    const had = pts.delete(e.pointerId);
    if (two && two.ids.includes(e.pointerId)) {
      endTwo();
      e.stopPropagation();
      return;
    }
    if (!had) return;
    if (tap && tap.id === e.pointerId && e.type === 'pointerup' && isTap(e.timeStamp - tap.t, Math.hypot(e.clientX - tap.x, e.clientY - tap.y))) {
      if (dbl.tap(e.timeStamp, e.clientX, e.clientY, 'v')) {
        suppressDbl = Date.now() + 700;
        // Fit <-> 100 %: press the viewer's own buttons (never synthetic keys: the global shortcuts would hear those too)
        const wrap = box.closest('.rs-viewer-wrap');
        const fitBtn = wrap?.querySelector<HTMLButtonElement>('.rs-viewer__fitbtn');
        const actualBtn = wrap?.querySelector<HTMLButtonElement>('.rs-viewer__actual');
        if (fitBtn?.classList.contains('is-on')) actualBtn?.click();
        else fitBtn?.click();
      }
    } else dbl.reset();
    tap = null;
  };

  // the viewer's own onDoubleClick (always "Fit") must not fight the toggle above
  const dblclick = (e: MouseEvent) => {
    if (Date.now() < suppressDbl) {
      e.stopPropagation();
      suppressDbl = 0;
    }
  };

  box.addEventListener('pointerdown', down, true);
  box.addEventListener('dblclick', dblclick, true);
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  return () => {
    endTwo();
    box.removeEventListener('pointerdown', down, true);
    box.removeEventListener('dblclick', dblclick, true);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
  };
}
