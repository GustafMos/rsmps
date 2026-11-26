import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORIES } from '../../engine/types';
import { defOf, GROUP_INPUT_TYPE, GROUP_TYPE, isBoundaryNode, NEW_PORT, PATH_SEP } from '../../engine/group';
import type { AnyNodeDef, InputSchema, NodeInstance, OutputSchema, ParamDef, SocketType } from '../../engine/types';
import { Icon, type IconName } from '../components/Icon';
import { KIND_ICON, kindOptions } from '../lib/outputInfo';
import { NumberField } from '../components/NumberField';
import { CheckField, ColorField, SelectField, TextField, Vec2Field } from '../components/fields';
import { hexOf } from '../lib/drag';
import { paletteInputPort } from '../lib/sockets';
import { PaletteHint } from '../components/PaletteHint';
import { DeviceField } from '../components/DeviceField';
import { FontField } from '../components/FontField';
import { CurveField } from '../components/CurveField';
import { RangeField } from '../components/RangeField';
import { LayerList } from './LayerList';
import { FamilySelect } from '../components/FamilySelect';
import { missingCapabilities } from '../lib/requirements';
import { PhoneChip, hasSessionParam } from '../inspector/PhonePanel';
import { frameSize, hasFrameParams } from '../viewer/FrameControl';
import { useKeyboardTarget } from '../playKeys';
import { LAYER_H, inboundSignature, multiCounts, layoutNode, parsePortSignature, portSignature, HEAD_H, ROW_H, SUMMARY_H, type ParamRow, type Row } from '../lib/layout';
import { useApp, useDef, useEd, usePlayer } from '../store/context';
import { useSelector } from '../store/createStore';
import { nodeViewStore, toggleExpanded } from '../store/nodeView';
import { bakeStatusOf } from '../lib/bake';
import { frozenIds, statusDeps } from '../store/bake';
import { isActiveJob, processBadge } from '../lib/process';
import { jobOf, processStore } from '../store/processes';
import './node.css';
import './bake.css';
import '../layers.css';

const catColor = (def: AnyNodeDef | undefined) => (def ? (CATEGORIES[def.category]?.color ?? '#7f8c9b') : '#ff5c6c');

function Socket({ node, port, type, dir, wired }: { node: string; port: string; type: SocketType; dir: 'in' | 'out'; wired?: boolean }) {
  return <span className={`rs-sock rs-sock--${type} rs-sock--${dir}${wired ? ' is-wired' : ''}`} data-sock data-node={node} data-port={port} data-dir={dir} data-type={type} />;
}

/** Full path id of a node of the shown level (what the viewer, the engine and processes use). */
const pathId = (path: readonly string[], id: string) => (path.length ? [...path, id].join(PATH_SEP) : id);

export const NodeView = memo(function NodeView({ node }: { node: NodeInstance }) {
  const { ed, graphCtl } = useApp();
  const regDef = useDef(node.type);
  // groups and the boundary of an open group get their ports and params from their own params
  const def = useMemo(() => defOf({ get: () => regDef }, node) ?? regDef, [regDef, node]);
  const isGroup = node.type === GROUP_TYPE;
  const boundary = isBoundaryNode(node);
  const fullId = useEd((s) => pathId(s.path, node.id));
  const selected = useEd((s) => s.selection.includes(node.id));
  const viewed = useEd((s) => s.viewedNodeId === pathId(s.path, node.id));
  const wiredSig = useEd((s) => inboundSignature(s.level.edges, node.id));
  const portSig = useEd((s) => (def ? '|' : portSignature(s.level.edges, node.id)));
  const debug = useEd((s) => s.prefs.debug);
  const rawError = usePlayer((s) => s.errors.get(fullId));
  const { io } = useApp();
  const missingReq = useMemo(() => missingCapabilities(io, def), [io, def]);
  // one clear message instead of the raw engine error when the app cannot run this node here
  const error = missingReq.length ? (rawError ? missingReq[0].explanation : undefined) : rawError;
  const wired = useMemo(() => new Set(wiredSig ? wiredSig.split(',') : []), [wiredSig]);
  const palPort = def ? paletteInputPort(def) : null;
  const hint = !!palPort && !wired.has(palPort);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    if (def) for (const p of Object.keys(multiCounts(def, [], node.id))) m[p] = wiredSig.split(',').filter((x) => x === p).length;
    return m;
  }, [def, wiredSig, node.id]);
  const pinned = useSelector(nodeViewStore, (s) => s.pins[node.id]);
  const expanded = useSelector(nodeViewStore, (s) => !!s.expanded[node.id]);
  const view = useMemo(() => ({ pinned, expanded, wired: def ? [...wired].filter((k) => k in def.params) : [] }), [pinned, expanded, wired, def]);
  const layout = layoutNode(node, def, def ? undefined : parsePortSignature(portSig), hint, counts, view);
  const [renaming, setRenaming] = useState(false);
  const kbd = useKeyboardTarget() === node.id;
  const hasEnabled = !!def && def.category === 'output' && 'enabled' in def.params;
  const exportOff = hasEnabled && node.params.enabled === false;
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail === node.id) setRenaming(true); };
    window.addEventListener('rsmps:rename', on);
    return () => window.removeEventListener('rsmps:rename', on);
  }, [node.id]);

  useEffect(() => {
    const e = el.current;
    if (!e) return;
    graphCtl.nodeEls.set(node.id, e);
    return () => {
      if (graphCtl.nodeEls.get(node.id) === e) graphCtl.nodeEls.delete(node.id);
    };
  }, [graphCtl, node.id]);

  // Loop snapping: a summary can say when the loop switch changed a typed value ("speed 2 → 3 to loop"); it gets the project's loop / length / rate.
  const clockKey = useEd((st) => `${st.level.project.loop ? 1 : 0}|${Math.max(1, Math.round(st.level.project.duration * st.level.project.fps))}|${st.level.project.fps}`);
  const summary = useMemo(() => {
    if (!def?.summary) return '';
    try {
      const params: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(def.params as Record<string, ParamDef>)) params[k] = node.params[k] ?? p.absent ?? p.default;
      const [lp, fr, fp] = clockKey.split('|').map(Number);
      return def.summary(params, wired, { loop: lp === 1, frames: fr, fps: fp });
    } catch {
      return '';
    }
  }, [def, node.params, wired, clockKey]);

  const frameTxt = useEd((s) => (hasFrameParams(def) ? (() => { const z = frameSize(s.level.project, node); return `${z.width}×${z.height}`; })() : ''));
  const title = node.label || def?.title || node.type;
  const missing = !def;
  const hasAudioOut = !!def && Object.values(def.outputs as OutputSchema).some((o) => o.type === 'audio');
  // Cache / Bake: a small grey badge (baked / stale / baking N%), and a dimmed look for everything a bake has made unnecessary.
  const app = useApp();
  const isCache = node.type === 'cache';
  const hasProcess = !!def?.process;
  const activeProject = useEd((s) => s.activeProject) ?? 'project';
  // Process mode: the scheduler's job for this node (null for nodes without a process: no work at all for them).
  const job = useSelector(processStore, (s) => (hasProcess ? jobOf(s.jobs, activeProject, fullId) : null));
  const bakeFraction = isCache && isActiveJob(job) ? job!.progress : undefined;
  const bake = useEd((s) => (isCache ? bakeStatusOf(s.level, node, statusDeps(app, s.level, bakeFraction === undefined ? null : { fraction: bakeFraction })) : null), (a, b) => a?.badge === b?.badge && a?.kind === b?.kind);
  // Other process nodes: queued / % / done / stale / failed / lost.
  const pbadge = useEd(
    (s) => (hasProcess && !isCache ? processBadge(def!.process!.title, app.io.processes.status(s.graph, pathId(s.path, node.id))?.state ?? 'none', job) : null),
    (a, b) => a?.text === b?.text && a?.kind === b?.kind,
  );
  const processing = isActiveJob(job);
  const frozen = useEd((s) => !s.path.length && frozenIds(app, s.graph).has(node.id));

  return (
    <div
      ref={el}
      className={`rs-node${isGroup ? ' rs-node--group' : ''}${boundary ? ' rs-node--boundary' : ''}${selected ? ' is-selected' : ''}${viewed ? ' is-viewed' : ''}${node.bypass ? ' is-bypassed' : ''}${missing ? ' rs-node--missing' : ''}${error ? ' has-error' : ''}${node.collapsed ? ' is-collapsed' : ''}${exportOff ? ' is-notexported' : ''}${frozen ? ' is-frozen' : ''}${processing ? ' is-processing' : ''}`}
      data-node-id={node.id}
      title={frozen ? 'Frozen: everything after this node is baked, so it is not calculated any more' : undefined}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: layout.width, height: layout.height, ['--cat' as string]: catColor(def) }}
    >
      {exportOff && <span className="rs-node__off">not exported</span>}
      {kbd && <span className="rs-node__kbd" title="Computer keys play this node. Esc or deselect to release.">Keyboard plays this node</span>}
      <div className="rs-node__head" data-node-head>
        <button
          className="rs-node__hbtn rs-node__chev"
          data-nodrag
          title={node.collapsed ? 'Expand (H)' : 'Collapse (H)'}
          onClick={() => ed.toggleCollapse([node.id])}
        >
          <Icon name={node.collapsed ? 'chevronRight' : 'chevronDown'} size={16} />
        </button>
        {isGroup && (
          <button className="rs-node__hbtn rs-node__stack" data-nodrag title="A group: double-click (or Tab) to open it" aria-label="Open group" onClick={() => ed.enterGroup(node.id)}>
            <Icon name="stack" size={16} />
          </button>
        )}
        {renaming ? (
          <input
            className="rs-node__rename"
            data-nodrag
            autoFocus
            defaultValue={node.label ?? ''}
            placeholder={def?.title ?? node.type}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim();
              setRenaming(false);
              if (v !== (node.label ?? '')) ed.setNode(node.id, { label: v || undefined });
            }}
          />
        ) : (
          <span className="rs-node__title" onDoubleClick={() => setRenaming(true)} title={def ? def.description : `Missing node type "${node.type}". Install the plugin that provides it.`}>
            {title}
          </span>
        )}
        {missingReq.length > 0 && (
          <span className="rs-node__req" data-nodrag title={`${missingReq[0].label}: ${missingReq[0].explanation}`} aria-label={missingReq[0].label}>
            <Icon name="warn" size={16} />
          </span>
        )}
        {error && !missingReq.length && (
          <span className="rs-node__err" data-nodrag title={error} aria-label={`Error: ${error}`}>
            <Icon name="warn" size={16} />
          </span>
        )}
        {bake?.badge && (
          <span className="rs-node__bake rs-num" data-nodrag data-kind={bake.kind} style={bakeFraction !== undefined ? ({ ['--p' as string]: `${Math.round(bakeFraction * 100)}%` }) : undefined} title={bake.text}>
            {bake.badge}
          </span>
        )}
        {pbadge && (
          <span className="rs-node__bake rs-node__proc rs-num" data-nodrag data-kind={pbadge.kind} style={processing ? ({ ['--p' as string]: `${Math.round((job?.progress ?? 0) * 100)}%` }) : undefined} title={pbadge.title}>
            {pbadge.text}
          </span>
        )}
        {debug && <NodeTiming id={fullId} group={isGroup} />}
        {hasEnabled && (
          <button className={`rs-node__hbtn rs-node__exp${exportOff ? '' : ' is-on'}`} data-nodrag title={exportOff ? 'Excluded from export: click to include' : 'Included in export: click to exclude'} aria-label={exportOff ? 'Excluded from export' : 'Included in export'} aria-pressed={!exportOff} onClick={() => ed.setParam(node.id, 'enabled', exportOff)}>
            <Icon name="exportBox" size={16} />
          </button>
        )}
        {!boundary && <button
          className={`rs-node__hbtn${node.bypass ? ' is-on' : ''}`}
          data-nodrag
          title={node.bypass ? 'Bypassed: click to enable (B)' : 'Bypass (B)'}
          aria-label="Bypass"
          aria-pressed={!!node.bypass}
          onClick={() => ed.toggleBypass(node.id)}
        >
          <Icon name="bypass" size={16} />
        </button>}
        {!boundary && <button
          className={`rs-node__hbtn rs-node__eye${viewed ? ' is-on' : ''}`}
          data-nodrag
          title="View this node (Ctrl+Shift+click)"
          aria-label="View this node"
          aria-pressed={viewed}
          onClick={() => ed.setViewed(fullId)}
        >
          <Icon name="monitor" size={16} />
        </button>}
        {hasAudioOut && <Meter id={node.id} />}
      </div>

      {node.collapsed
        ? (
          <>
            {def && Object.entries(def.inputs as InputSchema).slice(0, 1).map(([port, d]) => <Socket key={port} node={node.id} port={port} type={d.type} dir="in" />)}
            {def && Object.entries(def.outputs as OutputSchema).slice(0, 1).map(([port, d]) => <Socket key={port} node={node.id} port={port} type={d.type} dir="out" />)}
          </>
        )
        : layout.rows.map((row, i) => <RowView key={i} row={row} node={node} wired={wired} />)}

      {!node.collapsed && hasSessionParam(def) && layout.summaryY !== null && <div style={{ position: 'absolute', left: 0, right: 0, top: layout.summaryY, height: SUMMARY_H }}><PhoneChip node={node} /></div>}
      {!node.collapsed && summary && layout.summaryY !== null && !hasSessionParam(def) && (
        <div className="rs-node__summary" style={{ top: layout.summaryY, height: SUMMARY_H }} title={summary}>
          {frameTxt ? `${frameTxt} · ${summary}` : summary}
        </div>
      )}
      {error && !node.collapsed && <div className="rs-node__errtext" role="alert" title={error}>{error}</div>}
      {boundary && (
        <div className="rs-row rs-row--io rs-node__newport" style={{ top: layout.height + 2, height: ROW_H }} title={node.type === GROUP_INPUT_TYPE ? 'Drag a wire from an inner input here to add a group input' : 'Drag a wire from an inner output here to add a group output'}>
          {node.type === GROUP_INPUT_TYPE ? (
            <>
              <span className="rs-row__label rs-row__label--out">+ input</span>
              <Socket node={node.id} port={NEW_PORT} type="image" dir="out" />
            </>
          ) : (
            <>
              <Socket node={node.id} port={NEW_PORT} type="image" dir="in" />
              <span className="rs-row__label">+ output</span>
            </>
          )}
        </div>
      )}
      {missing && !node.collapsed && (
        <div className="rs-node__missing" style={{ top: HEAD_H + 6 + ROW_H * Math.max(1, layout.rows.length) }}>
          Missing node type
        </div>
      )}
    </div>
  );
});

function KindSelect({ node }: { node: NodeInstance }) {
  const { ed } = useApp();
  const def = useDef(node.type)!;
  const value = String(node.params.kind ?? 'auto');
  return (
    <div className="rs-nodekind" data-nodrag>
      <Icon name={(KIND_ICON as Record<string, IconName>)[value] ?? 'file'} size={14} />
      <SelectField value={value} options={kindOptions(def)} onChange={(v) => ed.setParam(node.id, 'kind', v)} label="Export type" title="What this output writes" />
    </div>
  );
}

function NodeTiming({ id, group }: { id: string; group?: boolean }) {
  // a group's time is the sum of what rendered inside it
  const t = usePlayer((s) => {
    if (!group) return s.timings.get(id);
    let sum: number | undefined;
    const prefix = id + PATH_SEP;
    s.timings.forEach((v, k) => {
      if (k.startsWith(prefix)) sum = (sum ?? 0) + v;
    });
    return sum === undefined ? undefined : Math.round(sum * 10) / 10;
  });
  return t === undefined ? null : <span className="rs-node__ms rs-num">{t}ms</span>;
}

function Meter({ id }: { id: string }) {
  const { io } = useApp();
  const a = useRef<HTMLSpanElement>(null);
  const b = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const m = io.player.meter(id);
      if (a.current) a.current.style.width = `${Math.min(1, m?.[0] ?? 0) * 100}%`;
      if (b.current) b.current.style.width = `${Math.min(1, m?.[1] ?? 0) * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [io, id]);
  return (
    <span className="rs-node__meter" aria-hidden="true">
      <span ref={a} />
      <span ref={b} />
    </span>
  );
}

function RowView({ row, node, wired }: { row: Row; node: NodeInstance; wired: Set<string> }) {
  const { ed } = useApp();
  if (row.kind === 'io') {
    return (
      <div className="rs-row rs-row--io" style={{ top: row.y, height: ROW_H }}>
        {row.input && (
          <>
            {!row.input.multi && <Socket node={node.id} port={row.input.port} type={row.input.type} dir="in" wired={wired.has(row.input.port)} />}
            <span className="rs-row__label" title={row.input.label}>{row.input.label}</span>
          </>
        )}
        {row.output && (
          <>
            <span className="rs-row__label rs-row__label--out" title={row.output.label}>{row.output.label}</span>
            <Socket node={node.id} port={row.output.port} type={row.output.type} dir="out" />
          </>
        )}
      </div>
    );
  }
  if (row.kind === 'more') {
    return (
      <button className="rs-row rs-row--more" data-nodrag data-more-row={node.id} style={{ top: row.y, height: ROW_H }} onClick={() => toggleExpanded(node.id)} title={row.expanded ? 'Show only the pinned parameters' : 'Show all parameters on the node (drop a wire here to pick one)'}>
        {row.expanded ? 'Show fewer' : `${row.count} more…`}
      </button>
    );
  }
  if (row.kind === 'kind') {
    return (
      <div className="rs-row" style={{ top: row.y, height: ROW_H + 2 }}>
        <KindSelect node={node} />
      </div>
    );
  }
  if (row.kind === 'family') {
    return (
      <div className="rs-row" style={{ top: row.y, height: ROW_H + 2 }}>
        <FamilySelect node={node} />
      </div>
    );
  }
  if (row.kind === 'layers') {
    return (
      <div className="rs-row rs-row--layers" style={{ top: row.y, height: (row.count + 1) * LAYER_H }}>
        <LayerList nodeId={node.id} port={row.port} type={row.type} variant="node" />
      </div>
    );
  }
  if (row.kind === 'hint') {
    return (
      <div className="rs-row rs-row--hint" style={{ top: row.y, height: 56 }}>
        <PaletteHint nodeId={node.id} compact />
      </div>
    );
  }
  return <ParamRowView row={row} node={node} isWired={wired.has(row.key)} />;
}

function ParamRowView({ row, node, isWired }: { row: ParamRow; node: NodeInstance; isWired: boolean }) {
  const { ed } = useApp();
  const p = row.def;
  const label = p.label ?? row.key;
  const value = node.params[row.key] ?? p.absent ?? p.default;
  const set = (v: unknown) => ed.setParam(node.id, row.key, v);
  let control: React.ReactNode;
  if (isWired) {
    control = (
      <div className="rs-row__wired" title="Driven by a connected node">
        <span>{label}</span>
        <Icon name="plug" size={12} />
      </div>
    );
  } else {
    switch (p.type) {
      case 'number':
        control = <NumberField label={label} value={value as number} min={p.min} max={p.max} softMax={p.softMax} scrubSpan={p.scrubSpan} askKey={`${node.id}:${row.key}`} step={p.step} unit={p.unit} integer={p.integer} defaultValue={p.default} onChange={set} title={p.hint} />;
        break;
      case 'bool':
        control = <CheckField label={label} value={!!value} onChange={set} title={p.hint} />;
        break;
      case 'enum':
        control = (
          <div className="rs-row__pair">
            <span className="rs-row__label" title={label}>{label}</span>
            <SelectField value={String(value)} options={p.options} onChange={set} label={label} title={p.hint} />
          </div>
        );
        break;
      case 'color':
        control = <ColorField label={label} value={value as [number, number, number, number]} onChange={set} />;
        break;
      case 'string':
        control = (
          <div className="rs-row__pair">
            <span className="rs-row__label" title={label}>{label}</span>
            {p.kind === 'font' ? <FontField value={String(value ?? '')} onChange={set} /> : p.kind === 'code' ? <span className="rs-row__label" title="Edit the code in the Inspector">{String(value ?? '').split('\n').length} lines · edit in Inspector</span> : <TextField value={String(value ?? '')} onChange={set} />}
          </div>
        );
        break;
      case 'vec2':
        control = p.range ? <RangeField compact nodeId={node.id} keyName={row.key} value={value as [number, number]} defaultValue={p.default} /> : <Vec2Field value={value as [number, number]} min={p.min} max={p.max} step={p.step} unit={p.unit} defaultValue={p.default} onChange={set} />;
        break;
      case 'palette': {
        const colors = (Array.isArray(value) ? value : []) as number[][];
        control = (
          <div className="rs-row__pair">
            <span className="rs-row__label" title={label}>{label}</span>
            <div className="rs-row__palette" title={`${colors.length} colors`}>
              {colors.slice(0, 16).map((c, i) => (
                <span key={i} style={{ background: hexOf(c) }} />
              ))}
            </div>
          </div>
        );
        break;
      }
      case 'curve':
        control = (
          <div className="rs-row__pair">
            <span className="rs-row__label" title={label}>{label}</span>
            <CurveField nodeId={node.id} keyName={row.key} label={label} value={value} min={p.min} max={p.max} />
          </div>
        );
        break;
      case 'device':
        control = (
          <div className="rs-row__pair">
            <span className="rs-row__label" title={label}>{label}</span>
            <DeviceField value={String(value ?? '')} kind={p.device} onChange={set} hint={false} />
          </div>
        );
        break;
      case 'assets': {
        const n = Array.isArray(value) ? value.length : 0;
        control = (
          <div className="rs-row__pair">
            <span className="rs-row__label" title={label}>{label}</span>
            <span className="rs-row__count rs-num">{n === 0 ? 'none' : `${n} file${n > 1 ? 's' : ''}`}</span>
          </div>
        );
        break;
      }
      default:
        control = null;
    }
  }
  return (
    <div className="rs-row rs-row--param" data-param-key={row.key} style={{ top: row.y, height: ROW_H }}>
      {row.socket && <Socket node={node.id} port={row.key} type={row.socket} dir="in" wired={isWired} />}
      {control}
    </div>
  );
}
