import pkg from '../../../package.json';
import { ABOUT, NOT_AFFILIATED } from '../aboutCopy';
import { useApp } from '../store/context';
import { Dialog } from './Dialog';

export function AboutDialog() {
  const { ed } = useApp();
  const close = () => ed.openDialog(null);
  return (
    <Dialog title="About" onClose={close} width={560} footer={<button className="rs-btn" onClick={close}>Close</button>}>
      <div className="rs-dlg__sec">
        <strong>{ABOUT.title}</strong>
        <p className="rs-dlg__note">Version {pkg.version}. {ABOUT.licence}</p>
        <p className="rs-dlg__note"><a href={ABOUT.source} target="_blank" rel="noopener noreferrer">{ABOUT.source}</a></p>
      </div>
      <div className="rs-dlg__sec">
        <strong>Not affiliated</strong>
        <p className="rs-dlg__note">{NOT_AFFILIATED}</p>
      </div>
    </Dialog>
  );
}
