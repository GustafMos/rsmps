/**
 * Deterministic node geometry. Node boxes have fixed row heights, so socket positions are
 * computed (not measured): wires can be drawn and updated without touching the DOM.
 */
import { paramBundle, paramBundles, paramSocketPorts, paramSocketType, type ParamBundle } from '../../engine/define';
import { paletteInputPort } from './sockets';
import { defOf } from '../../engine/group';
import { nodeViewStore } from '../store/nodeView';
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
  input?: { port: string; label: string; type: SocketType; multi?: boolean };
  output?: { port: string; label: string; type: SocketType };
}
export interface ParamRow {
  kind: 'param';
  y: number;
  key: string;
  def: ParamDef;
  socket: SocketType | null;
  /** The wired bundle socket that drives this param (a vector wire on its X / Y / Z group), when there is one. */
  via?: string;
}
/** A bundled param socket: one `vector` input for an X / Y / Z group of params. Only on the node while wired or with all rows shown. */
export interface BundleRow {
  kind: 'bundle';
  y: number;
  bundle: ParamBundle;
}
export interface LayersRow {
  kind: 'layers';
  y: number;
  port: string;
  type: SocketType;
  /** number of wires; the list has count + 1 rows (the last is the empty drop row) */
  count: number;
}
export const LAYER_H = 24;
/** Image and mask stacks are listed top layer first, like a layer panel; other types keep wire order. */
export const isLayerType = (t: SocketType) => t === 'image' || t === 'mask';
export interface HintRow {
  kind: 'hint';
  y: number;
}
export interface MoreRow {
  kind: 'more';
  y: number;
  count: number;
  expanded?: boolean;
}

/** Which params the node body shows: pinned ones, wired ones (always) and, when expanded, all. */
export interface BodyView {
  pinned?: string[];
  expanded: boolean;
  wired: string[];
  /** Show the bundle sockets even when they are not wired (a vector wire is being placed). */
  bundles?: boolean;
}
export interface KindRow {
  kind: 'kind';
  y: number;
}
/** The "Type" dropdown of a node that belongs to a convertible family (def.family). */
export interface FamilyRow {
  kind: 'family';
  y: number;
}
export type Row = IoRow | ParamRow | BundleRow | MoreRow | HintRow | LayersRow | KindRow | FamilyRow;
export const HINT_H = 56;

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

const cache = new WeakMap<NodeInstance, { def: AnyNodeDef | undefined; missing: string; collapsed: boolean; hint: boolean; counts: string; layout: NodeLayout }>();

export function visibleParams(def: AnyNodeDef, params: Record<string, unknown>): [string, ParamDef][] {
  const out: [string, ParamDef][] = [];
  for (const [key, p] of Object.entries(def.params as Record<string, ParamDef>)) {
    if (p.type === 'json' || key === 'liveTick' || (key === 'session' && p.type === 'string')) continue;
    try {
      if (p.visibleIf && !p.visibleIf(params)) continue;
    } catch {
      /* a broken visibleIf must not break the UI */
    }
    out.push([key, p]);
  }
  return out;
}

export function layoutNode(node: NodeInstance, def: AnyNodeDef | undefined, missing?: MissingPorts, hint = false, counts: Record<string, number> = {}, view: BodyView = { expanded: false, wired: [] }): NodeLayout {
  const hasSummary = true;
  const countsKey = JSON.stringify(counts) + JSON.stringify(view);
  const missKey = missing ? missing.inputs.join(',') + '|' + missing.outputs.join(',') : '';
  const hit = cache.get(node);
  if (hit && hit.def === def && hit.missing === missKey && hit.collapsed === !!node.collapsed && hit.hint === hint && hit.counts === countsKey) return hit.layout;

  const sockets: NodeLayout['sockets'] = {};
  const rows: Row[] = [];
  let y = HEAD_H + PAD_Y;
  let summaryY: number | null = null;

  const inputs: { port: string; label: string; type: SocketType; multi?: boolean }[] = [];
  const outputs: { port: string; label: string; type: SocketType }[] = [];
  if (def) {
    for (const [port, d] of Object.entries(def.inputs as InputSchema)) inputs.push({ port, label: d.label ?? port, type: d.type, multi: !!d.multi });
    for (const [port, d] of Object.entries(def.outputs as OutputSchema)) outputs.push({ port, label: d.label ?? port, type: d.type });
  } else if (missing) {
    for (const port of missing.inputs) inputs.push({ port, label: port, type: 'image' });
    for (const port of missing.outputs) outputs.push({ port, label: port, type: 'image' });
  }

  if (node.collapsed) {
    const cy = HEAD_H / 2;
    for (const i of inputs) sockets[`in:${i.port}`] = { x: 0, y: cy };
    for (const o of outputs) sockets[`out:${o.port}`] = { x: NODE_W, y: cy };
    if (def) for (const s of paramSocketPorts(def)) sockets[`in:${s.port}`] = { x: 0, y: cy };
    const layout = { width: NODE_W, height: HEAD_H, rows: [], summaryY: null, sockets };
    cache.set(node, { def, missing: missKey, collapsed: true, hint, counts: countsKey, layout });
    return layout;
  }

  const kindRow = !!def && def.category === 'output' && (def.params as Record<string, ParamDef>).kind?.type === 'enum';
  if (kindRow) {
    rows.push({ kind: 'kind', y });
    y += ROW_H + 2;
  }
  if (def?.family) {
    rows.push({ kind: 'family', y });
    y += ROW_H + 2;
  }
  const n = Math.max(inputs.length, outputs.length);
  for (let i = 0; i < n; i++) {
    const row: IoRow = { kind: 'io', y, input: inputs[i], output: outputs[i] };
    if (row.input && !row.input.multi) sockets[`in:${row.input.port}`] = { x: 0, y: y + ROW_H / 2 };
    if (row.output) sockets[`out:${row.output.port}`] = { x: NODE_W, y: y + ROW_H / 2 };
    rows.push(row);
    y += ROW_H;
  }

  for (const i of inputs) {
    if (!i.multi) continue;
    const n = counts[i.port] ?? 0;
    rows.push({ kind: 'layers', y, port: i.port, type: i.type, count: n });
    for (let k = 0; k < n; k++) {
      const r = isLayerType(i.type) ? n - 1 - k : k;
      sockets[`in:${i.port}#${k}`] = { x: 0, y: y + r * LAYER_H + LAYER_H / 2 };
    }
    sockets[`in:${i.port}`] = { x: 0, y: y + n * LAYER_H + LAYER_H / 2 };
    y += (n + 1) * LAYER_H;
  }

  if (def) {
    const params = visibleParams(def, node.params).filter(([k]) => !(kindRow && k === 'kind'));
    const pinnedSet = new Set(view.pinned ?? params.slice(0, MAX_PARAM_ROWS).map(([k]) => k));
    const wiredSet = new Set(view.wired);
    const shown = params.filter(([k]) => view.expanded || pinnedSet.has(k) || wiredSet.has(k));
    const hidden = params.filter(([k]) => !shown.some(([s]) => s === k));
    // Bundle sockets (one vector wire for an X / Y / Z group) take a row of their own right above their members, but only
    // while they are wired or every row is shown: an unused bundle costs the node nothing.
    const bundles = paramBundles(def);
    const bundleShown = (b: ParamBundle) => wiredSet.has(b.port) || view.expanded || !!view.bundles;
    const bundleRow = (b: ParamBundle) => {
      rows.push({ kind: 'bundle', y, bundle: b });
      sockets[`in:${b.port}`] = { x: 0, y: y + ROW_H / 2 };
      y += ROW_H;
    };
    const placed = new Set<string>();
    for (const [key, p] of shown) {
      // above the first of its members that is on the node
      const starts = bundles.find((b) => !placed.has(b.port) && b.members.includes(key));
      if (starts && bundleShown(starts)) {
        bundleRow(starts);
        placed.add(starts.port);
      }
      const socket = paramSocketType(def, key);
      const via = wiredSet.has(key) ? undefined : bundles.find((b) => wiredSet.has(b.port) && b.members.includes(key))?.port;
      rows.push({ kind: 'param', y, key, def: p, socket, ...(via ? { via } : {}) });
      if (socket) sockets[`in:${key}`] = { x: 0, y: y + ROW_H / 2 };
      y += ROW_H;
    }
    // a bundle whose first member is not on the node still shows while it is wired (or while a vector wire is being placed)
    for (const b of bundles) if ((wiredSet.has(b.port) || view.bundles) && !placed.has(b.port)) bundleRow(b);
    // hidden params that can be wired get a socket at the expander row (wired ones are never hidden)
    for (const [key] of hidden) if (paramSocketType(def, key)) sockets[`in:${key}`] = { x: 0, y: y + ROW_H / 2 };
    for (const b of bundles) if (!sockets[`in:${b.port}`]) sockets[`in:${b.port}`] = { x: 0, y: y + ROW_H / 2 };
    const extras = params.filter(([k]) => !pinnedSet.has(k) && !wiredSet.has(k)).length;
    if (hidden.length > 0 || (view.expanded && extras > 0)) {
      rows.push({ kind: 'more', y, count: view.expanded ? extras : hidden.length, expanded: view.expanded });
      y += ROW_H;
    }
    if (hint) {
      rows.push({ kind: 'hint', y });
      y += HINT_H;
    }
    if (def.summary && hasSummary) {
      summaryY = y;
      y += SUMMARY_H;
    }
  }
  const layout: NodeLayout = { width: NODE_W, height: y + PAD_Y, rows, summaryY, sockets };
  cache.set(node, { def, missing: missKey, collapsed: false, hint, counts: countsKey, layout });
  return layout;
}

export function socketWorld(
  node: NodeInstance,
  layout: NodeLayout,
  dir: 'in' | 'out',
  port: string,
  offset?: { x: number; y: number },
  slot?: number,
): { x: number; y: number } {
  const s = (slot !== undefined ? layout.sockets[`${dir}:${port}#${slot}`] : undefined) ?? layout.sockets[`${dir}:${port}`] ?? { x: dir === 'in' ? 0 : layout.width, y: HEAD_H / 2 };
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

/** Is `port` a param socket of the definition (a wireable param or a bundle), as opposed to an input? */
export const isParamPort = (def: AnyNodeDef, port: string): boolean => port in def.params || !!paramBundle(def, port);

/** Pins / expansion / wired params of a node, from the shared view store and the wires. */
export function bodyViewFor(def: AnyNodeDef, nodeId: string, edges: Edge[]): BodyView {
  const st = nodeViewStore.get();
  const wired = [...new Set(edges.filter((e) => e.to.node === nodeId && isParamPort(def, e.to.port)).map((e) => e.to.port))];
  return { pinned: st.pins[nodeId], expanded: !!st.expanded[nodeId], wired, bundles: st.bundles };
}

/** Params currently pinned on the node body (explicit pins, else the default first rows). */
export function effectivePins(def: AnyNodeDef, node: NodeInstance): string[] {
  const pins = nodeViewStore.get().pins[node.id];
  return pins ?? visibleParams(def, node.params).slice(0, MAX_PARAM_ROWS).map(([k]) => k);
}

/** Wire count per multi input port. */
export function multiCounts(def: AnyNodeDef, edges: Edge[], nodeId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [port, d] of Object.entries(def.inputs as InputSchema)) if (d.multi) out[port] = edges.filter((e) => e.to.node === nodeId && e.to.port === port).length;
  return out;
}

export function layoutFor(graph: GraphDoc, node: NodeInstance, def: AnyNodeDef | undefined): NodeLayout {
  // group nodes (and the boundary of an open group) take their ports from their own params, not from the registered placeholder
  def = defOf({ get: () => def }, node) ?? def;
  const pp = def ? paletteInputPort(def) : null;
  const hint = !!pp && !graph.edges.some((e) => e.to.node === node.id && e.to.port === pp);
  return layoutNode(node, def, def ? undefined : parsePortSignature(portSignature(graph.edges, node.id)), hint, def ? multiCounts(def, graph.edges, node.id) : {}, def ? bodyViewFor(def, node.id, graph.edges) : undefined);
}

export function nodeRect(graph: GraphDoc, node: NodeInstance, def: AnyNodeDef | undefined) {
  const l = layoutFor(graph, node, def);
  return { x: node.x, y: node.y, w: l.width, h: l.height };
}
