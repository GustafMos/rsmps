/**
 * Pure helpers for process mode in the UI (badge, texts, ordering). No React, no IO: tested in process.test.ts.
 * The state itself comes from the engine (`Io.processes.status`) and the scheduler (`ProcessJob`).
 */
import type { ProcessState } from '../../engine/types';
import type { ProcessJob } from '../../io/api';

export type ProcessBadgeKind = 'queued' | 'running' | 'paused' | 'done' | 'stale' | 'failed' | 'missing';

export interface ProcessBadge {
  text: string;
  kind: ProcessBadgeKind;
  title: string;
}

export const isActiveJob = (j: ProcessJob | null | undefined): boolean => !!j && (j.state === 'queued' || j.state === 'running' || j.state === 'paused');

/** The small label on a node: nothing for a node that never ran. */
export function processBadge(title: string, state: ProcessState, job: ProcessJob | null | undefined): ProcessBadge | null {
  if (job && isActiveJob(job)) {
    const pct = Math.round(job.progress * 100);
    if (job.state === 'queued') return { text: 'queued', kind: 'queued', title: `${title}: waiting for its turn${job.pausedFor ? ` (${job.pausedFor})` : ''}` };
    if (job.state === 'paused') return { text: `paused ${pct}%`, kind: 'paused', title: `${title}: paused while ${job.pausedFor ?? 'something else has priority'}. It continues by itself.` };
    return { text: `${pct}%`, kind: 'running', title: `${title}: ${pct}% done${job.note ? ` · ${job.note}` : ''}` };
  }
  if (job?.state === 'failed') return { text: 'failed', kind: 'failed', title: `${title} failed: ${job.error ?? 'unknown error'}` };
  switch (state) {
    case 'done':
      return { text: 'done', kind: 'done', title: `${title}: done. The stored result is used instead of calculating.` };
    case 'stale':
      return { text: 'stale', kind: 'stale', title: `${title}: something before this node (or its settings) changed after it ran. The old result is kept; run it again to update.` };
    case 'missing':
      return { text: 'lost', kind: 'missing', title: `${title}: the stored result is gone (cleared storage?). Run it again.` };
    case 'failed':
      return { text: 'failed', kind: 'failed', title: `${title} failed.` };
    default:
      return null;
  }
}

const cap = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;

/** One sentence for the inspector. */
export function processStateText(title: string, standIn: string, state: ProcessState, job: ProcessJob | null | undefined): string {
  const shows = standIn === 'bypass' ? 'the picture passes through' : standIn === 'placeholder' ? 'a "processing" card is shown' : standIn === 'last' ? 'the last result is kept' : 'a quick approximation is shown';
  if (job && isActiveJob(job)) {
    const pct = Math.round(job.progress * 100);
    if (job.state === 'queued') return `${title}: waiting for its turn${job.pausedFor ? ` (${job.pausedFor})` : ''}.`;
    if (job.state === 'paused') return `${title}: paused at ${pct}% while ${job.pausedFor ?? 'something else has priority'}. It continues by itself.`;
    return `${title}: ${pct}% done.`;
  }
  if (job?.state === 'failed') return `${title} failed: ${job.error ?? 'unknown error'}. Nothing was stored; ${shows} meanwhile.`;
  switch (state) {
    case 'done':
      return `${title}: done. The stored result is used; what feeds this node is not needed for it.`;
    case 'stale':
      return `Stale: something before this node, or its settings, changed after ${title.toLowerCase()} ran. ${standIn === 'last' ? 'The old result is still shown.' : `${cap(shows)}.`} Run it again to update. It never restarts by itself.`;
    case 'missing':
      return `The stored result is gone (cleared storage, or another computer). ${cap(shows)}. Run it again.`;
    default:
      return `Not run yet: ${shows}. Press ${title} to run it once; the result is saved with the project.`;
  }
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, '0')} s`;
}

/** Job line for the global list: "Analyse clip · Track · 42%". */
export function jobLine(j: ProcessJob): string {
  const pct = `${Math.round(j.progress * 100)}%`;
  const what = `${j.title} · ${j.label}`;
  switch (j.state) {
    case 'queued':
      return `${what} · queued${j.pausedFor ? ` (${j.pausedFor})` : ''}`;
    case 'paused':
      return `${what} · paused at ${pct} (${j.pausedFor ?? 'waiting'})`;
    case 'running':
      return `${what} · ${pct}${j.note ? ` · ${j.note}` : ''}`;
    case 'failed':
      return `${what} · failed: ${j.error ?? ''}`;
    case 'cancelled':
      return `${what} · cancelled`;
    default:
      return `${what} · done`;
  }
}
