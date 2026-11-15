/**
 * Deterministic node geometry. Node boxes have fixed row heights, so socket positions are
 * computed (not measured): wires can be drawn and updated without touching the DOM.
 */
import { paramSocketType } from '../../engine/define';
import type { AnyNodeDef, Edge, GraphDoc, InputSchema, NodeInstance, OutputSchema, ParamDef, SocketType } from '../../engine/types';

export const NODE_W = 216;
export const HEAD_H = 30;
export const ROW_H = 26;
export const PAD_Y = 6;
export const SUMMARY_H = 22;
export const MAX_PARAM_ROWS = 6;

export interface IoRow {
  kind: 'io';
  y: number;
  input?: { port: string; label: string; type: SocketType };
  output?: { port: string; label: string; type: SocketType };
}
export interface ParamRow {
  kind: 'param';
  y: number;
  key: string;
  def: ParamDef;
  socket: SocketType | null;
}
export interface MoreRow {
  kind: 'more';
  y: number;
  count: number;
}
export type Row = IoRow | ParamRow | MoreRow;

export interface NodeLayout {
  width: number;
  height: number;
  rows: Row[];
  summaryY: number | null;
  /** keys: `in:<port>` and `out:<port>`; positions relative to the node's top-left. */
  sockets: Record<string, { x: number; y: number }>;
}

/** Ports of nodes whose type is unknown, reconstructed from their wires so they keep them. */
export interface MissingPorts {
  inputs: string[];
  outputs: string[];
}

const cache = new WeakMap<NodeInstance, { def: AnyNodeDef | undefined; missing: string; collapsed: boolean; layout: NodeLayout }>();

export function visibleParams(def: AnyNodeDef, params: Record<string, unknown>): [string, ParamDef][] {
  const out: [string, ParamDef][] = [];
  for (const [key, p] of Object.entries(def.params as Record<string, ParamDef>)) {
    if (p.type === 'json') continue;
    try {
      if (p.visibleIf && !p.visibleIf(params)) continue;
    } catch {
      /* a broken visibleIf must not break the UI */
    }
    out.push([key, p]);
  }
  return out;
}

export function layoutNode(node: NodeInstance, def: AnyNodeDef | undefined, missing?: MissingPorts, hasSummary = true): NodeLayout {
  const missKey = missing ? missing.inputs.join(',') + '|' + missing.outputs.join(',') : '';
  const hit = cache.get(node);
  if (hit && hit.def === def && hit.missing === missKey && hit.collapsed === !!node.collapsed) return hit.layout;

  const sockets: NodeLayout['sockets'] = {};
  const rows: Row[] = [];
  let y = HEAD_H + PAD_Y;
  let summaryY: number | null = null;

  const inputs: { port: string; label: string; type: SocketType }[] = [];
  const outputs: { port: string; label: string; type: SocketType }[] = [];
  if (def) {
    for (const [port, d] of Object.entries(def.inputs as InputSchema)) inputs.push({ port, label: d.label ?? port, type: d.type });
    for (const [port, d] of Object.entries(def.outputs as OutputSchema)) outputs.push({ port, label: d.label ?? port, type: d.type });
  } else if (missing) {
    for (const port of missing.inputs) inputs.push({ port, label: port, type: 'image' });
    for (const port of missing.outputs) outputs.push({ port, label: port, type: 'image' });
  }

  if (node.collapsed) {
    const cy = HEAD_H / 2;
    for (const i of inputs) sockets[`in:${i.port}`] = { x: 0, y: cy };
    for (const o of outputs) sockets[`out:${o.port}`] = { x: NODE_W, y: cy };
    if (def) for (const key of Object.keys(def.params)) if (paramSocketType(def, key)) sockets[`in:${key}`] = { x: 0, y: cy };
    const layout = { width: NODE_W, height: HEAD_H, rows: [], summaryY: null, sockets };
    cache.set(node, { def, missing: missKey, collapsed: true, layout });
    return layout;
  }

  const n = Math.max(inputs.length, outputs.length);
  for (let i = 0; i < n; i++) {
    const row: IoRow = { kind: 'io', y, input: inputs[i], output: outputs[i] };
    if (row.input) sockets[`in:${row.input.port}`] = { x: 0, y: y + ROW_H / 2 };
    if (row.output) sockets[`out:${row.output.port}`] = { x: NODE_W, y: y + ROW_H / 2 };
    rows.push(row);
    y += ROW_H;
  }

  if (def) {
    const params = visibleParams(def, node.params);
    const shown = params.slice(0, MAX_PARAM_ROWS);
    for (const [key, p] of shown) {
      const socket = paramSocketType(def, key);
      rows.push({ kind: 'param', y, key, def: p, socket });
      if (socket) sockets[`in:${key}`] = { x: 0, y: y + ROW_H / 2 };
      y += ROW_H;
    }
    // hidden params that can still be wired keep a socket so existing wires stay attached
    for (const [key] of params.slice(MAX_PARAM_ROWS)) {
      if (paramSocketType(def, key)) sockets[`in:${key}`] = { x: 0, y: HEAD_H + PAD_Y + n * ROW_H + MAX_PARAM_ROWS * ROW_H + ROW_H / 2 };
    }
    if (params.length > MAX_PARAM_ROWS) {
      rows.push({ kind: 'more', y, count: params.length - MAX_PARAM_ROWS });
      y += ROW_H;
    }
    if (def.summary && hasSummary) {
      summaryY = y;
      y += SUMMARY_H;
    }
  }
  const layout: NodeLayout = { width: NODE_W, height: y + PAD_Y, rows, summaryY, sockets };
  cache.set(node, { def, missing: missKey, collapsed: false, layout });
  return layout;
}

export function socketWorld(
  node: NodeInstance,
  layout: NodeLayout,
  dir: 'in' | 'out',
  port: string,
  offset?: { x: number; y: number },
): { x: number; y: number } {
  const s = layout.sockets[`${dir}:${port}`] ?? { x: dir === 'in' ? 0 : layout.width, y: HEAD_H / 2 };
  return { x: node.x + s.x + (offset?.x ?? 0), y: node.y + s.y + (offset?.y ?? 0) };
}

/** Cubic bezier control offset shared by wires and the wire being dragged. */
export function wirePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.max(48, Math.abs(b.x - a.x) * 0.5);
  return `M${a.x} ${a.y}C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
}

export function wirePoints(a: { x: number; y: number }, b: { x: number; y: number }, n = 20): { x: number; y: number }[] {
  const dx = Math.max(48, Math.abs(b.x - a.x) * 0.5);
  const c1 = { x: a.x + dx, y: a.y };
  const c2 = { x: b.x - dx, y: b.y };
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  return pts;
}

const inboundCache = new WeakMap<Edge[], Map<string, string>>();
/** `port,port` list of wired input ports per node (memoised by edge-array identity). */
export function inboundSignature(edges: Edge[], nodeId: string): string {
  let m = inboundCache.get(edges);
  if (!m) {
    m = new Map();
    const tmp = new Map<string, string[]>();
    for (const e of edges) {
      const a = tmp.get(e.to.node) ?? [];
      a.push(e.to.port);
      tmp.set(e.to.node, a);
    }
    for (const [k, v] of tmp) m.set(k, v.join(','));
    inboundCache.set(edges, m);
  }
  return m.get(nodeId) ?? '';
}

const missingCache = new WeakMap<Edge[], Map<string, string>>();
/** Signature `in,in|out,out` of ports used by wires on a node (for missing-plugin nodes). */
export function portSignature(edges: Edge[], nodeId: string): string {
  let m = missingCache.get(edges);
  if (!m) {
    m = new Map();
    const ins = new Map<string, Set<string>>();
    const outs = new Map<string, Set<string>>();
    for (const e of edges) {
      (ins.get(e.to.node) ?? ins.set(e.to.node, new Set()).get(e.to.node)!).add(e.to.port);
      (outs.get(e.from.node) ?? outs.set(e.from.node, new Set()).get(e.from.node)!).add(e.from.port);
    }
    const ids = new Set([...ins.keys(), ...outs.keys()]);
    for (const id of ids) m.set(id, [...(ins.get(id) ?? [])].join(',') + '|' + [...(outs.get(id) ?? [])].join(','));
    missingCache.set(edges, m);
  }
  return m.get(nodeId) ?? '|';
}
export function parsePortSignature(sig: string): MissingPorts {
  const [a, b] = sig.split('|');
  return { inputs: a ? a.split(',') : [], outputs: b ? b.split(',') : [] };
}

export function layoutFor(graph: GraphDoc, node: NodeInstance, def: AnyNodeDef | undefined): NodeLayout {
  return layoutNode(node, def, def ? undefined : parsePortSignature(portSignature(graph.edges, node.id)));
}

export function nodeRect(graph: GraphDoc, node: NodeInstance, def: AnyNodeDef | undefined) {
  const l = layoutFor(graph, node, def);
  return { x: node.x, y: node.y, w: l.width, h: l.height };
}
