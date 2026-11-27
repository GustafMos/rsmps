/**
 * "How to use" for a node: what it does, what to wire where, and a to-do for every required input that is still empty, each with a
 * button that fixes it where a sensible automatic fix exists. Pure: the Inspector and the node itself only draw what this returns.
 *
 * The engine skips a node whose required input is empty (it makes nothing and says nothing). This is where that is said in words.
 */
import { defOf } from '../../engine/group';
import { addNode, connect, connectError } from '../../engine/graph';
import type { Registry } from '../../engine/define';
import type { AnyNodeDef, Edge, GraphDoc, InputSchema, OutputSchema, SocketType } from '../../engine/types';
import { layoutFor, NODE_W } from './layout';

/** What a socket type is called in plain words. */
export const TYPE_WORDS: Partial<Record<SocketType, string>> = {
  image: 'a picture',
  regions: 'regions',
  mask: 'a mask',
  number: 'a number',
  audio: 'a sound',
  palette: 'a palette',
};
const word = (t: SocketType) => TYPE_WORDS[t] ?? `a ${t}`;

export interface MissingInput {
  port: string;
  label: string;
  type: SocketType;
}

/** Required inputs with no wire. `wired` = ports that have a wire (what the node view already knows). */
export function missingInputs(def: AnyNodeDef | undefined, wired: ReadonlySet<string>): MissingInput[] {
  if (!def) return [];
  const out: MissingInput[] = [];
  for (const [port, d] of Object.entries(def.inputs as InputSchema)) {
    if (d.required && !wired.has(port)) out.push({ port, label: d.label ?? port, type: d.type });
  }
  return out;
}

/** "Needs a picture and regions" for the node's summary line, or null when every required input is wired. */
export function needsLine(def: AnyNodeDef | undefined, wired: ReadonlySet<string>): string | null {
  const m = missingInputs(def, wired);
  if (!m.length) return null;
  const parts = m.map((x) => word(x.type).replace(/^an? /, ''));
  const uniq = parts.filter((p, i) => parts.indexOf(p) === i);
  return `Needs ${uniq.length === 1 ? uniq[0] : `${uniq.slice(0, -1).join(', ')} and ${uniq[uniq.length - 1]}`}`;
}

/** The small tag beside an empty required socket on the node (the words are in its tooltip and on the node's summary line). */
export function socketHint(_type: SocketType): string {
  return 'needed';
}

/** The line shown on the node and in the phone list: the problem in words when something is missing, else the node's own summary. */
export function summaryLine(def: AnyNodeDef | undefined, params: Record<string, unknown>, wired: ReadonlySet<string>, clock?: Parameters<NonNullable<AnyNodeDef['summary']>>[2]): string {
  const need = needsLine(def, wired);
  if (need) return need;
  return def?.summary ? def.summary(params, wired, clock) : '';
}

export type GuideFix =
  /** Add a node of this type next to the node and wire its output into the empty input (fed by the node's own picture where it takes one). */
  | { kind: 'add'; label: string; type: string }
  /** Wire the picture that is being viewed into the empty input. */
  | { kind: 'viewed'; label: string; from: Edge['from'] }
  /** Open the Add menu with only the nodes that can fill this input. */
  | { kind: 'menu'; label: string };

export interface GuideTodo {
  input: string;
  label: string;
  type: SocketType;
  hint: string;
  fixes: GuideFix[];
}

export interface GuideView {
  does: string;
  steps: string[];
  todos: GuideTodo[];
  /** Open while something needed is still unwired. */
  open: boolean;
  seeAlso: { id: string; title: string }[];
}

/** The picture feeding the node: the first wired input of type image (the main one first), as the output that feeds it. */
function pictureSource(g: GraphDoc, def: AnyNodeDef, nodeId: string): Edge['from'] | null {
  const ports = Object.entries(def.inputs as InputSchema).filter(([, d]) => d.type === 'image' && !d.multi).map(([p]) => p);
  ports.sort((a, b) => (a === 'image' ? -1 : b === 'image' ? 1 : 0));
  for (const p of ports) {
    const e = g.edges.find((x) => x.to.node === nodeId && x.to.port === p);
    if (e) return e.from;
  }
  return null;
}

/** Detectors offered for an empty Regions input. */
const DETECTORS = [
  { type: 'detect-blobs', label: 'Add Detect Blobs' },
  { type: 'detect-motion', label: 'Add Detect Motion' },
];

export function guideView(g: GraphDoc, registry: Registry, nodeId: string, viewedId?: string | null): GuideView | null {
  const node = g.nodes.find((n) => n.id === nodeId);
  const def = node && defOf(registry, node);
  if (!node || !def?.guide) return null;
  const wired = new Set(g.edges.filter((e) => e.to.node === nodeId).map((e) => e.to.port));
  const needsByPort = new Map((def.guide.needs ?? []).map((n) => [n.input, n.hint] as const));
  // required inputs, plus the ones the guide names as needed (a node can do nothing useful without them even when the engine does not insist)
  const empty = [...missingInputs(def, wired)];
  for (const n of def.guide.needs ?? []) {
    const d = (def.inputs as InputSchema)[n.input];
    if (d && !wired.has(n.input) && !empty.some((m) => m.port === n.input)) empty.push({ port: n.input, label: d.label ?? n.input, type: d.type });
  }
  const todos: GuideTodo[] = empty.map((m) => {
    const fixes: GuideFix[] = [];
    if (m.type === 'regions') for (const d of DETECTORS) if (registry.get(d.type)) fixes.push({ kind: 'add', label: d.label, type: d.type });
    const vn = m.type === 'image' && viewedId && viewedId !== nodeId ? g.nodes.find((n) => n.id === viewedId) : undefined;
    const vd = vn && defOf(registry, vn);
    const vPort = vd && Object.entries(vd.outputs as OutputSchema).find(([, o]) => o.type === 'image')?.[0];
    if (vn && vPort && !connectError(g, registry, { node: vn.id, port: vPort }, { node: nodeId, port: m.port })) {
      fixes.push({ kind: 'viewed', label: `Use ${vn.label || vd.title}`, from: { node: vn.id, port: vPort } });
    }
    fixes.push({ kind: 'menu', label: m.type === 'image' ? 'Pick a picture node' : 'Choose a node…' });
    return { input: m.port, label: m.label, type: m.type, hint: needsByPort.get(m.port) ?? `${m.label} needs ${word(m.type)}.`, fixes };
  });
  return {
    does: def.guide.does,
    steps: def.guide.steps,
    todos,
    open: todos.length > 0,
    seeAlso: (def.guide.seeAlso ?? []).flatMap((id) => {
      const t = registry.get(id)?.title;
      return t ? [{ id, title: t }] : [];
    }),
  };
}

/**
 * Apply a fix from `guideView`. Returns the new graph (and the id of a node it added), or null when it cannot be done.
 * The caller commits it as ONE undo step. 'menu' fixes are the caller's (they open the Add menu).
 */
export function applyGuideFix(g: GraphDoc, registry: Registry, nodeId: string, input: string, fix: GuideFix): { graph: GraphDoc; added?: string } | null {
  const node = g.nodes.find((n) => n.id === nodeId);
  const def = node && defOf(registry, node);
  if (!node || !def) return null;
  const to = { node: nodeId, port: input };
  if (fix.kind === 'viewed') {
    return connectError(g, registry, fix.from, to) ? null : { graph: connect(g, registry, fix.from, to) };
  }
  if (fix.kind !== 'add') return null;
  const ndef = registry.get(fix.type);
  if (!ndef) return null;
  const pic = pictureSource(g, def, nodeId);
  // below and to the left of the node, so nothing sits on top of anything else
  const h = layoutFor(g, node, def).height;
  const at = { x: Math.round(node.x - NODE_W - 60), y: Math.round(node.y + h + 40) };
  const added = addNode(g, registry, fix.type, at);
  let next = added.graph;
  const inPort = Object.entries(ndef.inputs as InputSchema).find(([, d]) => d.type === 'image' && d.required)?.[0];
  if (pic && inPort && !connectError(next, registry, pic, { node: added.node.id, port: inPort })) next = connect(next, registry, pic, { node: added.node.id, port: inPort });
  const outPort = Object.keys(ndef.outputs).find((p) => !connectError(next, registry, { node: added.node.id, port: p }, to));
  if (!outPort) return null;
  next = connect(next, registry, { node: added.node.id, port: outPort }, to);
  return { graph: next, added: added.node.id };
}
