/**
 * One-step "Regions" setups: from a picture node, build and wire the whole chain (detector, Track, then Effects On Regions or Region Overlay).
 * Pure: it adds the nodes and their wires and says which wires of the picture node the last node should take over;
 * the editor splices the chain in (as every "insert after" does), selects it and views it, as ONE undo step.
 */
import { defOf } from '../../engine/group';
import { addNode, connect } from '../../engine/graph';
import type { Registry } from '../../engine/define';
import type { Edge, GraphDoc, OutputSchema } from '../../engine/types';
import { layoutFor, NODE_W } from './layout';

export type RegionsSetupId = 'moving' | 'bright' | 'boxes' | 'except';

export interface RegionsSetupInfo {
  id: RegionsSetupId;
  label: string;
  hint: string;
  /** Detector, then Track, then this. */
  detector: string;
  last: string;
  lastParams: Record<string, unknown>;
}

export const REGIONS_SETUPS: readonly RegionsSetupInfo[] = [
  { id: 'moving', label: 'Effect on moving things', hint: 'Pixelates whatever moves. Detect Motion, Track, Effects On Regions.', detector: 'detect-motion', last: 'region-fx', lastParams: {} },
  { id: 'bright', label: 'Effect on bright or colored things', hint: 'Pixelates bright spots. Detect Blobs, Track, Effects On Regions. Swap in Detect Color for one color.', detector: 'detect-blobs', last: 'region-fx', lastParams: {} },
  { id: 'boxes', label: 'Boxes and labels on things', hint: 'Draws a box and a label on whatever moves. Detect Motion, Track, Region Overlay.', detector: 'detect-motion', last: 'region-overlay', lastParams: { showLabel: true } },
  { id: 'except', label: 'Blur everything except the things', hint: 'Keeps the moving things sharp and blurs the rest. Turn Invert off to blur the things instead.', detector: 'detect-motion', last: 'region-fx', lastParams: { invert: true, fxA: 'blur', amtA: 0.7 } },
];

/** The picture output of a node, or null when it has none (then the setups are not offered). */
export function pictureOutput(g: GraphDoc, registry: Registry, nodeId: string): string | null {
  const node = g.nodes.find((n) => n.id === nodeId);
  const def = node && defOf(registry, node);
  if (!def) return null;
  return Object.entries(def.outputs as OutputSchema).find(([, o]) => o.type === 'image')?.[0] ?? null;
}

export function regionsSetupAvailable(g: GraphDoc, registry: Registry, nodeId: string): boolean {
  return !!pictureOutput(g, registry, nodeId) && !!registry.get('track') && REGIONS_SETUPS.every((s) => registry.get(s.detector) && registry.get(s.last));
}

export interface RegionsSetupResult {
  graph: GraphDoc;
  /** The node to select and view. */
  main: string;
  /** The picture node's output and the wires that left it before the setup: the main node takes them over. */
  from: Edge['from'];
  downstream: Edge[];
  /** Where the main node goes (left to right after Track). */
  place: { x: number; y: number };
}

const GAP = 60;

export function buildRegionsSetup(g: GraphDoc, registry: Registry, srcId: string, id: RegionsSetupId): RegionsSetupResult | null {
  const info = REGIONS_SETUPS.find((s) => s.id === id);
  const src = g.nodes.find((n) => n.id === srcId);
  const outPort = pictureOutput(g, registry, srcId);
  if (!info || !src || !outPort || !regionsSetupAvailable(g, registry, srcId)) return null;
  const from = { node: srcId, port: outPort };
  const downstream = g.edges.filter((e) => e.from.node === from.node && e.from.port === from.port);
  const srcW = layoutFor(g, src, defOf(registry, src)).width;
  const x0 = src.x + srcW + GAP;
  const y = src.y;
  let next = g;
  const add = (type: string, x: number, params: Record<string, unknown> = {}) => {
    const r = addNode(next, registry, type, { x: Math.round(x), y: Math.round(y) }, params);
    next = r.graph;
    return r.node.id;
  };
  const det = add(info.detector, x0);
  const trk = add('track', x0 + NODE_W + GAP);
  const place = { x: x0 + 2 * (NODE_W + GAP), y };
  const last = add(info.last, place.x, info.lastParams);
  next = connect(next, registry, from, { node: det, port: 'image' });
  next = connect(next, registry, { node: det, port: 'regions' }, { node: trk, port: 'regions' });
  next = connect(next, registry, { node: trk, port: 'regions' }, { node: last, port: 'regions' });
  next = connect(next, registry, from, { node: last, port: 'image' });
  return { graph: next, main: last, from, downstream, place };
}
