/**
 * "React to sound": wire a number setting to the music in one step.
 * Pure graph edits (built with the helpers in engine/graph.ts); the UI commits the result through the editor's `edit`, so the whole
 * thing is ONE undo step. The patch is: [sound source] -> Beat Detect -> Remap Range -> [the setting].
 * The Remap's "To min" is the setting's value when the sound is silent (the current value, so the look does not jump) and "To max"
 * is how far it goes at full strength.
 */
import type { Registry } from '../../engine/define';
import { addNode, connect, removeNodes, setParam } from '../../engine/graph';
import { defaultRange, shapeOf } from '../../engine/lib/midi-map';
import type { AnyNodeDef, GraphDoc, NodeInstance, ParamDef } from '../../engine/types';

export type ReactFeature = 'level' | 'onset' | 'beat' | 'kick' | 'snare' | 'hat' | 'phase';

export const REACT_FEATURES: { id: ReactFeature; label: string; hint: string }[] = [
  { id: 'level', label: 'Loudness', hint: 'Follows how loud the sound is.' },
  { id: 'beat', label: 'Beat pulse', hint: 'Jumps on every beat and fades.' },
  { id: 'kick', label: 'Kick', hint: 'Jumps on every bass drum hit.' },
  { id: 'snare', label: 'Snare', hint: 'Jumps on every snare hit.' },
  { id: 'hat', label: 'Hat', hint: 'Jumps on every hi-hat tick.' },
  { id: 'onset', label: 'Any hit', hint: 'Jumps on every sharp sound.' },
  { id: 'phase', label: 'Beat ramp', hint: 'Rises from the base value to the top once per beat.' },
];

export const REACT_LABEL_PREFIX = 'React: ';
const AUTO_BEAT_LABEL = 'Auto Beat Detect';

export interface SoundSource {
  node: string;
  port: string;
  label: string;
}

const defOf = (registry: Registry, n: NodeInstance): AnyNodeDef | undefined => registry.get(n.type);
const nodeLabel = (n: NodeInstance, def?: AnyNodeDef): string => n.label || def?.title || n.type;

/** Where the project's sound comes from, best first: what feeds the Audio Output, else Media In with sound, Audio Timeline, Audio File, Microphone. */
export function soundSources(graph: GraphDoc, registry: Registry): SoundSource[] {
  const out: SoundSource[] = [];
  const add = (node: string, port: string) => {
    if (out.some((s) => s.node === node && s.port === port)) return;
    const n = graph.nodes.find((x) => x.id === node);
    const def = n && defOf(registry, n);
    if (!n || !def || def.id === 'beat-detect' || !(def.outputs as Record<string, { type: string }>)[port]) return;
    out.push({ node, port, label: nodeLabel(n, def) });
  };
  for (const e of graph.edges) {
    const to = graph.nodes.find((n) => n.id === e.to.node);
    if (to?.type === 'audio-out') add(e.from.node, e.from.port);
  }
  if (out.length) return out;
  for (const [type, port] of [['media-in', 'audio'], ['audio-timeline', 'audio'], ['audio-file', 'audio'], ['microphone', 'tap']] as const) {
    for (const n of graph.nodes) if (n.type === type && n.params.mute !== true) add(n.id, port);
  }
  return out;
}

export interface Reaction {
  remap: NodeInstance;
  beat: NodeInstance | null;
  feature: ReactFeature | null;
  /** Sound source node, when still wired. */
  source: string | null;
}

/** The reaction that currently drives a setting, or null. */
export function reactionOf(graph: GraphDoc, nodeId: string, param: string): Reaction | null {
  const into = graph.edges.find((e) => e.to.node === nodeId && e.to.port === param);
  const remap = into && graph.nodes.find((n) => n.id === into.from.node);
  if (!remap || remap.type !== 'remap' || !remap.label?.startsWith(REACT_LABEL_PREFIX)) return null;
  const feed = graph.edges.find((e) => e.to.node === remap.id && e.to.port === 'value');
  const beat = feed && graph.nodes.find((n) => n.id === feed.from.node && n.type === 'beat-detect');
  const feature = REACT_FEATURES.find((f) => f.id === feed?.from.port)?.id ?? null;
  const src = beat && graph.edges.find((e) => e.to.node === beat.id && e.to.port === 'audio');
  return { remap, beat: beat ?? null, feature, source: src?.from.node ?? null };
}

/** Base value and how far to go, from the setting's current value and range: stays inside the setting's limits. */
export function defaultSwing(def: ParamDef, current: unknown): { base: number; top: number } | null {
  const shape = shapeOf(def);
  if (!shape || shape.type !== 'number') return null;
  const range = defaultRange(shape);
  const base = typeof current === 'number' && Number.isFinite(current) ? current : (def as { default: number }).default;
  const span = Math.max(1e-6, range.max - range.min);
  const outside = base < range.min || base > range.max;
  const amount = outside ? Math.max(span * 0.25, Math.abs(base) * 0.5) : span * 0.25;
  const ceiling = Math.min(shape.max, Math.max(range.max, base));
  let top = base + amount;
  if (top > ceiling) top = base - amount; // no room above: swing downwards
  top = Math.min(shape.max, Math.max(shape.min, top));
  const round = (v: number) => (shape.integer ? Math.round(v) : Number(v.toPrecision(4)));
  return { base: round(base), top: round(top) };
}

export interface ReactOptions {
  node: string;
  param: string;
  feature: ReactFeature;
  source: { node: string; port: string };
  /** Override the swing (value at silence, value at full strength). */
  base?: number;
  top?: number;
}

export interface ReactResult {
  graph: GraphDoc;
  beat: string;
  remap: string;
}

/** Remove a reaction (and the Beat Detect it created, when nothing else uses it); the setting goes back to its base value. */
export function stopReacting(graph: GraphDoc, registry: Registry, nodeId: string, param: string): GraphDoc {
  const r = reactionOf(graph, nodeId, param);
  if (!r) return graph;
  const base = r.remap.params.toMin;
  let g = removeNodes(graph, registry, [r.remap.id], false);
  if (r.beat && r.beat.label === AUTO_BEAT_LABEL && !g.edges.some((e) => e.from.node === r.beat!.id)) g = removeNodes(g, registry, [r.beat.id], false);
  if (typeof base === 'number') g = setParam(g, nodeId, param, base);
  return g;
}

/** Build the patch. Throws a plain message when it cannot (not a number setting, source missing). */
export function reactPatch(graph: GraphDoc, registry: Registry, o: ReactOptions): ReactResult {
  const target = graph.nodes.find((n) => n.id === o.node);
  const tdef = target && defOf(registry, target);
  const pdef = tdef && ((tdef.params as Record<string, ParamDef>)[o.param] as ParamDef | undefined);
  if (!target || !tdef || !pdef) throw new Error('That setting is gone.');
  if (pdef.type !== 'number') throw new Error('Only number settings can react to sound.');
  if (!graph.nodes.some((n) => n.id === o.source.node)) throw new Error('The sound source is gone.');
  let g = stopReacting(graph, registry, o.node, o.param);
  const t = g.nodes.find((n) => n.id === o.node)!;
  const swing = defaultSwing(pdef, t.params[o.param] ?? pdef.default)!;
  const base = o.base ?? swing.base;
  const top = o.top ?? swing.top;
  // reuse a Beat Detect that already listens to this source
  let beat = g.nodes.find((n) => n.type === 'beat-detect' && g.edges.some((e) => e.to.node === n.id && e.to.port === 'audio' && e.from.node === o.source.node && e.from.port === o.source.port));
  if (!beat) {
    const made = addNode(g, registry, 'beat-detect', { x: t.x - 560, y: t.y }, {});
    g = made.graph;
    beat = { ...made.node, label: AUTO_BEAT_LABEL };
    g = { ...g, nodes: g.nodes.map((n) => (n.id === beat!.id ? beat! : n)) };
    g = connect(g, registry, { node: o.source.node, port: o.source.port }, { node: beat.id, port: 'audio' });
  }
  const label = REACT_FEATURES.find((f) => f.id === o.feature)?.label ?? o.feature;
  const made = addNode(g, registry, 'remap', { x: t.x - 280, y: t.y }, { fromMin: 0, fromMax: 1, toMin: base, toMax: top, clamp: true });
  g = made.graph;
  const remap: NodeInstance = { ...made.node, label: `${REACT_LABEL_PREFIX}${label}` };
  g = { ...g, nodes: g.nodes.map((n) => (n.id === remap.id ? remap : n)) };
  g = connect(g, registry, { node: beat.id, port: o.feature }, { node: remap.id, port: 'value' });
  g = connect(g, registry, { node: remap.id, port: 'value' }, { node: o.node, port: o.param });
  return { graph: g, beat: beat.id, remap: remap.id };
}
