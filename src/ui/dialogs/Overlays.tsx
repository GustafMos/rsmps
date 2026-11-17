import { useEffect } from 'react';
import { Icon } from '../components/Icon';
import { SUPPORT } from '../supportCopy';
import { useApp, useEd } from '../store/context';
import { ExportDialog } from './ExportDialog';
import { PluginsDialog } from './PluginsDialog';
import { PresetsDialog, SavePresetDialog } from './PresetsDialog';
import { PaletteStudio } from '../palette/PaletteStudio';
import { KeymapDialog } from './KeymapDialog';
import { ShortcutsDialog } from './ShortcutsDialog';
import { BackupsDialog } from './BackupsDialog';
import { AboutDialog } from './AboutDialog';
import { BlankSheetsDialog } from '../scan/BlankSheetsDialog';
import { ConfirmHost, SaveNodeDialog } from './GroupDialogs';

export function DialogHost() {
  return (
    <>
      <DialogSwitch />
      <ConfirmHost />
    </>
  );
}

function DialogSwitch() {
  const dialog = useEd((s) => s.dialog);
  switch (dialog) {
    case 'saveNode':
      return <SaveNodeDialog />;
    case 'export':
      return <ExportDialog />;
    case 'plugins':
      return <PluginsDialog />;
    case 'presets':
      return <PresetsDialog />;
    case 'savePreset':
      return <SavePresetDialog />;
    case 'palette':
      return <PaletteStudio />;
    case 'keymap':
      return <KeymapDialog />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    case 'backups':
      return <BackupsDialog />;
    case 'about':
      return <AboutDialog />;
    case 'blankSheets':
      return <BlankSheetsDialog />;
    default:
      return null;
  }
}

export function SupportCard() {
  const { ed } = useApp();
  const kind = useEd((s) => s.supportPrompt);
  useEffect(() => {
    if (!kind) return;
    const t = setTimeout(() => ed.dismissSupport(), 20000);
    return () => clearTimeout(t);
  }, [kind, ed]);
  if (!kind) return null;
  return (
    <aside className="rs-support" role="complementary" aria-label="Support RSMPS">
      <img src={`${import.meta.env.BASE_URL}ripscorpy-logo.png`} alt="" width={36} height={36} />
      <div className="rs-support__body">
        <p>{SUPPORT[kind]}</p>
        <div className="rs-support__btns">
          <a className="rs-btn rs-btn--primary" href={SUPPORT.url} target="_blank" rel="noopener noreferrer" onClick={() => ed.dismissSupport()}>{SUPPORT.button}</a>
          <button className="rs-btn rs-btn--ghost" onClick={() => ed.dismissSupport()}>{SUPPORT.dismiss}</button>
        </div>
      </div>
      <button className="rs-btn rs-btn--icon rs-btn--ghost rs-support__x" onClick={() => ed.dismissSupport()} aria-label="Dismiss"><Icon name="close" size={12} /></button>
    </aside>
  );
}

export function ExportBar() {
  const { ed } = useApp();
  const job = useEd((s) => s.exportJob);
  if (!job) return null;
  return (
    <div className="rs-expbar" role="status">
      <div className="rs-dlg__bar"><div style={{ width: `${Math.round(job.fraction * 100)}%` }} /></div>
      <div className="rs-dlg__row">
        <span className="rs-mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.label}</span>
        <span className="rs-num">{Math.round(job.fraction * 100)}%</span>
        <button className="rs-btn rs-btn--danger" onClick={() => ed.cancelExport()}>Cancel</button>
      </div>
    </div>
  );
}

export function Toasts() {
  const { ed } = useApp();
  const toasts = useEd((s) => s.toasts);
  return (
    <div className="rs-toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`rs-toast rs-toast--${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <Icon name={t.kind === 'error' ? 'warn' : t.kind === 'ok' ? 'check' : 'help'} size={14} />
          <span>{t.text}{t.count && t.count > 1 ? <b className="rs-toast__n"> ×{t.count}</b> : null}</span>
          {t.actions?.map((a) => (
            <button key={a.label} className="rs-btn" onClick={() => { a.run(); ed.dismissToast(t.id); }}>{a.label}</button>
          ))}
          <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.dismissToast(t.id)} title="Dismiss"><Icon name="close" size={12} /></button>
        </div>
      ))}
    </div>
  );
}
