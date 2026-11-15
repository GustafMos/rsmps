import type { AnyNodeDef, GraphDoc, NodeInstance, ParamDef } from '../../engine/types';
import { frameSize, hasFrameParams } from '../viewer/FrameControl';

/** Param groups shown for each export kind (everything else in the Output's inspector is hidden). Defined once. */
export const KIND_GROUPS: Record<string, string[]> = {
  auto: ['Frame', 'Video', 'Spritesheet'],
  image: ['Frame'],
  sequence: ['Frame'],
  video: ['Frame', 'Video'],
  spritesheet: ['Frame', 'Spritesheet'],
  print: ['Print'],
};
/** Groups that start collapsed for `auto` (the kind is not decided yet). */
export const AUTO_COLLAPSED = ['Video', 'Spritesheet'];

export const KIND_ICON = { auto: 'focus', image: 'image', sequence: 'folder', video: 'video', spritesheet: 'grid', print: 'export' } as const;
export const KIND_SHORT: Record<string, string> = { auto: 'Auto', image: 'Still', sequence: 'Sequence', video: 'Video', spritesheet: 'Sheet', print: 'Print' };

export function hasKind(def: AnyNodeDef | undefined): boolean {
  return !!def && def.category === 'output' && (def.params as Record<string, ParamDef>).kind?.type === 'enum';
}
export function kindOptions(def: AnyNodeDef): { value: string; label: string }[] {
  return ((def.params as Record<string, ParamDef>).kind as unknown as { options: { value: string; label: string }[] }).options;
}

function optionLabel(def: AnyNodeDef, key: string, value: unknown): string {
  const p = (def.params as Record<string, ParamDef>)[key] as unknown as { options?: { value: string; label: string }[] } | undefined;
  return p?.options?.find((o) => o.value === value)?.label ?? String(value ?? '');
}

/** Plain-words summary of what an Output will write, computed from its params and the project (nothing is rendered). */
export function describeOutput(def: AnyNodeDef, node: NodeInstance, project: GraphDoc['project']): string {
  const kind = String(node.params.kind ?? 'auto');
  const fs = hasFrameParams(def) ? frameSize(project, node) : { width: project.width, height: project.height };
  const size = `${fs.width}×${fs.height}`;
  const frames = Math.max(1, Math.round(project.duration * project.fps));
  const fmt = String(node.params.imageFormat ?? 'png').toUpperCase();
  switch (kind) {
    case 'image':
      return `1 ${fmt} image, ${size}`;
    case 'sequence':
      return `${frames} ${fmt} files, ${size}`;
    case 'video': {
      const codec = optionLabel(def, 'codec', node.params.codec ?? 'h264').replace(/\s*\(.*\)/, '');
      const container = /\((.*)\)/.exec(optionLabel(def, 'codec', node.params.codec ?? 'h264'))?.[1];
      return `1 video (${[container, codec].filter(Boolean).join(', ')}, ${size}, ${project.duration} s)`;
    }
    case 'spritesheet':
      return `1 spritesheet + JSON, ${frames} frames, ${size} each`;
    case 'print':
      return 'Print sheets (PDF) to draw on and scan back';
    default:
      return `Auto: a ${fmt} image if nothing moves, otherwise a video (${size})`;
  }
}
