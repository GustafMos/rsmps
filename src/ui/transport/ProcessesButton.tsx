import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon';
import { isActiveJob, jobLine } from '../lib/process';
import { useOverlay } from '../lib/overlay';
import { useApp, useEd } from '../store/context';
import { useSelector } from '../store/createStore';
import { processStore, runProcess } from '../store/processes';

/**
 * Transport button + popover: every process job across the open projects (queued, running, paused, finished, failed) with progress and
 * Cancel. Hidden while there are no jobs, so a project that never uses process mode shows nothing.
 */
export function ProcessesButton() {
  const jobs = useSelector(processStore, (s) => s.jobs);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  if (!jobs.length) return null;
  const active = jobs.filter(isActiveJob);
  const mean = active.length ? active.reduce((s, j) => s + j.progress, 0) / active.length : 1;
  const failed = jobs.filter((j) => j.state === 'failed').length;
  return (
    <>
      <button
        ref={btn}
        className="rs-mem rs-procbtn"
        data-state={active.length ? 'running' : failed ? 'failed' : 'idle'}
        aria-label="Processes"
        title={active.length ? `${active.length} process${active.length === 1 ? '' : 'es'} running or waiting. Click for the list.` : 'Processes: nothing running. Click for the list.'}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setOpen(open ? null : { x: r.right, y: r.top });
        }}
      >
        <span className="rs-mem__lbl">{active.length ? `Jobs ${active.length}` : failed ? 'Jobs !' : 'Jobs'}</span>
        <span className="rs-mem__bar"><span style={{ width: `${Math.round(mean * 100)}%` }} /></span>
      </button>
      {open && <ProcessesPopover x={open.x} y={open.y} anchor={btn} onClose={() => setOpen(null)} />}
    </>
  );
}

function ProcessesPopover({ x, y, onClose, anchor }: { x: number; y: number; onClose: () => void; anchor: React.RefObject<HTMLButtonElement | null> }) {
  const app = useApp();
  const { io, ed } = app;
  const jobs = useSelector(processStore, (s) => s.jobs);
  const projects = useEd((s) => s.projects);
  const activeProject = useEd((s) => s.activeProject);
  const ref = useRef<HTMLDivElement>(null);
  useOverlay(onClose);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const nameOf = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const mine = (id: string) => id === activeProject || activeProject === null;
  return createPortal(
    <div ref={ref} className="rs-mem__pop rs-proc" style={{ right: window.innerWidth - x, bottom: window.innerHeight - y + 6, width: 340 }} role="dialog" aria-label="Processes">
      <div className="rs-caps">Processes</div>
      {jobs.length === 0 && <div className="rs-insp__hint">Nothing to show.</div>}
      {[...jobs].reverse().map((j) => (
        <div key={j.id} className="rs-proc__item">
          <div className="rs-proc__row">
            <span title={jobLine(j)}>{jobLine(j)}</span>
            {isActiveJob(j) ? (
              <button className="rs-btn" onClick={() => io.processes.cancel(j.node, j.project)} aria-label="Cancel"><Icon name="close" size={14} /></button>
            ) : (
              <>
                {j.state !== 'done' && mine(j.project) && (
                  <button className="rs-btn" onClick={() => void runProcess(app, j.node)} title="Run it again from the start">Retry</button>
                )}
                <button className="rs-btn" onClick={() => io.processes.dismiss(j.node, j.project)} aria-label="Dismiss"><Icon name="close" size={14} /></button>
              </>
            )}
          </div>
          {j.project !== activeProject && activeProject !== null && <div className="rs-bake__facts">in project {nameOf(j.project)}: paused until it is open</div>}
          {isActiveJob(j) && <div className="rs-proc__bar"><span style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>}
          {j.state === 'done' && mine(j.project) && (
            <button className="rs-btn" onClick={() => { ed.setViewed(j.node); onClose(); }}>View</button>
          )}
        </div>
      ))}
      <p className="rs-insp__hint">One GPU job runs at a time. Jobs wait while you play back or drag, and while another project is open.</p>
    </div>,
    document.body,
  );
}
