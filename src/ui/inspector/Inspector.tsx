import { Fragment, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CATEGORIES, type AnyNodeDef, type InputSchema, type NodeInstance, type ParamDef } from '../../engine/types';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { CheckField, ColorField, SelectField, TextField, Vec2Field } from '../components/fields';
import { parseHex, toHex } from '../lib/colorMath';
import { LayerList } from '../graph/LayerList';
import { paramBundles, paramSocketType, type ParamBundle } from '../../engine/define';
import { bundleAxes } from '../lib/compat';
import { useSelector } from '../store/createStore';
import { nodeViewStore, setPin } from '../store/nodeView';
import { effectivePins } from '../lib/layout';
import { isLayerType } from '../lib/layout';
import { Piano } from './Piano';
import { RecordButton } from '../timeline/RecordButton';
import { isTimelineDef } from '../timeline/TimelineEditor';
import { MEDIA_TIMELINE_ID } from '../../engine/lib/media-edit';
import { RangeField } from '../components/RangeField';
import { DrumGrid, looksLikeDrumPattern } from './DrumGrid';
import { KindPicker } from '../components/KindPicker';
import { FamilySelect } from '../components/FamilySelect';
import { AUTO_COLLAPSED, KIND_GROUPS, describeOutput, hasKind } from '../lib/outputInfo';
import { PaletteHint } from '../components/PaletteHint';
import { DeviceField } from '../components/DeviceField';
import { FontField } from '../components/FontField';
import { CurveField } from '../components/CurveField';
import { paletteInputPort } from '../lib/sockets';
import { visibleParams } from '../lib/layout';
import { useApp, useDef, useEd, usePlayer } from '../store/context';
import { bakeSelection } from '../store/bake';
import { AssetsEditor, CodeEditor, JsonEditor, PaletteEditor } from './editors';
import { CopyCode, PhonePanel, hasSessionParam } from './PhonePanel';
import { PhoneMotionPanel } from './PhoneMotionPanel';
import { LiveRecordPanel } from './LiveRecordPanel';
import { CameraPermissionPanel } from './CameraPermissionPanel';
import { FastCopyPanel } from './FastCopyPanel';
import { RecorderPanel } from './RecorderPanel';
import { isLivePictureType } from '../../engine/lib/live-source';
import { CodecSelect, REGISTRY_PARAMS, hasFfmpegOptions } from './CodecSelect';
import { missingCapabilities } from '../lib/requirements';
import { ProjectSettingsPanel } from './ProjectSettings';
import { BakePanel } from './BakePanel';
import { DatamoshPanel } from './DatamoshPanel';
import { ProcessPanel } from './ProcessPanel';
import { SplatTrainPanel } from './SplatTrainPanel';
import { DepthAiPanel } from './DepthAiPanel';
import { StyleAiPanel } from './StyleAiPanel';
import { GroupPanel } from './GroupPanel';
import { defOf, GROUP_TYPE } from '../../engine/group';
import { patchIsNoop, resetPatch, transformOf, type ResetKind, type Transform3d } from '../lib/xform3d';
import './inspector.css';

/** Messages that only say what to set up first (nothing is broken): shown as a note, not as an error. */
const isSetupNotice = (msg: string) => /^(Not linked|Link a phone|No (phone|camera|microphone|device|file|image|clip|take))/i.test(msg);
/** What an empty JSON-typed parameter says, by parameter key. */
const JSON_EMPTY: Record<string, string> = { take: 'No take recorded', analysis: 'Not analyzed yet', strokes: 'No strokes yet', clips: 'No clips yet', edit: 'No clips yet', iter: 'Not started' };

export function Inspector() {
  const selection = useEd((s) => s.selection);
  const frame = useEd((s) => s.selectedFrame);
  return (
    <div className="rs-insp" data-panel="inspector">
      {selection.length === 1 ? <NodePanel id={selection[0]} /> : selection.length > 1 ? <MultiPanel count={selection.length} /> : frame ? <FramePanel id={frame} /> : <ProjectSettingsPanel />}
    </div>
  );
}

/** Long node descriptions: two lines, with a "more" toggle only when the text really is longer. */
function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  const el = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const e = el.current;
    if (e && !open) setLong(e.scrollHeight > e.clientHeight + 1);
  }, [text, open]);
  return (
    <div className="rs-insp__descwrap">
      <p ref={el} className={`rs-insp__desc${open ? '' : ' is-clamped'}`}>{text}</p>
      {(long || open) && (
        <button className="rs-insp__more" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? 'less' : 'more'}</button>
      )}
    </div>
  );
}

function MultiPanel({ count }: { count: number }) {
  const app = useApp();
  const { ed } = app;
  return (
    <div className="rs-insp__scroll">
      <div className="rs-insp__sec">
        <div className="rs-insp__title">{count} nodes selected</div>
        <div className="rs-insp__actions">
          <button className="rs-btn" onClick={() => ed.groupNodes()} title="One node made of these nodes (Ctrl+G)"><Icon name="stack" /> Group</button>
          <button className="rs-btn" onClick={() => ed.groupNodes('repeat')} title="A Repeat group: the nodes applied several times">Repeat</button>
          <button className="rs-btn" onClick={() => ed.groupSelection()} title="Put them in a frame (Shift+G)"><Icon name="frame" /> Frame</button>
          <button className="rs-btn" onClick={() => ed.autoLayout(true)}><Icon name="layout" /> Arrange</button>
          <button className="rs-btn" onClick={() => void bakeSelection(app)} title="Group these nodes and bake the group: they stop costing time and memory (Ctrl+Shift+B)"><Icon name="save" /> Bake</button>
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
  return <ColorField large label="Custom color" value={[rgb[0], rgb[1], rgb[2], 1]} onChange={(v) => onChange(toHex(v))} />;
}

function NodePanel({ id }: { id: string }) {
  const { ed } = useApp();
  // the shown level (inside an open group: its nodes); viewer, errors and processes use the full path id
  const node = useEd((s) => s.level.nodes.find((n) => n.id === id));
  const regDef = useDef(node?.type ?? '');
  const def = useMemo(() => defOf({ get: () => regDef }, node) ?? regDef, [regDef, node]);
  const edges = useEd((s) => s.level.edges);
  const fullId = useEd((s) => (s.path.length ? [...s.path, id].join('/') : id));
  const viewed = useEd((s) => s.viewedNodeId === fullId);
  const nodes = useEd((s) => s.level.nodes);
  const error = usePlayer((s) => s.errors.get(fullId));
  const { io } = useApp();
  const missing = missingCapabilities(io, def);
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
        <FamilySelect node={node} large />
        <TextField large value={node.label ?? ''} placeholder={def.title} onChange={(v) => ed.setNode(id, { label: v || undefined }, `label:${id}`)} />
        <Description key={id} text={def.description} />
        <div className="rs-insp__actions">
          <button className={`rs-btn${viewed ? ' is-on' : ''}`} onClick={() => ed.setViewed(fullId)} title="Show this node in the viewer">
            <Icon name={viewed ? 'eye' : 'eyeOff'} /> View
          </button>
          <button className={`rs-btn${node.bypass ? ' is-on' : ''}`} onClick={() => ed.toggleBypass(id)} title="Bypass (B)">
            <Icon name="power" /> Bypass
          </button>
          <button className="rs-btn rs-btn--icon rs-btn--danger" onClick={() => ed.deleteSelection()} title="Delete (Del)">
            <Icon name="trash" />
          </button>
        </div>
        {error && !missing.length && <p className={`rs-insp__err${isSetupNotice(error) ? ' is-info' : ''}`} role={isSetupNotice(error) ? 'status' : 'alert'}>{error}</p>}
        {missing.map((m) => (
          <div key={m.capability} className="rs-insp__req" role="note">
            <div className="rs-insp__reqhead"><Icon name="warn" size={16} /><strong>{m.label}</strong></div>
            <p>{m.explanation}</p>
            {m.command && <CopyCode text={m.command} />}
          </div>
        ))}
        {def.cpu && <p className="rs-insp__warn">Heavy CPU node: may be slow on large images.</p>}
      </div>
      {node.type === MEDIA_TIMELINE_ID && (
        <div className="rs-insp__sec">
          <div className="rs-caps">Edit</div>
          <div className="rs-insp__actions">
            <button className="rs-btn rs-btn--primary" onClick={() => ed.openTimeline(id)}>Open editor</button>
          </div>
          <p className="rs-insp__hint">Wire pictures into Clips and sounds into Sounds: each new wire is added at the end. Arrange, trim, fade and layer them in the strip under the graph.</p>
        </div>
      )}
      {isTimelineDef(def) && (
        <div className="rs-insp__sec">
          <div className="rs-caps">Timeline</div>
          <div className="rs-insp__actions">
            <button className="rs-btn rs-btn--primary" onClick={() => ed.openTimeline(id)}>Open timeline</button>
            <RecordButton nodeId={id} />
          </div>
          {!wired.has('recordAudio') && <button className="rs-btn" onClick={() => ed.addRecordSource(id, 'audio')}>Record microphone</button>}
          {!wired.has('recordMidi') && <button className="rs-btn" onClick={() => ed.addRecordSource(id, 'midi')}>Record keyboard</button>}
          {(!wired.has('recordAudio') || !wired.has('recordMidi')) && <p className="rs-insp__hint">Nothing is wired into the record inputs yet: these buttons add the source node and connect it. Then arm a track (the ● button) and press Record.</p>}
        </div>
      )}
      {node.type === GROUP_TYPE ? <GroupPanel node={node} /> : node.type === 'cache' ? <BakePanel node={node} /> : node.type === 'depth-ai' ? <DepthAiPanel node={node} /> : node.type === 'splat-train' ? <SplatTrainPanel node={node} /> : node.type === 'datamosh-real' ? <DatamoshPanel node={node} /> : node.type === 'style-transfer-ai' ? <StyleAiPanel node={node} /> : def.process ? <ProcessPanel node={node} /> : null}
      {hasSessionParam(def) && !missing.length && node.params.device !== 'this' && <PhonePanel node={node} />}
      {(node.type === 'phone-motion' || node.type === 'ar-camera') && !missing.length && <PhoneMotionPanel node={node} />}
      {node.type === 'camera-in' && <CameraPermissionPanel />}
      {node.type === 'media-in' && <FastCopyPanel node={node} />}
      {isLivePictureType(node.type) && !missing.length && <LiveRecordPanel fullId={fullId} />}
      {node.type === 'recorder' && <RecorderPanel fullId={fullId} params={node.params} />}
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
          <div className="rs-caps">{/^layers/i.test(d.label ?? '') ? d.label : `${isLayerType(d.type) ? 'Layers' : 'Inputs'}: ${d.label ?? port}`}</div>
          {isLayerType(d.type) && <p className="rs-insp__hint">Top of the list is drawn on top. Drag rows or use the arrows to reorder.</p>}
          <LayerList nodeId={id} port={port} type={d.type} variant="inspector" />
        </div>
      ))}
      <TransformReset node={node} def={def} wired={wired} />
      <ParamGroups
        node={node}
        def={def}
        wired={wired}
        pinned={pinned}
        onSelectSource={(port) => { const e = wired.get(port); if (e) ed.select([e.from.node]); }}
        label={(port) => {
          const e = wired.get(port);
          const src = e && nodes.find((n) => n.id === e.from.node);
          return src ? `${src.label || defOf(ed.registry, src)?.title || src.type}` : '';
        }}
        onDisconnect={(port) => {
          const e = wired.get(port);
          if (e) ed.disconnect(e.id);
        }}
      />
    </div>
  );
}

const RESETS: { kind: ResetKind; label: string; title: (t: Transform3d) => string }[] = [
  { kind: 'position', label: 'Reset position', title: () => 'Put it back in the middle of the picture' },
  { kind: 'rotation', label: 'Reset rotation', title: () => 'No rotation at all: every angle to 0 (new nodes start slightly turned so they look 3D; this removes that too)' },
  { kind: 'all', label: 'Reset all', title: () => 'Position to the middle, rotation to 0 and the size back to normal' },
];

/**
 * One-tap "zero it out" for nodes that place something in 3D (which nodes: lib/xform3d.ts). Rotation goes to a true 0, 0, 0, not to
 * the slightly turned pose new nodes start with. Each button is one undo step; settings driven by a wire are left alone.
 */
function TransformReset({ node, def, wired }: { node: NodeInstance; def: AnyNodeDef; wired: ReadonlyMap<string, unknown> }) {
  const { ed } = useApp();
  const t = useMemo(() => transformOf(def), [def]);
  if (!t) return null;
  const skip = new Set(wired.keys());
  const params: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(def.params as Record<string, ParamDef>)) params[k] = node.params[k] ?? p.default;
  return (
    <div className="rs-insp__sec" data-xform-reset>
      <div className="rs-caps">Place in 3D</div>
      <div className="rs-insp__actions">
        {RESETS.map((r) => {
          const patch = resetPatch(t, r.kind, skip);
          return (
            <button key={r.kind} className="rs-btn" title={r.title(t)} disabled={patchIsNoop(params, patch)} onClick={() => ed.setParams(node.id, patch, `xreset:${node.id}:${r.kind}`)}>
              {r.label}
            </button>
          );
        })}
      </div>
      {t.kind === 'object' && <p className="rs-insp__hint">You can also drag the object on the picture: select this node and use Move, Turn and Size in the viewer.</p>}
    </div>
  );
}

/** Params whose default is a plain setting, so "back to the default" is safe to offer in one tap (files, drawn data and code are left out: they are work, not a setting). */
function canResetParam(p: ParamDef): boolean {
  return p.type !== 'assets' && p.type !== 'json' && !(p.type === 'string' && (p.kind === 'code' || p.multiline));
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
      try { if (p.visibleIf && !p.visibleIf(node.params)) continue; } catch { /* keep it */ }
      let g = out.find((x) => x.name === (p.group ?? ''));
      if (!g) out.push((g = { name: p.group ?? '', items: [] }));
      g.items.push([key, p]);
    }
    return out;
  }, [def, node.params]);

  const bundles = useMemo(() => paramBundles(def), [def]);
  if (!groups.length) return <div className="rs-insp__sec"><p className="rs-insp__hint">This node has no parameters.</p></div>;
  // A node with a very long inspector (SDF 3D has about a hundred settings) starts with its groups closed, except the shape slots that are switched on.
  const big = groups.reduce((n, g) => n + g.items.length, 0) > 60;
  const autoClosed = (name: string): boolean => {
    if (hasKind(def) && String(node.params.kind ?? 'auto') === 'auto' && AUTO_COLLAPSED.includes(name)) return true;
    if (!big || !name) return false;
    const slot = /^Shape (\d+)$/.exec(name);
    return slot ? node.params[`shape${slot[1]}`] === 'off' : true;
  };
  const isClosed = (name: string): boolean => collapsed[name] ?? autoClosed(name);
  return (
    <>
      {groups.map((g) => (
        <div key={g.name} className="rs-insp__sec">
          {g.name && (
            <button className="rs-insp__group" aria-expanded={!isClosed(g.name)} onClick={() => setCollapsed((c) => ({ ...c, [g.name]: !(c[g.name] ?? autoClosed(g.name)) }))}>
              <Icon name={isClosed(g.name) ? 'chevronRight' : 'chevronDown'} size={12} />
              <span className="rs-caps">{g.name}</span>
            </button>
          )}
          {!isClosed(g.name) &&
            g.items.map(([key, p]) => {
              // a bundle socket sits right above its first setting; a vector wire on it also drives the settings without a wire of their own
              const starts = bundles.find((b) => b.members[0] === key);
              const via = wired.has(key) ? undefined : bundles.find((b) => wired.has(b.port) && b.members.includes(key));
              return (
                <Fragment key={key}>
                  {starts && <BundleRow node={node} bundle={starts} isWired={wired.has(starts.port)} wiredFrom={label(starts.port)} onSelectSource={() => onSelectSource(starts.port)} onDisconnect={() => onDisconnect(starts.port)} />}
                  <ParamControl node={node} def={def} keyName={key} p={p} isWired={wired.has(key)} via={via} wiredFrom={label(via ? via.port : key)} pinned={pinned.includes(key)} onPin={(on) => setPin(node.id, key, on, pinned)} onSelectSource={() => onSelectSource(via ? via.port : key)} onDisconnect={() => onDisconnect(key)} />
                </Fragment>
              );
            })}
        </div>
      ))}
    </>
  );
}

/** The socket of a bundle (one vector wire for an X / Y / Z group of settings): a slim row, a drop target like every wireable setting. */
function BundleRow({ node, bundle, isWired, wiredFrom, onSelectSource, onDisconnect }: { node: NodeInstance; bundle: ParamBundle; isWired: boolean; wiredFrom: string; onSelectSource: () => void; onDisconnect: () => void }) {
  const axes = bundleAxes(bundle);
  const what = `${bundle.label} ${axes.split('').join(', ')}`;
  return (
    <div className="rs-insp__row rs-insp__bundle" title={`One vector wire sets ${what} together. A number wired into one of them still wins for that one.`} data-bundle-port={bundle.port} data-insp-sock="" data-node={node.id} data-port={bundle.port} data-dir="in" data-type="vector">
      <label className="rs-insp__label">
        <span className="rs-insp__dot rs-sock--vector" />
        <span className="rs-insp__lt">{bundle.label} <span className="rs-insp__axes">{axes}</span></span>
      </label>
      <div className="rs-insp__ctl">
        {isWired ? (
          <div className="rs-insp__wired">
            <Icon name="plug" size={13} />
            <button className="rs-insp__chip2" onClick={onSelectSource} title="Select the driving node">driven by {wiredFrom || 'a node'}</button>
            <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={onDisconnect} title="Disconnect and use the values below" aria-label="Disconnect"><Icon name="close" size={12} /></button>
          </div>
        ) : (
          <div className="rs-insp__bundlehint">one vector wire for all {axes.length}</div>
        )}
      </div>
    </div>
  );
}

function ParamControl({ node, def, keyName, p, isWired, via, wiredFrom, pinned, onPin, onSelectSource, onDisconnect }: { node: NodeInstance; def: AnyNodeDef; keyName: string; p: ParamDef; isWired: boolean; via?: ParamBundle; wiredFrom: string; pinned: boolean; onPin: (on: boolean) => void; onSelectSource: () => void; onDisconnect: () => void }) {
  const sockType = paramSocketType(def, keyName);
  const { ed, io } = useApp();
  const label = p.label ?? keyName;
  const value = node.params[keyName] ?? p.absent ?? p.default;
  const set = (v: unknown) => ed.setParam(node.id, keyName, v);
  const isCode = p.type === 'string' && p.kind === 'code';
  // one way to put ANY setting back, the same on every node: a small button beside the name once the value differs (and a double-click on the name)
  const changed = !isWired && canResetParam(p) && JSON.stringify(value) !== JSON.stringify(p.default);
  const resetParam = () => { if (changed) set(p.default); };
  const stacked = (p.type === 'vec2' && p.range) || p.type === 'curve' || p.type === 'palette' || p.type === 'assets' || p.type === 'json' || (p.type === 'string' && (p.multiline || p.kind === 'code'));

  let control: React.ReactNode;
  if (via && !isWired) {
    control = (
      <div className="rs-insp__wired" title="Driven by the vector wire of this group. Wire a number onto this row to set this one yourself.">
        <Icon name="plug" size={13} />
        <button className="rs-insp__chip2" onClick={onSelectSource} title="Select the driving node">from {wiredFrom || 'a node'} <span className="rs-insp__via">{'XYZ'[via.members.indexOf(keyName)]}</span></button>
      </div>
    );
  } else if (isWired) {
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
        control = <NumberField large name={label} askKey={`${node.id}:${keyName}`} softMax={p.softMax} scrubSpan={p.scrubSpan} value={value as number} min={p.min} max={p.max} step={p.step} unit={p.unit} integer={p.integer} defaultValue={p.default} onChange={set} />;
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
        control = REGISTRY_PARAMS.includes(keyName) && hasFfmpegOptions(p.options) ? <CodecSelect value={String(value)} options={p.options} onChange={set} label={label} /> : <SelectField large value={String(value)} options={p.options} onChange={set} label={label} />;
        break;
      case 'color':
        control = <ColorField large value={value as [number, number, number, number]} onChange={set} />;
        break;
      case 'string':
        control = p.kind === 'font' ? <FontField large value={String(value ?? '')} onChange={set} /> : p.kind === 'code' ? <CodeEditor value={String(value ?? '')} onChange={set} examples={p.examples} help={p.hint} defaultValue={p.default} /> : <TextField large multiline={p.multiline} value={String(value ?? '')} onChange={set} />;
        break;
      case 'vec2':
        control = p.range ? <RangeField nodeId={node.id} keyName={keyName} value={value as [number, number]} defaultValue={p.default} /> : <Vec2Field large value={value as [number, number]} min={p.min} max={p.max} step={p.step} unit={p.unit} defaultValue={p.default} onChange={set} />;
        break;
      case 'palette':
        control = <PaletteEditor value={value as [number, number, number][]} onChange={set} onStudio={() => { ed.studioTarget = { nodeId: node.id, key: keyName }; ed.openDialog('palette'); }} />;
        break;
      case 'assets':
        control = <AssetsEditor value={value as string[]} accept={p.accept} onChange={set} />;
        break;
      case 'curve':
        control = <CurveField large nodeId={node.id} keyName={keyName} label={label} value={value} min={p.min} max={p.max} />;
        break;
      case 'device':
        control = <DeviceField large value={String(value ?? '')} kind={p.device} onChange={set} />;
        break;
      case 'json':
        control = keyName === 'pattern' && looksLikeDrumPattern(value) ? <DrumGrid nodeId={node.id} keyName={keyName} value={value} /> : <JsonEditor value={value} onChange={set} empty={JSON_EMPTY[keyName] ?? 'Empty'} />;
        break;
    }
  }
  return (
    <div className={`rs-insp__row${stacked ? ' is-stacked' : ''}`} title={isCode ? undefined : p.hint} data-param-node={node.id} data-param-key={keyName} {...(sockType ? { 'data-insp-sock': '', 'data-node': node.id, 'data-port': keyName, 'data-dir': 'in', 'data-type': sockType } : {})}>
      <label className="rs-insp__label">
        <button className={`rs-insp__pin${pinned ? ' is-on' : ''}`} aria-pressed={pinned} title={pinned ? 'Shown on the node: click to hide' : 'Show on the node'} onClick={() => onPin(!pinned)}><Icon name="pin" size={12} /></button>
        {sockType && <span className={`rs-insp__dot rs-sock--${sockType}`} title="Drag a wire from a node's output onto this row to drive it" />}
        <span className="rs-insp__lt" onDoubleClick={resetParam}>{label}</span>
        {changed && <button type="button" className="rs-insp__reset" title="Back to the default value" aria-label={`Reset ${label} to its default`} onClick={(e) => { e.preventDefault(); resetParam(); }}><Icon name="undo" size={12} /></button>}
      </label>
      <div className="rs-insp__ctl">{control}</div>
      {p.hint && !isCode && <div className="rs-insp__phint">{p.hint}</div>}
    </div>
  );
}
