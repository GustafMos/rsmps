/**
 * Keeping a field visible above the on-screen keyboard. Browsers disagree about what the keyboard does to the layout viewport (Android
 * Chrome keeps it, iOS Safari scrolls it), but `visualViewport` is the same everywhere: it is the part of the page that is really visible.
 * The pure maths is here; `installVisualViewportVars` publishes it as CSS variables that the sheets position themselves with.
 */
export interface Box {
  top: number;
  bottom: number;
}

/** How many CSS px of the bottom of the layout viewport the keyboard (or any system UI) covers. Never negative. */
export function keyboardInset(layoutHeight: number, vvHeight: number, vvOffsetTop: number): number {
  return Math.max(0, Math.round(layoutHeight - vvHeight - vvOffsetTop));
}

/** The keyboard is up when it covers a real part of the screen (an address bar sliding away is far smaller). */
export function keyboardOpen(inset: number, layoutHeight: number): boolean {
  return inset > Math.max(120, layoutHeight * 0.15);
}

/**
 * How far the visible area must scroll so `field` (a bounding box, client coordinates) sits fully inside the visible area
 * `[vvTop, vvTop + vvHeight]` with `margin` to spare. Positive = scroll down (content moves up).
 */
export function scrollDeltaToReveal(field: Box, vvTop: number, vvHeight: number, margin = 12): number {
  const top = vvTop + margin;
  const bottom = vvTop + vvHeight - margin;
  if (field.bottom - field.top > bottom - top) return field.top - top; // taller than the area: show its top
  if (field.bottom > bottom) return field.bottom - bottom;
  if (field.top < top) return field.top - top;
  return 0;
}

export interface VisualViewportLike {
  height: number;
  offsetTop: number;
  addEventListener(type: 'resize' | 'scroll', fn: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', fn: () => void): void;
}

/**
 * Sets `--vv-h` (visible height), `--vv-top` (its offset) and `--kb-inset` on <html>, and `data-kb="1"` while the keyboard is up.
 * Falls back to the window size where `visualViewport` is missing. Writes only when a value changed (no layout churn).
 */
export function installVisualViewportVars(win: { innerHeight: number; visualViewport?: VisualViewportLike | null; addEventListener: Window['addEventListener']; removeEventListener: Window['removeEventListener'] } = window, root: HTMLElement = document.documentElement): () => void {
  const vv = win.visualViewport ?? null;
  let last = '';
  const apply = () => {
    const h = vv ? vv.height : win.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    const inset = keyboardInset(win.innerHeight, h, top);
    const key = `${Math.round(h)}|${Math.round(top)}|${inset}`;
    if (key === last) return;
    last = key;
    root.style.setProperty('--vv-h', `${Math.round(h)}px`);
    root.style.setProperty('--vv-top', `${Math.round(top)}px`);
    root.style.setProperty('--kb-inset', `${inset}px`);
    if (keyboardOpen(inset, win.innerHeight)) root.dataset.kb = '1';
    else delete root.dataset.kb;
  };
  apply();
  vv?.addEventListener('resize', apply);
  vv?.addEventListener('scroll', apply);
  win.addEventListener('resize', apply);
  return () => {
    vv?.removeEventListener('resize', apply);
    vv?.removeEventListener('scroll', apply);
    win.removeEventListener('resize', apply);
  };
}

/** When a text field gets focus inside a sheet, bring it into view once the keyboard has had time to appear. */
export function installFocusReveal(doc: Document = document): () => void {
  const onFocus = (e: FocusEvent) => {
    const el = e.target as HTMLElement | null;
    if (!el || !(el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') || !el.closest('[data-sheet], .rs-dlg, .rs-add')) return;
    window.setTimeout(() => {
      if (!el.isConnected) return;
      const vv = window.visualViewport;
      const r = el.getBoundingClientRect();
      const d = scrollDeltaToReveal(r, vv?.offsetTop ?? 0, vv?.height ?? window.innerHeight);
      if (d) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, 320);
  };
  doc.addEventListener('focusin', onFocus);
  return () => doc.removeEventListener('focusin', onFocus);
}
