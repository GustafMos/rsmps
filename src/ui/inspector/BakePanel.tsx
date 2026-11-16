import { useMemo, useState } from 'react';
import type { NodeInstance } from '../../engine/types';
import { Icon } from '../components/Icon';
import { SelectField } from '../components/fields';
import { bakeStatusOf, formatBytes } from '../lib/bake';
import { bakeNode, bakeStore, cancelBake, clearBake, getBakeQuality, setBakeQuality, statusDeps, type BakeQuality } from '../store/bake';
import { useApp, useEd } from '../store/context';
import { useSelector } from '../store/createStore';
import '../graph/bake.css';

/** Inspector section of a Cache / Bake node: state, Bake / Re-bake / Clear, progress and Cancel. */
export function BakePanel({ node }: { node: NodeInstance }) {
  const app = useApp();
  const { io } = app;
  const graph = useEd((s) => s.graph);
  const job = useSelector(bakeStore, (s) => s.jobs[node.id]);
  const status = useMemo(() => bakeStatusOf(graph, node, statusDeps(app, graph, job)), [graph, node, job, app]);
  const info = io.bake.info(node.id);
  const baked = status.kind === 'baked' || status.kind === 'stale';
  const [quality, setQuality] = useState<BakeQuality>(getBakeQuality());
  const run = () => void bakeNode(app, node.id);
  return (
    <div className="rs-insp__sec rs-bake" data-bake-state={status.kind}>
      <div className="rs-caps">Bake</div>
      <div className="rs-bake__state" role="status">{status.text}</div>
      {status.kind === 'baking' && job && (
        <>
          <div className="rs-bake__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.fraction * 100)}>
            <span style={{ width: `${Math.round(job.fraction * 100)}%` }} />
          </div>
          <div className="rs-bake__facts rs-num">Frame {job.frame} of {job.frames} · {formatBytes(job.bytes)} so far</div>
        </>
      )}
      {baked && info && (
        <div className="rs-bake__facts rs-num">
          {info.frames} frames · {info.width}×{info.height} · {formatBytes(info.bytes)} stored · {info.quality}
          {info.item !== null ? ` · batch item ${info.item + 1} only` : ''}
        </div>
      )}
      <div className="rs-insp__row">
        <label className="rs-insp__label"><span className="rs-insp__lt">Quality</span></label>
        <div className="rs-insp__ctl">
          <SelectField
            large
            value={quality}
            options={[
              { value: 'lossless', label: 'Lossless (exact, larger)' },
              { value: 'compressed', label: 'Compressed (smaller)' },
            ]}
            onChange={(v) => { setBakeQuality(v as BakeQuality); setQuality(v as BakeQuality); }}
            label="Bake quality"
          />
        </div>
        <div className="rs-insp__phint">Lossless bakes are always used by exports. A compressed bake is only used by exports when you allow it below.</div>
      </div>
      <div className="rs-insp__actions">
        {status.kind === 'baking' ? (
          <button className="rs-btn" onClick={() => cancelBake(node.id)}><Icon name="close" /> Cancel</button>
        ) : (
          <>
            <button className="rs-btn rs-btn--primary" disabled={status.kind === 'unconnected'} onClick={run} title="Render every frame of what feeds this node and store it">
              <Icon name="save" /> {baked || status.kind === 'missing' ? 'Re-bake' : 'Bake'}
            </button>
            {(baked || status.kind === 'missing') && (
              <button className="rs-btn rs-btn--danger" onClick={() => void clearBake(app, node.id)} title="Delete the stored frames; the node goes back to calculating live">
                <Icon name="trash" /> Clear
              </button>
            )}
          </>
        )}
      </div>
      <p className="rs-insp__hint">Baking renders the whole project length at full size. Edits before this node never re-bake it by themselves: it only says it is stale.</p>
    </div>
  );
}
