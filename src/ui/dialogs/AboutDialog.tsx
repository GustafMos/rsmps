import { useState } from 'react';
import pkg from '../../../package.json';
import { isDesktop } from '../../io/desktop';
import { isCheckEnabled, setCheckEnabled } from '../../io/updates';
import { ABOUT, NOT_AFFILIATED } from '../aboutCopy';
import { useApp } from '../store/context';
import { Dialog } from './Dialog';

export function AboutDialog() {
  const { ed } = useApp();
  const close = () => ed.openDialog(null);
  const [check, setCheck] = useState(() => isCheckEnabled(localStorage));
  return (
    <Dialog title="About" onClose={close} width={560} footer={<button className="rs-btn" onClick={close}>Close</button>}>
      <div className="rs-dlg__sec">
        <strong>{ABOUT.title}</strong>
        <p className="rs-dlg__note">Version {pkg.version}. {ABOUT.licence}</p>
        <p className="rs-dlg__note"><a href={ABOUT.source} target="_blank" rel="noopener noreferrer">{ABOUT.source}</a></p>
      </div>
      {isDesktop() && (
        <div className="rs-dlg__sec">
          <strong>Updates</strong>
          <p className="rs-dlg__note">{ABOUT.updates}</p>
          <label className="rs-dlg__note" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={check} onChange={(e) => { setCheckEnabled(localStorage, e.target.checked); setCheck(e.target.checked); }} />
            Check for new versions on start
          </label>
        </div>
      )}
      <div className="rs-dlg__sec">
        <strong>Not affiliated</strong>
        <p className="rs-dlg__note">{NOT_AFFILIATED}</p>
      </div>
    </Dialog>
  );
}
