/**
 * Pure helpers for baking (Cache / Bake nodes): what state a node is in, which nodes are "frozen" behind a bake, and how a group of
 * nodes gets its Cache / Bake nodes. No React, no IO: everything here is tested without a browser (bake.test.ts).
 */
import type { Registry } from '../../engine/define';
import { addNode, connect, groupOutputs } from '../../engine/graph';
import type { Edge, GraphDoc, NodeInstance } from '../../engine/types';
import { nodeRect } from './layout';
import { GROUP_TYPE } from '../../engine/group';

export const CACHE_TYPE = 'cache';

/** The params `Io.bake.bake` returns in `BakeResult.params`; cleared again by Clear. */
export const BAKE_PARAMS = ['baked', 'bakedSignature', 'bakedQuality', 'bakedItem', 'bakedUnit', 'bakedWidth', 'bakedCanvas'] as const;

/** The wire into a Cache / Bake node's picture input, or undefined when nothing is connected. */
export function bakeSource(graph: GraphDoc, nodeId: string): Edge | undefined {
  return graph.edges.find((e) => e.to.node === nodeId && e.to.port === 'image');
}

export type BakeKind = 'unconnected' | 'none' | 'baking' | 'baked' | 'stale' | 'missing';

export interface BakeStatus {
  kind: BakeKind;
  /** Short label for the node badge. */
  badge: string;
  /** One sentence for the inspector. */
  text: string;
  /** Baking progress 0..1 (kind 'baking'). */
  fraction?: number;
}

export interface BakeStatusDeps {
  /** Structural signature of what feeds an output port (Engine.signatureOf). */
  signatureOf(node: string, port: string): string;
  /** True when the stored sequence still exists in the media library. */
  assetExists(assetId: string): boolean;
  /** Progress of a running bake of this node. */
  job?: { fraction: number } | null;
}

export function bakeStatusOf(graph: GraphDoc, node: NodeInstance, deps: BakeStatusDeps): BakeStatus {
  const src = bakeSource(graph, node.id);
  const baked = typeof node.params.baked === 'string' ? node.params.baked : '';
  if (deps.job) {
    const pct = Math.round(deps.job.fraction * 100);
    return { kind: 'baking', badge: `baking ${pct}%`, text: `Baking: ${pct}% done`, fraction: deps.job.fraction };
  }
  if (!src) return { kind: 'unconnected', badge: '', text: 'Connect a picture to this node to bake it.' };
  if (!baked) return { kind: 'none', badge: '', text: 'Not baked: the picture passes through and is calculated as usual.' };
  if (!deps.assetExists(baked)) return { kind: 'missing', badge: 'bake lost', text: 'The stored frames are gone (cleared storage?). The node is live again. Bake it once more.' };
  const fresh = node.params.bakedSignature === deps.signatureOf(src.from.node, src.from.port);
  if (!fresh) return { kind: 'stale', badge: 'stale', text: 'Stale: something before this node changed after it was baked. The old picture is still shown. Re-bake to update it.' };
  return { kind: 'baked', badge: 'baked', text: 'Baked: the nodes before this one are not calculated any more.' };
}

/** `params` of a finished bake, as one patch for the node. */
export function applyBakeParams(graph: GraphDoc, nodeId: string, params: Record<string, string>): GraphDoc {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, ...params } } : n)) };
}

export function clearBakeParams(graph: GraphDoc, nodeId: string): GraphDoc {
  const cleared = Object.fromEntries(BAKE_PARAMS.map((k) => [k, '']));
  return applyBakeParams(graph, nodeId, cleared);
}

/** A Cache / Bake node that is serving its stored frames right now (so what feeds it is not calculated). */
export function servesBake(node: NodeInstance, deps: { assetExists(id: string): boolean; fresh(): boolean }): boolean {
  if (node.type !== CACHE_TYPE || node.bypass) return false;
  const baked = node.params.baked;
  if (typeof baked !== 'string' || !baked || node.params.mode === 'live') return false;
  if (!deps.assetExists(baked)) return false;
  return node.params.followEdits === true ? deps.fresh() : true;
}

/**
 * Nodes that no longer cost anything because every path out of them ends in a baked Cache / Bake node: the "frozen" region.
 * A node that also feeds something live is not frozen (it is still being calculated). Nodes without outgoing wires are not frozen.
 */
export function frozenNodes(graph: GraphDoc, serving: ReadonlySet<string>): Set<string> {
  // a baked group serves every output from the store: nothing wired into it (any port) is calculated
  const groups = new Set(graph.nodes.filter((n) => n.type === GROUP_TYPE && serving.has(n.id)).map((n) => n.id));
  const out = new Map<string, Edge[]>();
  for (const e of graph.edges) {
    const l = out.get(e.from.node);
    if (l) l.push(e);
    else out.set(e.from.node, [e]);
  }
  const memo = new Map<string, boolean>();
  const frozen = (id: string, depth = 0): boolean => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    if (depth > 500) return false;
    memo.set(id, false); // cycles never freeze
    const edges = out.get(id) ?? [];
    const ok = edges.length > 0 && edges.every((e) => (serving.has(e.to.node) && (e.to.port === 'image' || groups.has(e.to.node))) || frozen(e.to.node, depth + 1));
    memo.set(id, ok);
    return ok;
  };
  const result = new Set<string>();
  for (const n of graph.nodes) if (!serving.has(n.id) && frozen(n.id)) result.add(n.id);
  return result;
}

/**
 * "Bake selection": a Cache / Bake node after each picture that leaves the selected nodes (rewired in front of every consumer
 * outside it, wire order kept so layer stacks do not change), or, when nothing leaves, after the selected node's loose picture output.
 * Outputs that are already fed into Cache / Bake nodes are left alone. Returns the new graph and the ids of the nodes to bake.
 */
export function insertCacheNodes(graph: GraphDoc, registry: Registry, ids: Iterable<string>): { graph: GraphDoc; cacheIds: string[] } {
  const set = new Set(ids);
  const typeOf = (id: string) => graph.nodes.find((n) => n.id === id)?.type;
  const todo: { node: string; port: string; consumers: Edge[] }[] = groupOutputs(graph, set, registry)
    .filter((o) => o.type === 'image' && typeOf(o.node) !== CACHE_TYPE)
    .filter((o) => !o.consumers.every((e) => typeOf(e.to.node) === CACHE_TYPE && e.to.port === 'image'))
    .map((o) => ({ node: o.node, port: o.port, consumers: o.consumers }));
  if (todo.length === 0) {
    // Nothing leaves the group: bake its loose picture outputs (the chain ends at a node nobody consumes yet).
    for (const id of set) {
      const node = graph.nodes.find((n) => n.id === id);
      const def = node && registry.get(node.type);
      if (!node || !def || node.type === CACHE_TYPE) continue;
      for (const [port, o] of Object.entries(def.outputs as Record<string, { type: string }>)) {
        if (o.type === 'image' && !graph.edges.some((e) => e.from.node === id && e.from.port === port)) todo.push({ node: id, port, consumers: [] });
      }
    }
  }
  let g = graph;
  const cacheIds: string[] = [];
  for (const o of todo) {
    const src = g.nodes.find((n) => n.id === o.node)!;
    const r = nodeRect(g, src, registry.get(src.type));
    const added = addNode(g, registry, CACHE_TYPE, { x: r.x + r.w + 48, y: r.y });
    g = connect(added.graph, registry, { node: o.node, port: o.port }, { node: added.node.id, port: 'image' });
    const moved = new Set(o.consumers.map((e) => e.id));
    // Replace the source of each consumer wire in place: the wire keeps its position, so multi-input layer order is untouched.
    g = { ...g, edges: g.edges.map((e) => (moved.has(e.id) ? { ...e, from: { node: added.node.id, port: 'image' } } : e)) };
    cacheIds.push(added.node.id);
  }
  return { graph: g, cacheIds };
}

export function formatBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b >= 1024 ** 2) return `${Math.round(b / 1024 ** 2)} MB`;
  if (b >= 1024) return `${Math.round(b / 1024)} KB`;
  return `${b} B`;
}
