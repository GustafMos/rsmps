import { useMemo, useState } from 'react';
import { CATEGORIES, type AnyNodeDef, type InputSchema, type NodeInstance, type ParamDef } from '../../engine/types';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { CheckField, ColorField, SelectField, TextField, Vec2Field } from '../components/fields';
import { parseHex, toHex } from '../lib/colorMath';
import { LayerList } from '../graph/LayerList';
import { paramSocketType } from '../../engine/define';
import { useSelector } from '../store/createStore';
import { nodeViewStore, setPin } from '../store/nodeView';
import { effectivePins } from '../lib/layout';
import { isLayerType } from '../lib/layout';
import { Piano } from './Piano';
import { KindPicker } from '../components/KindPicker';
import { AUTO_COLLAPSED, KIND_GROUPS, describeOutput, hasKind } from '../lib/outputInfo';
import { PaletteHint } from '../components/PaletteHint';
import { DeviceField } from '../components/DeviceField';
import { paletteInputPort } from '../lib/sockets';
import { visibleParams } from '../lib/layout';
import { useApp, useDef, useEd } from '../store/context';
import { AssetsEditor, JsonEditor, PaletteEditor } from './editors';
import { ProjectSettingsPanel } from './ProjectSettings';
import './inspector.css';

export function Inspector() {
  const selection = useEd((s) => s.selection);
  const frame = useEd((s) => s.selectedFrame);
  return (
    <div className="rs-insp" data-panel="inspector">
      {selection.length === 1 ? <NodePanel id={selection[0]} /> : selection.length > 1 ? <MultiPanel count={selection.length} /> : frame ? <FramePanel id={frame} /> : <ProjectSettingsPanel />}
    </div>
  );
}

function MultiPanel({ count }: { count: number }) {
  const { ed } = useApp();
  return (
    <div className="rs-insp__scroll">
      <div className="rs-insp__sec">
        <div className="rs-insp__title">{count} nodes selected</div>
        <div className="rs-insp__actions">
          <button className="rs-btn" onClick={() => ed.groupSelection()} title="Ctrl+G"><Icon name="frame" /> Group</button>
          <button className="rs-btn" onClick={() => ed.autoLayout(true)}><Icon name="layout" /> Arrange</button>
          <button className="rs-btn" onClick={() => ed.duplicate()} title="Ctrl+D">Duplicate</button>
          <button className="rs-btn rs-btn--danger" onClick={() => ed.deleteSelection()} title="Delete"><Icon name="trash" /> Delete</button>
        </div>
        <p className="rs-insp__hint">Select a single node to edit its parameters.</p>
      </div>
    </div>
  );
}

const FRAME_COLORS = ['#5b8def', '#c77dff', '#4dd6a8', '#f2c14e', '#ef6f9c', '#58c4dd', '#f78154', '#8fd14f'];

function FramePanel({ id }: { id: string }) {
  const { ed } = useApp();
  const frame = useEd((s) => s.graph.frames?.find((f) => f.id === id));
  if (!frame) return null;
  return (
    <div className="rs-insp__scroll">
      <div className="rs-insp__sec">
        <div className="rs-caps">Frame</div>
        <TextField large value={frame.label} onChange={(v) => ed.updateFrame(id, { label: v })} />
        <div className="rs-insp__swatches">
          {FRAME_COLORS.map((c) => (
            <button key={c} className={`rs-insp__swatch${c === frame.color ? ' is-on' : ''}`} style={{ background: c }} title={c} onClick={() => ed.updateFrame(id, { color: c })} />
          ))}
        </div>
        <FrameColor color={frame.color} onChange={(c) => ed.updateFrame(id, { color: c })} />
        <button className="rs-btn rs-btn--danger" onClick={() => ed.ungroup(id)}>Ungroup</button>
      </div>
    </div>
  );
}

function FrameColor({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  const rgb = parseHex(color)?.rgb ?? [0.4, 0.5, 0.9];
  return <ColorField large label="Custom colour" value={[rgb[0], rgb[1], rgb[2], 1]} onChange={(v) => onChange(toHex(v))} />;
}

function NodePanel({ id }: { id: string }) {
  const { ed } = useApp();
  const node = useEd((s) => s.graph.nodes.find((n) => n.id === id));
  const def = useDef(node?.type ?? '');
  const edges = useEd((s) => s.graph.edges);
  const viewed = useEd((s) => s.viewedNodeId === id);
  const nodes = useEd((s) => s.graph.nodes);
  if (!node) return null;
  if (!def) {
    return (
      <div className="rs-insp__scroll">
        <div className="rs-insp__sec">
          <div className="rs-insp__title" style={{ color: 'var(--danger)' }}>Missing node type</div>
          <p className="rs-insp__hint">"{node.type}" is not installed (it probably comes from a plugin). Its connections are kept, so installing the plugin restores the graph.</p>
          <button className="rs-btn" onClick={() => ed.openDialog('plugins')}><Icon name="plug" /> Plugins…</button>
        </div>
      </div>
    );
  }
  const cat = CATEGORIES[def.category];
  const palPort = paletteInputPort(def);
  const project = useEd((s) => s.graph.project);
  const wired = new Map(edges.filter((e) => e.to.node === id).map((e) => [e.to.port, e] as const));
  const pins = useSelector(nodeViewStore, (s) => s.pins[id]);
  const pinned = pins ?? effectivePins(def, node);
  return (
    <div className="rs-insp__scroll">
      <div className="rs-insp__sec">
        <div className="rs-insp__kind">
          <span className="rs-insp__chip" style={{ background: cat?.color }} />
          <span className="rs-caps">{cat?.title}</span>
          <span className="rs-insp__id rs-mono">{def.id}</span>
        </div>
        {hasKind(def) && (
          <div className="rs-kind rs-kind--inspector">
            <KindPicker node={node} def={def} />
            <div className="rs-kind__what">{describeOutput(def, node, project)}</div>
          </div>
        )}
        <TextField large value={node.label ?? ''} placeholder={def.title} onChange={(v) => ed.setNode(id, { label: v || undefined }, `label:${id}`)} />
        <p className="rs-insp__desc">{def.description}</p>
        <div className="rs-insp__actions">
          <button className={`rs-btn${viewed ? ' is-on' : ''}`} onClick={() => ed.setViewed(id)} title="Show this node in the viewer">
            <Icon name={viewed ? 'eye' : 'eyeOff'} /> View
          </button>
          <button className={`rs-btn${node.bypass ? ' is-on' : ''}`} onClick={() => ed.toggleBypass(id)} title="Bypass (B)">
            <Icon name="power" /> Bypass
          </button>
          <button className="rs-btn rs-btn--icon rs-btn--danger" onClick={() => ed.deleteSelection()} title="Delete (Del)">
            <Icon name="trash" />
          </button>
        </div>
        {def.cpu && <p className="rs-insp__warn">Heavy CPU node: may be slow on large images.</p>}
      </div>
      {def.playable && (
        <div className="rs-insp__sec">
          <div className="rs-caps">Keyboard</div>
          <Piano nodeId={id} />
        </div>
      )}
      {palPort && !wired.has(palPort) && (
        <div className="rs-insp__sec">
          <PaletteHint nodeId={id} />
        </div>
      )}
      {Object.entries(def.inputs as InputSchema).filter(([, d]) => d.multi).map(([port, d]) => (
        <div key={port} className="rs-insp__sec">
          <div className="rs-caps">{isLayerType(d.type) ? 'Layers' : 'Inputs'}: {d.label ?? port}</div>
          {isLayerType(d.type) && <p className="rs-insp__hint">Top of the list is drawn on top. Drag rows or use the arrows to reorder.</p>}
          <LayerList nodeId={id} port={port} type={d.type} variant="inspector" />
        </div>
      ))}
      <ParamGroups
        node={node}
        def={def}
        wired={wired}
        pinned={pinned}
        onSelectSource={(port) => { const e = wired.get(port); if (e) ed.select([e.from.node]); }}
        label={(port) => {
          const e = wired.get(port);
          const src = e && nodes.find((n) => n.id === e.from.node);
          return src ? `${src.label || ed.registry.get(src.type)?.title || src.type}` : '';
        }}
        onDisconnect={(port) => {
          const e = wired.get(port);
          if (e) ed.disconnect(e.id);
        }}
      />
    </div>
  );
}

function ParamGroups({
  node,
  def,
  wired,
  pinned,
  onSelectSource,
  label,
  onDisconnect,
}: {
  node: NodeInstance;
  def: AnyNodeDef;
  wired: Map<string, unknown>;
  pinned: string[];
  onSelectSource: (port: string) => void;
  label: (port: string) => string;
  onDisconnect: (port: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const out: { name: string; items: [string, ParamDef][] }[] = [];
    const kindMap = hasKind(def) ? KIND_GROUPS[String(node.params.kind ?? 'auto')] : undefined;
    for (const [key, p] of visibleParams(def, node.params)) {
      if (hasKind(def) && key === 'kind') continue; // shown as the picker at the top
      if (kindMap && p.group && !kindMap.includes(p.group)) continue;
      const name = p.group ?? '';
      let g = out.find((x) => x.name === name);
      if (!g) out.push((g = { name, items: [] }));
      g.items.push([key, p]);
    }
    // jsons are skipped by visibleParams; show them last so the user can see their state
    for (const [key, p] of Object.entries(def.params as Record<string, ParamDef>)) {
      if (p.type !== 'json') continue;
      let g = out.find((x) => x.name === (p.group ?? ''));
      if (!g) out.push((g = { name: p.group ?? '', items: [] }));
      g.items.push([key, p]);
    }
    return out;
  }, [def, node.params]);

  if (!groups.length) return <div className="rs-insp__sec"><p className="rs-insp__hint">This node has no parameters.</p></div>;
  return (
    <>
      {groups.map((g) => (
        <div key={g.name} className="rs-insp__sec">
          {g.name && (
            <button className="rs-insp__group" onClick={() => setCollapsed((c) => ({ ...c, [g.name]: !(c[g.name] ?? (hasKind(def) && String(node.params.kind ?? 'auto') === 'auto' && AUTO_COLLAPSED.includes(g.name))) }))}>
              <Icon name={(collapsed[g.name] ?? (hasKind(def) && String(node.params.kind ?? 'auto') === 'auto' && AUTO_COLLAPSED.includes(g.name))) ? 'chevronRight' : 'chevronDown'} size={12} />
              <span className="rs-caps">{g.name}</span>
            </button>
          )}
          {!(collapsed[g.name] ?? (hasKind(def) && node.params.kind === undefined ? AUTO_COLLAPSED.includes(g.name) : hasKind(def) && String(node.params.kind) === 'auto' && AUTO_COLLAPSED.includes(g.name))) &&
            g.items.map(([key, p]) => (
              <ParamControl key={key} node={node} def={def} keyName={key} p={p} isWired={wired.has(key)} wiredFrom={label(key)} pinned={pinned.includes(key)} onPin={(on) => setPin(node.id, key, on, pinned)} onSelectSource={() => onSelectSource(key)} onDisconnect={() => onDisconnect(key)} />
            ))}
        </div>
      ))}
    </>
  );
}

function ParamControl({ node, def, keyName, p, isWired, wiredFrom, pinned, onPin, onSelectSource, onDisconnect }: { node: NodeInstance; def: AnyNodeDef; keyName: string; p: ParamDef; isWired: boolean; wiredFrom: string; pinned: boolean; onPin: (on: boolean) => void; onSelectSource: () => void; onDisconnect: () => void }) {
  const sockType = paramSocketType(def, keyName);
  const { ed, io } = useApp();
  const label = p.label ?? keyName;
  const value = node.params[keyName] ?? p.default;
  const set = (v: unknown) => ed.setParam(node.id, keyName, v);
  const stacked = p.type === 'palette' || p.type === 'assets' || p.type === 'json' || (p.type === 'string' && p.multiline);

  let control: React.ReactNode;
  if (isWired) {
    control = (
      <div className="rs-insp__wired">
        <Icon name="plug" size={13} />
        <button className="rs-insp__chip2" onClick={onSelectSource} title="Select the driving node">driven by {wiredFrom || 'a node'}</button>
        <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={onDisconnect} title="Disconnect and use the value here" aria-label="Disconnect"><Icon name="close" size={12} /></button>
      </div>
    );
  } else {
    switch (p.type) {
      case 'number':
        control = <NumberField large name={label} askKey={`${node.id}:${keyName}`} softMax={p.softMax} value={value as number} min={p.min} max={p.max} step={p.step} unit={p.unit} integer={p.integer} defaultValue={p.default} onChange={set} />;
        if (p.unit === 's') {
          control = (
            <div className="rs-insp__nowrap">
              {control}
              <button className="rs-btn" onClick={() => set(Math.round(io.player.getState().seconds * 100) / 100)} title="Set to the current playhead time">Now</button>
            </div>
          );
        }
        break;
      case 'bool':
        control = <CheckField value={!!value} onChange={set} label={value ? 'On' : 'Off'} />;
        break;
      case 'enum':
        control = <SelectField large value={String(value)} options={p.options} onChange={set} label={label} />;
        break;
      case 'color':
        control = <ColorField large value={value as [number, number, number, number]} onChange={set} />;
        break;
      case 'string':
        control = <TextField large multiline={p.multiline} value={String(value ?? '')} onChange={set} />;
        break;
      case 'vec2':
        control = <Vec2Field large value={value as [number, number]} min={p.min} max={p.max} step={p.step} unit={p.unit} defaultValue={p.default} onChange={set} />;
        break;
      case 'palette':
        control = <PaletteEditor value={value as [number, number, number][]} onChange={set} onStudio={() => { ed.studioTarget = { nodeId: node.id, key: keyName }; ed.openDialog('palette'); }} />;
        break;
      case 'assets':
        control = <AssetsEditor value={value as string[]} accept={p.accept} onChange={set} />;
        break;
      case 'device':
        control = <DeviceField large value={String(value ?? '')} kind={p.device} onChange={set} />;
        break;
      case 'json':
        control = <JsonEditor value={value} onChange={set} />;
        break;
    }
  }
  return (
    <div className={`rs-insp__row${stacked ? ' is-stacked' : ''}`} title={p.hint} {...(sockType ? { 'data-insp-sock': '', 'data-node': node.id, 'data-port': keyName, 'data-dir': 'in', 'data-type': sockType } : {})}>
      <label className="rs-insp__label">
        <button className={`rs-insp__pin${pinned ? ' is-on' : ''}`} aria-pressed={pinned} title={pinned ? 'Shown on the node: click to hide' : 'Show on the node'} onClick={() => onPin(!pinned)}><Icon name="pin" size={12} /></button>
        {sockType && <span className={`rs-insp__dot rs-sock--${sockType}`} title="Drag a wire from a node's output onto this row to drive it" />}
        <span className="rs-insp__lt">{label}</span>
      </label>
      <div className="rs-insp__ctl">{control}</div>
      {p.hint && <div className="rs-insp__phint">{p.hint}</div>}
    </div>
  );
}
