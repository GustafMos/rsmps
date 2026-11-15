interface Session {
  pointerId: number;
  abort: () => void;
}
const sessions = new Set<Session>();

/** End every running pointer gesture as cancelled (idempotent). Used when the browser swallowed the pointerup. */
export function abortAllTracking(): void {
  for (const s of [...sessions]) s.abort();
}

/**
 * Track a pointer gesture on `window` until release. Returns a cancel function.
 * A gesture also ends (cancelled = true) on pointercancel, window blur, tab hiding, a native drag start/end or a drop:
 * the browser sends no pointerup in those cases. A new gesture for the same pointer ends a stale one first.
 */
export function trackPointer(
  start: { pointerId: number },
  onMove: (e: PointerEvent) => void,
  onUp: (e: PointerEvent, cancelled: boolean) => void,
): () => void {
  for (const old of [...sessions]) {
    if (old.pointerId === start.pointerId) {
      if (import.meta.env?.DEV) console.warn('[gesture] a gesture started while another was still active; ending the old one');
      old.abort();
    }
  }
  let last: PointerEvent | null = null;
  let done = false;
  const move = (e: PointerEvent) => {
    if (e.pointerId !== start.pointerId) return;
    last = e;
    onMove(e);
  };
  const finish = (e: PointerEvent, cancelled: boolean) => {
    if (done) return;
    done = true;
    cleanup();
    onUp(e, cancelled);
  };
  const up = (e: PointerEvent) => {
    if (e.pointerId !== start.pointerId) return;
    finish(e, e.type === 'pointercancel');
  };
  const session: Session = {
    pointerId: start.pointerId,
    abort: () => finish(last ?? new PointerEvent('pointercancel', { pointerId: start.pointerId }), true),
  };
  function cleanup() {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    sessions.delete(session);
  }
  sessions.add(session);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  return () => {
    done = true;
    cleanup();
  };
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export function formatTime(seconds: number, fps: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`;
}

export function hexOf(rgb: readonly number[]): string {
  const c = (v: number) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}
export function rgbOf(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}
