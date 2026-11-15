/**
 * Pure helpers for editing a GraphDoc. Every function returns a new document
 * (never mutates), so the UI can keep undo history by reference.
 */
import { Registry, canConnect, paramSocketType } from './define';
import { defaultParams } from './engine';
import { DEFAULT_PROJECT, type Edge, type GraphDoc, type NodeInstance, type SocketType } from './types';

let counter = 0;
export function uid(prefix: string): string {
  counter++;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function createGraph(name = 'Untitled'): GraphDoc {
  return { schema: 'rsmps/graph', version: 2, name, project: { ...DEFAULT_PROJECT }, nodes: [], edges: [], frames: [] };
}

export function addNode(
  graph: GraphDoc,
  registry: Registry,
  type: string,
  at: { x: number; y: number } = { x: 0, y: 0 },
  params: Record<string, unknown> = {},
): { graph: GraphDoc; node: NodeInstance } {
  const def = registry.get(type);
  if (!def) throw new Error(`Unknown node type "${type}"`);
  const node: NodeInstance = { id: uid('n'), type, x: at.x, y: at.y, params: { ...defaultParams(def), ...params } };
  return { graph: { ...graph, nodes: [...graph.nodes, node] }, node };
}

/** Socket type of an output port, or null. */
export function outputType(graph: GraphDoc, registry: Registry, nodeId: string, port: string): SocketType | null {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const def = node && registry.get(node.type);
  return def?.outputs[port]?.type ?? null;
}

/** Socket type an input port (or param socket) accepts, and whether it takes several wires. */
export function inputType(
  graph: GraphDoc,
  registry: Registry,
  nodeId: string,
  port: string,
): { type: SocketType; multi: boolean } | null {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const def = node && registry.get(node.type);
  if (!def) return null;
  const input = def.inputs[port];
  if (input) return { type: input.type, multi: !!input.multi };
  const pt = paramSocketType(def, port);
  return pt ? { type: pt, multi: false } : null;
}

function reaches(graph: GraphDoc, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === target) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of graph.edges) if (e.from.node === id) stack.push(e.to.node);
  }
  return false;
}

/** Why a wire cannot be made, or null if it can. */
export function connectError(graph: GraphDoc, registry: Registry, from: Edge['from'], to: Edge['to']): string | null {
  const ft = outputType(graph, registry, from.node, from.port);
  const tt = inputType(graph, registry, to.node, to.port);
  if (!ft) return 'No such output';
  if (!tt) return 'No such input';
  if (!canConnect(ft, tt.type)) return `Cannot connect ${ft} to ${tt.type}`;
  if (from.node === to.node || reaches(graph, to.node, from.node)) return 'That would create a loop';
  return null;
}

/** Add a wire. A single-wire input drops its previous wire. Throws with a readable reason when invalid. */
export function connect(graph: GraphDoc, registry: Registry, from: Edge['from'], to: Edge['to']): GraphDoc {
  const err = connectError(graph, registry, from, to);
  if (err) throw new Error(err);
  const tt = inputType(graph, registry, to.node, to.port)!;
  const edges = graph.edges.filter((e) => {
    if (e.to.node !== to.node || e.to.port !== to.port) return true;
    if (!tt.multi) return false;
    return !(e.from.node === from.node && e.from.port === from.port);
  });
  return { ...graph, edges: [...edges, { id: uid('e'), from, to }] };
}

export function disconnect(graph: GraphDoc, edgeId: string): GraphDoc {
  return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
}

/**
 * Remove nodes. With `heal`, each removed node's main input is reconnected to whatever its
 * first output fed, when the types allow, so deleting a node in a chain keeps the chain intact.
 */
export function removeNodes(graph: GraphDoc, registry: Registry, ids: string[], heal = true): GraphDoc {
  let g = graph;
  for (const id of ids) {
    const node = g.nodes.find((n) => n.id === id);
    if (!node) continue;
    const def = registry.get(node.type);
    const incoming = g.edges.filter((e) => e.to.node === id);
    const outgoing = g.edges.filter((e) => e.from.node === id);
    let next: GraphDoc = {
      ...g,
      nodes: g.nodes.filter((n) => n.id !== id),
      edges: g.edges.filter((e) => e.from.node !== id && e.to.node !== id),
    };
    if (heal && def) {
      const firstIn = Object.keys(def.inputs)[0];
      const firstOut = Object.keys(def.outputs)[0];
      const feed = incoming.find((e) => e.to.port === firstIn);
      if (feed && firstOut) {
        for (const out of outgoing.filter((e) => e.from.port === firstOut)) {
          if (!connectError(next, registry, feed.from, out.to)) next = connect(next, registry, feed.from, out.to);
        }
      }
    }
    g = next;
  }
  return g;
}

export function setParam(graph: GraphDoc, nodeId: string, key: string, value: unknown): GraphDoc {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, [key]: value } } : n)),
  };
}

export function updateNode(graph: GraphDoc, nodeId: string, patch: Partial<NodeInstance>): GraphDoc {
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) };
}

/** Problems that would stop the graph from loading or running. Empty = fine. */
export function validateGraph(graph: GraphDoc, registry: Registry): { nodeId?: string; message: string }[] {
  const problems: { nodeId?: string; message: string }[] = [];
  if (graph.schema !== 'rsmps/graph' || graph.version !== 2) problems.push({ message: 'Not an RSMPS v2 graph' });
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) problems.push({ nodeId: n.id, message: 'Duplicate node id' });
    ids.add(n.id);
    if (!registry.get(n.type)) problems.push({ nodeId: n.id, message: `Unknown node type "${n.type}" (missing plugin?)` });
  }
  for (const e of graph.edges) {
    if (!ids.has(e.from.node) || !ids.has(e.to.node)) {
      problems.push({ message: `Wire ${e.id} points at a missing node` });
      continue;
    }
    const ft = outputType(graph, registry, e.from.node, e.from.port);
    const tt = inputType(graph, registry, e.to.node, e.to.port);
    if (ft && tt && !canConnect(ft, tt.type)) problems.push({ nodeId: e.to.node, message: `Wire type mismatch: ${ft} → ${tt.type}` });
  }
  return problems;
}

/** Nodes of the 'output' category, in document order. */
export function outputNodes(graph: GraphDoc, registry: Registry): NodeInstance[] {
  return graph.nodes.filter((n) => registry.get(n.type)?.category === 'output');
}

/** Batch size: the largest asset list on any node with an `assets` param (minimum 1). */
export function batchCount(graph: GraphDoc, registry: Registry): number {
  let count = 1;
  for (const n of graph.nodes) {
    const def = registry.get(n.type);
    if (!def) continue;
    for (const [key, p] of Object.entries(def.params)) {
      if ((p as { type: string }).type === 'assets' && Array.isArray(n.params[key])) {
        count = Math.max(count, (n.params[key] as unknown[]).length);
      }
    }
  }
  return count;
}

/** Ids of every node upstream of `nodeId` (inclusive). */
export function upstream(graph: GraphDoc, nodeId: string): Set<string> {
  const seen = new Set<string>();
  const stack = [nodeId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of graph.edges) if (e.to.node === id) stack.push(e.from.node);
  }
  return seen;
}
