import { addNode, connect, createGraph } from '../../engine/graph';
import type { AssetInfo, GraphDoc, ParamDef } from '../../engine/types';
import type { Io } from '../../io/api';
import { sourceDefFor } from '../lib/sockets';

export type QuickKind = 'mp4' | 'webm' | 'sequence' | 'spritesheet';
export const QUICK_KINDS: { id: QuickKind; label: string }[] = [
  { id: 'mp4', label: 'Video (MP4, H.264)' },
  { id: 'webm', label: 'Video (WebM, VP9)' },
  { id: 'sequence', label: 'PNG sequence (ZIP)' },
  { id: 'spritesheet', label: 'Spritesheet (+ JSON)' },
];

export interface QuickOptions {
  fps: number;
  upscale: number;
  loops: number;
  name: string;
}

/**
 * A throwaway graph (never put in the editor store): Media In (the scanned sequence) -> Output with the chosen type.
 * The canvas is the frame size, loop is off, and the duration is the sequence length times the loop count.
 */
export function buildQuickGraph(io: Io, asset: AssetInfo, kind: QuickKind, o: QuickOptions): { graph: GraphDoc; outId: string } {
  const src = sourceDefFor(io.registry, asset.kind === 'image' ? 'image' : 'video');
  const out = io.registry.list().find((d) => d.category === 'output' && (d.params as Record<string, ParamDef>).kind?.type === 'enum' && 'codec' in d.params);
  if (!src || !out) throw new Error('The Media In or Output node type is not available.');
  const frames = Math.max(1, asset.duration > 0 ? Math.round(asset.duration * o.fps) : 1);
  const loops = kind === 'mp4' || kind === 'webm' ? Math.max(1, Math.round(o.loops)) : 1;
  let g = createGraph(o.name);
  g = {
    ...g,
    project: { ...g.project, width: asset.width, height: asset.height, fps: o.fps, duration: (frames / o.fps) * loops, loop: false },
  };
  const a = addNode(g, io.registry, src.def.id, { x: 0, y: 0 }, { [src.key]: [asset.id] });
  const kindParam: Record<QuickKind, Record<string, unknown>> = {
    mp4: { kind: 'video', codec: 'avc' },
    webm: { kind: 'video', codec: 'vp9' },
    sequence: { kind: 'sequence' },
    spritesheet: { kind: 'spritesheet' },
  };
  const b = addNode(a.graph, io.registry, out.id, { x: 300, y: 0 }, { ...kindParam[kind], scale: o.upscale, name: o.name.replace(/[\\/:*?"<>|]+/g, '_') || 'scan' });
  const from = Object.keys(src.def.outputs)[0];
  const to = Object.keys(out.inputs).find((k) => (out.inputs as Record<string, { type: string }>)[k].type === 'image')!;
  return { graph: connect(b.graph, io.registry, { node: a.node.id, port: from }, { node: b.node.id, port: to }), outId: b.node.id };
}
