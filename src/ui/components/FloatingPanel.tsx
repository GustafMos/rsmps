import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import './floating.css';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  min: boolean;
  dock: boolean;
}

const KEY = (id: string) => `rsmps.ui.panel.${id}`;

function load(id: string): Partial<Rect> | null {
  try {
    return JSON.parse(localStorage.getItem(KEY(id)) ?? 'null');
  } catch {
    return null;
  }
}

/** Keep the panel fully reachable inside the window. */
function clampRect(r: Rect, minW: number, minH: number): Rect {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = Math.min(Math.max(minW, r.w), W - 8);
  const h = Math.min(Math.max(minH, r.h), H - 8);
  return { ...r, w, h, x: Math.min(Math.max(4, r.x), W - w - 4), y: Math.min(Math.max(4, r.y), H - (r.min ? 36 : h) - 4) };
}

/**
 * The ONE floating panel used for every large popup that edits something visible elsewhere (Palette Studio, colour picker, curve
 * editor...): non-modal (no backdrop; the app stays live behind it), dragged by its header, resized from the edges and corners,
 * remembers position / size / minimised / docked state per `id`, never leaves the window. Esc closes it only while it has focus.
 */
export function FloatingPanel({
  id,
  title,
  onClose,
  children,
  footer,
  defaultSize = { w: 640, h: 520 },
  minSize = { w: 280, h: 160 },
}: {
  id: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  defaultSize?: { w: number; h: number };
  minSize?: { w: number; h: number };
}) {
  const [rect, setRect] = useState<Rect>(() => {
    const saved = load(id);
    const w = saved?.w ?? defaultSize.w;
    const h = saved?.h ?? defaultSize.h;
    return clampRect({ x: saved?.x ?? window.innerWidth - w - 24, y: saved?.y ?? 64, w, h, min: !!saved?.min, dock: !!saved?.dock }, minSize.w, minSize.h);
  });
  const ref = useRef<HTMLDivElement>(null);
  const rectRef = useRef(rect);
  rectRef.current = rect;

  const update = useCallback(
    (patch: Partial<Rect>, persist = true) => {
      const next = clampRect({ ...rectRef.current, ...patch }, minSize.w, minSize.h);
      rectRef.current = next;
      setRect(next);
      if (persist) {
        try {
          localStorage.setItem(KEY(id), JSON.stringify(next));
        } catch {
          /* storage unavailable */
        }
      }
    },
    [id, minSize.w, minSize.h],
  );

  useEffect(() => {
    const onResize = () => update({}, false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [update]);
  useLayoutEffect(() => ref.current?.focus({ preventScroll: true }), []);

  const grab = (e: React.PointerEvent, mode: 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw') => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    const r0 = { ...rectRef.current };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (mode === 'move') return update({ x: r0.x + dx, y: r0.y + dy, dock: false }, false);
      let { x, y, w, h } = r0;
      if (mode.includes('e')) w = r0.w + dx;
      if (mode.includes('s')) h = r0.h + dy;
      if (mode.includes('w')) {
        w = r0.w - dx;
        x = r0.x + dx;
      }
      if (mode.includes('n')) {
        h = r0.h - dy;
        y = r0.y + dy;
      }
      if (w < minSize.w) {
        if (mode.includes('w')) x -= minSize.w - w;
        w = minSize.w;
      }
      if (h < minSize.h) {
        if (mode.includes('n')) y -= minSize.h - h;
        h = minSize.h;
      }
      update({ x, y, w, h, dock: false }, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      update({}); // persist
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const docked = rect.dock && !rect.min;
  const style = docked
    ? { right: 0, top: 'var(--bar-h)', bottom: 0, width: Math.min(rect.w, window.innerWidth - 8), height: 'auto' }
    : { left: rect.x, top: rect.y, width: rect.w, height: rect.min ? 'auto' : rect.h };

  return createPortal(
    <div
      ref={ref}
      className={`rs-fp${rect.min ? ' is-min' : ''}${docked ? ' is-docked' : ''}`}
      style={style}
      role="dialog"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="rs-fp__head" onPointerDown={(e) => grab(e, 'move')} onDoubleClick={() => update({ min: !rect.min })}>
        <span className="rs-fp__title">{title}</span>
        <span className="rs-fp__sp" />
        <button className={`rs-btn rs-btn--icon rs-btn--ghost${rect.dock ? ' is-on' : ''}`} title={rect.dock ? 'Float' : 'Dock to the right side'} aria-label="Dock" onClick={() => update({ dock: !rect.dock, min: false })}>
          <Icon name="restore" size={16} />
        </button>
        <button className="rs-btn rs-btn--icon rs-btn--ghost" title={rect.min ? 'Restore' : 'Minimise to a bar'} aria-label="Minimise" onClick={() => update({ min: !rect.min })}>
          <Icon name="minus" size={16} />
        </button>
        <button className="rs-btn rs-btn--icon rs-btn--ghost" title="Close (Esc)" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>
      {!rect.min && (
        <>
          <div className="rs-fp__body">{children}</div>
          {footer && <footer className="rs-fp__foot">{footer}</footer>}
          {!docked && (['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const).map((m) => <span key={m} className={`rs-fp__h rs-fp__h--${m}`} onPointerDown={(e) => grab(e, m)} />)}
        </>
      )}
    </div>,
    document.body,
  );
}
