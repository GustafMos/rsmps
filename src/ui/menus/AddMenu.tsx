import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CATEGORIES, type AnyNodeDef, type Category } from '../../engine/types';
import { Icon } from '../components/Icon';
import { NODE_W } from '../lib/layout';
import { inputsAccepting, outputsFeeding } from '../lib/sockets';
import { getRecent } from '../store/editor';
import { NODE_PREFIX, bindingsOf, eventToBinding, owners, setBindings, useKeymapVersion } from '../keymap';
import { allCommandIds, commandLabel, nodeCommandId } from '../shortcuts';
import { useApp, useDefs, useEd } from '../store/context';
import './menus.css';

function score(def: AnyNodeDef, tokens: string[]): number {
  const title = def.title.toLowerCase();
  const id = def.id.toLowerCase();
  const kw = (def.keywords ?? []).join(' ').toLowerCase();
  const desc = def.description.toLowerCase();
  let total = 0;
  for (const t of tokens) {
    let s = 0;
    if (title.startsWith(t)) s = 100;
    else if (title.includes(t)) s = 70;
    else if (kw.split(' ').some((k) => k.startsWith(t))) s = 55;
    else if (id.includes(t)) s = 45;
    else if (kw.includes(t)) s = 35;
    else if (desc.includes(t)) s = 15;
    if (!s) return 0;
    total += s;
  }
  return total;
}

interface Group {
  key: string;
  title: string;
  color: string;
  defs: AnyNodeDef[];
}

export function AddMenu() {
  const req = useEd((s) => s.addMenu);
  if (!req) return null;
  return <AddMenuInner key={`${req.clientX}:${req.clientY}:${req.link?.node ?? ''}:${req.link?.port ?? ''}`} />;
}

function AddMenuInner() {
  const { ed } = useApp();
  const req = useEd((s) => s.addMenu)!;
  const defs = useDefs();
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState(0);
  const [item, setItem] = useState(0);
  const [focus, setFocus] = useState<'cats' | 'items'>('cats');
  const [pos, setPos] = useState({ x: req.clientX, y: req.clientY });
  const [assign, setAssign] = useState<{ type: string; pending?: { binding: string; other: string } } | null>(null);
  useKeymapVersion();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const link = req.link;

  const allowed = useMemo(
    () =>
      defs.filter((d) => {
        if (!link) return true;
        return link.side === 'out' ? inputsAccepting(d, link.type).length > 0 : outputsFeeding(d, link.type).length > 0;
      }),
    [defs, link],
  );

  const groups: Group[] = useMemo(() => {
    const out: Group[] = [];
    const recent = getRecent()
      .map((id) => allowed.find((d) => d.id === id))
      .filter((d): d is AnyNodeDef => !!d);
    if (recent.length) out.push({ key: '_recent', title: 'Recent', color: 'var(--yellow)', defs: recent });
    for (const key of Object.keys(CATEGORIES) as Category[]) {
      const list = allowed.filter((d) => d.category === key).sort((a, b) => a.title.localeCompare(b.title));
      if (list.length) out.push({ key, title: CATEGORIES[key].title, color: CATEGORIES[key].color, defs: list });
    }
    return out;
  }, [allowed]);

  const results = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    return allowed
      .map((d) => ({ d, s: score(d, tokens) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || a.d.title.localeCompare(b.d.title))
      .map((r) => r.d)
      .slice(0, 60);
  }, [allowed, query]);

  const searching = query.trim().length > 0;
  const items = searching ? results : (groups[cat]?.defs ?? []);

  useLayoutEffect(() => {
    const r = root.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      x: Math.max(8, Math.min(req.clientX, window.innerWidth - r.width - 8)),
      y: Math.max(8, Math.min(req.clientY, window.innerHeight - r.height - 8)),
    });
  }, [req.clientX, req.clientY]);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (req.quick && groups[0]?.key === '_recent') setFocus('items');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) ed.openAddMenu(null);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [ed]);
  useEffect(() => {
    root.current?.querySelector('[data-active="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [cat, item, focus, query]);

  const choose = (def: AnyNodeDef) => {
    const at = link?.side === 'in' ? { x: req.world.x - NODE_W, y: req.world.y - 20 } : { x: req.world.x, y: req.world.y - 14 };
    ed.openAddMenu(null);
    ed.addNodeAt(def.id, { x: Math.round(at.x), y: Math.round(at.y) }, link);
  };

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const n = items.length;
    if (assign) {
      e.preventDefault();
      const id = nodeCommandId(assign.type);
      if (e.key === 'Escape') return setAssign(null);
      if (e.key === 'Backspace' || e.key === 'Delete') {
        setBindings(id, []);
        return setAssign(null);
      }
      const binding = eventToBinding(e.nativeEvent);
      if (!binding) return;
      const other = owners(binding, allCommandIds(), id)[0];
      if (other && assign.pending?.binding !== binding) {
        return setAssign({ type: assign.type, pending: { binding, other: commandLabel(other, (t) => defs.find((d) => d.id === t)?.title) } });
      }
      if (other) setBindings(other, bindingsOf(other).filter((b) => b !== binding));
      setBindings(id, [binding]);
      return setAssign(null);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && items[item]) {
      e.preventDefault();
      return setAssign({ type: items[item].id });
    }
    if (e.key === 'Escape') {
      ed.openAddMenu(null);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (searching || focus === 'items') setItem((i) => (n ? (i + 1) % n : 0));
      else setCat((c) => (c + 1) % Math.max(1, groups.length));
      if (!searching && focus === 'cats') setItem(0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (searching || focus === 'items') setItem((i) => (n ? (i - 1 + n) % n : 0));
      else setCat((c) => (c - 1 + groups.length) % Math.max(1, groups.length));
      if (!searching && focus === 'cats') setItem(0);
    } else if (e.key === 'ArrowRight' && !searching && (focus === 'cats' || !query)) {
      if (focus === 'cats') {
        e.preventDefault();
        setFocus('items');
        setItem(0);
      }
    } else if (e.key === 'ArrowLeft' && !searching && focus === 'items') {
      e.preventDefault();
      setFocus('cats');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (searching || focus === 'items') items[item] && choose(items[item]);
      else {
        setFocus('items');
        setItem(0);
      }
    }
  };

  const label = link ? (link.side === 'out' ? `Nodes that accept ${link.type}` : `Nodes that output ${link.type}`) : null;

  return (
    <div ref={root} className="rs-add" style={{ left: pos.x, top: pos.y }} onKeyDown={onKey} role="dialog" aria-label="Add node">
      <div className="rs-add__search">
        <Icon name="search" size={14} />
        <input
          ref={input}
          value={query}
          placeholder="Search nodes…"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setItem(0);
          }}
        />
        <span className="rs-kbd">Esc</span>
      </div>
      {label && <div className="rs-add__filter rs-caps">{label}</div>}
      <div className="rs-add__body">
        {!searching && (
          <div className="rs-add__cats">
            {groups.map((g, i) => (
              <button
                key={g.key}
                className={`rs-add__cat${i === cat ? ' is-active' : ''}${i === cat && focus === 'cats' ? ' is-focus' : ''}`}
                data-active={i === cat && focus === 'cats' ? 1 : 0}
                onPointerEnter={() => {
                  setCat(i);
                  setItem(0);
                }}
                onClick={() => {
                  setCat(i);
                  setFocus('items');
                }}
              >
                <span className="rs-add__chip" style={{ background: g.color }} />
                <span className="rs-add__cat-title">{g.title}</span>
                <Icon name="chevronRight" size={12} />
              </button>
            ))}
          </div>
        )}
        <div className="rs-add__items">
          {items.length === 0 && <div className="rs-add__none">{searching ? `No node matches "${query}"` : 'No compatible nodes'}</div>}
          {items.map((d, i) => (
            <button
              key={d.id}
              className={`rs-add__item${i === item && (searching || focus === 'items') ? ' is-active' : ''}`}
              data-active={i === item && (searching || focus === 'items') ? 1 : 0}
              title={d.description}
              onPointerEnter={() => setItem(i)}
              onClick={() => choose(d)}
            >
              <span className="rs-add__chip" style={{ background: CATEGORIES[d.category]?.color }} />
              <span className="rs-add__item-main">
                <span className="rs-add__item-title">{d.title}</span>
                {searching && <span className="rs-add__item-desc">{d.description}</span>}
              </span>
              {bindingsOf(nodeCommandId(d.id))[0] && <span className="rs-kbd rs-add__key">{bindingsOf(nodeCommandId(d.id))[0]}</span>}
              {searching && <span className="rs-add__item-cat">{CATEGORIES[d.category]?.title}</span>}
              <span className="rs-add__assign" role="button" title="Assign a hotkey that adds this node (Ctrl+K)" onClick={(ev) => { ev.stopPropagation(); setAssign({ type: d.id }); input.current?.focus(); }}><Icon name="keyboard" size={14} /></span>
            </button>
          ))}
        </div>
      </div>
      {assign && (
        <div className="rs-add__assign-bar" role="status">
          {assign.pending ? `${assign.pending.binding} is used by “${assign.pending.other}”. Press it again to take it over, or another key.` : `Press the key for “${defs.find((d) => d.id === assign.type)?.title ?? assign.type}”. Esc cancels, Backspace clears.`}
        </div>
      )}
      <div className="rs-add__foot">
        <span><span className="rs-kbd">↑↓</span> move</span>
        <span><span className="rs-kbd">→</span> open</span>
        <span><span className="rs-kbd">Enter</span> add</span>
        <span><span className="rs-kbd">Ctrl+K</span> assign hotkey</span>
      </div>
    </div>
  );
}
