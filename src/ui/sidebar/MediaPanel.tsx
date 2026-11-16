import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Icon } from '../components/Icon';
import { MenuPopup, type MenuItem } from '../components/Menu';
import { ASSET_MIME } from '../graph/gestures';
import { isTypingTarget } from '../lib/drag';
import { buildSections, countByGroup, filterItems, isFiltering, type Query, type Section } from '../lib/mediaFilter';
import { columnsFor, layoutRows, moveCursor, orderedIds, type CursorKey } from '../lib/mediaLayout';
import { BIN_COLORS, deleteBin, moveToBin, recolorBin, renameBin } from '../lib/mediaOrg';
import { NO_SEL, clickSelect, moveSelect, pruneSel, targetsOf, type Sel } from '../lib/mediaSelect';
import { useApp } from '../store/context';
import { editOrg, newBin, revealNodes, setMedia, toggleSection, useMedia } from '../store/media';
import { BinList, type ListActions } from './BinList';
import { MediaToolbar } from './MediaToolbar';
import { useAssetUsage, useMediaItems, useOrg } from './useMediaData';

const ARROWS: Record<string, CursorKey> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', Home: 'home', End: 'end' };

interface Props {
  busy: boolean;
  pick: () => void;
  /** Import files; with a bin id they also land in that bin. */
  importFiles: (files: File[], bin: string | null) => void;
}

/** The expanded media panel: search, type chips, view controls and the virtual list of bins and assets. */
export function MediaPanel({ busy, pick, importFiles }: Props) {
  const app = useApp();
  const { io, ed, graphCtl } = app;
  const items = useMediaItems();
  const usage = useAssetUsage(items);
  const org = useOrg();
  const m = useMedia((s) => s);
  const [sel, setSel] = useState<Sel>(NO_SEL);
  const [renamingAsset, setRenamingAsset] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const used = useMemo(() => new Set(usage.keys()), [usage]);
  const query: Query = useMemo(() => ({ type: m.type, text: m.text, unusedOnly: m.unusedOnly }), [m.type, m.text, m.unusedOnly]);
  const filtering = isFiltering(query);
  const shown = useMemo(() => filterItems(items, query, used), [items, query, used]);
  const sections = useMemo(() => buildSections(items, shown, org, m.view, m.sortKey, m.sortDir, filtering), [items, shown, org, m.view, m.sortKey, m.sortDir, filtering]);
  const closed = useMemo(() => new Set(m.closed), [m.closed]);
  const cols = columnsFor(m.width - 18); // minus the scrollbar and the border
  const { rows, height } = useMemo(() => layoutRows(sections, closed, cols, m.density), [sections, closed, cols, m.density]);
  const order = useMemo(() => orderedIds(rows), [rows]);
  const counts = useMemo(() => countByGroup(items), [items]);
  const unused = useMemo(() => items.filter((a) => !used.has(a.id)).length, [items, used]);
  const byId = useMemo(() => new Map(items.map((a) => [a.id, a])), [items]);

  // the selection only holds what is on screen (a folded bin, a filter or a removed asset drops its items)
  useEffect(() => {
    const visible = new Set(order);
    setSel((s) => pruneSel(s, visible));
  }, [order]);

  useEffect(() => {
    if (!m.searchFocus) return;
    searchRef.current?.focus();
    searchRef.current?.select();
    setMedia({ searchFocus: false });
  }, [m.searchFocus]);

  /* ------------------------------ actions on assets ----------------------------- */

  const ordered = (ids: readonly string[]) => {
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...ids].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9));
  };

  const addToGraph = (ids: readonly string[]) => {
    const groups = new Map<string, string[]>();
    for (const id of ordered(ids)) {
      const it = byId.get(id);
      if (!it) continue;
      const g = it.kind === 'image' || it.kind === 'video' ? 'visual' : it.kind; // pictures and clips share a Media In node, other kinds need their own
      (groups.get(g) ?? groups.set(g, []).get(g)!).push(id);
    }
    const r = graphCtl.rect();
    const at = graphCtl.toWorld(r.left + r.width / 3, r.top + r.height / 3);
    let i = 0;
    for (const list of groups.values()) ed.addAssetNode(list, { x: Math.round(at.x) + i++ * 260, y: Math.round(at.y) });
  };

  const remove = (ids: readonly string[], ask: boolean) => {
    const list = ids.filter((id) => byId.has(id));
    if (!list.length) return;
    const inUse = list.filter((id) => usage.has(id));
    if (ask || inUse.length || list.length > 1) {
      const what = list.length === 1 ? `"${byId.get(list[0])!.name}"` : `${list.length} items`;
      const msg = inUse.length
        ? `${inUse.length === 1 && list.length === 1 ? what : `${inUse.length} of these`} ${inUse.length === 1 && list.length === 1 ? 'is' : 'are'} used by nodes in this project. Removing deletes the file from the media library (shared by all project tabs) and those nodes lose their media. Remove anyway?`
        : `Remove ${what} from the media library? This cannot be undone.`;
      if (!window.confirm(msg)) return;
    }
    for (const id of list) void io.library.remove(id);
  };

  const nodesOf = (ids: readonly string[]) => [...new Set(ids.flatMap((id) => usage.get(id) ?? []))];

  const move = (ids: readonly string[], bin: string | null) => editOrg(app, (o) => moveToBin(o, ids, bin));

  const rename = async (id: string, name: string | null) => {
    setRenamingAsset(null);
    scrollRef.current?.focus({ preventScroll: true });
    if (name?.trim()) await io.library.rename(id, name);
  };

  const openAssetMenu = (x: number, y: number, id: string) => {
    const cur = sel.ids.has(id) ? sel : clickSelect(NO_SEL, order, id, {});
    if (cur !== sel) setSel(cur);
    const ids = ordered(targetsOf(cur, id));
    const nodes = nodesOf(ids);
    const n = ids.length;
    const bins: MenuItem[] = [{ label: 'Unsorted', onClick: () => move(ids, null) }, ...org.bins.map((b) => ({ label: b.name, onClick: () => move(ids, b.id) })), { label: 'New bin…', icon: 'folderPlus', onClick: () => newBin(app, ids) }];
    setMenu({
      x,
      y,
      items: [
        { label: n > 1 ? `Add ${n} to graph` : 'Add to graph', icon: 'plus', shortcut: 'Enter', onClick: () => addToGraph(ids) },
        { label: nodes.length ? `Reveal ${nodes.length} node${nodes.length === 1 ? '' : 's'} in graph` : 'Reveal in graph (not used)', icon: 'eye', disabled: !nodes.length, onClick: () => revealNodes(app, nodes) },
        { label: 'Rename', icon: 'rename', shortcut: 'F2', disabled: n !== 1, onClick: () => setRenamingAsset(id) },
        { sep: true },
        { head: 'Move to bin' },
        ...bins,
        { sep: true },
        { label: 'Remove from library…', icon: 'trash', shortcut: 'Del', onClick: () => remove(ids, true) },
      ],
    });
  };

  const openSectionMenu = (s: Section, x: number, y: number) => {
    if (!s.binId) return;
    const id = s.binId;
    setMenu({
      x,
      y,
      items: [
        { label: 'Rename bin', icon: 'rename', onClick: () => setMedia({ renamingBin: id }) },
        { label: 'Select its media', icon: 'check', disabled: !s.items.length, onClick: () => setSel({ ids: new Set(s.items.map((a) => a.id)), anchor: s.items[0]?.id ?? null, cursor: s.items[0]?.id ?? null }) },
        { label: 'Next colour', icon: 'palette', onClick: () => recolor(id) },
        { sep: true },
        { label: 'Delete bin (the media stays, unsorted)', icon: 'trash', onClick: () => editOrg(app, (o) => deleteBin(o, id)) },
      ],
    });
  };

  const recolor = (id: string) => editOrg(app, (o) => recolorBin(o, id, ((o.bins.find((b) => b.id === id)?.color ?? 0) + 1) % BIN_COLORS.length));

  /* ------------------------------------ list ------------------------------------ */

  const actions: ListActions = {
    onSelect: (id, e: MouseEvent) => {
      setSel((s) => clickSelect(s, order, id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }));
      scrollRef.current?.focus({ preventScroll: true });
    },
    onOpen: (id) => addToGraph(sel.ids.has(id) && sel.ids.size > 1 ? [...sel.ids] : [id]),
    onAssetMenu: (id, e) => {
      e.preventDefault();
      openAssetMenu(e.clientX, e.clientY, id);
    },
    onAssetDrag: (id, e: DragEvent) => {
      let cur = sel;
      if (!sel.ids.has(id)) setSel((cur = clickSelect(NO_SEL, order, id, {})));
      e.dataTransfer.setData(ASSET_MIME, JSON.stringify(ordered(targetsOf(cur, id))));
      e.dataTransfer.effectAllowed = 'copyMove';
    },
    onAssetRenamed: (id, name) => void rename(id, name),
    onRemove: (id) => remove([id], false),
    onToggle: (id) => toggleSection(id),
    onSectionMenu: (s, e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      if (e.type === 'contextmenu') openSectionMenu(s, e.clientX, e.clientY);
      else openSectionMenu(s, r.left, r.bottom + 2);
    },
    onBinRenamed: (id, name) => {
      setMedia({ renamingBin: null });
      scrollRef.current?.focus({ preventScroll: true });
      if (name) editOrg(app, (o) => renameBin(o, id, name));
    },
    onStartBinRename: (id) => setMedia({ renamingBin: id }),
    onRecolor: recolor,
    onDropAssets: (bin, ids) => move(ids, bin),
    onDropFiles: (bin, files) => importFiles(files, bin),
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target) || (e.target as HTMLElement).closest?.('button')) return;
    const mod = e.ctrlKey || e.metaKey;
    const own = () => {
      e.preventDefault();
      e.stopPropagation(); // the shortcuts behind this panel (frame step, delete nodes, select all nodes) must not also fire
    };
    const dir = ARROWS[e.key];
    if (dir && !mod && !e.altKey) {
      own();
      const to = moveCursor(rows, sel.cursor, dir);
      setSel((s) => moveSelect(s, order, to, e.shiftKey && !!s.cursor));
      return;
    }
    const targets = sel.ids.size ? ordered([...sel.ids]) : sel.cursor ? [sel.cursor] : [];
    if (e.key === 'Enter' && !mod) {
      own();
      if (targets.length) addToGraph(targets);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) {
      own();
      if (targets.length) remove(targets, true);
    } else if (e.key === 'F2') {
      own();
      if (sel.cursor) setRenamingAsset(sel.cursor);
    } else if (mod && e.key.toLowerCase() === 'a') {
      own();
      setSel({ ids: new Set(order), anchor: order[0] ?? null, cursor: sel.cursor ?? order[0] ?? null });
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      own();
      const cur = sel.cursor;
      const el = cur ? document.getElementById(`media-${cur}`) : null;
      if (cur && el) {
        const r = el.getBoundingClientRect();
        openAssetMenu(r.left + 12, r.bottom - 4, cur);
      }
    } else if (e.key === 'Escape' && sel.ids.size) {
      setSel(NO_SEL);
    }
  };

  const clearFilters = () => setMedia({ type: 'all', text: '', unusedOnly: false });

  const empty =
    items.length === 0 ? (
      <div className="rs-empty rs-media__empty">
        <Icon name="image" size={24} />
        <span>{busy ? 'Importing…' : 'Drop files here or press Import'}</span>
        <button className="rs-btn" onClick={pick} disabled={busy}>
          <Icon name="plus" /> Import
        </button>
      </div>
    ) : (
      <div className="rs-empty rs-media__empty">
        <Icon name="search" size={24} />
        <span>Nothing matches{m.text ? ` "${m.text}"` : ''}.</span>
        <button className="rs-btn" onClick={clearFilters}>Clear filters</button>
      </div>
    );

  return (
    <>
      <MediaToolbar
        total={items.length}
        counts={counts}
        unused={unused}
        busy={busy}
        onImport={pick}
        onNewBin={() => newBin(app, sel.ids.size ? ordered([...sel.ids]) : [])}
        selected={sel.ids.size}
        searchRef={searchRef}
        onFocusList={() => {
          scrollRef.current?.focus();
          if (!sel.cursor && order[0]) setSel(clickSelect(NO_SEL, order, order[0], {}));
        }}
      />
      <BinList
        {...actions}
        rows={rows}
        height={height}
        cols={cols}
        density={m.density}
        filtering={filtering}
        sel={sel}
        usage={usage}
        renamingAsset={renamingAsset}
        renamingBin={m.renamingBin}
        empty={empty}
        onKeyDown={onKeyDown}
        scrollRef={scrollRef}
      />
      {menu && <MenuPopup x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}
