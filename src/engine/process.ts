/**
 * Process mode, kernel side (pure): where a node's result handle lives, how a node's process state is derived, which processes an
 * export still needs, and the striped "processing" card. The scheduler that actually runs jobs is src/io/processes.ts.
 * Contract: docs/ENGINE.md (Pending rules, "Process mode"); types in types.ts (`ProcessDef`, `ProcessView`...).
 */
import type {
  AnyNodeDef,
  GraphDoc,
  Host,
  ImageValue,
  NodeGpu,
  NodeInstance,
  ProcessLive,
  ProcessResult,
  ProcessState,
  ProcessStandIn,
} from './types';
import type { Registry } from './define';
import { upstream } from './graph';
import { defOf, nodeAtPath, PATH_SEP, updateNodeAtPath } from './group';

/** Reserved param that holds the result handle of a node whose process has no `handle` adapter of its own. */
export const PROCESS_PARAM = '__process';

/** The progress buckets of the placeholder card: a node that shows a percentage re-renders this many times per job, no more. */
export const PLACEHOLDER_STEPS = 10;

/** The stored handle of a node, or null. Reads through the definition's `handle` adapter when it has one. */
export function processResultOf(node: Pick<NodeInstance, 'params'>, def: AnyNodeDef): ProcessResult | null {
  const adapter = def.process?.handle;
  if (adapter) return adapter.read(node.params);
  const raw = node.params[PROCESS_PARAM];
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<ProcessResult>;
  if (typeof r.signature !== 'string' || !r.items || typeof r.items !== 'object') return null;
  return { signature: r.signature, items: r.items, meta: r.meta ?? {}, bytes: r.bytes ?? 0, createdAt: r.createdAt ?? 0, seconds: r.seconds ?? 0 };
}

/** The params patch that stores (or, with null, clears) a node's handle. */
export function processParamsPatch(def: AnyNodeDef, result: ProcessResult | null): Record<string, unknown> {
  const adapter = def.process?.handle;
  if (adapter) return result ? adapter.write(result) : adapter.clear();
  return { [PROCESS_PARAM]: result ?? '' };
}

/** Pure: the graph with `result` written into the node (null clears it). */
export function withProcessResult(graph: GraphDoc, registry: Registry, nodeId: string, result: ProcessResult | null): GraphDoc {
  // `nodeId` may be a path inside groups (`group/inner`); a group's own handle is its bake.
  const node = nodeAtPath(graph, nodeId);
  const def = defOf(registry, node);
  if (!node || !def?.process) return graph;
  const patch = processParamsPatch(def, result);
  return updateNodeAtPath(graph, nodeId, (n) => ({ ...n, params: { ...n.params, ...patch } }));
}

/** Every stored item still exists in the store (the host can answer for its id). */
export function processDataPresent(result: ProcessResult, host: Pick<Host, 'assetInfo'>): boolean {
  const items = Object.values(result.items);
  return items.every((i) => !!host.assetInfo(i.id));
}

export interface ProcessStatus {
  state: ProcessState;
  /** The stored result when its data is present (also when stale); null for 'none' and 'missing'. */
  result: ProcessResult | null;
  /** A result is referenced by the node, whether or not its data is still there. */
  referenced: boolean;
  /** `ProcessDef.signature(...)` now. */
  current: string;
  live: ProcessLive | null;
  /** Part of the node's cache key: state + identity of the stored result (+ progress bucket for the placeholder). Never raw progress. */
  key: string;
}

export function deriveProcessStatus(a: {
  handle: ProcessResult | null;
  hasData: boolean;
  current: string;
  live: ProcessLive | null;
  standIn: ProcessStandIn;
}): ProcessStatus {
  const { handle, hasData, live } = a;
  let state: ProcessState;
  if (live?.state === 'running') state = 'running';
  else if (live?.state === 'queued') state = 'queued';
  else if (live?.state === 'failed') state = 'failed';
  else if (!handle) state = 'none';
  else if (!hasData) state = 'missing';
  else if (handle.signature !== a.current) state = 'stale';
  else state = 'done';
  const result = handle && hasData ? handle : null;
  const bucket = a.standIn === 'placeholder' && state === 'running' ? Math.min(PLACEHOLDER_STEPS, Math.floor((live?.progress ?? 0) * PLACEHOLDER_STEPS)) : 0;
  const key = `${state}|${handle ? `${handle.signature}|${handle.createdAt}|${hasData ? 1 : 0}` : ''}|${bucket}`;
  return { state, result, referenced: !!handle, current: a.current, live, key };
}

/** May the stored data be used for rendering right now? */
export function isServable(status: ProcessStatus, standIn: ProcessStandIn): boolean {
  if (!status.result) return false;
  if (status.state === 'done') return true;
  return standIn === 'last';
}

/** The process of a node that the export of `outputs` still needs. */
export interface PendingProcess {
  node: string;
  type: string;
  label: string;
  title: string;
  state: ProcessState;
}

/**
 * Export gate: the nodes upstream of the outputs (all `outputs`, or every output node when empty) whose process an export needs and
 * is not done: state none / stale / missing / failed / queued / running. Requirement per `ProcessDef.required` (default 'always';
 * 'once-run' only when a result is referenced; 'never' never). Bypassed nodes are skipped. A process node that is done and takes only
 * lazy inputs (it never evaluates what feeds it) hides everything before it. `statusOf` answers the current state of a node
 * (`Engine.processStatus`).
 */
export function pendingProcesses(
  graph: GraphDoc,
  registry: Registry,
  statusOf: (nodeId: string) => ProcessStatus | null,
  outputs: readonly string[] = [],
  /** The document as the engine evaluates it (`Engine.flatView`): with groups, inner processes are listed by path. */
  flat?: (graph: GraphDoc) => GraphDoc,
): PendingProcess[] {
  if (flat) graph = flat(graph);
  const outs = outputs.length ? [...outputs] : graph.nodes.filter((n) => registry.get(n.type)?.category === 'output' && !n.bypass && n.params.enabled !== false).map((n) => n.id);
  const inbound = new Map<string, string[]>();
  for (const e of graph.edges) {
    const l = inbound.get(e.to.node);
    if (l) l.push(e.from.node);
    else inbound.set(e.to.node, [e.from.node]);
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const needed = new Set<string>();
  const stack = [...outs];
  while (stack.length) {
    const id = stack.pop()!;
    if (needed.has(id)) continue;
    const node = byId.get(id);
    if (!node) continue;
    needed.add(id);
    const def = defOf(registry, node);
    if (node.bypass === true && !def?.process) {
      for (const from of inbound.get(id) ?? []) stack.push(from);
      continue;
    }
    if (def?.process && !node.bypass) {
      const st = statusOf(id);
      const lazyOnly = Object.values(def.inputs as Record<string, { lazy?: boolean }>).every((i) => i.lazy === true);
      if (st?.state === 'done' && lazyOnly) continue; // serves its stored result: nothing before it runs
    }
    for (const from of inbound.get(id) ?? []) stack.push(from);
  }
  const out: PendingProcess[] = [];
  for (const id of needed) {
    const node = byId.get(id)!;
    const def = defOf(registry, node);
    if (!def?.process || node.bypass) continue;
    const st = statusOf(id);
    if (!st || st.state === 'done') continue;
    const req = def.process.required ?? 'always';
    if (req === 'never') continue;
    if (req === 'once-run' && !st.referenced) continue;
    out.push({ node: id, type: node.type, label: node.label || def.title, title: def.process.title, state: st.state });
  }
  return out;
}

/** Process nodes of a graph in document order (for "Process selected nodes" and the panels). */
export function processNodes(graph: GraphDoc, registry: Registry, ids?: Iterable<string>): NodeInstance[] {
  const set = ids ? new Set(ids) : null;
  return graph.nodes.filter((n) => (!set || set.has(n.id)) && !!defOf(registry, n)?.process);
}

/** Process nodes among the nodes at FULL path ids (`group/inner`), in the order given (the shown level's selection, mapped to paths). */
export function processNodePaths(graph: GraphDoc, registry: Registry, ids: Iterable<string>): string[] {
  const out: string[] = [];
  for (const id of ids) if (defOf(registry, nodeAtPath(graph, id))?.process) out.push(id);
  return out;
}

/** A readable name for a node by path: `Group name › Inner node` (just the node's name at the top level). */
export function processLabel(graph: GraphDoc, registry: Registry, id: string): string {
  const parts = id.split(PATH_SEP).filter((x) => !x.startsWith('~'));
  const names: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const n = nodeAtPath(graph, parts.slice(0, i + 1).join(PATH_SEP));
    names.push(n ? n.label || defOf(registry, n)?.title || n.type : parts[i]);
  }
  return names.join(' › ');
}

/** Nodes upstream of `nodeId` that have a process and still need running, deepest first (the order to run them in). */
export function processOrder(graph: GraphDoc, registry: Registry, nodeIds: readonly string[]): string[] {
  const want = new Set<string>();
  for (const id of nodeIds) for (const u of upstream(graph, id)) want.add(u);
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !want.has(id)) return;
    seen.add(id);
    for (const e of graph.edges) if (e.to.node === id) visit(e.from.node);
    if (defOf(registry, graph.nodes.find((n) => n.id === id))?.process) order.push(id);
  };
  for (const id of nodeIds) visit(id);
  return order;
}


/* ----------------------------------- the placeholder card ----------------------------------- */

/**
 * The kernel's stand-in picture: diagonal stripes, a progress bar (when the fraction is known) and, when the host can rasterise text,
 * the title and a percentage. One pass, canvas-sized, cached with the node like any render (so one texture per size and progress step).
 */
export function placeholderCard(
  gpu: NodeGpu,
  host: Pick<Host, 'rasterizeText'>,
  size: { width: number; height: number; unit: number },
  title: string,
  fraction: number | null,
): ImageValue {
  const label = fraction === null ? title : `${title} · ${Math.round(fraction * 100)}%`;
  const px = Math.max(10, Math.min(size.height * 0.07, size.width * 0.07));
  const text = host.rasterizeText?.({ text: label, font: 'sans-serif', sizePx: px, weight: 600, italic: false, align: 'center', lineHeight: 1.2, maxWidthPx: size.width * 0.85 }) ?? null;
  const txt = text && text.width > 0 && text.height > 0 ? gpu.upload(text.data, text.width, text.height, 1, true) : null;
  return gpu.pass({
    label: 'process-placeholder',
    size,
    textures: { txt },
    uniforms: { frac: fraction ?? 0, hasBar: fraction === null ? 0 : 1 },
    wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = max(u.size.y * 0.05, 10.0);
  let stripe = step(0.5, fract((px.x + px.y) / s));
  var c = mix(vec3f(0.10, 0.11, 0.13), vec3f(0.15, 0.16, 0.19), stripe);
  let bx0 = u.size.x * 0.2;
  let bx1 = u.size.x * 0.8;
  let by = u.size.y * 0.58;
  let bh = max(u.size.y * 0.014, 3.0);
  if (u.hasBar > 0.5 && px.y > by && px.y < by + bh && px.x > bx0 && px.x < bx1) {
    c = select(vec3f(0.28, 0.29, 0.33), vec3f(0.95, 0.70, 0.25), (px.x - bx0) / (bx1 - bx0) <= u.frac);
  }
  var out = vec4f(c, 1.0);
  ${txt ? `let tsz = vec2f(textureDimensions(txt));
  let tuv = (px - vec2f(u.size.x * 0.5, u.size.y * 0.46)) / tsz + vec2f(0.5, 0.5);
  let inside = select(0.0, 1.0, tuv.x >= 0.0 && tuv.x <= 1.0 && tuv.y >= 0.0 && tuv.y <= 1.0);
  let t = textureSampleLevel(txt, smp, clamp(tuv, vec2f(0.0), vec2f(1.0)), 0.0) * inside;
  out = vec4f(out.rgb * (1.0 - t.a) + t.rgb, 1.0);` : ''}
  return out;
}`,
  });
}
