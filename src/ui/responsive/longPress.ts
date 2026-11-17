/**
 * Long press. `LongPress` is the pure recogniser (timers injected, so it is tested with fake timers): a press that stays within
 * `tolerance` px for `delay` ms fires once. `installLongPress` is the DOM glue: on touch and pen, a long press anywhere a right-click
 * does something sends that element a `contextmenu` event, and where nothing handles it, shows the element's tooltip (`title`).
 * The node graph has its own long-press (nodes, wires, background) and is left alone.
 */
export interface LongPressOptions {
  delay?: number;
  tolerance?: number;
  onFire: (x: number, y: number) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP = 8;

export class LongPress {
  /** True from the moment it fired until the next `start`. The caller swallows the click that follows. */
  fired = false;
  private timer: unknown = null;
  private origin: { x: number; y: number; id: number } | null = null;
  private readonly delay: number;
  private readonly tolerance: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;
  constructor(private readonly o: LongPressOptions) {
    this.delay = o.delay ?? LONG_PRESS_MS;
    this.tolerance = o.tolerance ?? LONG_PRESS_SLOP;
    this.setTimer = o.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = o.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }
  start(x: number, y: number, id = 0): void {
    this.cancel();
    this.fired = false;
    this.origin = { x, y, id };
    this.timer = this.setTimer(() => {
      this.timer = null;
      const o = this.origin;
      if (!o) return;
      this.fired = true;
      this.o.onFire(o.x, o.y);
    }, this.delay);
  }
  /** Returns false when the move was too big and the press was dropped. */
  move(x: number, y: number, id = 0): boolean {
    const o = this.origin;
    if (!o || o.id !== id || this.timer === null) return true;
    if (Math.hypot(x - o.x, y - o.y) > this.tolerance) {
      this.cancel();
      return false;
    }
    return true;
  }
  /** A second finger, a release, a cancel: the press is over. */
  cancel(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.origin = null;
  }
  get pending(): boolean {
    return this.timer !== null;
  }
}

/* ------------------------------ DOM glue ------------------------------ */

const SKIP = 'input, textarea, select, [contenteditable="true"], .rs-graph, .rs-nf, .rs-viewer, [data-no-longpress]';

let tip: HTMLDivElement | null = null;
let tipTimer: number | undefined;
export function hideTouchTip(): void {
  window.clearTimeout(tipTimer);
  tip?.remove();
  tip = null;
}
export function showTouchTip(text: string, x: number, y: number, ms = 2600): void {
  hideTouchTip();
  tip = document.createElement('div');
  tip.className = 'rs-touchtip';
  tip.setAttribute('role', 'tooltip');
  tip.textContent = text;
  document.body.appendChild(tip);
  const r = tip.getBoundingClientRect();
  const left = Math.max(8, Math.min(x - r.width / 2, window.innerWidth - r.width - 8));
  const top = y - r.height - 16 < 8 ? y + 24 : y - r.height - 16;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tipTimer = window.setTimeout(hideTouchTip, ms);
}

/** The first `title` up the tree, trimmed to a short sentence. */
export function tooltipFor(el: Element | null): string | null {
  const t = el?.closest('[title]')?.getAttribute('title');
  return t && t.trim() ? t.trim() : null;
}

export function installLongPress(doc: Window = window): () => void {
  let nativeSeen = 0;
  let swallowUntil = 0;
  const lp = new LongPress({
    onFire: (x, y) => {
      const target = target0;
      if (!target || !target.isConnected) return;
      swallowUntil = Date.now() + 700;
      if (Date.now() - nativeSeen < 800) return; // the browser sent its own contextmenu a moment ago
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2, view: window });
      target.dispatchEvent(ev);
      if (!ev.defaultPrevented) {
        const text = tooltipFor(target);
        if (text) showTouchTip(text, x, y);
      }
    },
  });
  let target0: Element | null = null;
  let pid = -1;
  const touches = new Set<number>();
  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    if (e.isPrimary) touches.clear(); // a primary pointer going down means no other finger is down: forget any whose release another listener swallowed
    touches.add(e.pointerId);
    hideTouchTip();
    const t = e.target as Element | null;
    if (touches.size > 1 || !t || t.closest(SKIP)) {
      lp.cancel();
      return;
    }
    target0 = t;
    pid = e.pointerId;
    lp.start(e.clientX, e.clientY, e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (e.pointerId === pid) lp.move(e.clientX, e.clientY, e.pointerId);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    touches.delete(e.pointerId);
    if (e.pointerId === pid) lp.cancel();
  };
  const native = (e: Event) => {
    if (!e.isTrusted) return;
    nativeSeen = Date.now();
    // a native long-press menu on an element that has our own handling would double up: let the app decide
  };
  const click = (e: MouseEvent) => {
    if (Date.now() < swallowUntil) {
      swallowUntil = 0;
      e.stopPropagation();
      e.preventDefault();
    }
  };
  doc.addEventListener('pointerdown', down, true);
  doc.addEventListener('pointermove', move, true);
  doc.addEventListener('pointerup', up, true);
  doc.addEventListener('pointercancel', up, true);
  doc.addEventListener('contextmenu', native, true);
  doc.addEventListener('click', click, true);
  return () => {
    lp.cancel();
    hideTouchTip();
    doc.removeEventListener('pointerdown', down, true);
    doc.removeEventListener('pointermove', move, true);
    doc.removeEventListener('pointerup', up, true);
    doc.removeEventListener('pointercancel', up, true);
    doc.removeEventListener('contextmenu', native, true);
    doc.removeEventListener('click', click, true);
  };
}
