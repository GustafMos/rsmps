import { useEffect, useRef } from 'react';

/**
 * Overlay stack: Esc closes only the topmost overlay (a menu on top of a dialog closes the menu first), and when an overlay
 * goes away focus returns to where it was before it opened (if nothing else took it meanwhile).
 */
const stack: object[] = [];

export const isTopOverlay = (token: object): boolean => stack[stack.length - 1] === token;

/** Register an overlay for its lifetime. `onEscape` (optional) is called by a window key listener only while this one is on top. */
export function useOverlay(onEscape?: () => void, capture = false): { current: object } {
  const token = useRef<object>({});
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    const t = token.current;
    const prev = document.activeElement as HTMLElement | null;
    stack.push(t);
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !cb.current || !isTopOverlay(t)) return;
      if (capture) e.stopPropagation();
      cb.current();
    };
    window.addEventListener('keydown', key, capture);
    return () => {
      window.removeEventListener('keydown', key, capture);
      const i = stack.indexOf(t);
      if (i >= 0) stack.splice(i, 1);
      // after React removed the overlay's DOM, focus is on <body>: give it back
      setTimeout(() => {
        if (prev && prev.isConnected && (!document.activeElement || document.activeElement === document.body)) prev.focus({ preventScroll: true });
      }, 0);
    };
  }, [capture]);
  return token;
}
