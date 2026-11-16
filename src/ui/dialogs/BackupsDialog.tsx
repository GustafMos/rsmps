import { useEffect, useState } from 'react';
import type { BackupInfo } from '../../io/backups';
import { isDesktop } from '../../io/desktop';
import { listFileBackups, readFileBackup, revealBackupsFolder, type FileBackup } from '../../io/desktop-backups';
import { restoreBackup } from '../safety';
import { useApp } from '../store/context';
import { Dialog } from './Dialog';

const when = (at: number) => new Date(at).toLocaleString();
const size = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Project > Backups: the last good autosaves of this project (and, in the desktop app, the files mirrored to disk). Restoring can be undone. */
export function BackupsDialog() {
  const app = useApp();
  const { io, ed } = app;
  const project = ed.state.activeProject;
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [files, setFiles] = useState<FileBackup[]>([]);
  const desktop = isDesktop();

  useEffect(() => {
    if (project) io.projects.listBackups(project).then(setList, () => setList([]));
    else setList([]);
    if (desktop) void listFileBackups().then(setFiles);
  }, [io, project, desktop]);

  const close = () => ed.openDialog(null);
  const restore = async (id: string) => {
    if (await restoreBackup(app, id)) {
      ed.toast('Backup restored. Undo (Ctrl+Z) brings the previous version back.', 'ok');
      close();
    } else ed.toast('That backup could not be read.', 'error');
  };
  const restoreFile = async (f: FileBackup) => {
    const g = await readFileBackup(f.file);
    if (!g) return ed.toast('That backup file could not be read.', 'error');
    await ed.newProjectTab(g); // a file from disk opens as a new tab: nothing is overwritten
    close();
  };

  return (
    <Dialog title="Backups" onClose={close} width={620} footer={<>{desktop && <button className="rs-btn" onClick={() => void revealBackupsFolder().then((p) => !p && ed.toast('Could not open the backups folder.', 'error'))}>Reveal backups folder</button>}<button className="rs-btn" onClick={close}>Close</button></>}>
      <p className="rs-dlg__note">RSMPS keeps the last ten autosaves of each project that rendered a picture successfully. Restoring one replaces the open project; Undo brings the current version back.</p>
      {list === null ? (
        <div className="rs-empty">Loading…</div>
      ) : list.length === 0 ? (
        <div className="rs-empty" style={{ border: '1px dashed var(--line-strong)' }}>No backups of this project yet. One is made about every 30 seconds while you work.</div>
      ) : (
        <div className="rs-dlg__list">
          {list.map((b, i) => (
            <div className="rs-dlg__row" key={b.id}>
              <span>{when(b.at)}{i === 0 ? ' (newest)' : ''}</span>
              <span className="rs-dlg__note">{b.nodes} nodes · {size(b.bytes)}</span>
              <span className="rs-dlg__spacer" />
              <button className="rs-btn" onClick={() => void restore(b.id)}>Restore</button>
            </div>
          ))}
        </div>
      )}
      {desktop && files.length > 0 && (
        <>
          <p className="rs-dlg__note">Files on disk (all projects). These survive a damaged browser database; they open as a new tab.</p>
          <div className="rs-dlg__list">
            {files.slice(0, 30).map((f) => (
              <div className="rs-dlg__row" key={f.file}>
                <span>{when(f.at)}</span>
                <span className="rs-dlg__note">{f.name} · {size(f.bytes)}</span>
                <span className="rs-dlg__spacer" />
                <button className="rs-btn" onClick={() => void restoreFile(f)}>Open as new tab</button>
              </div>
            ))}
          </div>
        </>
      )}
    </Dialog>
  );
}
