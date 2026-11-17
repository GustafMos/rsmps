import { useEffect, useState } from 'react';
import { etaSeconds, formatEta, type QueueJob } from '../../io/queue';
import { Icon } from '../components/Icon';
import { MenuPopup } from '../components/Menu';
import { Dialog } from '../dialogs/Dialog';
import { addCurrent, addFile, addTab, chooseFolder, ensureFolderPermission, getQueue, queueState, queueUi } from '../store/queue';
import { useApp, useEd } from '../store/context';
import { useSelector } from '../store/createStore';
import { featureStore, openFeature } from '../store/features';
import './queue.css';

const STATUS_TEXT: Record<QueueJob['status'], string> = { pending: 'waiting', running: 'rendering', done: 'ok', failed: 'failed', skipped: 'skipped', interrupted: 'interrupted' };

/** Several projects rendered one after another: add jobs, set what each renders, start it and leave. */
export function QueueDialog() {
  const app = useApp();
  const { ed } = app;
  const q = getQueue(app);
  useSelector(queueState, (s) => s.v);
  const ui = useSelector(queueUi, (s) => s);
  const st = q.get();
  const projects = useEd((s) => s.projects);
  const active = useEd((s) => s.activeProject);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!st.running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [st.running]);
  const close = () => openFeature(null);
  const pending = st.jobs.filter((j) => j.status === 'pending').length;

  const start = async () => {
    if (!(await ensureFolderPermission())) ed.toast('No access to the folder: files will download instead.', 'info');
    void q.start();
  };
  const addMenu = [
    { label: 'This project', onClick: () => void addCurrent(app) },
    ...projects.filter((p) => p.id !== active && (p as { kind?: string }).kind !== 'scan').map((p) => ({ label: `Tab: ${p.name || 'Untitled'}`, onClick: () => void addTab(app, p.id, p.name || 'Untitled') })),
    { sep: true as const },
    { label: 'A saved project file…', onClick: () => void addFile(app) },
  ];

  return (
    <Dialog
      title="Render queue"
      onClose={close}
      width={560}
      footer={
        <>
          <button className="rs-btn" onClick={() => q.clearFinished()} disabled={!st.jobs.some((j) => j.status === 'done' || j.status === 'failed' || j.status === 'skipped')}>Clear finished</button>
          <span style={{ flex: 1 }} />
          <button className="rs-btn" onClick={close}>Close</button>
        </>
      }
    >
      <div className="rs-q">
        <div className="rs-q__bar">
          <button className="rs-btn" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 2 }); }} aria-haspopup="menu"><Icon name="plus" /> Add…</button>
          {st.running ? (
            <>
              <button className="rs-btn" onClick={() => (st.paused ? q.resume() : q.pause())}>{st.paused ? 'Resume' : 'Pause after this job'}</button>
              <button className="rs-btn rs-btn--danger" onClick={() => q.cancelCurrent()}>Cancel current</button>
            </>
          ) : (
            <button className="rs-btn rs-btn--primary" disabled={!pending} onClick={() => void start()}>{st.paused && pending ? 'Resume queue' : 'Start queue'}</button>
          )}
          <span className="rs-q__note">{st.running ? 'Queue running: avoid exporting by hand meanwhile.' : pending ? `${pending} job${pending === 1 ? '' : 's'} waiting` : 'Nothing waiting'}</span>
        </div>

        <div className="rs-q__bar">
          {ui.canPickFolder ? (
            <>
              <button className="rs-btn" onClick={() => void chooseFolder()}><Icon name="folder" /> {ui.folder ? 'Change folder' : 'Choose a folder'}</button>
              <span className="rs-q__note">{ui.folder ? `Files go into "${ui.folder}".` : 'No folder chosen: each job downloads as one zip.'}</span>
            </>
          ) : (
            <span className="rs-q__note">This browser cannot write into a folder: each job downloads as one zip. Allow multiple downloads if it asks.</span>
          )}
        </div>

        {st.jobs.length === 0 ? (
          <p className="rs-q__note">No jobs yet. Add this project, another open tab or a saved project file. Each job renders the Output nodes that are switched on.</p>
        ) : (
          <ul className="rs-q__list">
            {st.jobs.map((j, i) => (
              <li key={j.id} className={`rs-q__job${j.status === 'running' ? ' is-running' : ''}`}>
                <div className="rs-q__row">
                  <span className="rs-q__name" title={j.name}>{i + 1}. {j.name}</span>
                  <span className={`rs-q__status is-${j.status}`}>{STATUS_TEXT[j.status]}</span>
                  {j.status === 'running' && <span className="rs-q__note">{formatEta(etaSeconds(j.progress, j.startedAt, Date.now()))}</span>}
                  <button className="rs-btn rs-btn--icon rs-btn--ghost" aria-label="Move up" title="Move up" disabled={i === 0 || j.status === 'running'} onClick={() => q.move(j.id, -1)}>↑</button>
                  <button className="rs-btn rs-btn--icon rs-btn--ghost" aria-label="Move down" title="Move down" disabled={i === st.jobs.length - 1 || j.status === 'running'} onClick={() => q.move(j.id, 1)}>↓</button>
                  <button className="rs-btn rs-btn--icon rs-btn--ghost" aria-label="Duplicate" title="Duplicate (then change its outputs)" onClick={() => q.duplicate(j.id)}><Icon name="copy" size={12} /></button>
                  {(j.status === 'failed' || j.status === 'skipped' || j.status === 'interrupted') && <button className="rs-btn" onClick={() => q.retry(j.id)}>Retry</button>}
                  {(j.status === 'pending' || j.status === 'interrupted') && <button className="rs-btn rs-btn--ghost" onClick={() => q.skip(j.id)}>Skip</button>}
                  <button className="rs-btn rs-btn--icon rs-btn--ghost" aria-label="Remove" title="Remove" disabled={j.status === 'running'} onClick={() => q.remove(j.id)}><Icon name="trash" size={12} /></button>
                </div>
                {j.status === 'running' && <div className="rs-q__prog"><div style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>}
                {j.status === 'running' && <span className="rs-q__msg">{j.label}</span>}
                {(j.status === 'pending' || j.status === 'interrupted' || j.status === 'failed' || j.status === 'skipped') && (
                  <>
                    <div className="rs-q__outs">
                      {j.outputs.map((o) => (
                        <label key={o.id}><input type="checkbox" checked={o.enabled} onChange={(e) => q.setOutputEnabled(j.id, o.id, e.target.checked)} /> {o.label}</label>
                      ))}
                    </div>
                    <input className="rs-input rs-q__pattern" placeholder="File name pattern (optional)" value={j.namePattern} onChange={(e) => q.setNamePattern(j.id, e.target.value)} aria-label="File name pattern" />
                  </>
                )}
                {j.message && <span className={`rs-q__msg${j.status === 'failed' || j.status === 'interrupted' ? ' is-error' : ''}`}>{j.message}</span>}
                {j.status === 'done' && j.files.length > 0 && <span className="rs-q__msg" title={j.files.join('\n')}>{j.files.length} file{j.files.length === 1 ? '' : 's'}: {j.files.slice(0, 3).join(', ')}{j.files.length > 3 ? '…' : ''}</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="rs-q__note">Processes that have to run first (Bake, analysis) run automatically before each job. After the last job nothing happens: the computer is not put to sleep or shut down by the app. For batches without the window, use the command line (see docs/RECIPES.md).</p>
      </div>
      {menu && <MenuPopup x={menu.x} y={menu.y} items={addMenu} onClose={() => setMenu(null)} />}
    </Dialog>
  );
}

/** A small badge while the queue runs, so it is clear even with the dialog closed. */
export function QueueBadge() {
  const app = useApp();
  const busy = useSelector(queueUi, (s) => s.busy);
  useSelector(queueState, (s) => s.v);
  const dialog = useSelector(featureStore, (s) => s.dialog);
  if (!busy || dialog === 'queue') return null;
  const cur = getQueue(app).get().jobs.find((j) => j.status === 'running');
  return (
    <button className="rs-qbadge" onClick={() => openFeature('queue')} title="Open the render queue" role="status">
      <span className="rs-ps__dot" />
      <span>Queue: {cur ? `${cur.name} ${Math.round(cur.progress * 100)}%` : 'running'}</span>
    </button>
  );
}

