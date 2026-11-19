import type { NodeInstance } from '../../engine/types';
import type { ProcessStatus } from '../../engine/process';
import type { ProcessJob } from '../../io/api';
import { isActiveJob } from '../lib/process';
import { ProcessPanel } from './ProcessPanel';

/** The sentence above the buttons, where the generic one would be vague about what this node shows without a result. Pure (tested). */
export function datamoshStateText(state: string, job: Pick<ProcessJob, 'state' | 'error'> | null, hasResult = false): string | null {
  if (job && isActiveJob(job as ProcessJob)) return null; // progress: the generic sentences
  if (job?.state === 'failed') return `Mosh failed: ${job.error ?? 'unknown error'}. Nothing was stored; ${hasResult ? 'the last mosh is still shown' : 'the picture passes through unchanged'}.`;
  if (state === 'none') return 'Not moshed yet: the picture passes through unchanged. This effect cannot be calculated live. Press Mosh to compress, damage and decode the whole project once; the result is saved with the project.';
  if (state === 'missing') return 'The stored mosh is gone (cleared storage, or another computer): the picture passes through unchanged. Press Mosh to make it again.';
  if (state === 'stale') return 'Out of date: the settings, or something before this node, changed after the mosh was made. The old mosh is still shown. Press Mosh again to update it; it never restarts by itself.';
  return null;
}

/** What the last mosh found and used: the codec, the cuts, what was damaged. Pure (tested). */
export function datamoshFacts(meta: Record<string, unknown>): string | null {
  if (typeof meta.codec !== 'string') return null;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const parts = [`${meta.codec}`, `${n(meta.frames)} frames`];
  const at = Array.isArray(meta.removedAt) ? (meta.removedAt as number[]) : [];
  if (n(meta.removed) > 0) parts.push(`${n(meta.removed)} key frame${n(meta.removed) === 1 ? '' : 's'} removed${at.length && at.length <= 8 ? ` at ${at.join(', ')}` : ''}`);
  else if (meta.mode !== 'bloom') parts.push(n(meta.cuts) > 0 ? 'no key frame removed' : 'no cut found, no key frame removed');
  if (n(meta.blooms) > 0) parts.push(`${n(meta.blooms)} bloom${n(meta.blooms) === 1 ? '' : 's'}`);
  else if (meta.mode === 'bloom') parts.push('no bloom: nothing to repeat there');
  if (typeof meta.item === 'number') parts.push(`batch item ${meta.item + 1} only`);
  return parts.join(' · ');
}

/**
 * Codec Datamosh's inspector section: the generic process panel (Mosh / Mosh again / Cancel / Clear, progress) with its own
 * sentences, because this node has no live version at all and has to say so plainly.
 */
export function DatamoshPanel({ node }: { node: NodeInstance }) {
  return (
    <ProcessPanel
      node={node}
      runLabel="Mosh"
      rerunLabel="Mosh again"
      stateText={(status: ProcessStatus | null, job) => datamoshStateText(status?.state ?? 'none', job, !!status?.result)}
      facts={(st) => datamoshFacts(st.result?.meta ?? {})}
      hint="Renders every frame, compresses it as video in this browser, leaves out or repeats frames of the compressed stream and stores what the decoder makes of it. Needs motion; removing key frames needs a cut."
    />
  );
}
