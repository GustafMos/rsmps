/**
 * Group nodes (macros), Repeat groups and cache regions: the data model and the pure functions around it.
 *
 * A group is a node of type `group` whose params hold a sub-graph (`GroupData`): its nodes, its wires, its ports and the inner params it
 * exposes. Inner wires reach the group's ports through two pseudo nodes, `@in` (a wire FROM `@in` port X = "what arrives on group input
 * X") and `@out` (a wire TO `@out` port Y = "what group output Y gives"); keeping them as ordinary wires keeps the wire order of `multi`
 * inputs exact. The engine never evaluates a group node: `flattenGraph` turns a document with groups into a plain graph whose inner node
 * ids are paths (`groupId/innerId`, `repeatId/~2/innerId` for iteration 2), so caching, timings, errors and process state work per inner
 * node exactly as in the flat graph, and a group boundary costs nothing (no node, no pass, no copy). A baked group ("cache region") is the
 * exception: it stays ONE node that serves its stored outputs (see the `process` of `groupDefOf`).
 *
 * Contract: docs/ENGINE.md, Pending rules ("Group nodes", "Repeat groups", "Bake a group").
 */
import { isInputPort, type Registry } from './define';
import { SDF_SCENE_PARAMS } from './lib/sdf-scene-params';
import { stableStringify } from './lib/stable-json';
import {
  CATEGORIES,
  type AnyNodeDef,
  type Category,
  type Edge,
  type FrameBox,
  type GraphDoc,
  type ImageValue,
  type InputDef,
  type MaskValue,
  type NodeInstance,
  type OutputDef,
  type ParamDef,
  type ProcessCtx,
  type SocketType,
  type Value,
} from './types';

export const GROUP_TYPE = 'group';
export const GROUP_INPUT_TYPE = 'group-input';
export const GROUP_OUTPUT_TYPE = 'group-output';
export const ITERATION_TYPE = 'iteration';
/** Pseudo node ids used by inner wires (and the ids of the boundary nodes shown when a group is open). */
export const GROUP_IN = '@in';
export const GROUP_OUT = '@out';
/** The "+" socket of a boundary node: a wire dropped on it adds a group port of the wire's type. */
export const NEW_PORT = '+';
/** Separator of path ids (`group/inner`). Plain node ids never contain it. */
export const PATH_SEP = '/';
/** Same as PROCESS_PARAM in process.ts (kept here so this module has no runtime import of process.ts: import cycle). */
const PROCESS_PARAM = '__process';
/** Groups inside groups: at most this many levels. Deeper groups are kept as one node that says why. */
export const GROUP_MAX_DEPTH = 8;
/** Hard cap of a Repeat count (a wired count above it is clamped and reported). */
export const REPEAT_MAX = 64;
export const REPEAT_SOFT_MAX = 16;
export const REPEAT_DEFAULT = 4;

export type GroupKind = 'group' | 'repeat';
export type RepeatMode = 'chain' | 'accumulate';

/** One port of a group. `loop` marks the Repeat input that carries the previous pass's picture. */
export interface GroupPort {
  id: string;
  name: string;
  type: SocketType;
  loop?: boolean;
}

/**
 * An inner param shown on the group node. `def` is a JSON snapshot of the inner param's definition taken when it was exposed (functions
 * such as `visibleIf` dropped), so the group's own definition is a pure function of its params (no registry needed) and a saved group
 * file describes itself. The value lives on the group node under `id` and overrides the inner node's value.
 */
export interface GroupExposed {
  id: string;
  label: string;
  node: string;
  param: string;
  def: ParamDef;
}

export interface GroupData {
  kind: GroupKind;
  title?: string;
  /** A category key: the colour stripe of the node. */
  color?: Category;
  /** An icon name of the UI (stack glyph when absent). */
  icon?: string;
  description?: string;
  nodes: NodeInstance[];
  edges: Edge[];
  inputs: GroupPort[];
  outputs: GroupPort[];
  exposed: GroupExposed[];
  /** An SDF Scene: a group whose inside holds SDF nodes around a Scene Output node (lib/sdf-scene-group.ts). Only in an SDF Scene can SDF nodes be added. */
  sdfScene?: boolean;
  /** Repeat only. */
  count?: number;
  mode?: RepeatMode;
  blend?: string;
  opacity?: number;
  /** UI only: where the boundary nodes sit when the group is open, and the frames drawn inside it. */
  ui?: { in?: { x: number; y: number }; out?: { x: number; y: number }; frames?: FrameBox[] };
}

/** Params of a group node that are not exposed values. Exposed ids must not use these. */
export const GROUP_KEYS: readonly string[] = ['kind', 'title', 'color', 'icon', 'description', 'nodes', 'edges', 'inputs', 'outputs', 'exposed', 'sdfScene', 'count', 'mode', 'blend', 'opacity', 'ui', PROCESS_PARAM];

export const REPEAT_BLENDS = [
  { value: 'normal', label: 'Normal' },
  { value: 'add', label: 'Add' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'difference', label: 'Difference' },
] as const;

const SOCKETS: readonly SocketType[] = ['image', 'mask', 'palette', 'number', 'color', 'vector', 'motion', 'regions', 'camera', 'material', 'sdf', 'audio', 'midi'];

export const isGroupNode = (n: { type: string } | undefined | null): boolean => !!n && n.type === GROUP_TYPE;
export const isBoundaryNode = (n: { type: string } | undefined | null): boolean => !!n && (n.type === GROUP_INPUT_TYPE || n.type === GROUP_OUTPUT_TYPE);
/** The last segment of a path id: the id the node had in its own level (used as the seed base, so grouping never changes a look). */
export const localId = (id: string): string => id.slice(id.lastIndexOf(PATH_SEP) + 1);
export const isPathId = (id: string): boolean => id.includes(PATH_SEP);

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** The group record of a group node, with missing fields defaulted (never throws). */
export function groupData(node: Pick<NodeInstance, 'params'>): GroupData {
  const p = node.params ?? {};
  const kind: GroupKind = p.kind === 'repeat' ? 'repeat' : 'group';
  return {
    kind,
    title: typeof p.title === 'string' ? p.title : undefined,
    color: typeof p.color === 'string' && p.color in CATEGORIES ? (p.color as Category) : undefined,
    icon: typeof p.icon === 'string' ? p.icon : undefined,
    description: typeof p.description === 'string' ? p.description : undefined,
    nodes: arr<NodeInstance>(p.nodes),
    edges: arr<Edge>(p.edges),
    inputs: arr<GroupPort>(p.inputs),
    outputs: arr<GroupPort>(p.outputs),
    exposed: arr<GroupExposed>(p.exposed),
    sdfScene: p.sdfScene === true ? true : undefined,
    count: typeof p.count === 'number' ? p.count : undefined,
    mode: p.mode === 'accumulate' ? 'accumulate' : p.mode === 'chain' ? 'chain' : undefined,
    blend: typeof p.blend === 'string' ? p.blend : undefined,
    opacity: typeof p.opacity === 'number' ? p.opacity : undefined,
    ui: p.ui && typeof p.ui === 'object' ? (p.ui as GroupData['ui']) : undefined,
  };
}

/** The repeat count as stored (unwired): an integer in 1..REPEAT_MAX. */
export function storedCount(data: GroupData): number {
  const n = typeof data.count === 'number' && Number.isFinite(data.count) ? Math.round(data.count) : REPEAT_DEFAULT;
  return Math.min(REPEAT_MAX, Math.max(1, n));
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Definitions (pure functions of the node: no registry needed)                                                                   */
/* ------------------------------------------------------------------------------------------------------------------------------ */

const REPEAT_PARAMS: Record<string, ParamDef> = {
  count: { type: 'number', default: REPEAT_DEFAULT, min: 1, max: REPEAT_MAX, softMax: REPEAT_SOFT_MAX, step: 1, integer: true, label: 'Count', hint: 'How many times the inside is applied. Each pass costs as much as the inside once.' },
  mode: {
    type: 'enum',
    default: 'chain',
    options: [
      { value: 'chain', label: 'Chain' },
      { value: 'accumulate', label: 'Accumulate' },
    ],
    label: 'Mode',
    hint: 'Chain: each pass works on the previous pass. Accumulate: each pass works on the original input and is blended over the passes before it.',
  },
  blend: { type: 'enum', default: 'normal', options: REPEAT_BLENDS, label: 'Blend', hint: 'Accumulate: how each pass is blended over the result so far.', visibleIf: (p) => p.mode === 'accumulate' },
  opacity: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Pass opacity', hint: 'Accumulate: opacity of each pass over the result so far.', visibleIf: (p) => p.mode === 'accumulate' },
};

function cleanParamDef(def: ParamDef, label: string): ParamDef {
  const copy = { ...def, label } as ParamDef & { visibleIf?: unknown; group?: unknown };
  delete copy.visibleIf;
  delete copy.group;
  return copy as ParamDef;
}

/** A JSON-safe snapshot of a param definition (for `GroupExposed.def`). */
export function snapshotParamDef(def: ParamDef): ParamDef {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def)) if (typeof v !== 'function' && k !== 'group') out[k] = structuredClone(v);
  return out as unknown as ParamDef;
}

const defMemo = new WeakMap<object, AnyNodeDef>();

/** The definition of a group node, built from its own params (ports, exposed params, Repeat params, bake process). Memoised per params object. */
export function groupDefOf(node: Pick<NodeInstance, 'params' | 'type'>): AnyNodeDef {
  const hit = defMemo.get(node.params);
  if (hit) return hit;
  const data = groupData(node);
  const inputs: Record<string, InputDef> = {};
  for (const p of data.inputs) inputs[p.id] = { type: SOCKETS.includes(p.type) ? p.type : 'image', label: p.name, lazy: true };
  const outputs: Record<string, OutputDef> = {};
  for (const p of data.outputs) outputs[p.id] = { type: SOCKETS.includes(p.type) ? p.type : 'image', label: p.name };
  const params: Record<string, ParamDef> = {};
  if (data.kind === 'repeat') Object.assign(params, REPEAT_PARAMS);
  for (const x of data.exposed) {
    if (!x.def || typeof x.def !== 'object' || x.id in inputs || GROUP_KEYS.includes(x.id)) continue;
    // an SDF Scene shows its render settings with their groups and conditions (the plain snapshot drops both)
    const full = data.sdfScene && x.param === x.id ? (SDF_SCENE_PARAMS as Record<string, ParamDef>)[x.id] : undefined;
    params[x.id] = full ? ({ ...full, label: x.label } as ParamDef) : cleanParamDef(x.def, x.label);
  }
  const title = data.title || (data.sdfScene ? 'SDF Scene' : data.kind === 'repeat' ? 'Repeat' : 'Group');
  const def: AnyNodeDef = {
    id: GROUP_TYPE,
    title,
    category: data.color ?? (data.sdfScene ? 'sdf' : 'math'),
    description: data.description || (data.sdfScene ? 'A place to model with SDF shapes. Double-click to open it, add shapes inside, and wire them to the Scene Output. It renders the scene and can also be wired into another SDF Scene.' : data.kind === 'repeat' ? 'Applies the nodes inside several times, each pass on the result of the one before.' : 'Nodes bundled into one. Double-click to open it.'),
    inputs,
    outputs,
    params,
    summary: () => {
      const n = data.nodes.length;
      const base = `${n} node${n === 1 ? '' : 's'}`;
      return data.kind === 'repeat' ? `${base} · ${data.mode === 'accumulate' ? 'accumulate' : 'chain'}` : base;
    },
    render: renderBakedGroup,
    process: groupProcess(data),
  };
  defMemo.set(node.params, def);
  return def;
}

/** Boundary nodes shown inside an open group: their ports are the group's ports (stored in their params by the editor). */
export function boundaryDefOf(node: Pick<NodeInstance, 'params' | 'type'>): AnyNodeDef {
  const hit = defMemo.get(node.params);
  if (hit) return hit;
  const ports = arr<GroupPort>(node.params.ports);
  const isIn = node.type === GROUP_INPUT_TYPE;
  const sockets: Record<string, InputDef | OutputDef> = {};
  for (const p of ports) sockets[p.id] = { type: SOCKETS.includes(p.type) ? p.type : 'image', label: p.name };
  const def: AnyNodeDef = {
    id: node.type,
    title: isIn ? 'Group Input' : 'Group Output',
    category: 'math',
    description: isIn ? 'What arrives on the group from outside. Drag a wire from an inner input onto it to add a port.' : 'What the group gives back. Drag a wire onto it to add a port.',
    inputs: isIn ? {} : (sockets as Record<string, InputDef>),
    outputs: isIn ? (sockets as Record<string, OutputDef>) : {},
    params: {},
    render: () => ({}),
  };
  defMemo.set(node.params, def);
  return def;
}

/** The definition of any node: groups and boundary nodes get theirs from their params, everything else from the registry. */
export function defOf(registry: Pick<Registry, 'get'>, node: Pick<NodeInstance, 'params' | 'type'> | undefined | null): AnyNodeDef | undefined {
  if (!node) return undefined;
  if (node.type === GROUP_TYPE) return groupDefOf(node);
  if (node.type === GROUP_INPUT_TYPE || node.type === GROUP_OUTPUT_TYPE) return boundaryDefOf(node);
  return registry.get(node.type);
}

/** Registered placeholders so documents with groups validate and load; the real definition of a node comes from `defOf`. */
export const GROUP_STATIC_DEFS: AnyNodeDef[] = [
  {
    id: GROUP_TYPE,
    title: 'Group',
    category: 'math',
    description: 'Nodes bundled into one node (Ctrl+G). Double-click to open it.',
    keywords: ['macro', 'bundle', 'subgraph', 'collapse'],
    hidden: true,
    inputs: {},
    outputs: { out: { type: 'image', label: 'Output' } },
    params: {},
    render: () => ({}),
    process: {
      title: 'Bake',
      standIn: 'bypass',
      required: 'never',
      signature: () => '',
      run: async () => {
        throw new Error('Internal: a group is baked through its own definition (defOf).');
      },
    },
  },
  { id: GROUP_INPUT_TYPE, title: 'Group Input', category: 'math', description: 'Inside a group: what arrives from outside.', hidden: true, inputs: {}, outputs: { out: { type: 'image', label: 'Output' } }, params: {}, render: () => ({}) },
  { id: GROUP_OUTPUT_TYPE, title: 'Group Output', category: 'math', description: 'Inside a group: what the group gives back.', hidden: true, inputs: {}, outputs: { out: { type: 'image', label: 'Output' } }, params: {}, render: () => ({}) },
];

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Bake a group (cache region)                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------------------ */

const BAKEABLE: readonly SocketType[] = ['image', 'mask', 'number', 'color'];

/** Why a group cannot be baked, or null. */
export function groupBakeProblem(data: GroupData): string | null {
  if (!data.outputs.length) return 'This group has no outputs: there is nothing to bake.';
  const bad = data.outputs.find((o) => !BAKEABLE.includes(o.type));
  if (bad) return `The output "${bad.name}" is a ${bad.type}: only pictures, masks, numbers and colors can be baked.`;
  return null;
}

/** Stored item name of a group output (pictures: a sequence; numbers and colors: one JSON array of per-frame values). */
const itemName = (port: string) => `out:${port}`;

function groupProcess(data: GroupData): NonNullable<AnyNodeDef['process']> {
  return {
    title: 'Bake',
    description: 'Render every frame of the group outputs once and store them; the nodes inside then cost nothing.',
    standIn: 'bypass',
    required: 'never',
    gpu: true,
    // The engine computes the signature of a group itself (structure of everything inside and before it), see Engine.groupSignature.
    signature: () => '',
    estimate: (_p, project) => {
      const frames = Math.max(1, Math.round(project.duration * project.fps));
      const pics = data.outputs.filter((o) => o.type === 'image' || o.type === 'mask').length;
      return { frames, bytes: Math.round(frames * project.width * project.height * 1.5 * pics), note: 'about 1.5 bytes per pixel per picture output' };
    },
    async run(job: ProcessCtx) {
      const problem = groupBakeProblem(data);
      if (problem) throw new Error(problem);
      if (!job.pullOutput) throw new Error('This host cannot bake groups.');
      const meta: Record<string, { kind: SocketType; unit?: number; width?: number; height?: number }> = {};
      const pics = new Map<string, Blob[]>();
      const values = new Map<string, unknown[]>();
      for (let i = 0; i < job.frames; i++) {
        await job.yield();
        for (const o of data.outputs) {
          const pulled = await job.pullOutput(o.id, { frame: i, proxy: 1, quality: 'final' });
          try {
            const v = pulled.value;
            if (o.type === 'image' || o.type === 'mask') {
              if (!(v && typeof v === 'object' && 'texture' in v)) throw new Error([...pulled.errors.values()][0] ?? `The output "${o.name}" is empty at frame ${i + 1}.`);
              const img = v as ImageValue | MaskValue;
              const m = (meta[o.id] ??= { kind: o.type, unit: img.unit, width: img.width, height: img.height });
              if (img.width !== m.width || img.height !== m.height) throw new Error(`Frame ${i + 1} of "${o.name}" has another size (${img.width}x${img.height}) than the first (${m.width}x${m.height}).`);
              const list = pics.get(o.id) ?? [];
              list.push(await job.encodeImage(img, 'lossless'));
              pics.set(o.id, list);
            } else {
              meta[o.id] ??= { kind: o.type };
              const list = values.get(o.id) ?? [];
              list.push(v ?? null);
              values.set(o.id, list);
            }
          } finally {
            pulled.release();
          }
        }
        job.progress((i + 1) / job.frames, `Frame ${i + 1} of ${job.frames}`, { frame: i + 1, frames: job.frames, bytes: job.store.bytes });
      }
      for (const [port, blobs] of pics) {
        const m = meta[port];
        job.store.sequence(itemName(port), blobs, { fps: job.fps, width: m.width!, height: m.height!, unit: m.unit });
      }
      for (const [port, list] of values) job.store.json(itemName(port), list);
      return { meta: { ports: meta, canvas: `${Math.round(job.canvas.width)}x${Math.round(job.canvas.height)}`, item: job.item.dependent ? job.item.index : null } };
    },
  };
}

/** Render of a baked group (the only time a group node is evaluated): every output from the store, nothing inside is evaluated. */
async function renderBakedGroup(ctx: Parameters<NonNullable<AnyNodeDef['render']>>[0]): Promise<Record<string, Value | null>> {
  const ps = ctx.process;
  const out: Record<string, Value | null> = {};
  if (!ps?.result) return out;
  const meta = (ps.result.meta.ports ?? {}) as Record<string, { kind: SocketType; unit?: number; width?: number }>;
  for (const [port, m] of Object.entries(meta)) {
    const item = ps.result.items[itemName(port)];
    if (!item) continue;
    if (item.kind === 'sequence') {
      const total = Math.max(1, item.frames ?? 1);
      const f = ctx.time.frame;
      const idx = ctx.time.loop ? ((f % total) + total) % total : Math.min(total - 1, Math.max(0, f));
      const bakedLong = Math.max(item.width ?? 0, item.height ?? 0);
      const wanted = bakedLong * ctx.proxy;
      const frame = await ps.frame(itemName(port), idx, wanted < bakedLong - 0.5 ? Math.ceil(wanted) : 0);
      if (!frame) continue;
      const unit = m.unit && m.width ? m.unit * (frame.width / m.width) : ctx.unitFor(frame.width, frame.height);
      out[port] = { kind: m.kind === 'mask' ? 'mask' : 'image', texture: frame.texture, width: frame.width, height: frame.height, unit } as ImageValue;
    } else {
      const list = await ps.json<unknown[]>(itemName(port));
      if (!Array.isArray(list) || !list.length) continue;
      const f = ctx.time.frame;
      const idx = ctx.time.loop ? ((f % list.length) + list.length) % list.length : Math.min(list.length - 1, Math.max(0, f));
      out[port] = (list[idx] ?? null) as Value | null;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Flattening                                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export interface PortRef {
  node: string;
  port: string;
}

export interface FlatOptions {
  /** Group paths kept as one node (baked groups that serve their stored outputs). */
  opaque?: ReadonlySet<string>;
  /** Counts of Repeat groups whose count is wired, by path (resolved by the engine). Absent = kept as one unresolved node. */
  counts?: ReadonlyMap<string, number>;
}

export interface FlatView {
  /** The plain graph (the input itself when it has no groups). */
  graph: GraphDoc;
  /** False when the input had no group at all: `graph` is the input and nothing else here is filled. */
  grouped: boolean;
  /** `<group path>:<output port>` -> what feeds that output in the flat graph (expanded groups only; null = nothing). */
  outputs: Map<string, PortRef | null>;
  /** Repeat groups whose count is wired but not in `counts`: kept as one node; `source` = what feeds their count. */
  dynamic: { path: string; source: PortRef | null }[];
  /** Every group in the document by path (expanded or not), in document order. */
  groups: string[];
  /** Groups that hold a bake result (whether or not expanded). */
  baked: string[];
  /** Logical id -> flat id, for ids that differ (an inner node of a Repeat is shown as its last pass). */
  alias: Map<string, string>;
  /** Group path -> problem (too deep, count above the cap, a cycle). */
  errors: Map<string, string>;
  /** The groups kept as one node because they serve a bake (the `opaque` option). */
  opaque: ReadonlySet<string>;
}

const memo = new WeakMap<GraphDoc, Map<string, FlatView>>();

/** True when the document has a group node at its top level. */
export function hasGroups(graph: GraphDoc): boolean {
  for (const n of graph.nodes) if (n.type === GROUP_TYPE) return true;
  return false;
}

const optsKey = (o: FlatOptions): string =>
  (o.opaque?.size ? [...o.opaque].sort().join(',') : '') + '|' + (o.counts?.size ? [...o.counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join(',') : '');

/**
 * The document as a plain graph: every group (that is not `opaque`) replaced by its inside, inner ids namespaced by path, exposed values
 * written into the inner params, wires into exposed params re-targeted to the inner param, Repeat groups unrolled. Pure; memoised per
 * (document object, options), so calling it every frame costs one map lookup.
 */
export function flattenGraph(graph: GraphDoc, opts: FlatOptions = {}): FlatView {
  let byOpts = memo.get(graph);
  const key = optsKey(opts);
  const hit = byOpts?.get(key);
  if (hit) return hit;
  const view = hasGroups(graph) ? flattenImpl(graph, opts) : { graph, grouped: false, outputs: new Map(), dynamic: [], groups: [], baked: [], alias: new Map(), errors: new Map(), opaque: new Set<string>() };
  if (!byOpts) {
    byOpts = new Map();
    memo.set(graph, byOpts);
  }
  if (byOpts.size > 32) byOpts.delete(byOpts.keys().next().value as string);
  byOpts.set(key, view);
  return view;
}

function flattenImpl(graph: GraphDoc, opts: FlatOptions): FlatView {
  const opaque = opts.opaque ?? new Set<string>();
  const counts = opts.counts ?? new Map<string, number>();
  const nodesOut: NodeInstance[] = [];
  const edgesOut: Edge[] = [];
  const view: FlatView = { graph, grouped: true, outputs: new Map(), dynamic: [], groups: [], baked: [], alias: new Map(), errors: new Map(), opaque };

  /**
   * Emit one level. `prefix` = flat id prefix of its nodes; `logical` = the prefix the user sees (differs inside a Repeat's last pass,
   * null inside the other passes); `inputOf(port)` = what feeds group input `port` from outside. Returns what feeds each `@out` port.
   */
  const runLevel = (
    nodes: NodeInstance[],
    edges: Edge[],
    prefix: string,
    logical: string | null,
    depth: number,
    iter: { index: number; count: number } | null,
    inputOf: (port: string) => PortRef | null,
  ): Map<string, PortRef | null> => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const inbound = new Map<string, Edge[]>();
    for (const e of edges) {
      const l = inbound.get(e.to.node);
      if (l) l.push(e);
      else inbound.set(e.to.node, [e]);
    }
    const expanded = new Map<string, Map<string, PortRef | null> | 'busy'>();

    const wiredCount = (g: NodeInstance) => (inbound.get(g.id) ?? []).some((e) => e.to.port === 'count');
    const isExpanded = (n: NodeInstance): boolean => {
      if (n.type !== GROUP_TYPE) return false;
      const path = prefix + n.id;
      if (opaque.has(path)) return false;
      if (depth + 1 > GROUP_MAX_DEPTH) return false;
      if (groupData(n).kind === 'repeat' && wiredCount(n) && !counts.has(path)) return false;
      return true;
    };

    const resolve = (ref: PortRef): PortRef | null => {
      if (ref.node === GROUP_IN) return inputOf(ref.port);
      const n = byId.get(ref.node);
      if (!n) return null;
      if (isExpanded(n)) return expandGroup(n).get(ref.port) ?? null;
      return { node: prefix + ref.node, port: ref.port };
    };

    const expandGroup = (g: NodeInstance): Map<string, PortRef | null> => {
      const done = expanded.get(g.id);
      if (done === 'busy') {
        view.errors.set(prefix + g.id, 'The wires around this group form a loop.');
        return new Map();
      }
      if (done) return done;
      expanded.set(g.id, 'busy');
      const path = prefix + g.id;
      const lpath = logical === null ? null : logical + g.id;
      if (lpath !== null && lpath !== path) view.alias.set(lpath, path);
      const data = groupData(g);
      const into = inbound.get(g.id) ?? [];
      const wireInto = (port: string): Edge | undefined => {
        let last: Edge | undefined;
        for (const e of into) if (e.to.port === port) last = e;
        return last;
      };
      const outerInput = (port: string): PortRef | null => {
        const e = wireInto(port);
        return e ? resolve(e.from) : null;
      };
      // Exposed params: the group's value overrides the inner one; a wire into the exposed socket drives the inner param.
      const overrides = new Map<string, Record<string, unknown>>();
      const virtual: Edge[] = [];
      for (const x of data.exposed) {
        if (x.id in g.params) {
          const o = overrides.get(x.node) ?? {};
          o[x.param] = g.params[x.id];
          overrides.set(x.node, o);
        }
        if (wireInto(x.id)) virtual.push({ id: `@x:${x.id}`, from: { node: GROUP_IN, port: `@x:${x.id}` }, to: { node: x.node, port: x.param } });
      }
      const innerNodes = overrides.size ? data.nodes.map((n) => (overrides.has(n.id) ? { ...n, params: { ...n.params, ...overrides.get(n.id) } } : n)) : data.nodes;
      const innerEdges = virtual.length ? [...data.edges, ...virtual] : data.edges;
      const innerInput = (port: string) => (port.startsWith('@x:') ? outerInput(port.slice(3)) : outerInput(port));
      let result: Map<string, PortRef | null>;
      if (g.bypass) {
        // Bypassed: like any node, each output passes the first unused input of the same type through; nothing inside is evaluated.
        result = new Map();
        const used = new Set<string>();
        for (const o of data.outputs) {
          const i = data.inputs.find((p) => !used.has(p.id) && (p.type === o.type || (p.type === 'mask' && o.type === 'image')));
          if (i) used.add(i.id);
          result.set(o.id, i ? outerInput(i.id) : null);
        }
      } else if (data.kind !== 'repeat') {
        result = runLevel(innerNodes, innerEdges, path + PATH_SEP, lpath === null ? null : lpath + PATH_SEP, depth + 1, iter, innerInput);
      } else {
        let n = storedCount(data);
        if (wiredCount(g)) {
          const want = Math.round(counts.get(path) ?? n);
          if (want > REPEAT_MAX) view.errors.set(path, `Repeat count ${want} is above the limit of ${REPEAT_MAX}; using ${REPEAT_MAX}.`);
          n = Math.min(REPEAT_MAX, Math.max(1, Number.isFinite(want) ? want : 1));
        }
        const mode: RepeatMode = data.mode === 'accumulate' ? 'accumulate' : 'chain';
        const loopIn = data.inputs.find((p) => p.loop) ?? data.inputs.find((p) => p.type === 'image');
        const carried = data.outputs.find((p) => p.type === 'image');
        let prev: Map<string, PortRef | null> | null = null;
        const passes: Map<string, PortRef | null>[] = [];
        for (let i = 0; i < n; i++) {
          const before = prev;
          const passInput = (port: string): PortRef | null => {
            if (mode === 'chain' && i > 0 && loopIn && carried && port === loopIn.id) return before?.get(carried.id) ?? null;
            return innerInput(port);
          };
          const last = i === n - 1;
          prev = runLevel(innerNodes, innerEdges, `${path}${PATH_SEP}~${i}${PATH_SEP}`, last && lpath !== null ? lpath + PATH_SEP : null, depth + 1, { index: i, count: n }, passInput);
          passes.push(prev);
        }
        result = new Map(prev ?? []);
        if (mode === 'accumulate' && carried) {
          let acc = passes[0]?.get(carried.id) ?? null;
          const blend = typeof g.params.blend === 'string' ? g.params.blend : 'normal';
          const opacity = typeof g.params.opacity === 'number' ? g.params.opacity : 1;
          const opacityWire = wireInto('opacity');
          const opacitySrc = opacityWire ? resolve(opacityWire.from) : null;
          for (let i = 1; i < passes.length; i++) {
            const layer = passes[i].get(carried.id) ?? null;
            if (!acc) {
              acc = layer;
              continue;
            }
            const id = `${path}${PATH_SEP}~acc${i}`;
            nodesOut.push({ id, type: 'merge', x: g.x, y: g.y, params: { mode: blend, opacity } });
            edgesOut.push({ id: `${id}:bg`, from: acc, to: { node: id, port: 'background' } });
            if (layer) edgesOut.push({ id: `${id}:fg`, from: layer, to: { node: id, port: 'foreground' } });
            if (opacitySrc) edgesOut.push({ id: `${id}:op`, from: opacitySrc, to: { node: id, port: 'opacity' } });
            acc = { node: id, port: 'image' };
          }
          result.set(carried.id, acc);
        }
      }
      for (const o of data.outputs) {
        if (!result.has(o.id)) result.set(o.id, null);
        view.outputs.set(`${path}:${o.id}`, result.get(o.id) ?? null);
      }
      expanded.set(g.id, result);
      return result;
    };

    for (const n of nodes) {
      const id = prefix + n.id;
      if (n.type === GROUP_TYPE) {
        view.groups.push(id);
        if (n.params[PROCESS_PARAM] && typeof n.params[PROCESS_PARAM] === 'object') view.baked.push(id);
        if (isExpanded(n)) {
          expandGroup(n);
          continue;
        }
        if (depth + 1 > GROUP_MAX_DEPTH && !opaque.has(id)) view.errors.set(id, `Groups are nested more than ${GROUP_MAX_DEPTH} levels deep: this one is not calculated.`);
        if (groupData(n).kind === 'repeat' && wiredCount(n) && !counts.has(id)) {
          const e = (inbound.get(n.id) ?? []).filter((x) => x.to.port === 'count').pop();
          view.dynamic.push({ path: id, source: e ? resolve(e.from) : null });
        }
      }
      if (logical !== null && logical + n.id !== id) view.alias.set(logical + n.id, id);
      const params = n.type === ITERATION_TYPE && iter ? { ...n.params, iter: { index: iter.index, count: iter.count } } : n.params;
      nodesOut.push(id === n.id && params === n.params ? n : { ...n, id, params });
    }
    const outs = new Map<string, PortRef | null>();
    for (const e of edges) {
      if (e.to.node === GROUP_OUT) {
        outs.set(e.to.port, resolve(e.from));
        continue;
      }
      const t = byId.get(e.to.node);
      if (!t || isExpanded(t)) continue;
      const src = resolve(e.from);
      if (!src) continue;
      const to = { node: prefix + e.to.node, port: e.to.port };
      edgesOut.push(prefix === '' && src.node === e.from.node && src.port === e.from.port ? e : { id: prefix + e.id, from: src, to });
    }
    return outs;
  };

  runLevel(graph.nodes, graph.edges, '', '', 0, null, () => null);
  view.graph = { ...graph, nodes: nodesOut, edges: edgesOut };
  return view;
}

/**
 * Where the evaluation of (logical) node `id`, port `port` really happens in a flat view: an expanded group's output becomes the inner
 * source of that output, an inner node of a Repeat becomes its last pass. `port` undefined = the node's first output.
 */
export function resolveFlatTarget(view: FlatView, id: string, port: string | undefined, firstOutput: (flatId: string) => string | undefined): { node: string; port: string | undefined } | null {
  const real = view.alias.get(id) ?? id;
  if (view.graph.nodes.some((n) => n.id === real)) return { node: real, port };
  // An expanded group: follow its output into the inside (a chain of nested groups resolves in one step: outputs are already flat).
  const prefix = `${real}:`;
  let first: string | undefined;
  for (const k of view.outputs.keys()) {
    if (k.startsWith(prefix) && !k.slice(prefix.length).includes(':')) {
      first = k.slice(prefix.length);
      break;
    }
  }
  const p = port ?? first;
  if (p === undefined) return null;
  const ref = view.outputs.get(prefix + p);
  if (ref === undefined) return null;
  if (ref === null) return { node: '', port: undefined };
  void firstOutput;
  return { node: ref.node, port: ref.port };
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Paths (open groups in the editor)                                                                                               */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** The group node at `path` (ids from the top level down), or null when the path no longer exists. */
export function groupAtPath(root: GraphDoc, path: readonly string[]): NodeInstance | null {
  let nodes = root.nodes;
  let found: NodeInstance | null = null;
  for (const id of path) {
    found = nodes.find((n) => n.id === id && n.type === GROUP_TYPE) ?? null;
    if (!found) return null;
    nodes = groupData(found).nodes;
  }
  return found;
}

/** A node by full path id (`g1/g2/n3`), or null. Plain ids are top-level nodes. */
export function nodeAtPath(root: GraphDoc, id: string): NodeInstance | null {
  const parts = id.split(PATH_SEP).filter((p) => !p.startsWith('~'));
  const parent = groupAtPath(root, parts.slice(0, -1));
  const nodes = parts.length > 1 ? (parent ? groupData(parent).nodes : []) : root.nodes;
  return nodes.find((n) => n.id === parts[parts.length - 1]) ?? null;
}

/** The longest prefix of `path` that still exists (after undo, delete...). */
export function validPath(root: GraphDoc, path: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of path) {
    if (!groupAtPath(root, [...out, id])) break;
    out.push(id);
  }
  return out;
}

const levelMemo = new WeakMap<GraphDoc, Map<string, GraphDoc>>();

/**
 * What the editor shows at `path`: the inside of that group as a document (same project settings) with two boundary nodes, `@in` (outputs =
 * the group inputs) and `@out` (inputs = the group outputs). The top level is the document itself. Memoised per (document, path).
 */
export function levelGraph(root: GraphDoc, path: readonly string[]): GraphDoc {
  if (!path.length) return root;
  const key = path.join(PATH_SEP);
  const m = levelMemo.get(root);
  const hit = m?.get(key);
  if (hit) return hit;
  const g = groupAtPath(root, path);
  let level: GraphDoc;
  if (!g) level = root;
  else {
    const d = groupData(g);
    const xs = d.nodes.map((n) => n.x);
    const ys = d.nodes.map((n) => n.y);
    const minX = xs.length ? Math.min(...xs) : 0;
    const maxX = xs.length ? Math.max(...xs) : 0;
    const minY = ys.length ? Math.min(...ys) : 0;
    const inPos = d.ui?.in ?? { x: minX - 300, y: minY };
    const outPos = d.ui?.out ?? { x: maxX + 300, y: minY };
    const inNode: NodeInstance = { id: GROUP_IN, type: GROUP_INPUT_TYPE, x: inPos.x, y: inPos.y, params: { ports: d.inputs } };
    const outNode: NodeInstance = { id: GROUP_OUT, type: GROUP_OUTPUT_TYPE, x: outPos.x, y: outPos.y, params: { ports: d.outputs } };
    level = { ...root, name: d.title || (d.kind === 'repeat' ? 'Repeat' : 'Group'), nodes: [inNode, ...d.nodes, outNode], edges: d.edges, frames: Array.isArray(d.ui?.frames) ? d.ui!.frames : [] };
  }
  const map = m ?? new Map<string, GraphDoc>();
  if (!m) levelMemo.set(root, map);
  if (map.size > 16) map.delete(map.keys().next().value as string);
  map.set(key, level);
  return level;
}

/** Write an edited level back: the group at `path` gets the level's nodes, wires, ports (from the boundary nodes) and boundary positions. */
export function withLevel(root: GraphDoc, path: readonly string[], level: GraphDoc): GraphDoc {
  if (!path.length) return level;
  const parentPath = path.slice(0, -1);
  const gid = path[path.length - 1];
  const parent = levelGraph(root, parentPath);
  const g = parent.nodes.find((n) => n.id === gid && n.type === GROUP_TYPE);
  if (!g) return root;
  const inNode = level.nodes.find((n) => n.id === GROUP_IN);
  const outNode = level.nodes.find((n) => n.id === GROUP_OUT);
  const inner = level.nodes.filter((n) => n.id !== GROUP_IN && n.id !== GROUP_OUT);
  const d = groupData(g);
  const inputs = inNode ? arr<GroupPort>(inNode.params.ports) : d.inputs;
  const outputs = outNode ? arr<GroupPort>(outNode.params.ports) : d.outputs;
  const ids = new Set(inner.map((n) => n.id));
  const exposed = d.exposed.filter((x) => ids.has(x.node)); // an exposed param whose inner node is gone is dropped
  const params: Record<string, unknown> = {
    ...g.params,
    nodes: inner,
    edges: level.edges,
    inputs,
    outputs,
    exposed,
    ui: { in: inNode ? { x: inNode.x, y: inNode.y } : d.ui?.in, out: outNode ? { x: outNode.x, y: outNode.y } : d.ui?.out, ...(level.frames?.length ? { frames: level.frames } : {}) },
  };
  for (const x of d.exposed) if (!exposed.includes(x)) delete params[x.id];
  const next: NodeInstance = { ...g, params };
  // Wires outside that used a port (or an exposed param) that no longer exists go too.
  const def = groupDefOf(next);
  const okIn = (port: string) => isInputPort(def, port);
  const edges = parent.edges.filter((e) => !(e.to.node === gid && !okIn(e.to.port)) && !(e.from.node === gid && !(e.from.port in def.outputs)));
  const nextParent: GraphDoc = { ...parent, nodes: parent.nodes.map((n) => (n.id === gid ? next : n)), edges: edges.length === parent.edges.length ? parent.edges : edges };
  return withLevel(root, parentPath, nextParent);
}

/** Pure: the document with the group at `path` replaced by `fn(group)`. */
export function updateGroupAt(root: GraphDoc, path: readonly string[], fn: (g: NodeInstance) => NodeInstance): GraphDoc {
  const rec = (nodes: NodeInstance[], i: number): NodeInstance[] =>
    nodes.map((n) => {
      if (n.id !== path[i] || n.type !== GROUP_TYPE) return n;
      if (i === path.length - 1) return fn(n);
      return { ...n, params: { ...n.params, nodes: rec(groupData(n).nodes, i + 1) } };
    });
  return { ...root, nodes: rec(root.nodes, 0) };
}

/** Pure: the document with the node at full path id `id` replaced by `fn(node)` (any depth). */
export function updateNodeAtPath(root: GraphDoc, id: string, fn: (n: NodeInstance) => NodeInstance): GraphDoc {
  const parts = id.split(PATH_SEP);
  if (parts.length === 1) return { ...root, nodes: root.nodes.map((n) => (n.id === id ? fn(n) : n)) };
  if (parts.some((p) => p.startsWith('~'))) return root; // a single pass of a Repeat has no node of its own
  const last = parts.pop()!;
  return updateGroupAt(root, parts, (g) => ({ ...g, params: { ...g.params, nodes: groupData(g).nodes.map((n) => (n.id === last ? fn(n) : n)) } }));
}

/** Every node id of the document at any depth, as full paths (groups included). */
export function allNodePaths(root: GraphDoc): string[] {
  const out: string[] = [];
  const walk = (nodes: NodeInstance[], prefix: string, depth: number) => {
    for (const n of nodes) {
      out.push(prefix + n.id);
      if (n.type === GROUP_TYPE && depth < GROUP_MAX_DEPTH) walk(groupData(n).nodes, prefix + n.id + PATH_SEP, depth + 1);
    }
  };
  walk(root.nodes, '', 0);
  return out;
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Group / ungroup                                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------------------ */

let seq = 0;
const freshId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(++seq).toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;

type DefLookup = (n: NodeInstance) => AnyNodeDef | undefined;

function portLabel(def: AnyNodeDef | undefined, port: string, dir: 'in' | 'out'): string {
  if (!def) return port;
  if (dir === 'out') return (def.outputs as Record<string, OutputDef>)[port]?.label ?? port;
  return (def.inputs as Record<string, InputDef>)[port]?.label ?? (def.params as Record<string, ParamDef>)[port]?.label ?? port;
}

/** Why these nodes cannot be grouped, or null. */
export function groupProblem(graph: GraphDoc, registry: Pick<Registry, 'get'>, ids: readonly string[]): string | null {
  const set = new Set(ids);
  const nodes = graph.nodes.filter((n) => set.has(n.id));
  if (!nodes.length) return 'Select the nodes to group first.';
  for (const n of nodes) {
    if (isBoundaryNode(n)) return 'The group input and output stay where they are: select only the nodes between them.';
    const def = defOf(registry, n);
    if (def?.category === 'output') return 'Output nodes stay outside groups (export looks for them at the top level).';
    if (def?.audio) return `"${n.label || def.title}" works on sound: audio and MIDI nodes cannot go in a group yet.`;
  }
  return null;
}

/**
 * Replace nodes `ids` by one group node wired identically: one input per distinct source outside that feeds the selection (named after
 * the first socket it feeds), one output per distinct inner output that feeds something outside (named after that output). Wires keep
 * their ids and their order. Inner node ids are kept, so seeds (and so the look) do not change. With no wire leaving the selection, the
 * first output of its last node becomes the group's output. Throws with a readable reason (see `groupProblem`).
 */
export function makeGroup(
  graph: GraphDoc,
  registry: Pick<Registry, 'get'>,
  ids: readonly string[],
  opts: { kind?: GroupKind; title?: string; id?: string } = {},
): { graph: GraphDoc; group: NodeInstance } {
  const problem = groupProblem(graph, registry, ids);
  if (problem) throw new Error(problem);
  const set = new Set(ids);
  const kind = opts.kind ?? 'group';
  const def: DefLookup = (n) => defOf(registry, n);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const inner = graph.nodes.filter((n) => set.has(n.id)).map((n) => ({ ...n, frame: undefined }));
  const gid = opts.id ?? freshId('g');
  const inputs: GroupPort[] = [];
  const outputs: GroupPort[] = [];
  const inBySrc = new Map<string, GroupPort>();
  const outBySrc = new Map<string, GroupPort>();
  const innerEdges: Edge[] = [];
  const outerEdges: Edge[] = [];
  const typeOfOut = (ref: PortRef): SocketType => ((def(byId.get(ref.node)!)?.outputs as Record<string, OutputDef> | undefined)?.[ref.port]?.type ?? 'image');
  for (const e of graph.edges) {
    const a = set.has(e.from.node);
    const b = set.has(e.to.node);
    if (a && b) innerEdges.push(e);
    else if (!a && b) {
      const key = `${e.from.node}\u0000${e.from.port}`;
      let p = inBySrc.get(key);
      if (!p) {
        p = { id: `in${inputs.length + 1}`, name: portLabel(def(byId.get(e.to.node)!), e.to.port, 'in'), type: typeOfOut(e.from) };
        inputs.push(p);
        inBySrc.set(key, p);
        outerEdges.push({ id: e.id, from: e.from, to: { node: gid, port: p.id } });
      }
      innerEdges.push({ id: e.id, from: { node: GROUP_IN, port: p.id }, to: e.to });
    } else if (a && !b) {
      const key = `${e.from.node}\u0000${e.from.port}`;
      let p = outBySrc.get(key);
      if (!p) {
        p = { id: `out${outputs.length + 1}`, name: portLabel(def(byId.get(e.from.node)!), e.from.port, 'out'), type: typeOfOut(e.from) };
        outputs.push(p);
        outBySrc.set(key, p);
        innerEdges.push({ id: freshId('e'), from: e.from, to: { node: GROUP_OUT, port: p.id } });
      }
      outerEdges.push({ ...e, from: { node: gid, port: p.id } });
    } else outerEdges.push(e);
  }
  if (!outputs.length) {
    // Nothing leaves: the last selected node that feeds nothing inside gives the group its output (so it can be viewed and used).
    const feeds = new Set(innerEdges.filter((e) => e.from.node !== GROUP_IN).map((e) => e.from.node));
    const sink = [...inner].reverse().find((n) => !feeds.has(n.id) && Object.keys(def(n)?.outputs ?? {}).length > 0) ?? [...inner].reverse().find((n) => Object.keys(def(n)?.outputs ?? {}).length > 0);
    const port = sink ? Object.keys(def(sink)!.outputs)[0] : undefined;
    if (sink && port) {
      const p: GroupPort = { id: 'out1', name: portLabel(def(sink), port, 'out'), type: typeOfOut({ node: sink.id, port }) };
      outputs.push(p);
      innerEdges.push({ id: freshId('e'), from: { node: sink.id, port }, to: { node: GROUP_OUT, port: p.id } });
    }
  }
  if (kind === 'repeat') {
    const loop = inputs.find((p) => p.type === 'image');
    if (loop) loop.loop = true;
  }
  const xs = inner.map((n) => n.x);
  const ys = inner.map((n) => n.y);
  const params: Record<string, unknown> = {
    kind,
    title: opts.title ?? (kind === 'repeat' ? 'Repeat' : 'Group'),
    nodes: inner,
    edges: innerEdges,
    inputs,
    outputs,
    exposed: [],
  };
  if (kind === 'repeat') Object.assign(params, { count: REPEAT_DEFAULT, mode: 'chain', blend: 'normal', opacity: 1 });
  const group: NodeInstance = { id: gid, type: GROUP_TYPE, x: Math.round(Math.min(...xs)), y: Math.round(Math.min(...ys)), params, collapsed: undefined };
  const kept = graph.nodes.filter((n) => !set.has(n.id));
  const usedFrames = new Set(kept.map((n) => n.frame).filter(Boolean));
  return {
    graph: { ...graph, nodes: [...kept, group], edges: outerEdges, frames: (graph.frames ?? []).filter((f) => usedFrames.has(f.id)) },
    group,
  };
}

/**
 * Put a group's inside back in its place: exposed values written into the inner params, wires into exposed sockets re-targeted to the
 * inner params, inner ids kept unless they clash with a node that exists (then renamed), inner positions moved so the inside starts where
 * the group node is. `makeGroup` then `ungroupNode` gives the original graph (up to new wire ids for re-targeted exposed wires).
 */
export function ungroupNode(graph: GraphDoc, groupId: string): { graph: GraphDoc; ids: string[] } {
  const g = graph.nodes.find((n) => n.id === groupId && n.type === GROUP_TYPE);
  if (!g) return { graph, ids: [] };
  const d = groupData(g);
  const taken = new Set(graph.nodes.filter((n) => n.id !== groupId).map((n) => n.id));
  const rename = new Map<string, string>();
  for (const n of d.nodes) rename.set(n.id, taken.has(n.id) ? freshId('n') : n.id);
  const nid = (id: string) => rename.get(id) ?? id;
  const xs = d.nodes.map((n) => n.x);
  const ys = d.nodes.map((n) => n.y);
  const dx = xs.length ? Math.round(g.x - Math.min(...xs)) : 0;
  const dy = ys.length ? Math.round(g.y - Math.min(...ys)) : 0;
  const values = new Map<string, Record<string, unknown>>();
  for (const x of d.exposed) {
    if (!(x.id in g.params)) continue;
    const o = values.get(x.node) ?? {};
    o[x.param] = structuredClone(g.params[x.id]);
    values.set(x.node, o);
  }
  const nodes = d.nodes.map((n) => ({ ...n, id: nid(n.id), x: n.x + dx, y: n.y + dy, frame: g.frame, params: values.has(n.id) ? { ...n.params, ...values.get(n.id) } : n.params }));
  const into = graph.edges.filter((e) => e.to.node === groupId);
  const source = (port: string): PortRef | null => {
    let last: Edge | undefined;
    for (const e of into) if (e.to.port === port) last = e;
    return last ? last.from : null;
  };
  const innerSource = (ref: PortRef): PortRef | null => (ref.node === GROUP_IN ? source(ref.port) : { node: nid(ref.node), port: ref.port });
  const outputSource = new Map<string, PortRef | null>();
  for (const e of d.edges) if (e.to.node === GROUP_OUT) outputSource.set(e.to.port, innerSource(e.from));
  const edges: Edge[] = [];
  for (const e of graph.edges) {
    if (e.to.node === groupId) continue;
    if (e.from.node === groupId) {
      const src = outputSource.get(e.from.port);
      if (src) edges.push({ ...e, from: src });
      continue;
    }
    edges.push(e);
  }
  for (const e of d.edges) {
    if (e.to.node === GROUP_OUT) continue;
    const src = innerSource(e.from);
    if (src) edges.push({ ...e, from: src, to: { node: nid(e.to.node), port: e.to.port } });
  }
  for (const x of d.exposed) {
    const src = source(x.id);
    if (src) edges.push({ id: freshId('e'), from: src, to: { node: nid(x.node), port: x.param } });
  }
  return { graph: { ...graph, nodes: [...graph.nodes.filter((n) => n.id !== groupId), ...nodes], edges }, ids: nodes.map((n) => n.id) };
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Exposed params                                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** Params of the inner nodes that can be exposed on the group (every param type; sockets come with number / color / palette). */
export function exposableParams(group: NodeInstance, registry: Pick<Registry, 'get'>): { node: string; nodeLabel: string; param: string; label: string; def: ParamDef }[] {
  const d = groupData(group);
  const out: { node: string; nodeLabel: string; param: string; label: string; def: ParamDef }[] = [];
  for (const n of d.nodes) {
    const def = defOf(registry, n);
    if (!def) continue;
    for (const [key, p] of Object.entries(def.params as Record<string, ParamDef>)) {
      if (p.visibleIf && (p as { visibleIf: (x: Record<string, unknown>) => boolean }).visibleIf.length === 0) {
        try {
          if (!(p.visibleIf as () => boolean)()) continue; // permanently hidden params (handles, internal state)
        } catch {
          /* show it */
        }
      }
      if (key === PROCESS_PARAM) continue;
      out.push({ node: n.id, nodeLabel: n.label || def.title, param: key, label: p.label ?? key, def: p });
    }
  }
  return out;
}

/** Pure: the group with inner param `node.param` exposed under a fresh id (its current value copied onto the group). */
export function exposeParam(graph: GraphDoc, groupId: string, node: string, param: string, registry: Pick<Registry, 'get'>, label?: string): GraphDoc {
  const g = graph.nodes.find((n) => n.id === groupId && n.type === GROUP_TYPE);
  if (!g) return graph;
  const d = groupData(g);
  if (d.exposed.some((x) => x.node === node && x.param === param)) return graph;
  const inner = d.nodes.find((n) => n.id === node);
  const pdef = inner && (defOf(registry, inner)?.params as Record<string, ParamDef> | undefined)?.[param];
  if (!inner || !pdef) throw new Error('That parameter does not exist inside this group.');
  let k = d.exposed.length + 1;
  const used = new Set([...d.exposed.map((x) => x.id), ...d.inputs.map((p) => p.id), ...d.outputs.map((p) => p.id), ...GROUP_KEYS]);
  while (used.has(`x${k}`)) k++;
  const id = `x${k}`;
  const x: GroupExposed = { id, label: (label ?? pdef.label ?? param).slice(0, 24), node, param, def: snapshotParamDef(pdef) };
  const value = inner.params[param] === undefined ? structuredClone(pdef.default) : structuredClone(inner.params[param]);
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === groupId ? { ...n, params: { ...n.params, exposed: [...d.exposed, x], [id]: value } } : n)) };
}

/** Pure: stop exposing `exposedId`. Its current value is written back into the inner node, and wires into its socket are removed. */
export function unexposeParam(graph: GraphDoc, groupId: string, exposedId: string): GraphDoc {
  const g = graph.nodes.find((n) => n.id === groupId && n.type === GROUP_TYPE);
  if (!g) return graph;
  const d = groupData(g);
  const x = d.exposed.find((e) => e.id === exposedId);
  if (!x) return graph;
  const params = { ...g.params, exposed: d.exposed.filter((e) => e.id !== exposedId) } as Record<string, unknown>;
  const value = g.params[exposedId];
  delete params[exposedId];
  if (value !== undefined) params.nodes = d.nodes.map((n) => (n.id === x.node ? { ...n, params: { ...n.params, [x.param]: value } } : n));
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === groupId ? { ...n, params } : n)),
    edges: graph.edges.filter((e) => !(e.to.node === groupId && e.to.port === exposedId)),
  };
}

/** Pure: rename / reorder exposed params (`order` = exposed ids in the new order; missing ids keep their place at the end). */
export function editExposed(graph: GraphDoc, groupId: string, patch: { rename?: Record<string, string>; order?: string[] }): GraphDoc {
  const g = graph.nodes.find((n) => n.id === groupId && n.type === GROUP_TYPE);
  if (!g) return graph;
  let list = groupData(g).exposed.map((x) => (patch.rename?.[x.id] !== undefined ? { ...x, label: patch.rename[x.id].trim().slice(0, 24) || x.label } : x));
  if (patch.order) {
    const rank = new Map(patch.order.map((id, i) => [id, i]));
    list = [...list].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9));
  }
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === groupId ? { ...n, params: { ...n.params, exposed: list } } : n)) };
}

/**
 * Pure, on an open group's level: add a port to a boundary node (`@in` gets an input, `@out` an output) and return its id. The port
 * is written back into the group by `withLevel`.
 */
export function addBoundaryPort(level: GraphDoc, side: 'in' | 'out', type: SocketType, name: string): { graph: GraphDoc; port: string } {
  const id = side === 'in' ? GROUP_IN : GROUP_OUT;
  const b = level.nodes.find((n) => n.id === id);
  if (!b) throw new Error('Open a group first.');
  const ports = arr<GroupPort>(b.params.ports);
  const prefix = side === 'in' ? 'in' : 'out';
  let k = ports.length + 1;
  const used = new Set(ports.map((p) => p.id));
  while (used.has(`${prefix}${k}`)) k++;
  const port: GroupPort = { id: `${prefix}${k}`, name: name.slice(0, 24) || (side === 'in' ? 'Input' : 'Output'), type };
  return { graph: { ...level, nodes: level.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, ports: [...ports, port] } } : n)) }, port: port.id };
}

/** Pure, on an open group's level: remove a port of a boundary node and its wires inside (the group's wires outside go when written back). */
export function removeBoundaryPort(level: GraphDoc, side: 'in' | 'out', portId: string): GraphDoc {
  const id = side === 'in' ? GROUP_IN : GROUP_OUT;
  return {
    ...level,
    nodes: level.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, ports: arr<GroupPort>(n.params.ports).filter((p) => p.id !== portId) } } : n)),
    edges: level.edges.filter((e) => !(side === 'in' ? e.from.node === id && e.from.port === portId : e.to.node === id && e.to.port === portId)),
  };
}

/** Pure: rename a group port. */
export function renameGroupPort(graph: GraphDoc, groupId: string, dir: 'in' | 'out', portId: string, name: string): GraphDoc {
  const g = graph.nodes.find((n) => n.id === groupId && n.type === GROUP_TYPE);
  if (!g) return graph;
  const key = dir === 'in' ? 'inputs' : 'outputs';
  const list = (groupData(g)[key] as GroupPort[]).map((p) => (p.id === portId ? { ...p, name: name.trim().slice(0, 24) || p.name } : p));
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === groupId ? { ...n, params: { ...n.params, [key]: list } } : n)) };
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Copies: a copy never shares a stored process result                                                                              */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/**
 * A copy of a node (duplicate, paste, a preset) must start unprocessed: its stored result belongs to the original (the store is owned by the
 * original node id, and clearing one would break the other). Strips the result handle of the node and of everything inside it.
 * `clearOf(type)` gives the params patch that clears a node type's handle (`processParamsPatch(def, null)`), or null for types without a process.
 */
export function withoutProcessResults(node: NodeInstance, clearOf: (n: NodeInstance) => Record<string, unknown> | null): NodeInstance {
  let params = node.params;
  const patch = clearOf(node);
  if (patch) params = { ...params, ...patch };
  if (node.type === GROUP_TYPE) {
    const d = groupData(node);
    params = { ...params, nodes: d.nodes.map((n) => withoutProcessResults(n, clearOf)) };
    delete (params as Record<string, unknown>)[PROCESS_PARAM];
  }
  return params === node.params ? node : { ...node, params };
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Validation (imported group files)                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** Problems of a group node that came from outside (a file): unknown types, depth, ports, sizes. Empty = fine. Data only: nothing is run. */
export function validateGroupNode(node: unknown, registry: Pick<Registry, 'get'>, depth = 0): string[] {
  const problems: string[] = [];
  if (!node || typeof node !== 'object') return ['not a node'];
  const n = node as NodeInstance;
  if (n.type !== GROUP_TYPE) return ['not a group node'];
  if (!n.params || typeof n.params !== 'object') return ['the group has no contents'];
  if (depth >= GROUP_MAX_DEPTH) return [`groups are nested more than ${GROUP_MAX_DEPTH} levels deep`];
  const d = groupData(n);
  if (!Array.isArray(n.params.nodes) || !Array.isArray(n.params.edges)) problems.push('the group has no node or wire list');
  const ids = new Set<string>();
  for (const inner of d.nodes) {
    if (!inner || typeof inner !== 'object' || typeof inner.id !== 'string' || typeof inner.type !== 'string') {
      problems.push('a node inside is damaged');
      continue;
    }
    if (inner.id.includes(PATH_SEP) || inner.id.startsWith('@')) problems.push(`node id "${inner.id}" is not allowed`);
    if (ids.has(inner.id)) problems.push(`node id "${inner.id}" is used twice`);
    ids.add(inner.id);
    if (inner.type === GROUP_TYPE) problems.push(...validateGroupNode(inner, registry, depth + 1));
    else if (!registry.get(inner.type)) problems.push(`unknown node type "${inner.type}" (missing plugin?)`);
    if (!inner.params || typeof inner.params !== 'object') problems.push(`node "${inner.id}" has no params`);
  }
  const ports = new Set<string>();
  for (const p of [...d.inputs, ...d.outputs]) {
    if (!p || typeof p.id !== 'string' || !SOCKETS.includes(p.type)) problems.push('a port of the group is damaged');
    else if (ports.has(p.id) || GROUP_KEYS.includes(p.id)) problems.push(`port id "${p.id}" is not allowed`);
    else ports.add(p.id);
  }
  for (const e of d.edges) {
    if (!e || !e.from || !e.to) {
      problems.push('a wire inside is damaged');
      continue;
    }
    if (e.from.node !== GROUP_IN && !ids.has(e.from.node)) problems.push(`a wire starts at a missing node "${e.from.node}"`);
    if (e.to.node !== GROUP_OUT && !ids.has(e.to.node)) problems.push(`a wire ends at a missing node "${e.to.node}"`);
  }
  for (const x of d.exposed) {
    if (!x || typeof x.id !== 'string' || !ids.has(x.node) || typeof x.param !== 'string' || !x.def || typeof x.def !== 'object') problems.push('an exposed parameter is damaged');
    else if (GROUP_KEYS.includes(x.id) || ports.has(x.id)) problems.push(`exposed id "${x.id}" is not allowed`);
  }
  return [...new Set(problems)];
}

/** Stable text of a group's definition (no positions, no stored results): equal for equal insides. */
export function groupFingerprint(node: NodeInstance): string {
  const d = groupData(node);
  return stableStringify({ ...d, ui: undefined, nodes: d.nodes.map((n) => ({ id: n.id, type: n.type, params: n.params, bypass: n.bypass })) });
}
