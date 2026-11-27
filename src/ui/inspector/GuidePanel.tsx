import { useState } from 'react';
import { guideView, type GuideFix } from '../lib/guide';
import { Icon } from '../components/Icon';
import { useApp, useEd } from '../store/context';

/**
 * "How to use" under the node's description: one sentence on what the node does, the steps, and a to-do (with a fix button) for each
 * required input that is still empty. Open by default while something is missing; with everything wired it shrinks to the sentence.
 */
export function GuidePanel({ nodeId, description }: { nodeId: string; description: string }) {
  const { ed } = useApp();
  const graph = useEd((s) => s.level);
  const viewed = useEd((s) => s.viewedNodeId);
  const [manual, setManual] = useState<boolean | null>(null);
  const [details, setDetails] = useState(false);
  const view = guideView(graph, ed.registry, nodeId, viewed);
  if (!view) return null;
  const open = manual ?? view.open;
  const fix = (input: string, f: GuideFix, e: React.MouseEvent) => ed.fixInput(nodeId, input, f, { clientX: e.clientX, clientY: e.clientY });
  return (
    <div className={`rs-guide${view.todos.length ? ' has-todos' : ''}`} data-testid="guide">
      <div className="rs-guide__head">
        <p className="rs-guide__does">{view.does}</p>
        <button className={`rs-btn rs-btn--icon rs-btn--ghost rs-guide__q${open ? ' is-on' : ''}`} aria-expanded={open} aria-label="How to use this node" title="How to use this node" onClick={() => setManual(!open)}>?</button>
      </div>
      {view.todos.length > 0 && (
        <ul className="rs-guide__todos" aria-label="Still needed">
          {view.todos.map((t) => (
            <li key={t.input} className="rs-guide__todo" data-todo={t.input}>
              <div className="rs-guide__tt"><Icon name="warn" size={14} /> <b>{t.label}</b> is empty</div>
              <div className="rs-guide__th">{t.hint}</div>
              <div className="rs-guide__fixes">
                {t.fixes.map((f, i) => (
                  <button key={i} className={`rs-btn${i === 0 ? ' rs-btn--primary' : ''}`} onClick={(e) => fix(t.input, f, e)} data-fix={f.kind}>{f.label}</button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="rs-guide__more">
          <ol className="rs-guide__steps">{view.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          <button className="rs-insp__more" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? 'less about this node' : 'more about this node'}</button>
          {details && <p className="rs-guide__desc">{description}</p>}
          {view.seeAlso.length > 0 && <div className="rs-guide__see">See also: {view.seeAlso.map((s) => s.title).join(', ')}</div>}
        </div>
      )}
    </div>
  );
}
