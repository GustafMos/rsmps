import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import '../menus/menus.css';

export interface MenuItem {
  label?: string;
  onClick?: () => void;
  shortcut?: string;
  disabled?: boolean;
  sep?: boolean;
  head?: string;
}

export function MenuPopup({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="rs-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="rs-menu__sep" />
        ) : it.head ? (
          <div key={i} className="rs-menu__head rs-caps">
            {it.head}
          </div>
        ) : (
          <button
            key={i}
            className="rs-menu__item"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
          >
            <span>{it.label}</span>
            {it.shortcut && <span className="rs-kbd">{it.shortcut}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** A button that opens a menu below it. */
export function MenuButton({ children, items, className, title }: { children: ReactNode; items: MenuItem[]; className?: string; title?: string }) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        className={className ?? 'rs-btn rs-btn--ghost'}
        title={title}
        aria-haspopup="menu"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { x: r.left, y: r.bottom + 2 });
        }}
      >
        {children}
      </button>
      {open && <MenuPopup x={open.x} y={open.y} items={items} onClose={() => setOpen(null)} />}
    </>
  );
}
