import { useRef } from 'react';
import { wiresInto } from '../../engine/graph';
import type { SocketType } from '../../engine/types';
import { Icon } from '../components/Icon';
import { layerRows, moveUpDelta } from '../lib/layerRows';
import { useApp, useEd } from '../store/context';
import { shallowArrayEqual } from '../store/createStore';

/**
 * Every wire into a `multi` input as its own row. An input marked `order: 'top-first'` (a layer stack) lists the top layer
 * first, like a layer panel, labelled Top / 2 / Bottom; others keep wire order, numbered 1, 2, 3. In the graph each row owns a socket so wires end at their row.
 */
export function LayerList({ nodeId, port, type, variant, topFirst = false, firstNote }: { nodeId: string; port: string; type: SocketType; variant: 'node' | 'inspector'; topFirst?: boolean; firstNote?: string }) {
  const { ed, io } = useApp();
  const edges = useEd((s) => wiresInto(s.level, nodeId, port), shallowArrayEqual);
  const names = useEd(
    (s) =>
      wiresInto(s.level, nodeId, port).map((e) => {
        const src = s.level.nodes.find((n) => n.id === e.from.node);
        const def = src && io.registry.get(src.type);
        if (!src) return '(missing node)';
        const base = src.label || def?.title || src.type;
        const outs = def ? Object.keys(def.outputs as object) : [];
        return outs.length > 1 ? `${base} · ${(def!.outputs as Record<string, { label?: string }>)[e.from.port]?.label ?? e.from.port}` : base;
      }),
    shallowArrayEqual,
  );
  const dragFrom = useRef<number | null>(null);
  const n = edges.length;
  const rows = layerRows(n, topFirst, firstNote);
  const up = moveUpDelta(topFirst);
  const move = (k: number, delta: number) => ed.edit((g) => ed.moveLayerPure(g, edges[k].id, delta));
  const big = variant === 'inspector';

  const dropRow = (
    <div className="rs-layer rs-layer--drop">
      <span className={`rs-sock rs-sock--in rs-sock--${type}`} data-sock data-node={nodeId} data-port={port} data-dir="in" data-type={type} />
      <span className="rs-layer__hint">{topFirst ? '+ add on top' : '+ drop wire here'}</span>
    </div>
  );

  return (
    <div className={`rs-layers${big ? ' rs-layers--big' : ''}`}>
      {!big && topFirst && dropRow}
      {rows.map(({ k, label }, r) => {
        const e = edges[k];
        const first = r === 0;
        const last = r === n - 1;
        return (
          <div
            key={e.id}
            className="rs-layer"
            data-nodrag
            draggable={big}
            onDragStart={() => (dragFrom.current = k)}
            onDragOver={(ev) => big && ev.preventDefault()}
            onDrop={() => {
              if (dragFrom.current !== null && dragFrom.current !== k) move(dragFrom.current, k - dragFrom.current);
              dragFrom.current = null;
            }}
          >
            {!big && <span className={`rs-sock rs-sock--in rs-sock--${type}`} data-sock data-node={nodeId} data-port={port} data-dir="in" data-type={type} data-slot={k} />}
            <span className="rs-layer__idx rs-num" title={label}>{label}</span>
            <button className="rs-layer__name" title={`Select ${names[k]}`} onClick={() => ed.select([e.from.node])}>
              {names[k]}
            </button>
            <span className="rs-layer__btns">
              <button title="Move up" disabled={first} onClick={() => move(k, up)}><Icon name="chevronDown" size={12} className="rs-flip" /></button>
              <button title="Move down" disabled={last} onClick={() => move(k, -up)}><Icon name="chevronDown" size={12} /></button>
              <button title="Disconnect" onClick={() => ed.disconnect(e.id)}><Icon name="close" size={12} /></button>
            </span>
          </div>
        );
      })}
      {!big && !topFirst && dropRow}
      {big && n === 0 ? (
        <div className="rs-layer__hint">Nothing connected. Drag a wire from another node onto this node.</div>
      ) : null}
    </div>
  );
}
