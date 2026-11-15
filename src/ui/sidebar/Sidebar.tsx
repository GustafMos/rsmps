import { useRef, useState } from 'react';
import { KIND_SHORT, describeOutput, hasKind, kindOptions } from '../lib/outputInfo';
import { enabledOutputs, outputNodes } from '../../engine/graph';
import { MenuPopup, type MenuItem } from '../components/Menu';
import { frameSize, hasFrameParams } from '../viewer/FrameControl';
import { CATEGORIES } from '../../engine/types';
import { Icon } from '../components/Icon';
import { Thumb } from '../components/Thumb';
import { ASSET_MIME } from '../graph/gestures';
import { useApp, useAssets, useDefs, useEd, usePlayer } from '../store/context';
import { shallowArrayEqual } from '../store/createStore';
import { resolveActiveOutput } from '../store/editor';
import './sidebar.css';

export function Sidebar() {
  return (
    <div className="rs-side">
      <MediaSection />
      <OutputsSection />
    </div>
  );
}

function fmt(a: { kind: string; width: number; height: number; duration: number }): string {
  if (a.kind === 'audio' || a.kind === 'midi') return `${a.kind} · ${a.duration.toFixed(1)}s`;
  return `${a.width}×${a.height}${a.kind === 'video' ? ` · ${a.duration.toFixed(1)}s` : ''}`;
}

function MediaSection() {
  const { io, ed, graphCtl } = useApp();
  const assets = useAssets();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);

  const importFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    setBusy(true);
    try {
      const infos = await io.library.add(list);
      ed.toast(`Imported ${infos.length} file${infos.length === 1 ? '' : 's'}`, 'ok');
    } catch (err) {
      ed.toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const click = (id: string, e: React.MouseEvent) => {
    setSel((cur) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        const n = new Set(cur);
        n.has(id) ? n.delete(id) : n.add(id);
        return n;
      }
      return new Set([id]);
    });
  };

  const addToGraph = (ids: string[]) => {
    const r = graphCtl.rect();
    const at = graphCtl.toWorld(r.left + r.width / 3, r.top + r.height / 3);
    ed.addAssetNode(ids, { x: Math.round(at.x), y: Math.round(at.y) });
  };

  return (
    <section
      className={`rs-side__sec rs-side__media${over ? ' is-drop' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (e.dataTransfer.files.length) {
          e.preventDefault();
          void importFiles(e.dataTransfer.files);
        }
      }}
    >
      <header className="rs-side__head" title="The media library is shared by all project tabs">
        <span className="rs-caps">Media</span>
        <span className="rs-side__count rs-num">{assets.length}</span>
        <button className="rs-btn rs-btn--icon rs-btn--ghost" title="Import files" onClick={() => fileIn.current?.click()} disabled={busy}>
          <Icon name="plus" />
        </button>
        <input ref={fileIn} type="file" hidden multiple accept="image/*,video/*,audio/*,.mid,.midi" onChange={(e) => { if (e.target.files) void importFiles(e.target.files); e.target.value = ''; }} />
      </header>
      <div className="rs-side__list">
        {assets.length === 0 ? (
          <div className="rs-empty">
            <Icon name="image" size={24} />
            <span>{busy ? 'Importing…' : 'Drop images, videos or audio here, or click +'}</span>
          </div>
        ) : (
          assets.map((a) => (
            <div
              key={a.id}
              className={`rs-side__asset${sel.has(a.id) ? ' is-sel' : ''}`}
              draggable
              title={`${a.name}\nDrag onto the graph to create a node. Double-click to add.`}
              onClick={(e) => click(a.id, e)}
              onDoubleClick={() => addToGraph(sel.has(a.id) && sel.size > 1 ? [...sel] : [a.id])}
              onDragStart={(e) => {
                const ids = sel.has(a.id) ? [...sel] : [a.id];
                e.dataTransfer.setData(ASSET_MIME, JSON.stringify(ids));
                e.dataTransfer.effectAllowed = 'copy';
              }}
            >
              <Thumb asset={a} size={40} />
              <div className="rs-side__meta">
                <span className="rs-side__name">{a.name}</span>
                <span className="rs-side__sub rs-num">{fmt(a)}</span>
              </div>
              <button
                className="rs-side__rm rs-btn rs-btn--icon rs-btn--ghost"
                title="Remove from library"
                onClick={(e) => {
                  e.stopPropagation();
                  void io.library.remove(a.id);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function OutputsSection() {
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
