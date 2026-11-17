import { useRef } from 'react';
import { wiresInto } from '../../engine/graph';
import type { SocketType } from '../../engine/types';
import { Icon } from '../components/Icon';
import { isLayerType } from '../lib/layout';
import { useApp, useEd } from '../store/context';
import { shallowArrayEqual } from '../store/createStore';

/**
 * Every wire into a `multi` input as its own row. Image/mask stacks list the top layer first (like a
 * layer panel); other types keep wire order. In the graph each row owns a socket so wires end at their row.
 */
export function LayerList({ nodeId, port, type, variant }: { nodeId: string; port: string; type: SocketType; variant: 'node' | 'inspector' }) {
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
  const reversed = isLayerType(type);
  const n = edges.length;
  const order = edges.map((_, k) => k);
  if (reversed) order.reverse();
  const up = reversed ? 1 : -1;
  const move = (k: number, delta: number) => ed.edit((g) => ed.moveLayerPure(g, edges[k].id, delta));
  const big = variant === 'inspector';

  return (
    <div className={`rs-layers${big ? ' rs-layers--big' : ''}`}>
      {order.map((k) => {
        const e = edges[k];
        const first = reversed ? k === n - 1 : k === 0;
        const last = reversed ? k === 0 : k === n - 1;
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
            <span className="rs-layer__idx rs-num">{k + 1}</span>
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
      {!big ? (
        <div className="rs-layer rs-layer--drop">
          <span className={`rs-sock rs-sock--in rs-sock--${type}`} data-sock data-node={nodeId} data-port={port} data-dir="in" data-type={type} />
          <span className="rs-layer__hint">+ drop wire here</span>
        </div>
      ) : n === 0 ? (
        <div className="rs-layer__hint">Nothing connected. Drag a wire from another node onto this node.</div>
      ) : null}
    </div>
  );
}
