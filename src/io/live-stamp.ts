/**
 * Live nodes (camera, URL stream) read pictures that change without the graph changing, and the engine caches
 * node results by their params. They declare a hidden `liveTick` param; the player evaluates a copy of the graph
 * in which that param holds a counter that grows every render, so the engine re-renders them (and everything
 * downstream) and can never serve a frozen picture. Pure helpers.
 */
import type { Registry } from '../engine/define';
import { upstream } from '../engine/graph';
import { groupData, GROUP_MAX_DEPTH, GROUP_TYPE, PATH_SEP, updateNodeAtPath } from '../engine/group';
import type { GraphDoc } from '../engine/types';

export const LIVE_TICK_PARAM = 'liveTick';

/** Ids of the nodes in `graph` whose type declares the live tick param. */
export function liveNodeIds(graph: GraphDoc, registry: Registry): Set<string> {
  const ids = new Set<string>();
  // live nodes inside groups count too (by path: group/inner)
  const walk = (nodes: GraphDoc['nodes'], edges: GraphDoc['edges'], prefix: string, depth: number) => {
    for (const n of nodes) {
      // the World AR Camera is live only while its Picture output is wired (its camera output alone does not change by itself)
      if (registry.get(n.type)?.params[LIVE_TICK_PARAM] && (n.type !== 'world-ar' || edges.some((e) => e.from.node === n.id && e.from.port === 'picture'))) ids.add(prefix + n.id);
      if (n.type === GROUP_TYPE && depth < GROUP_MAX_DEPTH) walk(groupData(n).nodes, groupData(n).edges, prefix + n.id + PATH_SEP, depth + 1);
    }
  };
  walk(graph.nodes, graph.edges, '', 0);
  return ids;
}

/** True when a live node feeds `nodeId` (or is it). */
export function feedsFromLive(graph: GraphDoc, nodeId: string | null, live: Set<string>): boolean {
  if (!nodeId || live.size === 0) return false;
  for (const id of live) if (id.includes(PATH_SEP)) return true; // inside a group: assume it feeds what is shown
  for (const id of upstream(graph, nodeId)) if (live.has(id)) return true;
  return false;
}

/** Copy of the graph where every live node carries `tick`. Other nodes keep their identity. */
export function stampLive(graph: GraphDoc, live: Set<string>, tick: number): GraphDoc {
  if (live.size === 0) return graph;
  let g: GraphDoc = { ...graph, nodes: graph.nodes.map((n) => (live.has(n.id) ? { ...n, params: { ...n.params, [LIVE_TICK_PARAM]: String(tick) } } : n)) };
  for (const id of live) if (id.includes(PATH_SEP)) g = updateNodeAtPath(g, id, (n) => ({ ...n, params: { ...n.params, [LIVE_TICK_PARAM]: String(tick) } }));
  return g;
}

/** Hidden param of Stop Motion that the player stamps while paused: the node then shows the live picture (Shoot view) in "Automatic". */
export const SHOOT_VIEW_PARAM = 'shootView';
export const STOP_MOTION_ID = 'stop-motion';

/**
 * Ids of the Stop Motion nodes the player may put in Shoot view: those that do not feed a Media Timeline (a timeline always gets
 * the animation, so its cuts look the same paused and playing).
 */
export function shootNodeIds(graph: GraphDoc): Set<string> {
  const ids = new Set<string>();
  for (const n of graph.nodes) if (n.type === STOP_MOTION_ID) ids.add(n.id);
  if (ids.size === 0) return ids;
  for (const t of graph.nodes) {
    if (t.type !== 'media-timeline') continue;
    for (const id of upstream(graph, t.id)) ids.delete(id);
  }
  return ids;
}

/** Copy of the graph in which the given Stop Motion nodes are in Shoot view (the picture while paused). */
export function stampShoot(graph: GraphDoc, ids: Set<string>): GraphDoc {
  if (ids.size === 0) return graph;
  return { ...graph, nodes: graph.nodes.map((n) => (ids.has(n.id) ? { ...n, params: { ...n.params, [SHOOT_VIEW_PARAM]: '1' } } : n)) };
}
