import { useEffect, useSyncExternalStore } from 'react';
import { DEPTH_ANYTHING_V2_SMALL_ID, modelEntry } from '../../io/model-catalogue';
import { modelStore } from '../../io/models';
import type { NodeInstance } from '../../engine/types';
import { useApp } from '../store/context';
import { ProcessPanel } from './ProcessPanel';

/**
 * Inspector section of the AI Depth node. With the model on this computer it is the generic process panel ("Estimate depth").
 * Without it the node keeps showing the quick Depth from Picture guess, and this panel offers to open Plugins > AI models, where the
 * user can download it. It never downloads anything by itself.
 */
export function DepthAiPanel({ node }: { node: NodeInstance }) {
  const { ed } = useApp();
  const store = modelStore();
  useSyncExternalStore((fn) => store.subscribe(fn), () => store.version);
  useEffect(() => {
    void store.refresh(DEPTH_ANYTHING_V2_SMALL_ID);
  }, [store]);
  const s = store.status(DEPTH_ANYTHING_V2_SMALL_ID);
  if (s.state === 'ready') return <ProcessPanel node={node} />;
  const m = modelEntry(DEPTH_ANYTHING_V2_SMALL_ID)!;
  return (
    <div className="rs-insp__sec rs-process">
      <div className="rs-caps">Estimate depth</div>
      <div className="rs-bake__state" role="status">
        {s.state === 'downloading' ? 'The AI model is downloading…' : 'The AI model is not on this computer yet, so this node shows the quick Depth from Picture guess.'}
      </div>
      <div className="rs-insp__actions">
        <button className="rs-btn rs-btn--primary" onClick={() => ed.openDialog('plugins')}>Get the AI model…</button>
      </div>
      <p className="rs-insp__hint">{m.sizeLabel}, {m.license.name}, from {m.host}. It opens Plugins, where you choose to download it. Nothing is downloaded until you press Download there. The model runs on your own GPU and nothing is uploaded.</p>
    </div>
  );
}
