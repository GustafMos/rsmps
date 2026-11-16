import { useApp } from '../store/context';
import { useSelector } from '../store/createStore';
import { Icon } from './Icon';
import { dismissBanner, reloadInSafeMode, resumeRendering, safeBannerText, safetyStore, setPaused, undoLastChange } from '../safety';

/**
 * Two bars under the top bar:
 *  - the safe-mode banner (the last run did not end cleanly, or safe mode was asked for): Resume, Undo last change, Open a backup, New empty project;
 *  - "Rendering is taking long…" with a Pause button, while an edit has not finished rendering.
 */
export function SafetyBar() {
  const app = useApp();
  const { ed } = app;
  const paused = useSelector(safetyStore, (s) => s.paused);
  const banner = useSelector(safetyStore, (s) => s.banner);
  const safe = useSelector(safetyStore, (s) => s.safe);
  const slow = useSelector(safetyStore, (s) => s.slow);

  const undo = async () => {
    const r = await undoLastChange(app);
    if (!r) ed.toast('There is no earlier change to undo. Open a backup instead.', 'info');
    else if (r.kind === 'param') ed.toast(`Reverted ${r.label}. Press Resume rendering to check.`, 'ok');
    else ed.toast(`Restored the newest backup (${new Date(r.at).toLocaleTimeString()}). Press Resume rendering to check.`, 'ok');
  };

  if (banner && paused) {
    return (
      <div className="rs-safe rs-safe--bar" role="alert">
        <Icon name="warn" size={14} />
        <span className="rs-safe__text">{safeBannerText(safe)}</span>
        <span className="rs-safe__btns">
          <button className="rs-btn rs-btn--primary" onClick={() => resumeRendering(app)}>Resume rendering</button>
          <button className="rs-btn" onClick={() => void undo()} title="Put the last edited value back, or restore the newest backup">Undo last change</button>
          <button className="rs-btn" onClick={() => ed.openDialog('backups')}>Open a backup…</button>
          <button className="rs-btn" onClick={() => void ed.newProjectTab().then(() => setPaused(app, false))}>New empty project</button>
          <button className="rs-btn rs-btn--ghost" onClick={dismissBanner} title="Hide this bar (rendering stays paused until you resume)">Hide</button>
        </span>
      </div>
    );
  }
  if (slow && !paused) {
    return (
      <div className="rs-safe rs-safe--bar" role="status">
        <Icon name="warn" size={14} />
        <span className="rs-safe__text">Rendering is taking long… The last change may be too heavy.</span>
        <span className="rs-safe__btns">
          <button className="rs-btn rs-btn--primary" onClick={() => setPaused(app, true)}>Pause rendering</button>
          <button className="rs-btn" onClick={() => void undo()}>Undo last change</button>
          <button className="rs-btn rs-btn--ghost" onClick={() => reloadInSafeMode(app)}>Reload in safe mode</button>
        </span>
      </div>
    );
  }
  if (paused) {
    return (
      <div className="rs-safe rs-safe--bar rs-safe--quiet" role="status">
        <span className="rs-safe__text">Rendering is paused. Edits still apply to the graph.</span>
        <button className="rs-btn rs-btn--primary" onClick={() => resumeRendering(app)}>Resume rendering</button>
      </div>
    );
  }
  return null;
}
