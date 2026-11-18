import type { Registry } from '../../engine/define';
import { addNode, connect, connectError, inputType, outputType } from '../../engine/graph';
import type { Edge, GraphDoc, SocketType } from '../../engine/types';

/**
 * Wires between socket types that do not connect directly but have an obvious converter node. Dropping such a wire adds the
 * converter between the two ends, so the conversion is visible in the graph and can be adjusted (and nothing is hidden in the
 * engine). Today: a picture into a mask input goes through Image to Mask (brightness = coverage).
 */
const CONVERTERS: { from: SocketType; to: SocketType; node: string; in: string; out: string }[] = [{ from: 'image', to: 'mask', node: 'image-to-mask', in: 'image', out: 'mask' }];

function converterFor(graph: GraphDoc, registry: Registry, from: Edge['from'], to: Edge['to']) {
  const ft = outputType(graph, registry, from.node, from.port);
  const tt = inputType(graph, registry, to.node, to.port);
  if (!ft || !tt) return null;
  const c = CONVERTERS.find((x) => x.from === ft && x.to === tt.type);
  return c && registry.get(c.node) ? c : null;
}

/** Like `connectError`, but a wire that only needs a converter node is fine. Null = this wire can be made. */
export function wireError(graph: GraphDoc, registry: Registry, from: Edge['from'], to: Edge['to']): string | null {
  const err = connectError(graph, registry, from, to);
  if (!err) return null;
  if (!converterFor(graph, registry, from, to)) return err;
  // The converter adds no way around a loop: test the wire as if the types matched.
  return makeWire(graph, registry, from, to) ? null : 'That would create a loop';
}

/**
 * Connect `from` to `to`, through a converter node when the types need one. Returns the new graph and the converter's node id
 * (when one was added), or null when the wire cannot be made at all.
 */
export function makeWire(graph: GraphDoc, registry: Registry, from: Edge['from'], to: Edge['to']): { graph: GraphDoc; converter: string | null } | null {
  if (!connectError(graph, registry, from, to)) return { graph: connect(graph, registry, from, to), converter: null };
  const c = converterFor(graph, registry, from, to);
  const target = graph.nodes.find((n) => n.id === to.node);
  if (!c || !target) return null;
  // placed just left of the input it feeds, a little lower so it does not sit on the wire into the node's first input
  const added = addNode(graph, registry, c.node, { x: target.x - 240, y: target.y + 90 });
  const mid = added.node.id;
  if (connectError(added.graph, registry, from, { node: mid, port: c.in })) return null;
  const first = connect(added.graph, registry, from, { node: mid, port: c.in });
  if (connectError(first, registry, { node: mid, port: c.out }, to)) return null;
  return { graph: connect(first, registry, { node: mid, port: c.out }, to), converter: mid };
}
