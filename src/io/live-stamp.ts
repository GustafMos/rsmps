/**
 * Live nodes (camera, URL stream) read pictures that change without the graph changing, and the engine caches
 * node results by their params. They declare a hidden `liveTick` param; the player evaluates a copy of the graph
 * in which that param holds a counter that grows every render, so the engine re-renders them (and everything
 * downstream) and can never serve a frozen picture. Pure helpers.
 */
import type { Registry } from '../engine/define';
import { upstream } from '../engine/graph';
import type { GraphDoc } from '../engine/types';

export const LIVE_TICK_PARAM = 'liveTick';

/** Ids of the nodes in `graph` whose type declares the live tick param. */
export function liveNodeIds(graph: GraphDoc, registry: Registry): Set<string> {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (registry.get(n.type)?.params[LIVE_TICK_PARAM]) ids.add(n.id);
  }
  return ids;
}

/** True when a live node feeds `nodeId` (or is it). */
export function feedsFromLive(graph: GraphDoc, nodeId: string | null, live: Set<string>): boolean {
  if (!nodeId || live.size === 0) return false;
  for (const id of upstream(graph, nodeId)) if (live.has(id)) return true;
  return false;
}

/** Copy of the graph where every live node carries `tick`. Other nodes keep their identity. */
export function stampLive(graph: GraphDoc, live: Set<string>, tick: number): GraphDoc {
  if (live.size === 0) return graph;
  return { ...graph, nodes: graph.nodes.map((n) => (live.has(n.id) ? { ...n, params: { ...n.params, [LIVE_TICK_PARAM]: String(tick) } } : n)) };
}
