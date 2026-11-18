import type { Registry } from '../../engine/define';
import { enabledOutputs, outputNodes, upstream } from '../../engine/graph';
import type { GraphDoc, InputSchema, NodeInstance } from '../../engine/types';

/** What these rules need to know about a media file. */
export interface SoundInfo {
  kind: string;
  name: string;
  hasAudio: boolean;
}
type Info = (assetId: string) => SoundInfo | null | undefined;

const hasInput = (registry: Registry, n: NodeInstance, type: string): boolean => Object.values((registry.get(n.type)?.inputs ?? {}) as InputSchema).some((i) => i.type === type);
const titleOf = (registry: Registry, n: NodeInstance): string => n.label || registry.get(n.type)?.title || n.type;

/** Audio Output nodes (sinks with a sound input). */
export function audioOutputs(graph: GraphDoc, registry: Registry): NodeInstance[] {
  return outputNodes(graph, registry).filter((n) => hasInput(registry, n, 'audio') && !hasInput(registry, n, 'image'));
}
const wired = (graph: GraphDoc, n: NodeInstance): boolean => graph.edges.some((e) => e.to.node === n.id);

/**
 * The sound an export of a video would take when NO Audio Output plays anything: the Media Timeline's sound is never taken
 * (it has to be wired), else the first Media In upstream of a picture output whose current file is a video with sound.
 * This mirrors the exporter's fallback (`videoAudio` in src/io/exporter.ts). Null when there is none.
 */
export function ownSoundSource(graph: GraphDoc, registry: Registry, info: Info, item: number): { node: NodeInstance; port: string; file: string; timeline: boolean } | null {
  const pictureOuts = enabledOutputs(graph, registry).filter((n) => hasInput(registry, n, 'image'));
  for (const out of pictureOuts.length ? pictureOuts : outputNodes(graph, registry).filter((n) => hasInput(registry, n, 'image'))) {
    const up = upstream(graph, out.id);
    const timeline = graph.nodes.find((n) => up.has(n.id) && n.type === 'media-timeline');
    if (timeline) return { node: timeline, port: 'audio', file: titleOf(registry, timeline), timeline: true };
    for (const n of graph.nodes) {
      if (!up.has(n.id) || n.type !== 'media-in' || !Array.isArray(n.params.assets) || n.params.assets.length === 0) continue;
      const id = n.params.assets[item % n.params.assets.length];
      const a = typeof id === 'string' ? info(id) : null;
      if (a?.kind === 'video' && a.hasAudio) return { node: n, port: 'audio', file: a.name, timeline: false };
    }
  }
  return null;
}

/** The sound source "Enable audio" should wire into a new Audio Output: only when no Audio Output has anything wired yet. */
export function soundToWire(graph: GraphDoc, registry: Registry, info: Info, item: number): { node: NodeInstance; port: string } | null {
  if (audioOutputs(graph, registry).some((n) => wired(graph, n))) return null;
  const src = ownSoundSource(graph, registry, info, item);
  return src ? { node: src.node, port: src.port } : null;
}

export interface ExportSound {
  /** 'output' = what is wired into the Audio Output(s); 'clip' = a clip's own sound (no Audio Output); 'none' = silent. */
  kind: 'output' | 'clip' | 'none';
  /** One plain sentence for the export dialog. */
  text: string;
  /** True when the export has sound that the preview does not play (so the user should be offered an Audio Output). */
  unheard: boolean;
}

/** What sound an exported video of this graph gets, in words. Same rules as the exporter. */
export function describeExportSound(graph: GraphDoc, registry: Registry, info: Info, item: number): ExportSound {
  const outs = audioOutputs(graph, registry);
  const on = outs.filter((n) => !n.bypass && n.params.enabled !== false);
  if (outs.length > 0 && on.length === 0) return { kind: 'none', text: 'No sound: every Audio Output is switched off ("Include in export").', unheard: false };
  const playing = on.filter((n) => wired(graph, n));
  if (playing.length > 0) {
    const names = new Set<string>();
    for (const o of playing) for (const e of graph.edges) if (e.to.node === o.id) names.add(titleOf(registry, graph.nodes.find((n) => n.id === e.from.node) ?? o));
    return { kind: 'output', text: `Sound: what is wired into the Audio Output (${[...names].join(', ')}). It is what you hear in the preview.`, unheard: false };
  }
  const own = ownSoundSource(graph, registry, info, item);
  if (own?.timeline) return { kind: 'none', text: `No sound: the sound of ${own.file} is exported only when it is wired into an Audio Output.`, unheard: true };
  if (own) return { kind: 'clip', text: `Sound: the own sound of "${own.file}", unchanged. There is no Audio Output, so you do not hear it in the preview.`, unheard: true };
  return { kind: 'none', text: 'No sound: nothing is wired into an Audio Output and the picture comes from no video with sound.', unheard: false };
}
