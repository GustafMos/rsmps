import type { AnyNodeDef, GraphDoc, NodeInstance, ParamDef } from '../../engine/types';
import { readFrameParams, resolveFrame } from '../../io/frame';
import { Icon } from '../components/Icon';
import type { MenuItem } from '../components/Menu';
import { resolveActiveOutput } from '../store/editor';
import { useApp, useEd } from '../store/context';

const PIXEL_STEPS = [1, 2, 3, 4, 6, 8, 10, 12, 16, 24, 32];

/** Does this output node carry the Frame params (frame + orientation)? Generic: found by param names. */
export function hasFrameParams(def: AnyNodeDef | undefined): boolean {
  return !!def && def.category === 'output' && 'frame' in def.params && 'orientation' in def.params;
}

export function frameSize(project: GraphDoc['project'], node: NodeInstance): { width: number; height: number } {
  return resolveFrame({ width: project.width, height: project.height }, readFrameParams(node.params));
}

function useFrameCtx() {
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
  const hasPix = 'pixelSize' in (def.params as object);
  const px = Math.max(1, Math.round(Number(node.params.pixelSize ?? 1)));
  const stepPix = (dir: 1 | -1) => {
    const i = PIXEL_STEPS.findIndex((v) => v >= px);
    const cur = i < 0 ? PIXEL_STEPS.length - 1 : i;
    const next = dir > 0 ? (PIXEL_STEPS[cur] > px ? cur : cur + 1) : cur - 1;
    ed.setParam(node.id, 'pixelSize', PIXEL_STEPS[Math.max(0, Math.min(PIXEL_STEPS.length - 1, next))]);
  };
  const toggleOrientation = () => ed.setParam(node.id, 'orientation', portrait ? 'landscape' : 'portrait');
  return { ed, node, size, preset, options, portrait, name, hasPix, px, stepPix, toggleOrientation };
}

/** The frame / pixel-size actions as menu rows, for the viewer bar's "…" menu when there is no room for the chips. */
export function useFrameMenuItems(parts: { frame: boolean; pix: boolean }): MenuItem[] {
  const c = useFrameCtx();
  if (!c) return [];
  const out: MenuItem[] = [];
  if (parts.frame) {
    out.push({ head: `Frame · ${c.size.width}×${c.size.height}` }, { label: c.portrait ? 'Switch to landscape' : 'Switch to portrait', onClick: c.toggleOrientation });
    for (const o of c.options) out.push({ label: `${o.value === c.preset ? '✓ ' : ''}${o.label}`, onClick: () => c.ed.setParam(c.node.id, 'frame', o.value) });
  }
  if (parts.pix && c.hasPix) {
    out.push({ head: `Pixel size · ${c.px}×` }, { label: 'Smaller pixels', onClick: () => c.stepPix(-1) }, { label: 'Bigger pixels', onClick: () => c.stepPix(1) });
  }
  return out;
}

/** Compact frame control for the active output: resolved size, landscape/portrait toggle and an aspect preset. */
export function FrameControl({ frame = true, pix = true }: { frame?: boolean; pix?: boolean }) {
  const c = useFrameCtx();
  if (!c) return null;
  const { ed, node, size, preset, options, portrait, name, hasPix, px, stepPix, toggleOrientation } = c;
  return (
    <>
      {frame && (
        <div className="rs-viewer__frame rs-viewer__chip" data-nodrag title={`Frame of the active output "${name}". The project canvas is the default; each Output can override it.`}>
          <span className="rs-viewer__fname">{name}</span>
          <span className="rs-num">{size.width}×{size.height}</span>
          <button
            className="rs-btn rs-btn--icon rs-btn--ghost"
            onClick={toggleOrientation}
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
      )}
      {pix && hasPix && (
        <div className="rs-viewer__pix rs-viewer__chip" data-nodrag title="Final pixel size of the export: every art pixel becomes this many output pixels">
          <span className="rs-viewer__fname">Pixel size</span>
          <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => stepPix(-1)} aria-label="Smaller pixels">−</button>
          <span className="rs-num">{px}×</span>
          <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => stepPix(1)} aria-label="Bigger pixels">+</button>
          <span className="rs-num rs-viewer__fname">{Math.max(1, Math.floor(size.width / px))}×{Math.max(1, Math.floor(size.height / px))} art px</span>
        </div>
      )}
    </>
  );
}
