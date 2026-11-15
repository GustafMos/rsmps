import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORIES } from '../../engine/types';
import type { AnyNodeDef, InputSchema, NodeInstance, OutputSchema, ParamDef, SocketType } from '../../engine/types';
import { Icon } from '../components/Icon';
import { NumberField } from '../components/NumberField';
import { CheckField, ColorField, SelectField, TextField, Vec2Field } from '../components/fields';
import { hexOf } from '../lib/drag';
import { inboundSignature, layoutNode, parsePortSignature, portSignature, HEAD_H, ROW_H, SUMMARY_H, type ParamRow, type Row } from '../lib/layout';
import { useApp, useDef, useEd, usePlayer } from '../store/context';
import './node.css';

const catColor = (def: AnyNodeDef | undefined) => (def ? (CATEGORIES[def.category]?.color ?? '#7f8c9b') : '#ff5c6c');

function Socket({ node, port, type, dir }: { node: string; port: string; type: SocketType; dir: 'in' | 'out' }) {
  return <span className={`rs-sock rs-sock--${type} rs-sock--${dir}`} data-sock data-node={node} data-port={port} data-dir={dir} data-type={type} />;
}

export const NodeView = memo(function NodeView({ node }: { node: NodeInstance }) {
  const { ed, graphCtl } = useApp();
  const def = useDef(node.type);
  const selected = useEd((s) => s.selection.includes(node.id));
  const viewed = useEd((s) => s.viewedNodeId === node.id);
  const wiredSig = useEd((s) => inboundSignature(s.graph.edges, node.id));
  const portSig = useEd((s) => (def ? '|' : portSignature(s.graph.edges, node.id)));
  const debug = useEd((s) => s.prefs.debug);
  const error = usePlayer((s) => s.errors.get(node.id));
  const wired = useMemo(() => new Set(wiredSig ? wiredSig.split(',') : []), [wiredSig]);
  const layout = layoutNode(node, def, def ? undefined : parsePortSignature(portSig));
  const [renaming, setRenaming] = useState(false);
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const e = el.current;
    if (!e) return;
    graphCtl.nodeEls.set(node.id, e);
    return () => {
      if (graphCtl.nodeEls.get(node.id) === e) graphCtl.nodeEls.delete(node.id);
    };
  }, [graphCtl, node.id]);

  const summary = useMemo(() => {
    if (!def?.summary) return '';
    try {
      const params: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(def.params as Record<string, ParamDef>)) params[k] = node.params[k] ?? p.default;
      return def.summary(params);
    } catch {
      return '';
    }
  }, [def, node.params]);

  const title = node.label || def?.title || node.type;
  const missing = !def;
  const hasAudioOut = !!def && Object.values(def.outputs as OutputSchema).some((o) => o.type === 'audio');

  return (
    <div
      ref={el}
      className={`rs-node${selected ? ' is-selected' : ''}${viewed ? ' is-viewed' : ''}${node.bypass ? ' is-bypassed' : ''}${missing ? ' rs-node--missing' : ''}${error ? ' has-error' : ''}${node.collapsed ? ' is-collapsed' : ''}`}
      data-node-id={node.id}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: layout.width, height: layout.height, ['--cat' as string]: catColor(def) }}
    >
      <div className="rs-node__head" data-node-head>
        <button
          className="rs-node__hbtn rs-node__chev"
          data-nodrag
          title={node.collapsed ? 'Expand (H)' : 'Collapse (H)'}
          onClick={() => ed.toggleCollapse([node.id])}
        >
          <Icon name={node.collapsed ? 'chevronRight' : 'chevronDown'} size={12} />
        </button>
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
        {error && (
          <span className="rs-node__err" data-nodrag title={error}>
            <Icon name="warn" size={13} />
          </span>
        )}
        {debug && <NodeTiming id={node.id} />}
        <button
          className={`rs-node__hbtn${node.bypass ? ' is-on' : ''}`}
          data-nodrag
          title={node.bypass ? 'Bypassed: click to enable (B)' : 'Bypass this node (B)'}
          onClick={() => ed.toggleBypass(node.id)}
        >
          <Icon name="power" size={13} />
        </button>
        <button
          className={`rs-node__hbtn rs-node__eye${viewed ? ' is-on' : ''}`}
          data-nodrag
          title="View this node in the viewer (Ctrl+Shift+click)"
          onClick={() => ed.setViewed(node.id)}
        >
          <Icon name={viewed ? 'eye' : 'eyeOff'} size={14} />
        </button>
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

      {!node.collapsed && summary && layout.summaryY !== null && (
        <div className="rs-node__summary" style={{ top: layout.summaryY, height: SUMMARY_H }} title={summary}>
          {summary}
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

function NodeTiming({ id }: { id: string }) {
  const t = usePlayer((s) => s.timings.get(id));
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
            <Socket node={node.id} port={row.input.port} type={row.input.type} dir="in" />
            <span className="rs-row__label">{row.input.label}</span>
          </>
        )}
        {row.output && (
          <>
            <span className="rs-row__label rs-row__label--out">{row.output.label}</span>
            <Socket node={node.id} port={row.output.port} type={row.output.type} dir="out" />
          </>
        )}
      </div>
    );
  }
  if (row.kind === 'more') {
    return (
      <button className="rs-row rs-row--more" data-nodrag style={{ top: row.y, height: ROW_H }} onClick={() => ed.select([node.id])} title="Open the inspector for all parameters">
        {row.count} more…
      </button>
    );
  }
  return <ParamRowView row={row} node={node} isWired={wired.has(row.key)} />;
}

function ParamRowView({ row, node, isWired }: { row: ParamRow; node: NodeInstance; isWired: boolean }) {
  const { ed } = useApp();
  const p = row.def;
  const label = p.label ?? row.key;
  const value = node.params[row.key] ?? p.default;
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
        control = <NumberField label={label} value={value as number} min={p.min} max={p.max} step={p.step} unit={p.unit} integer={p.integer} defaultValue={p.default} onChange={set} title={p.hint} />;
        break;
      case 'bool':
        control = <CheckField label={label} value={!!value} onChange={set} title={p.hint} />;
        break;
      case 'enum':
        control = (
          <div className="rs-row__pair">
            <span className="rs-row__label">{label}</span>
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
            <span className="rs-row__label">{label}</span>
            <TextField value={String(value ?? '')} onChange={set} />
          </div>
        );
        break;
      case 'vec2':
        control = <Vec2Field value={value as [number, number]} min={p.min} max={p.max} step={p.step} unit={p.unit} defaultValue={p.default} onChange={set} />;
        break;
      case 'palette': {
        const colors = (Array.isArray(value) ? value : []) as number[][];
        control = (
          <div className="rs-row__pair">
            <span className="rs-row__label">{label}</span>
            <div className="rs-row__palette" title={`${colors.length} colours`}>
              {colors.slice(0, 16).map((c, i) => (
                <span key={i} style={{ background: hexOf(c) }} />
              ))}
            </div>
          </div>
        );
        break;
      }
      case 'assets': {
        const n = Array.isArray(value) ? value.length : 0;
        control = (
          <div className="rs-row__pair">
            <span className="rs-row__label">{label}</span>
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
    <div className="rs-row rs-row--param" style={{ top: row.y, height: ROW_H }}>
      {row.socket && <Socket node={node.id} port={row.key} type={row.socket} dir="in" />}
      {control}
    </div>
  );
}
