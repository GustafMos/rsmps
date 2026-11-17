import { useState } from 'react';
import type { NodeInstance } from '../../engine/types';
import { SelectField } from '../components/fields';
import { bakeStatusOf, formatBytes } from '../lib/bake';
import { bakeJobOf, getBakeQuality, setBakeQuality, statusDeps, type BakeQuality } from '../store/bake';
import { useApp, useEd } from '../store/context';
import { useSelector } from '../store/createStore';
import { processStore } from '../store/processes';
import { ProcessPanel } from './ProcessPanel';

/**
 * Inspector section of a Cache / Bake node: the generic process panel (Bake / Re-bake / Cancel / Clear, progress) with Bake's own
 * sentences, its quality choice and its facts (frames, size, quality, batch item).
 */
export function BakePanel({ node }: { node: NodeInstance }) {
  const app = useApp();
  const { io } = app;
  const graph = useEd((s) => s.graph);
  const fullId = useEd((s) => (s.path.length ? [...s.path, node.id].join('/') : node.id));
  const inGroup = fullId !== node.id;
  useSelector(processStore, (s) => s.jobs); // re-render when a bake's state changes
  const [quality, setQuality] = useState<BakeQuality>(getBakeQuality());
  return (
    <ProcessPanel
      node={node}
      runLabel="Bake"
      rerunLabel="Re-bake"
      options={() => ({ quality })}
      stateText={() => (inGroup ? null : bakeStatusOf(graph, node, statusDeps(app, graph, bakeJobOf(app, fullId))).text)}
      facts={() => {
        const info = io.bake.info(fullId);
        return info ? `${info.frames} frames · ${info.width}×${info.height} · ${formatBytes(info.bytes)} stored · ${info.quality}${info.item !== null ? ` · batch item ${info.item + 1} only` : ''}` : null;
      }}
      hint="Baking renders the whole project length at full size. Lossless bakes are always used by exports; a compressed bake only when you allow it below."
      extra={
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
        </div>
      }
    />
  );
}
