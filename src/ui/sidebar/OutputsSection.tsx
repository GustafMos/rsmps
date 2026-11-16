import { useState } from 'react';
import { KIND_SHORT, describeOutput, hasKind, kindOptions } from '../lib/outputInfo';
import { enabledOutputs, outputNodes } from '../../engine/graph';
import { MenuPopup, type MenuItem } from '../components/Menu';
import { frameSize, hasFrameParams } from '../viewer/FrameControl';
import { CATEGORIES } from '../../engine/types';
import { Icon } from '../components/Icon';
import { useApp, useDefs, useEd, usePlayer } from '../store/context';
import { shallowArrayEqual } from '../store/createStore';
import { resolveActiveOutput } from '../store/editor';

export function OutputsSection() {
  const { ed, io } = useApp();
  useDefs();
  const ids = useEd((s) => outputNodes(s.graph, io.registry).map((n) => n.id), shallowArrayEqual);
  const nodes = useEd((s) => s.graph.nodes);
  const sel = useEd((s) => s.selection);
  const viewed = useEd((s) => s.viewedNodeId);
  const active = useEd((s) => resolveActiveOutput(s, io.registry));
  const enabledCount = useEd((s) => enabledOutputs(s.graph, io.registry).length);
  const project = useEd((s) => s.graph.project);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const isAudioOut = (id: string) => {
    const n = ed.state.graph.nodes.find((x) => x.id === id);
    const d = n && io.registry.get(n.type);
    return !!d && Object.values(d.inputs as Record<string, { type: string }>)[0]?.type === 'audio';
  };
  const errors = usePlayer((s) => s.errors);
  return (
    <section className="rs-side__sec rs-side__outputs">
      <header className="rs-side__head">
        <span className="rs-caps">Outputs</span>
        <span className="rs-side__count rs-num">{ids.length}</span>
        <button className="rs-btn rs-btn--ghost" onClick={() => void ed.runExport([], ed.exportPrefs(ed.state.activeProject).items)} disabled={enabledCount === 0} title="Export every output that is ticked">
          Export enabled ({enabledCount})
        </button>
      </header>
      <div className="rs-side__list">
        {ids.length === 0 ? (
          <div className="rs-empty">Add an Output node to export your result.</div>
        ) : (
          ids.map((id) => {
            const n = nodes.find((x) => x.id === id)!;
            const def = io.registry.get(n.type)!;
            const fs = hasFrameParams(def) ? frameSize(project, n) : null;
            const on = n.params.enabled !== false;
            return (
              <div key={id} className={`rs-side__outrow${on ? '' : ' is-off'}`}>
                <input type="checkbox" className="rs-side__chk" checked={on} aria-label={`Include ${n.label || def.title} in export`} title="Include in export" onChange={(e) => ed.setParam(id, 'enabled', e.target.checked)} />
              <button
                className={`rs-side__out${sel.includes(id) ? ' is-sel' : ''}`}
                onClick={() => {
                  ed.select([id]);
                  ed.setActiveOutput(id);
                  ed.setViewed(id);
                }}
                title="Select and view this output"
              >
                {isAudioOut(id) ? <Icon name="volume" size={14} /> : <span className="rs-side__chip" style={{ background: CATEGORIES[def.category]?.color }} />}
                <span className="rs-side__name">{n.label || def.title}{fs && <span className="rs-side__sub rs-num"> {fs.width}×{fs.height}</span>}</span>
                {active === id && <span className="rs-side__active" title="Active output: previews use its frame">active</span>}
                {errors.has(id) && <Icon name="warn" size={13} />}
                {viewed === id && <Icon name="eye" size={13} />}
              </button>
                {hasKind(def) && <select className="rs-select rs-side__kind" value={String(n.params.kind ?? 'auto')} aria-label="Export type" title={describeOutput(def, n, project)} onChange={(e) => ed.setParam(id, 'kind', e.target.value)}>{kindOptions(def).map((o) => <option key={o.value} value={o.value}>{KIND_SHORT[o.value] ?? o.label}</option>)}</select>}
                <button className="rs-btn rs-btn--ghost rs-side__exp" title="Export just this output (current item)" onClick={() => void ed.runExport([id], 'current')}><Icon name="export" size={14} /></button>
                <button className="rs-btn rs-btn--icon rs-btn--ghost" title="More" aria-label="More export options" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, id })}><Icon name="menu" size={14} /></button>
              </div>
            );
          })
        )}
      </div>
      {menu && <MenuPopup x={menu.x} y={menu.y} items={[{ label: 'Export this for the whole batch', onClick: () => void ed.runExport([menu.id], 'all') }, { label: 'Export this (current item)', onClick: () => void ed.runExport([menu.id], 'current') }, ...(isAudioOut(menu.id) ? [{ sep: true } as MenuItem, { label: 'Export sound only (WAV)', onClick: () => void ed.runExport([menu.id], 'current', undefined, 'wav') }, { label: 'Export sound only (M4A)', onClick: () => void ed.runExport([menu.id], 'current', undefined, 'm4a') }] : [])]} onClose={() => setMenu(null)} />}
    </section>
  );
}
