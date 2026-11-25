import { paramSocketType } from '../../engine/define';
import { connectError } from '../../engine/graph';
import { wireError } from './wireConvert';
import type { Registry } from '../../engine/define';
import type { Edge, GraphDoc, InputSchema, ParamDef, SocketType } from '../../engine/types';
import { hexOf } from './drag';

export interface CompatSocket {
  port: string;
  label: string;
  group: string;
  type: SocketType;
  kind: 'input' | 'param';
  /** Current value in words, for params. */
  current: string;
  wired: boolean;
}

export function describeValue(p: ParamDef, v: unknown): string {
  const val = v ?? p.absent ?? p.default;
  if (typeof val === 'number') return String(Number(val.toFixed(3))) + (p.type === 'number' && p.unit ? ` ${p.unit}` : '');
  if (Array.isArray(val) && val.length >= 3 && typeof val[0] === 'number' && p.type === 'color') return hexOf(val as number[]).toUpperCase();
  if (Array.isArray(val)) return `${val.length} colors`;
  return String(val ?? '');
}

/** Every socket (inputs and wireable params, hidden or not) of `nodeId` that can take a wire from `from`. */
export function compatibleSockets(graph: GraphDoc, registry: Registry, nodeId: string, from: Edge['from']): CompatSocket[] {
  const node = graph.nodes.find((n) => n.id === nodeId);
  const def = node && registry.get(node.type);
  if (!node || !def) return [];
  const out: CompatSocket[] = [];
  const wiredPorts = new Set(graph.edges.filter((e) => e.to.node === nodeId).map((e) => e.to.port));
  for (const [port, d] of Object.entries(def.inputs as InputSchema)) {
    if (wireError(graph, registry, from, { node: nodeId, port })) continue;
    out.push({ port, label: d.label ?? port, group: 'Inputs', type: d.type, kind: 'input', current: '', wired: wiredPorts.has(port) && !d.multi });
  }
  for (const [key, p] of Object.entries(def.params as Record<string, ParamDef>)) {
    const t = paramSocketType(def, key);
    if (!t || connectError(graph, registry, from, { node: nodeId, port: key })) continue;
    out.push({ port: key, label: p.label ?? key, group: p.group ?? 'Parameters', type: t, kind: 'param', current: describeValue(p, node.params[key]), wired: wiredPorts.has(key) });
  }
  return out;
}
