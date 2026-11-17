import { useMemo, useState } from 'react';
import { CATEGORIES, type Category, type NodeInstance } from '../../engine/types';
import { exposableParams, groupBakeProblem, groupData } from '../../engine/group';
import { Icon } from '../components/Icon';
import { TextField } from '../components/fields';
import { useApp, useEd } from '../store/context';
import { useSelector } from '../store/createStore';
import { jobOf, processStore } from '../store/processes';
import { bakeGroup, clearGroupBake } from '../store/bake';
import { cancelProcess } from '../store/processes';
import { isActiveJob } from '../lib/process';
import { downloadText, nodeFileName } from '../dialogs/GroupDialogs';

/**
 * Inspector of a group node: title, colour stripe, description; open / ungroup / save as node / export; the group's bake (cache region);
 * its ports (rename) and the "Exposed" editor (add from a searchable list of the inner params, rename, reorder, remove). The exposed params
 * themselves are edited below like any param (they are the group's own params).
 */
export function GroupPanel({ node }: { node: NodeInstance }) {
  const app = useApp();
  const { ed, io } = app;
  const d = groupData(node);
  const fullId = useEd((s) => (s.path.length ? [...s.path, node.id].join('/') : node.id));
  const project = useEd((s) => s.activeProject) ?? 'project';
  const job = useSelector(processStore, (s) => jobOf(s.jobs, project, fullId));
  const state = useEd((s) => io.processes.status(s.graph, fullId)?.state ?? 'none');
  const running = isActiveJob(job);
  const bakeProblem = groupBakeProblem(d);
  const [query, setQuery] = useState('');
  const candidates = useMemo(() => {
    const taken = new Set(d.exposed.map((x) => `${x.node}:${x.param}`));
    const q = query.trim().toLowerCase();
    return exposableParams(node, io.registry)
      .filter((c) => !taken.has(`${c.node}:${c.param}`))
      .filter((c) => !q || `${c.nodeLabel} ${c.label} ${c.param}`.toLowerCase().includes(q))
      .slice(0, 40);
  }, [node, io, d.exposed, query]);
  const move = (id: string, delta: number) => {
    const order = d.exposed.map((x) => x.id);
    const i = order.indexOf(id);
    const j = Math.max(0, Math.min(order.length - 1, i + delta));
    if (i === j) return;
    order.splice(i, 1);
    order.splice(j, 0, id);
    ed.editExposed(node.id, { order });
  };
  const bakeText: Record<string, string> = {
    none: 'Not baked: the nodes inside are calculated live.',
    done: 'Baked: the group serves its stored frames; nothing inside (or before it) is calculated.',
    stale: 'Stale: something inside or before the group changed. It is live again until you bake once more.',
    missing: 'The stored frames are gone (cleared storage?). The group is live. Bake it again.',
    failed: 'The last bake failed.',
    queued: 'Waiting to bake…',
    running: 'Baking…',
  };
  return (
    <>
      <div className="rs-insp__sec">
        <div className="rs-caps"><Icon name="stack" size={12} /> {d.kind === 'repeat' ? 'Repeat group' : 'Group'}</div>
        <TextField large value={d.title ?? ''} placeholder={d.kind === 'repeat' ? 'Repeat' : 'Group'} onChange={(v) => ed.setGroupInfo(node.id, { title: v })} />
        <div className="rs-insp__swatches" role="radiogroup" aria-label="Color stripe">
          {(Object.keys(CATEGORIES) as Category[]).map((c) => (
            <button key={c} role="radio" aria-checked={(d.color ?? 'math') === c} className={`rs-insp__swatch${(d.color ?? 'math') === c ? ' is-on' : ''}`} style={{ background: CATEGORIES[c].color }} title={CATEGORIES[c].title} onClick={() => ed.setGroupInfo(node.id, { color: c })} />
          ))}
        </div>
        <TextField large multiline value={d.description ?? ''} placeholder="What this group does (shown as its description)" onChange={(v) => ed.setGroupInfo(node.id, { description: v })} />
        <div className="rs-insp__actions">
          <button className="rs-btn rs-btn--primary" onClick={() => ed.enterGroup(node.id)} title="Open the group (double-click or Tab)"><Icon name="stack" /> Open</button>
          <button className="rs-btn" onClick={() => ed.ungroupNodes([node.id])} title="Put the nodes back (Ctrl+Shift+G)">Ungroup</button>
          <button className="rs-btn" onClick={() => ed.openSaveNode(fullId)} title="Keep this group in your add menu">Save as node…</button>
          <button className="rs-btn rs-btn--icon" onClick={() => downloadText(nodeFileName(node.label || d.title || 'group'), io.nodePresets.toFile(node))} title="Export a .rsmps-node.json file to share"><Icon name="export" /></button>
        </div>
        {d.kind === 'repeat' && <p className="rs-insp__hint">Inside, an Iteration node gives the pass number (0, 1, 2…): wire it into any parameter to change it from pass to pass.</p>}
      </div>

      <div className="rs-insp__sec">
        <div className="rs-caps">Bake</div>
        <p className="rs-insp__hint">{bakeProblem ?? (running ? `Baking: ${Math.round((job?.progress ?? 0) * 100)}%` : bakeText[state] ?? '')}</p>
        <div className="rs-insp__actions">
          {running ? (
            <button className="rs-btn" onClick={() => cancelProcess(app, fullId)}>Cancel</button>
          ) : (
            <button className="rs-btn" disabled={!!bakeProblem} onClick={() => void bakeGroup(app, node.id)} title="Render every frame of the outputs once and store them (Ctrl+Shift+B)">
              <Icon name="save" /> {state === 'done' ? 'Bake again' : 'Bake'}
            </button>
          )}
          {state !== 'none' && !running && <button className="rs-btn" onClick={() => void clearGroupBake(app, node.id)}>Clear</button>}
        </div>
      </div>

      {(d.inputs.length > 0 || d.outputs.length > 0) && (
        <div className="rs-insp__sec">
          <div className="rs-caps">Ports</div>
          {d.inputs.map((p) => (
            <div key={p.id} className="rs-insp__row rs-insp__port">
              <label className="rs-insp__label"><span className={`rs-insp__dot rs-sock--${p.type}`} /><span className="rs-insp__lt">In{p.loop ? ' · carried' : ''}</span></label>
              <div className="rs-insp__ctl"><TextField value={p.name} onChange={(v) => ed.renameGroupPort(node.id, 'in', p.id, v)} /></div>
              <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.removeGroupPort('in', p.id, node.id)} title="Remove this input (and its wires)" aria-label="Remove input"><Icon name="close" size={12} /></button>
            </div>
          ))}
          {d.outputs.map((p) => (
            <div key={p.id} className="rs-insp__row rs-insp__port">
              <label className="rs-insp__label"><span className={`rs-insp__dot rs-sock--${p.type}`} /><span className="rs-insp__lt">Out</span></label>
              <div className="rs-insp__ctl"><TextField value={p.name} onChange={(v) => ed.renameGroupPort(node.id, 'out', p.id, v)} /></div>
              <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.removeGroupPort('out', p.id, node.id)} title="Remove this output (and its wires)" aria-label="Remove output"><Icon name="close" size={12} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="rs-insp__sec">
        <div className="rs-caps">Exposed</div>
        {d.exposed.length === 0 && <p className="rs-insp__hint">Show inner parameters on the group node: pick them below, or right-click a parameter inside the group.</p>}
        {d.exposed.map((x, i) => (
          <div key={x.id} className="rs-insp__row rs-insp__exposed">
            <div className="rs-insp__ctl"><TextField value={x.label} onChange={(v) => ed.editExposed(node.id, { rename: { [x.id]: v } })} /></div>
            <button className="rs-btn rs-btn--icon rs-btn--ghost" disabled={i === 0} onClick={() => move(x.id, -1)} title="Move up" aria-label="Move up"><Icon name="sortUp" size={12} /></button>
            <button className="rs-btn rs-btn--icon rs-btn--ghost" disabled={i === d.exposed.length - 1} onClick={() => move(x.id, 1)} title="Move down" aria-label="Move down"><Icon name="sortDown" size={12} /></button>
            <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.unexposeParam(node.id, x.id)} title="Stop showing it (its value goes back inside)" aria-label="Remove"><Icon name="close" size={12} /></button>
          </div>
        ))}
        <input className="rs-input" value={query} placeholder="Find an inner parameter to expose…" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Find an inner parameter" />
        {query.trim() !== '' && (
          <div className="rs-insp__picklist" role="listbox">
            {candidates.length === 0 && <p className="rs-insp__hint">Nothing matches.</p>}
            {candidates.map((c) => (
              <button
                key={`${c.node}:${c.param}`}
                role="option"
                aria-selected={false}
                className="rs-insp__pick"
                onClick={() => {
                  ed.exposeParam(c.node, c.param, c.label, [...ed.state.path, node.id]);
                  setQuery('');
                }}
              >
                <span className="rs-insp__pickn">{c.nodeLabel}</span> {c.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
