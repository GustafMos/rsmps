import { useEffect, useSyncExternalStore } from 'react';
import { STYLE_AI_MODEL_IDS, modelEntry } from '../../io/model-catalogue';
import { modelStore, type ModelStatus } from '../../io/models';
import type { NodeInstance } from '../../engine/types';
import type { ProcessStatus } from '../../engine/process';
import type { ProcessJob } from '../../io/api';
import { isActiveJob } from '../lib/process';
import { useApp, useEd } from '../store/context';
import { ProcessPanel } from './ProcessPanel';

const MB = 1024 * 1024;

/**
 * The sentence above the buttons: this node has no live version, and has to say what is on screen instead. `held` = there is no
 * transition (Driven by: Held, or nothing wired to B), so what is shown meanwhile is picture A and not a dissolve. Pure (tested).
 */
export function styleAiStateText(state: string, job: Pick<ProcessJob, 'state' | 'error'> | null, hasResult = false, held = false): string | null {
  if (job && isActiveJob(job as ProcessJob)) return null; // progress: the generic sentences
  const plain = held ? 'picture A is shown as it is' : 'a plain dissolve from A to B is shown';
  const what = held ? 'every frame' : 'every frame of the transition';
  if (job?.state === 'failed') return `Render failed: ${job.error ?? 'unknown error'}. Nothing was stored; ${hasResult ? 'the last painting is still shown' : plain}.`;
  if (state === 'none') return `Not rendered yet: ${plain}. The network is far too slow to run while playing. Press Render to paint ${what} once; the result is saved with the project.`;
  if (state === 'missing') return `The stored painting is gone (cleared storage, or another computer): ${plain}. Press Render to make it again.`;
  if (state === 'stale') return 'Out of date: the settings, or something before this node, changed after the painting was made. The old painting is still shown. Press Render again to update it; it never restarts by itself.';
  return null;
}

/** What the last render was: how many frames, by which method, at what size, on what, how fast. Pure (tested). */
export function styleAiFacts(meta: Record<string, unknown>): string | null {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  if (!n(meta.count)) return null;
  const parts = [`${n(meta.count)} painted frame${n(meta.count) === 1 ? '' : 's'}`];
  // Results from before the node had looks carry no method: they were AdaIN, one pass.
  const swap = meta.method === 'swap';
  parts.push(swap ? (n(meta.material) < 1 ? `style swap ${Math.round(n(meta.material) * 100)}% over AdaIN` : 'style swap') : 'AdaIN');
  if (n(meta.passes) > 1) parts.push(`${n(meta.passes)} passes`);
  if (swap && n(meta.crawl) > 0) parts.push('crawling');
  if (meta.source === 'style') parts.push('material from Style');
  if (meta.drive === 'hold') parts.push('held');
  if (n(meta.tiles) > 1) parts.push(`${n(meta.tiles)} squares per frame`);
  parts.push(meta.provider === 'webgpu' ? 'on the GPU' : 'on the processor');
  if (n(meta.secondsPerFrame) > 0) parts.push(`${n(meta.secondsPerFrame) >= 10 ? Math.round(n(meta.secondsPerFrame)) : n(meta.secondsPerFrame).toFixed(1)} s per frame`);
  if (typeof meta.item === 'number') parts.push(`batch item ${meta.item + 1} only`);
  return parts.join(' · ');
}

/** Both files as one download for the panel: what is on this computer, what is on its way, what went wrong. Pure (tested). */
export function styleAiModelState(parts: readonly ModelStatus[], sizes: readonly number[]): { state: 'ready' | 'downloading' | 'failed' | 'absent'; received: number; total: number; error: string | null } {
  const total = sizes.reduce((a, b) => a + b, 0);
  let received = 0;
  parts.forEach((s, i) => {
    received += s.state === 'ready' ? sizes[i] : s.state === 'downloading' ? Math.min(sizes[i], s.received) : 0;
  });
  const failed = parts.find((s) => s.state === 'failed');
  const state = parts.every((s) => s.state === 'ready') ? 'ready' : parts.some((s) => s.state === 'downloading') ? 'downloading' : failed ? 'failed' : 'absent';
  return { state, received, total, error: failed && failed.state === 'failed' ? failed.error : null };
}

/**
 * Inspector section of the AI Style Transfer node. With the model on this computer it is the process panel (Render / Render again /
 * Cancel / Clear, progress) with this node's own sentences. Without it, it says what the model is and offers ONE button that
 * downloads both files: nothing is fetched before that button is pressed, here or anywhere else.
 */
export function StyleAiPanel({ node }: { node: NodeInstance }) {
  const { ed } = useApp();
  // No transition when the user chose so or when there is no B to go to: the sentences then speak of picture A, not of a dissolve.
  const hasB = useEd((st) => st.level.edges.some((e) => e.to.node === node.id && e.to.port === 'b'));
  const held = node.params.drive === 'hold' || !hasB;
  const store = modelStore();
  useSyncExternalStore((fn) => store.subscribe(fn), () => store.version);
  useEffect(() => {
    for (const id of STYLE_AI_MODEL_IDS) void store.refresh(id);
  }, [store]);
  const entries = STYLE_AI_MODEL_IDS.map((id) => modelEntry(id)!);
  const m = styleAiModelState(STYLE_AI_MODEL_IDS.map((id) => store.status(id)), entries.map((e) => e.bytes));
  if (m.state === 'ready') {
    return (
      <ProcessPanel
        node={node}
        runLabel="Render"
        rerunLabel="Render again"
        stateText={(status: ProcessStatus | null, job) => styleAiStateText(status?.state ?? 'none', job, !!status?.result, held)}
        facts={(st) => styleAiFacts(st.result?.meta ?? {})}
        hint="Paints every frame of the transition (held: of the project) with a neural network on this computer and stores the frames. Seconds per frame without WebGPU, and the Hallucination look takes about three times as long as Painterly, so try a short transition first. Painting and Ends fade can be changed afterwards without rendering again."
      />
    );
  }
  const busy = m.state === 'downloading';
  // One after the other: a failed first file must not leave the second one running unnoticed.
  const download = async () => {
    for (const id of STYLE_AI_MODEL_IDS) {
      if (store.status(id).state === 'ready') continue;
      if ((await store.download(id)).state !== 'ready') return;
    }
  };
  const first = entries[0];
  return (
    <div className="rs-insp__sec rs-process">
      <div className="rs-caps">Render</div>
      <div className="rs-bake__state" role="status">
        {busy ? `The model is downloading… ${(m.received / MB).toFixed(0)} of ${(m.total / MB).toFixed(0)} MB` : 'The style transfer model is not on this computer yet, so this node shows the plain pictures.'}
      </div>
      {busy && (
        <div className="rs-dlg__progress">
          <div className="rs-dlg__bar"><div style={{ width: `${Math.min(100, (m.received / Math.max(1, m.total)) * 100)}%` }} /></div>
        </div>
      )}
      {m.state === 'failed' && <p className="rs-addon__err" role="alert">{m.error}</p>}
      <div className="rs-insp__actions">
        {busy ? (
          <button className="rs-btn" onClick={() => STYLE_AI_MODEL_IDS.forEach((id) => store.cancel(id))}>Cancel</button>
        ) : (
          <button className="rs-btn rs-btn--primary" onClick={() => void download()}>{m.state === 'failed' ? 'Try again' : `Download the model (${(m.total / MB).toFixed(0)} MB)`}</button>
        )}
        <button className="rs-btn" onClick={() => ed.openDialog('plugins')}>Details…</button>
      </div>
      <p className="rs-insp__hint">
        The style transfer networks (AdaIN): two files, {(m.total / MB).toFixed(0)} MB together, {first.license.name} license, from {first.host}. Nothing is downloaded until you press Download; the files are checked against known checksums before they are used. The model runs on your own computer and nothing is uploaded. Details opens Plugins, where both files are listed with their sources and can be removed.
      </p>
    </div>
  );
}
