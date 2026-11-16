import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon';
import { useOverlay } from '../lib/overlay';
import './dialogs.css';

export function Dialog({ title, onClose, children, footer, width = 520 }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useOverlay(onClose, true);
  return createPortal(
    <div className="rs-dlg__scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="rs-dlg" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <header className="rs-dlg__head">
          <span className="rs-dlg__title">{title}</span>
          <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={onClose} title="Close (Esc)"><Icon name="close" /></button>
        </header>
        <div className="rs-dlg__body">{children}</div>
        {footer && <footer className="rs-dlg__foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
