import { useState } from 'react';

const H_KEY = 'rsmps.ui.timeline.h';
const C_KEY = 'rsmps.ui.timeline.collapsed';
const readNum = (k: string, d: number) => {
  try {
    const v = Number(localStorage.getItem(k));
    return v >= 120 ? v : d;
  } catch {
    return d;
  }
};

/**
 * The docked strip's own chrome, shared by every timeline-like editor: height (drag the top edge, remembered) and collapsed state
 * (remembered). `grip` goes on the resize handle's onPointerDown, `toggle` on the chevron.
 */
export function usePanelFrame() {
  const [h, setH] = useState(() => readNum(H_KEY, 240));
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(C_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(C_KEY, c ? '0' : '1');
      } catch {
        /* storage unavailable */
      }
      return !c;
    });
  };
  /** Drag the top edge: the strip grows upward, the graph above shrinks. */
  const grip = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = h;
    let cur = h0;
    const mv = (ev: PointerEvent) => {
      cur = Math.round(Math.min(window.innerHeight * 0.7, Math.max(120, h0 + (y0 - ev.clientY))));
      setH(cur);
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem(H_KEY, String(cur));
      } catch {
        /* storage unavailable */
      }
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };
  return { h, collapsed, toggle, grip };
}

/** Run `move` for every pointer move until release (the window listeners every timeline drag needs). `done` runs once at the end. */
export function dragWindow(move: (ev: PointerEvent) => void, done?: () => void): void {
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    done?.();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}
