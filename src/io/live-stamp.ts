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

/** Hidden param of Stop Motion that the player stamps while paused and the node is selected: the node then shows the live picture (Shoot view) in "Automatic". */
export const SHOOT_VIEW_PARAM = 'shootView';
export const STOP_MOTION_ID = 'stop-motion';

/**
 * Ids of the Stop Motion nodes the player may put in Shoot view while paused ("Show: Automatic"): only the SELECTED one, so a Stop
 * Motion shows its animation unless you are working in it. With several nodes selected the primary one (the last in `selection`)
 * counts, and only if it is a Stop Motion. A Stop Motion that feeds a Media Timeline on the way to the viewed picture is never
 * included (the timeline always gets the animation, so its cuts look the same paused and playing); viewing the Stop Motion itself
 * is not affected, because the timeline is not part of what is shown then.
 */
export function shootNodeIds(graph: GraphDoc, selection: readonly string[], viewed: string | null): Set<string> {
  const ids = new Set<string>();
  const primary = selection[selection.length - 1];
  if (!primary || !graph.nodes.some((n) => n.id === primary && n.type === STOP_MOTION_ID)) return ids;
  ids.add(primary);
  if (viewed) {
    const shown = upstream(graph, viewed);
    for (const t of graph.nodes) {
      if (t.type !== 'media-timeline' || (t.id !== viewed && !shown.has(t.id))) continue;
      for (const id of upstream(graph, t.id)) ids.delete(id);
    }
  }
  return ids;
}

/** Stop Motion nodes that show their live picture right now: Show "Live with onion skin", or Automatic and stamped while paused. */
export function shootingIds(graph: GraphDoc, stamped: Set<string>, paused: boolean): Set<string> {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (n.type !== STOP_MOTION_ID) continue;
    const show = n.params.show;
    if (show === 'live' || (show !== 'loop' && paused && stamped.has(n.id))) ids.add(n.id);
  }
  return ids;
}

/**
 * The graph as far as live pictures are concerned: a Stop Motion that shows its animation does not read its Picture input, so the
 * edge into it is dropped (the camera behind it is then not needed and can close). A Stop Motion without shots passes its input
 * through, so it keeps its edge.
 */
export function withoutIdleStopMotionInputs(graph: GraphDoc, shooting: Set<string>): GraphDoc {
  const idle = new Set<string>();
  for (const n of graph.nodes) {
    if (n.type !== STOP_MOTION_ID || shooting.has(n.id)) continue;
    if (Array.isArray(n.params.shots) && n.params.shots.length > 0) idle.add(n.id);
  }
  if (idle.size === 0) return graph;
  return { ...graph, edges: graph.edges.filter((e) => !(idle.has(e.to.node) && e.to.port === 'image')) };
}

/** Copy of the graph in which the given Stop Motion nodes are in Shoot view (the picture while paused). */
export function stampShoot(graph: GraphDoc, ids: Set<string>): GraphDoc {
  if (ids.size === 0) return graph;
  return { ...graph, nodes: graph.nodes.map((n) => (ids.has(n.id) ? { ...n, params: { ...n.params, [SHOOT_VIEW_PARAM]: '1' } } : n)) };
}
