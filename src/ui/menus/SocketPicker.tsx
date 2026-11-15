import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { compatibleSockets } from '../lib/compat';
import { useApp, useEd } from '../store/context';
import './menus.css';

/** Searchable list of every socket on a node that can take the wire being dragged (including hidden params). */
export function SocketPicker() {
  const req = useEd((s) => s.socketPicker);
  if (!req) return null;
  return <Inner key={`${req.node}:${req.from.node}:${req.from.port}`} />;
}

function Inner() {
  const { ed, io } = useApp();
  const req = useEd((s) => s.socketPicker)!;
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const [pos, setPos] = useState({ x: req.x, y: req.y });
  const root = useRef<HTMLDivElement>(null);
  const node = ed.state.graph.nodes.find((n) => n.id === req.node);
  const title = node ? node.label || io.registry.get(node.type)?.title || node.type : '';
  const all = useMemo(() => compatibleSockets(ed.state.graph, io.registry, req.node, { node: req.from.node, port: req.from.port }), [ed, io, req]);
  const list = all.filter((s) => !q || `${s.label} ${s.port} ${s.group}`.toLowerCase().includes(q.toLowerCase()));

  useLayoutEffect(() => {
    const r = root.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.max(8, Math.min(req.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(req.y, window.innerHeight - r.height - 8)) });
  }, [req.x, req.y]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) ed.openSocketPicker(null);
    };
    // drag-created: listen next tick so the pointer-up that opened us does not close us
    const t = setTimeout(() => window.addEventListener('pointerdown', down, true), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', down, true);
    };
  }, [ed]);

  const choose = (port: string) => {
    ed.openSocketPicker(null);
    ed.connect({ node: req.from.node, port: req.from.port }, { node: req.node, port });
  };

  let lastGroup = '';
  return createPortal(
    <div
      ref={root}
      className="rs-sp"
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={`Connect to ${title}`}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') ed.openSocketPicker(null);
        else if (e.key === 'ArrowDown') { e.preventDefault(); setI((n) => Math.min(list.length - 1, n + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setI((n) => Math.max(0, n - 1)); }
        else if (e.key === 'Enter' && list[i]) { e.preventDefault(); choose(list[i].port); }
      }}
    >
      <div className="rs-sp__head">
        <span className="rs-caps">Connect {req.from.type} to {title}</span>
        <input autoFocus className="rs-sp__q" placeholder="Search parameters…" value={q} spellCheck={false} onChange={(e) => { setQ(e.target.value); setI(0); }} />
      </div>
      <div className="rs-sp__list">
        {list.length === 0 && <div className="rs-add__none">Nothing on this node accepts that wire.</div>}
        {list.map((s, k) => {
          const head = s.group !== lastGroup ? (lastGroup = s.group) : null;
          return (
            <div key={s.port}>
              {head && <div className="rs-sp__group rs-caps">{head}</div>}
              <button className={`rs-sp__item${k === i ? ' is-active' : ''}`} data-pick={s.port} onPointerEnter={() => setI(k)} onClick={() => choose(s.port)}>
                <span className={`rs-sock rs-sock--${s.type}`} style={{ position: 'static', margin: 0 }} />
                <span className="rs-sp__label">{s.label}</span>
                {s.wired && <span className="rs-sp__cur">replaces wire</span>}
                {!s.wired && s.current && <span className="rs-sp__cur rs-num">{s.current}</span>}
              </button>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
