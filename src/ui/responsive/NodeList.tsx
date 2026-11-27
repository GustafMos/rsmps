import { useMemo } from 'react';
import { libraryAssetName, nodeDisplayName } from '../lib/nodeTitle';
import { CATEGORIES, type ParamDef } from '../../engine/types';
import { GROUP_TYPE, defOf } from '../../engine/group';
import { Icon } from '../components/Icon';
import { evaluationOrder } from '../graph-touch/pure';
import { useApp, useEd, usePlayer } from '../store/context';
import { showTab } from './shellStore';
import { missingInputs, summaryLine } from '../lib/guide';

/**
 * The graph as a list: nodes in evaluation order with their one-line summaries. For when wiring is not the task: tap selects, the
 * arrow (or a second tap) opens the node in the Inspector, the eye shows it in the viewer. Reordering is not needed (the order is the
 * graph's own). Inside an open group a back row leads out.
 */
export function NodeList() {
  const { ed, io } = useApp();
  const nodes = useEd((s) => s.level.nodes);
  const edges = useEd((s) => s.level.edges);
  const path = useEd((s) => s.path);
  const selection = useEd((s) => s.selection);
  const viewedId = useEd((s) => s.viewedNodeId);
  const project = useEd((s) => s.level.project);
  const errors = usePlayer((s) => s.errors);
  const ordered = useMemo(() => evaluationOrder(nodes, edges), [nodes, edges]);
  const wiredOf = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of edges) (m.get(e.to.node) ?? m.set(e.to.node, new Set()).get(e.to.node)!).add(e.to.port);
    return m;
  }, [edges]);
  const fullId = (id: string) => (path.length ? [...path, id].join('/') : id);

  const summaryOf = (id: string): string => {
    const n = nodes.find((x) => x.id === id);
    const def = n && defOf(io.registry, n);
    if (!n || !def) return '';
    const wiredSet = wiredOf.get(id) ?? new Set<string>();
    if (!def.summary && !missingInputs(def, wiredSet).length) return '';
    try {
      const params: Record<string, unknown> = {};
      for (const [k, p] of Object.entries(def.params as Record<string, ParamDef>)) params[k] = n.params[k] ?? p.absent ?? p.default;
      const frames = Math.max(1, Math.round(project.duration * project.fps));
      return summaryLine(def, params, wiredSet, { loop: !!project.loop, frames, fps: project.fps });
    } catch {
      return '';
    }
  };

  return (
    <div className="rs-nlist" data-pane-scroll>
      {path.length > 0 && (
        <button className="rs-nlist__back" onClick={() => ed.exitGroup(path.length - 1)}>
          <Icon name="chevronLeft" size={18} /> Back out of the group
        </button>
      )}
      {ordered.length === 0 && <div className="rs-empty">The graph is empty. Use Add to put the first node in.</div>}
      <ol className="rs-nlist__list">
        {ordered.map((n, i) => {
          const def = defOf(io.registry, n);
          const cat = def ? CATEGORIES[def.category] : undefined;
          const sel = selection.includes(n.id);
          const viewed = viewedId === fullId(n.id);
          const err = errors.get(fullId(n.id));
          const sum = summaryOf(n.id);
          return (
            <li key={n.id} className={`rs-nlist__item${sel ? ' is-selected' : ''}${n.bypass ? ' is-bypassed' : ''}${err ? ' has-error' : ''}`}>
              <button
                className="rs-nlist__main"
                onClick={() => {
                  if (sel && ed.state.selection.length === 1) showTab('inspector');
                  else ed.select([n.id]);
                }}
                aria-pressed={sel}
              >
                <span className="rs-nlist__n rs-num">{i + 1}</span>
                <span className="rs-nlist__chip" style={{ background: cat?.color }} />
                <span className="rs-nlist__text">
                  <span className="rs-nlist__title">{nodeDisplayName(n, def, libraryAssetName(io.library))}</span>
                  <span className="rs-nlist__sum">{err ? err : sum || cat?.title || ''}</span>
                </span>
              </button>
              <button className={`rs-btn rs-btn--icon rs-btn--ghost${viewed ? ' is-on' : ''}`} onClick={() => ed.setViewed(fullId(n.id))} aria-label={`View ${n.label || def?.title || n.type}`} aria-pressed={viewed}>
                <Icon name={viewed ? 'eye' : 'eyeOff'} size={18} />
              </button>
              {n.type === GROUP_TYPE ? (
                <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => ed.enterGroup(n.id)} aria-label="Open group">
                  <Icon name="stack" size={18} />
                </button>
              ) : (
                <button className="rs-btn rs-btn--icon rs-btn--ghost" onClick={() => { ed.select([n.id]); showTab('inspector'); }} aria-label="Edit parameters">
                  <Icon name="chevronRight" size={18} />
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
