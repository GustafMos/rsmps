import type { NodeInstance } from '../../engine/types';
import type { ProcessStatus } from '../../engine/process';
import type { ProcessJob } from '../../io/api';
import { isActiveJob } from '../lib/process';
import { ProcessPanel } from './ProcessPanel';

/** The sentence above the buttons. Pure (tested): says plainly what the node shows in each state. */
export function stabilizeStateText(state: string, job: Pick<ProcessJob, 'state' | 'error'> | null, hasResult = false): string | null {
  if (job && isActiveJob(job as ProcessJob)) return null; // progress: the generic sentences
  if (job?.state === 'failed') return `Analysis failed: ${job.error ?? 'unknown error'}. Nothing was stored; ${hasResult ? 'the last analysis is still used' : 'the picture passes through unchanged'}.`;
  if (state === 'none') return 'Not analysed yet: the picture passes through unchanged. Press Analyse to measure the camera motion of the whole clip once; the result is saved with the project.';
  if (state === 'missing') return 'The stored analysis is gone (cleared storage, or another computer): the picture passes through unchanged. Press Analyse to make it again.';
  if (state === 'stale') return 'The clip before this node changed since it was analysed. The old analysis is still used, so frames that moved may not be steady. Press Analyse again to update it; it never restarts by itself.';
  if (state === 'done') return 'Analysed. The stored camera motion is used; changing the settings below needs no new analysis.';
  return null;
}

/** What the analysis found: frames, uncertain ones, repeated stills, the zoom needed. Pure (tested). */
export function stabilizeFacts(meta: Record<string, unknown>, params: Record<string, unknown> = {}): string | null {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const frames = n(meta.frames);
  if (frames === null) return null;
  const uncertain = n(meta.uncertain) ?? 0;
  const parts = [`Analysed ${frames} frame${frames === 1 ? '' : 's'}, ${uncertain} uncertain`];
  const repeated = n(meta.repeated) ?? 0;
  if (repeated > 0) parts.push(`${repeated} repeated still${repeated === 1 ? '' : 's'} skipped`);
  const zoom = n(meta.zoom);
  if (zoom !== null && zoom > 1.0005) {
    const max = n(params.maxZoom);
    const hides = params.edges === undefined || params.edges === 'zoom';
    parts.push(`zoom ${zoom.toFixed(2)}x needed to hide the borders${hides && max !== null && zoom > max ? ` (limit ${max.toFixed(2)}x, the edge is stretched past it)` : ''}`);
  }
  if (typeof meta.item === 'number') parts.push(`batch item ${meta.item + 1} only`);
  return parts.join(' · ');
}

/** Stabilize's inspector section: the generic process panel (Analyse / Analyse again / Cancel / Clear, progress) with its own sentences. */
export function StabilizePanel({ node }: { node: NodeInstance }) {
  return (
    <ProcessPanel
      node={node}
      runLabel="Analyse"
      rerunLabel="Analyse again"
      stateText={(status: ProcessStatus | null, job) => stabilizeStateText(status?.state ?? 'none', job, !!status?.result)}
      facts={(st) => stabilizeFacts(st.result?.meta ?? {}, node.params)}
      hint="Reads every frame once at a small size and follows the camera from frame to frame: no model, no network. Needs something to follow (texture, edges); large moving subjects and frames without detail are flagged as uncertain and left alone. The needed zoom is measured with the settings used for the analysis."
    />
  );
}
