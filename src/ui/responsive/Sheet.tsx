import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon';
import { useOverlay } from '../lib/overlay';

/**
 * A bottom sheet for phones and tablets: a scrim, a title bar with a clear close button, a scrolling body. It sits on the visible part of
 * the screen (`--vv-top` / `--vv-h` from keyboardAvoid.ts), so a search field in it is never under the on-screen keyboard.
 * Not for desktop: those places keep their popovers.
 */
export function Sheet({ title, onClose, children, footer, tall = false }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; tall?: boolean }) {
  useOverlay(onClose, true);
  return createPortal(
    <div className="rs-sheet__scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`rs-sheet${tall ? ' rs-sheet--tall' : ''}`} role="dialog" aria-modal="true" aria-label={title} data-sheet>
        <header className="rs-sheet__head">
          <span className="rs-sheet__grab" aria-hidden="true" />
          <span className="rs-sheet__title">{title}</span>
          <button className="rs-btn rs-btn--icon rs-btn--ghost rs-sheet__close" onClick={onClose} aria-label="Close" title="Close">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="rs-sheet__body">{children}</div>
        {footer && <footer className="rs-sheet__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
