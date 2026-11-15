import { memo, useMemo } from 'react';
import { useApp, useDefs, useEd } from '../store/context';
import { edgeEndpoints } from '../lib/geometry';
import { layoutFor, wirePath, type NodeLayout } from '../lib/layout';
import type { SocketType } from '../../engine/types';

/**
 * Wires live in one SVG inside the transformed layer. The SVG is 1x1 with visible overflow, so it
 * is never clipped no matter where nodes are placed.
 */
export const Wires = memo(function Wires() {
  const { io, graphCtl } = useApp();
  const nodes = useEd((s) => s.graph.nodes);
  const edges = useEd((s) => s.graph.edges);
  const selection = useEd((s) => s.selection);
  useDefs();

  const items = useMemo(() => {
    const graph = { nodes, edges } as Parameters<typeof edgeEndpoints>[0];
    const layouts = new Map<string, NodeLayout>();
    for (const n of nodes) layouts.set(n.id, layoutFor(graph, n, io.registry.get(n.type)));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return edges.flatMap((e) => {
      const ep = edgeEndpoints(graph, io.registry, e, undefined, layouts);
      if (!ep) return [];
      const from = byId.get(e.from.node)!;
      const type: SocketType = io.registry.get(from.type)?.outputs[e.from.port]?.type ?? 'image';
      return [{ e, d: wirePath(ep.from, ep.to), type }];
    });
  }, [nodes, edges, io]);

  const sel = useMemo(() => new Set(selection), [selection]);

  return (
    <svg className="rs-wires" width="1" height="1">
      {items.map(({ e, d, type }) => {
        const hot = sel.has(e.from.node) || sel.has(e.to.node);
        return (
          <g
            key={e.id}
            className={`rs-wire-g${hot ? ' is-hot' : ''}`}
            ref={(g) => {
              if (g) graphCtl.edgeEls.set(e.id, Array.from(g.querySelectorAll('path')));
              else graphCtl.edgeEls.delete(e.id);
            }}
          >
            <path className="rs-wire__hit" data-edge={e.id} d={d} />
            <path className={`rs-wire rs-wire--${type}`} d={d} />
          </g>
        );
      })}
    </svg>
  );
});
