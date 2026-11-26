import { paramSocketPorts } from '../../engine/define';
import { connectError } from '../../engine/graph';
import { wireError } from './wireConvert';
import type { ParamBundle, Registry } from '../../engine/define';
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

/** "XY" or "XYZ": which numbers a bundle socket drives, shown next to its label. */
export const bundleAxes = (b: ParamBundle): string => 'XYZ'.slice(0, b.members.length);

export function describeValue(p: ParamDef, v: unknown): string {
  const val = v ?? p.absent ?? p.default;
  if (typeof val === 'number') return String(Number(val.toFixed(3))) + (p.type === 'number' && p.unit ? ` ${p.unit}` : '');
  if (Array.isArray(val) && val.length >= 3 && typeof val[0] === 'number' && p.type === 'color') return hexOf(val as number[]).toUpperCase();
  if (Array.isArray(val) && p.type === 'vec2') return val.map((n) => String(Number(Number(n).toFixed(3)))).join(', ');
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
  const params = def.params as Record<string, ParamDef>;
  for (const s of paramSocketPorts(def)) {
    if (connectError(graph, registry, from, { node: nodeId, port: s.port })) continue;
    if (s.bundle) {
      // one vector wire for an X / Y / Z group: listed with its members' group, its current value = the members' values
      const first = params[s.bundle.members[0]];
      const current = s.bundle.members.map((k) => describeValue({ ...params[k], unit: undefined } as ParamDef, node.params[k])).join(', ');
      out.push({ port: s.port, label: `${s.bundle.label} ${bundleAxes(s.bundle)}`, group: first.group ?? 'Parameters', type: s.type, kind: 'param', current, wired: wiredPorts.has(s.port) });
      continue;
    }
    const p = params[s.port];
    out.push({ port: s.port, label: p.label ?? s.port, group: p.group ?? 'Parameters', type: s.type, kind: 'param', current: describeValue(p, node.params[s.port]), wired: wiredPorts.has(s.port) });
  }
  return out;
}
