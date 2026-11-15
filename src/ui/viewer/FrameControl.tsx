import type { AnyNodeDef, GraphDoc, NodeInstance, ParamDef } from '../../engine/types';
import { readFrameParams, resolveFrame } from '../../io/frame';
import { Icon } from '../components/Icon';
import { resolveActiveOutput } from '../store/editor';
import { useApp, useEd } from '../store/context';

/** Does this output node carry the Frame params (frame + orientation)? Generic: found by param names. */
export function hasFrameParams(def: AnyNodeDef | undefined): boolean {
  return !!def && def.category === 'output' && 'frame' in def.params && 'orientation' in def.params;
}

export function frameSize(project: GraphDoc['project'], node: NodeInstance): { width: number; height: number } {
  return resolveFrame({ width: project.width, height: project.height }, readFrameParams(node.params));
}

/** Compact frame control for the active output: resolved size, landscape/portrait toggle and an aspect preset. */
export function FrameControl() {
  const { ed, io } = useApp();
  const node = useEd((s) => {
    const id = resolveActiveOutput(s, io.registry);
    return s.graph.nodes.find((n) => n.id === id);
  });
  const project = useEd((s) => s.graph.project);
  const def = node && io.registry.get(node.type);
  if (!node || !def || !hasFrameParams(def)) return null;
  const size = frameSize(project, node);
  const preset = String(node.params.frame ?? 'project');
  const options = ((def.params as Record<string, ParamDef>).frame as unknown as { options: { value: string; label: string }[] }).options;
  const portrait = size.height > size.width;
  const name = node.label || def.title;
  return (
    <div className="rs-viewer__frame rs-viewer__chip" data-nodrag title={`Frame of the active output "${name}". The project canvas is the default; each Output can override it.`}>
      <span className="rs-viewer__fname">{name}</span>
      <span className="rs-num">{size.width}×{size.height}</span>
      <button
        className="rs-btn rs-btn--icon rs-btn--ghost"
        onClick={() => ed.setParam(node.id, 'orientation', portrait ? 'landscape' : 'portrait')}
        title={portrait ? 'Portrait: switch to landscape' : 'Landscape: switch to portrait'}
        aria-label="Toggle landscape / portrait"
      >
        <Icon name="swap" />
      </button>
      <select className="rs-select rs-viewer__preset" value={preset} aria-label="Frame preset" onChange={(e) => ed.setParam(node.id, 'frame', e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
