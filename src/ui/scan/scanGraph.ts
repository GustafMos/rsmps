import { addNode, connect, createGraph } from '../../engine/graph';
import type { Registry } from '../../engine/define';
import type { AssetInfo, GraphDoc, InputSchema } from '../../engine/types';
import { sourceDefFor } from '../lib/sockets';

/** What the printed sheets looked like, stored on the hidden working sequence by `io.scan.attach`. */
export interface PrintGuideInfo {
  mode: 'full' | 'faded' | 'outline' | 'blank';
  opacity: number;
  blue: boolean;
}

export const printGuideOf = (a: AssetInfo | undefined): PrintGuideInfo | null => ((a as { printGuide?: PrintGuideInfo } | undefined)?.printGuide ?? null);
export const layerOf = (a: AssetInfo): number => (a as { layer?: number }).layer ?? 0;

/** The "Keep only what I drew" step for sheets that were printed with a guide picture, or null when there is nothing to remove. */
export function guideRemovalStep(registry: Registry, a: AssetInfo | undefined): { id: string; label: string; params: Record<string, unknown> } | null {
  const g = printGuideOf(a);
  if (!g || g.mode === 'full' || g.mode === 'blank' || !registry.get('remove-guide')) return null;
  return {
    id: 'remove-guide',
    label: 'Keep only what I drew',
    params: { guide: g.blue ? 'blue' : g.mode === 'faded' ? 'faint' : 'outline', strength: Math.max(0.05, Math.min(1, g.opacity / 100)) },
  };
}

/**
 * Scan project graph for sheets with several paper layers: one "Scanned frames N" source per layer, each through
 * Keep-only-what-I-drew (when the guide was printed) and Paper Clean set to ink on transparent, then a Stack (layer 1 at the
 * bottom) and the Export output. Returns null when the needed node types are missing.
 */
export function buildLayeredScanGraph(registry: Registry, name: string, assets: AssetInfo[]): GraphDoc | null {
  const sorted = [...assets].sort((a, b) => layerOf(a) - layerOf(b));
  const first = sorted[0];
  const src = first && sourceDefFor(registry, first.kind === 'image' ? 'image' : 'video');
  const stack = registry.get('stack');
  const out = registry.list().find((d) => d.category === 'output' && (d.params as Record<string, { type: string }>).kind?.type === 'enum' && 'codec' in d.params);
  if (!first || !src || !stack || !out) return null;
  let g = createGraph(name);
  g = { ...g, project: { ...g.project, width: first.width, height: first.height, fps: first.fps || 12, duration: Math.max(...sorted.map((a) => a.duration)) || g.project.duration, loop: false } };
  const label = (id: string, l: string) => {
    g = { ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, label: l } : n)) };
  };
  const portIn = (type: string) => Object.keys(registry.get(type)!.inputs).find((k) => ((registry.get(type)!.inputs as InputSchema)[k].type === 'image'))!;
  const stackAdded = addNode(g, registry, 'stack', { x: 840, y: 60 * sorted.length }, {});
  g = stackAdded.graph;
  label(stackAdded.node.id, 'Stack layers');
  sorted.forEach((asset, i) => {
    const y = i * 170;
    let x = 0;
    const chain: { id: string; label: string; params: Record<string, unknown> }[] = [{ id: src.def.id, label: `Scanned frames ${i + 1}`, params: { [src.key]: [asset.id] } }];
    const rm = guideRemovalStep(registry, asset);
    if (rm) chain.push(rm);
    if (registry.get('paper-clean')) chain.push({ id: 'paper-clean', label: `Ink to alpha ${i + 1}`, params: { output: 'ink' } });
    let prev: { node: string; port: string } | null = null;
    for (const c of chain) {
      const added = addNode(g, registry, c.id, { x, y }, c.params);
      g = added.graph;
      label(added.node.id, c.label);
      const d = registry.get(c.id)!;
      if (prev) g = connect(g, registry, prev, { node: added.node.id, port: portIn(c.id) });
      prev = { node: added.node.id, port: Object.keys(d.outputs)[0] };
      x += 270;
    }
    g = connect(g, registry, prev!, { node: stackAdded.node.id, port: 'images' });
  });
  const exp = addNode(g, registry, out.id, { x: 1120, y: 60 * sorted.length }, { kind: 'video', name: 'scan' });
  g = exp.graph;
  label(exp.node.id, 'Export');
  const to = Object.keys(out.inputs).find((k) => (out.inputs as InputSchema)[k].type === 'image')!;
  return connect(g, registry, { node: stackAdded.node.id, port: 'image' }, { node: exp.node.id, port: to });
}
