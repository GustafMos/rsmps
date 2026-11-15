import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** "Fields the user said not to ask about again" (this session only). */
const quiet = new Set<string>();
export const isQuiet = (key: string) => quiet.has(key);

/** Small non-blocking confirm for suspiciously large typed numbers. Enter or Esc keeps the previous value. */
export function NumberConfirm({ anchor, value, label, softMax, askKey, format, onUse, onCancel }: {
  anchor: HTMLElement | null;
  value: number;
  label: string;
  softMax?: number;
  askKey: string;
  format: (n: number) => string;
  onUse: (v: number) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: -999, y: -999 });
  const [dontAsk, setDontAsk] = useState(false);
  const use = (v: number) => {
    if (dontAsk) quiet.add(askKey);
    onUse(v);
  };
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.max(8, Math.min(a.left, window.innerWidth - r.width - 8)),
      y: a.bottom + 4 + r.height > window.innerHeight - 8 ? Math.max(8, a.top - r.height - 4) : a.bottom + 4,
    });
  }, [anchor]);
  useEffect(() => {
    ref.current?.focus();
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onCancel();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [onCancel]);
  return createPortal(
    <div
      ref={ref}
      className="rs-pop rs-numconfirm"
      style={{ left: pos.x, top: pos.y }}
      role="alertdialog"
      aria-label="Confirm large value"
      tabIndex={-1}
      data-nodrag
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <p className="rs-numconfirm__text">
        <strong className="rs-num">{format(value)}</strong> is unusually large for {label}
        {softMax !== undefined ? ` (typical maximum ${format(softMax)})` : ''}. It may be slow. Did you mean that?
      </p>
      <label className="rs-numconfirm__ask">
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} /> Don&apos;t ask again for this field
      </label>
      <div className="rs-pop__row">
        <button className="rs-btn rs-btn--danger" onClick={() => use(value)}>Use {format(value)}</button>
        {softMax !== undefined && <button className="rs-btn rs-btn--primary" onClick={() => use(softMax)}>Use {format(softMax)}</button>}
        <button className="rs-btn" onClick={onCancel}>Cancel</button>
      </div>
    </div>,
    document.body,
  );
}
