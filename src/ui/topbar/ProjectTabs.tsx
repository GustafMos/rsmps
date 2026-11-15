import { useEffect, useRef, useState } from 'react';
import type { OpenProject } from '../../io/api';
import { Icon } from '../components/Icon';
import { MenuButton, MenuPopup, type MenuItem } from '../components/Menu';
import { useApp, useEd } from '../store/context';
import './tabs.css';

function ago(t: number): string {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

/** One tab per open project. Only the active project is in memory; background tabs are just this metadata. */
export function ProjectTabs() {
  const { ed, io } = useApp();
  const projects = useEd((s) => s.projects);
  const active = useEd((s) => s.activeProject);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; closed: OpenProject[] } | null>(null);
  const [tip, setTip] = useState<{ p: OpenProject; x: number } | null>(null);
  const dragId = useRef<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // keep the active tab visible
    strip.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, projects.length]);

  const openMenu = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const closed = await io.projects.listClosed().catch(() => []);
    setMenu({ x: e.clientX, y: e.clientY, id, closed });
  };

  const items = (m: NonNullable<typeof menu>): MenuItem[] => [
    { label: 'Rename', onClick: () => setRenaming(m.id) },
    { label: 'Duplicate', onClick: () => void ed.duplicateTab(m.id) },
    { label: 'Close', onClick: () => void ed.closeTab(m.id), shortcut: m.id === active ? 'Ctrl+Alt+W' : undefined },
    {
      label: 'Close others',
      disabled: projects.length < 2,
      onClick: async () => {
        for (const p of projects) if (p.id !== m.id) await ed.closeTab(p.id);
        if (m.id !== ed.state.activeProject) await ed.switchTo(m.id);
      },
    },
    { sep: true },
    { head: 'Reopen closed project' },
    ...(m.closed.length ? m.closed.map((c) => ({ label: `${c.name} · ${ago(c.updatedAt)}`, onClick: () => void ed.reopenProject(c.id) })) : [{ label: 'No recently closed projects', disabled: true }]),
  ];

  return (
    <div className="rs-tabs" role="tablist" aria-label="Open projects" ref={strip}>
      {projects.map((p) => (
        <div
          key={p.id}
          role="tab"
          aria-selected={p.id === active}
          tabIndex={0}
          className={`rs-tab${p.id === active ? ' is-active' : ''}`}
          draggable={renaming !== p.id}
          onDragStart={() => (dragId.current = p.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            const from = dragId.current;
            dragId.current = null;
            if (!from || from === p.id) return;
            const ids = projects.map((x) => x.id).filter((i) => i !== from);
            ids.splice(ids.indexOf(p.id) + (projects.findIndex((x) => x.id === from) < projects.findIndex((x) => x.id === p.id) ? 1 : 0), 0, from);
            void ed.reorderTabs(ids);
          }}
          onClick={() => void ed.switchTo(p.id)}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); void ed.closeTab(p.id); } }}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          onDoubleClick={() => setRenaming(p.id)}
          onContextMenu={(e) => void openMenu(e, p.id)}
          onKeyDown={(e) => { if (e.key === 'Enter') void ed.switchTo(p.id); }}
          onMouseEnter={(e) => setTip({ p, x: e.currentTarget.getBoundingClientRect().left })}
          onMouseLeave={() => setTip(null)}
        >
          {(p as { kind?: string }).kind === 'scan' && <span className="rs-tab__kind" title="Scan"><Icon name="image" size={12} /></span>}
          {p.dirty && <span className="rs-tab__dot" title="Edited since the last file save" />}
          {renaming === p.id ? (
            <input
              className="rs-tab__rename"
              autoFocus
              defaultValue={p.name}
              onClick={(e) => e.stopPropagation()}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') setRenaming(null);
              }}
              onBlur={(e) => { setRenaming(null); void ed.renameTab(p.id, e.currentTarget.value); }}
            />
          ) : (
            <span className="rs-tab__name">{p.name || 'Untitled'}</span>
          )}
          <button className="rs-tab__x" aria-label={`Close ${p.name}`} title="Close (middle-click)" onClick={(e) => { e.stopPropagation(); void ed.closeTab(p.id); }}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <button className="rs-btn rs-btn--icon rs-btn--ghost rs-tabs__new" onClick={() => void ed.newProjectTab()} title="New project in a new tab (Ctrl+Alt+T)" aria-label="New tab">
        <Icon name="plus" />
      </button>
      <MenuButton className="rs-btn rs-btn--icon rs-btn--ghost rs-tabs__new" title="New project or scan" items={[{ label: 'New project', onClick: () => void ed.newProjectTab(), shortcut: 'Ctrl+Alt+T' }, { label: 'New scan', onClick: () => void ed.newScanTab() }]}><Icon name="chevronDown" size={12} /></MenuButton>
      <span className="rs-tabs__mem" title="Only the active tab is loaded. Background tabs keep just their name and a thumbnail; undo history is cleared when you switch tabs.">
        1 live
      </span>
      {tip && (
        <div className="rs-tab__tip" style={{ left: Math.max(4, tip.x) }}>
          {tip.p.thumbnail ? <img src={tip.p.thumbnail} alt="" /> : <div className="rs-tab__nothumb">No preview yet</div>}
          <strong>{tip.p.name}</strong>
          <span>Edited {ago(tip.p.updatedAt)}</span>
        </div>
      )}
      {menu && <MenuPopup x={menu.x} y={menu.y} items={items(menu)} onClose={() => setMenu(null)} />}
    </div>
  );
}
