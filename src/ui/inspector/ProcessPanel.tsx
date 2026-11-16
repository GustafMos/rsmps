import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { resolveNodeParams } from '../../engine/engine';
import type { NodeInstance } from '../../engine/types';
import type { ProcessStatus } from '../../engine/process';
import type { ProcessJob } from '../../io/api';
import { Icon } from '../components/Icon';
import { formatElapsed, isActiveJob, processStateText } from '../lib/process';
import { formatBytes } from '../lib/bake';
import { useApp, useDef, useEd } from '../store/context';
import { useSelector } from '../store/createStore';
import { cancelProcess, clearProcess, jobOf, processStore, runProcess } from '../store/processes';
import '../graph/bake.css';

/**
 * Inspector section of any node that declares `process`: what state it is in, Process / Re-process / Cancel / Clear, progress with
 * the job's own note, elapsed time, and what the stored result weighs. Bake wraps it (BakePanel) with its quality choice.
 */
export function ProcessPanel({
  node,
  extra,
  options,
  stateText,
  facts,
  hint,
  runLabel,
  rerunLabel,
}: {
  node: NodeInstance;
  /** Controls above the buttons (Bake: the quality select). */
  extra?: ReactNode;
  /** Options handed to the job when it starts. */
  options?: () => Record<string, unknown>;
  /** Replace the generic sentence. */
  stateText?: (status: ProcessStatus | null, job: ProcessJob | null) => string | null;
  /** Extra fact line for a stored result. */
  facts?: (status: ProcessStatus) => string | null;
  hint?: string;
  /** Button caption for the first run (default: the process title). */
  runLabel?: string;
  /** Button caption when a result exists (default: "<title> again"). */
  rerunLabel?: string;
}) {
  const app = useApp();
  const def = useDef(node.type);
  const pdef = def?.process;
  const graph = useEd((s) => s.graph);
  const project = useEd((s) => s.activeProject) ?? 'project';
  const job = useSelector(processStore, (s) => jobOf(s.jobs, project, node.id));
  const status = useMemo(() => (pdef ? app.io.processes.status(graph, node.id) : null), [app, pdef, graph, node.id, job?.state]);
  const active = isActiveJob(job);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  const estimate = useMemo(() => {
    if (!pdef?.estimate || !def) return null;
    try {
      return pdef.estimate(resolveNodeParams(def, node.params) as never, graph.project);
    } catch {
      return null;
    }
  }, [pdef, def, node.params, graph.project]);
  if (!def || !pdef) return null;

  const state = status?.state ?? 'none';
  const has = !!status?.referenced;
  const pct = Math.round((job?.progress ?? 0) * 100);
  const result = status?.result ?? null;
  const text = stateText?.(status, job) ?? processStateText(pdef.title, pdef.standIn, state, job);
  const run = () => void runProcess(app, node.id, { options: options?.() });
  const shown = !active && (has || state === 'missing' || job?.state === 'failed');

  return (
    <div className="rs-insp__sec rs-bake rs-process" data-process-state={job && active ? job.state : state}>
      <div className="rs-caps">{pdef.title}</div>
      <div className="rs-bake__state" role="status">{text}</div>
      {active && job && (
        <>
          <div className="rs-bake__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="rs-bake__facts rs-num">
            {pct}%{job.note ? ` · ${job.note}` : ''} · {formatElapsed(now - (job.startedAt ?? job.queuedAt))}
            {typeof job.detail?.bytes === 'number' ? ` · ${formatBytes(job.detail.bytes)} so far` : ''}
          </div>
        </>
      )}
      {!active && result && (
        <div className="rs-bake__facts rs-num">
          {result.bytes > 0 ? `${formatBytes(result.bytes)} stored` : 'stored'}
          {result.seconds > 0 ? ` · took ${formatElapsed(result.seconds * 1000)}` : ''}
          {facts?.(status!) ? ` · ${facts(status!)}` : ''}
        </div>
      )}
      {!active && !result && estimate && (
        <div className="rs-bake__facts rs-num">
          {estimate.frames ? `${estimate.frames} frames` : ''}
          {estimate.bytes ? `${estimate.frames ? ' · ' : ''}about ${formatBytes(estimate.bytes)}` : ''}
          {estimate.note ? `${estimate.frames || estimate.bytes ? ' · ' : ''}${estimate.note}` : ''}
        </div>
      )}
      {extra}
      <div className="rs-insp__actions">
        {active ? (
          <button className="rs-btn" onClick={() => cancelProcess(app, node.id)}><Icon name="close" /> Cancel</button>
        ) : (
          <>
            <button className="rs-btn rs-btn--primary" onClick={run} title={pdef.description ?? `Run ${pdef.title.toLowerCase()} once and store the result`}>
              <Icon name="play" /> {shown ? (rerunLabel ?? `${pdef.title} again`) : (runLabel ?? pdef.title)}
            </button>
            {shown && (
              <button className="rs-btn rs-btn--danger" onClick={() => void clearProcess(app, node.id)} title="Delete the stored result; the node goes back to its stand-in">
                <Icon name="trash" /> Clear
              </button>
            )}
          </>
        )}
      </div>
      <p className="rs-insp__hint">
        {hint ?? pdef.description ?? 'Runs once, outside playback.'} Edits before this node never restart it by themselves: it only says it is stale. Playing back or dragging pauses it; it continues by itself.
      </p>
    </div>
  );
}
