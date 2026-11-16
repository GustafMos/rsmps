/**
 * Convert a node into another member of its family, in place ("Type" dropdown, "Convert to…" menu).
 *
 * The node keeps its id, position, title override, frame, bypass and collapsed flags, so every wire that can stay, stays.
 * What changes is `type` and `params`:
 *  - layer inputs (the picture/sound being combined) are mapped by slot, described by the table below:
 *    slot 0 = background / bottom / A / first wire, slot 1 = foreground / next layer / B, further slots = further layers in order;
 *  - any other input with the same name and a type the new node accepts (e.g. `mask`) keeps its wire, and so do wired parameter
 *    sockets whose parameter survives;
 *  - outputs: each wire leaving the node follows the output of the same name (else the first one of the same type);
 *  - params with the same key and type keep their value (enums only when the value is also an option of the new node; numbers
 *    are clamped to the new range); the rest start at their defaults.
 * Layers that do not fit (a Stack of 4 converted to a Merge) are left disconnected and counted: `dropped.layers`. Simple on purpose:
 * no extra nodes are created.
 */
import type { Registry } from '../../engine/define';
import { canConnect, paramSocketType } from '../../engine/define';
import { defaultParams } from '../../engine/engine';
import type { AnyNodeDef, Edge, GraphDoc, ParamDef } from '../../engine/types';

/** How a family member takes its layers: separate ports in slot order, or one multi port whose wire order is the slot order. */
export type LayerSpec = { ports: readonly string[] } | { multi: string };

export interface FamilySpec {
  /** Shown in the UI next to the dropdown. */
  label: string;
  /** Node type -> layer inputs. The order of this object is the order of the dropdown. */
  members: Record<string, LayerSpec>;
}

/**
 * Adding a family = adding an entry here and `family: '<id>'` on each member's definition.
 * (Audio: the Mixer is the only combining audio node today, so it has no family yet; add `mix-audio` here when a second one exists.)
 */
export const FAMILIES: Record<string, FamilySpec> = {
  combine: {
    label: 'Combine images',
    members: {
      merge: { ports: ['background', 'foreground'] },
      mix: { ports: ['a', 'b'] },
      stack: { multi: 'images' },
      switch: { multi: 'images' },
    },
  },
};

export interface ConvertResult {
  graph: GraphDoc;
  /** Wires that could not be kept. `layers` = layer wires beyond what the new node takes. */
  dropped: { layers: number; other: number };
  /** Set (and the graph is unchanged) when the conversion is not possible. */
  error?: string;
}

const layerPorts = (s: LayerSpec): string[] => ('ports' in s ? [...s.ports] : [s.multi]);

/** The types a node can be converted to (its own type included, first in table order); empty when it has no family. */
export function familyMembers(registry: Registry, type: string): { id: string; title: string }[] {
  const def = registry.get(type);
  const fam = def?.family ? FAMILIES[def.family] : undefined;
  if (!def || !fam || !(type in fam.members)) return [];
  const out: { id: string; title: string }[] = [];
  for (const id of Object.keys(fam.members)) {
    const d = registry.get(id);
    if (d && d.family === def.family) out.push({ id, title: d.title });
  }
  return out.length > 1 ? out : [];
}

function keepParam(oldP: ParamDef, newP: ParamDef, value: unknown): { keep: boolean; value: unknown } {
  if (oldP.type !== newP.type || value === undefined) return { keep: false, value };
  if (newP.type === 'enum') return { keep: (newP.options as readonly { value: string }[]).some((o) => o.value === value), value };
  if (newP.type === 'number' && typeof value === 'number') {
    let v = value;
    if (newP.min !== undefined) v = Math.max(newP.min, v);
    if (newP.max !== undefined) v = Math.min(newP.max, v);
    return { keep: true, value: v };
  }
  return { keep: true, value };
}

export function convertNode(graph: GraphDoc, registry: Registry, nodeId: string, newType: string): ConvertResult {
  const fail = (error: string): ConvertResult => ({ graph, dropped: { layers: 0, other: 0 }, error });
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return fail('No such node');
  const oldDef = registry.get(node.type);
  const newDef = registry.get(newType);
  if (!oldDef || !newDef) return fail('Unknown node type');
  if (node.type === newType) return { graph, dropped: { layers: 0, other: 0 } };
  const fam = oldDef.family ? FAMILIES[oldDef.family] : undefined;
  if (!fam || newDef.family !== oldDef.family || !(node.type in fam.members) || !(newType in fam.members)) return fail(`${oldDef.title} cannot be converted to ${newDef.title}`);
  const oldSpec = fam.members[node.type];
  const newSpec = fam.members[newType];

  const inEdges = graph.edges.filter((e) => e.to.node === nodeId);
  const outEdges = graph.edges.filter((e) => e.from.node === nodeId);
  const rest = graph.edges.filter((e) => e.to.node !== nodeId && e.from.node !== nodeId);
  let droppedLayers = 0;
  let droppedOther = 0;
  const kept: Edge[] = [];

  // layers by slot
  const slots: (Edge | undefined)[] = 'ports' in oldSpec ? oldSpec.ports.map((p) => inEdges.find((e) => e.to.port === p)) : inEdges.filter((e) => e.to.port === oldSpec.multi);
  const oldLayerPorts = new Set(layerPorts(oldSpec));
  const newLayerPorts = new Set(layerPorts(newSpec));
  if ('ports' in newSpec) {
    slots.forEach((e, i) => {
      if (!e) return;
      if (i < newSpec.ports.length) kept.push({ ...e, to: { node: nodeId, port: newSpec.ports[i] } });
      else droppedLayers++;
    });
  } else {
    // appended in layer order: the edge list order is the wire order of a multi input
    for (const e of slots) if (e) kept.push({ ...e, to: { node: nodeId, port: newSpec.multi } });
  }

  // everything else going in: same name, and the new input must accept the wire
  for (const e of inEdges) {
    if (oldLayerPorts.has(e.to.port)) continue;
    const fromType = registry.get(graph.nodes.find((n) => n.id === e.from.node)?.type ?? '')?.outputs[e.from.port]?.type;
    const input = newDef.inputs[e.to.port];
    const socket = !input && e.to.port in newDef.params && e.to.port in oldDef.params && newDef.params[e.to.port].type === oldDef.params[e.to.port].type ? paramSocketType(newDef, e.to.port) : null;
    const accepts = input ? input.type : socket;
    if (fromType && accepts && !newLayerPorts.has(e.to.port) && canConnect(fromType, accepts)) kept.push(e);
    else droppedOther++;
  }

  // outputs follow by name, then by type
  const outs: Edge[] = [];
  for (const e of outEdges) {
    const t = oldDef.outputs[e.from.port]?.type;
    const port = newDef.outputs[e.from.port]?.type === t ? e.from.port : Object.keys(newDef.outputs).find((k) => newDef.outputs[k].type === t);
    if (port) outs.push({ ...e, from: { node: nodeId, port } });
    else droppedOther++;
  }

  // params
  const params: Record<string, unknown> = defaultParams(newDef as AnyNodeDef);
  for (const [k, np] of Object.entries(newDef.params as Record<string, ParamDef>)) {
    const op = (oldDef.params as Record<string, ParamDef>)[k];
    if (!op) continue;
    const r = keepParam(op, np, node.params[k]);
    if (r.keep) params[k] = r.value;
  }

  const edges = [...rest, ...outs, ...kept];
  return {
    graph: { ...graph, nodes: graph.nodes.map((n) => (n.id === nodeId ? { ...n, type: newType, params } : n)), edges },
    dropped: { layers: droppedLayers, other: droppedOther },
  };
}

/** One sentence about what a conversion left disconnected, or '' when nothing was lost. */
export function describeDropped(d: ConvertResult['dropped']): string {
  const parts: string[] = [];
  if (d.layers) parts.push(`${d.layers} layer${d.layers > 1 ? 's' : ''} did not fit and ${d.layers > 1 ? 'were' : 'was'} disconnected`);
  if (d.other) parts.push(`${d.other} other wire${d.other > 1 ? 's' : ''} had nowhere to go`);
  return parts.join('; ');
}
