import type { RefObject } from 'react';
import { Icon } from '../components/Icon';
import { GROUPS, SORT_LABELS, type SortKey, type TypeGroup, type ViewMode } from '../lib/mediaFilter';
import { setMedia, toggleMediaPanel, useMedia } from '../store/media';

const VIEWS: { id: ViewMode; label: string; tip: string }[] = [
  { id: 'bins', label: 'Bins', tip: 'Your own folders' },
  { id: 'type', label: 'By type', tip: 'Grouped by kind of media' },
  { id: 'flat', label: 'Flat', tip: 'One list' },
];

interface Props {
  total: number;
  counts: Record<TypeGroup, number>;
  unused: number;
  busy: boolean;
  onImport: () => void;
  onNewBin: () => void;
  selected: number;
  searchRef: RefObject<HTMLInputElement | null>;
  onFocusList: () => void;
}

export function MediaToolbar({ total, counts, unused, busy, onImport, onNewBin, selected, searchRef, onFocusList }: Props) {
  const m = useMedia((s) => s);
  return (
    <>
      <header className="rs-side__head" title="The media library is shared by all project tabs; bins belong to this project">
        <span className="rs-caps">Media</span>
        <span className="rs-side__count rs-num">{total}</span>
        <button className="rs-btn rs-btn--icon rs-btn--ghost" title="Import files" aria-label="Import files" onClick={onImport} disabled={busy}>
          <Icon name="plus" />
        </button>
        <button className="rs-btn rs-btn--icon rs-btn--ghost" title="Collapse the media panel to the side (the media button in the top bar brings it back)" aria-label="Collapse media panel" onClick={toggleMediaPanel}>
          <Icon name="chevLeft" />
        </button>
      </header>
      <div className="rs-media__tools">
        <div className="rs-media__search">
          <Icon name="search" size={13} />
          <input
            ref={searchRef}
            className="rs-input"
            placeholder="Search media"
            aria-label="Search media by name or type"
            value={m.text}
            spellCheck={false}
            onChange={(e) => setMedia({ text: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                if (m.text) setMedia({ text: '' });
                else e.currentTarget.blur();
              } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                e.preventDefault();
                onFocusList();
              }
            }}
          />
          {m.text && (
            <button className="rs-btn rs-btn--icon rs-btn--ghost" title="Clear search" aria-label="Clear search" onClick={() => { setMedia({ text: '' }); searchRef.current?.focus(); }}>
              <Icon name="close" size={11} />
            </button>
          )}
        </div>
        <div className="rs-media__chips" role="group" aria-label="Filter by type">
          <button className={`rs-media__chip${m.type === 'all' ? ' is-on' : ''}`} aria-pressed={m.type === 'all'} onClick={() => setMedia({ type: 'all' })}>
            All <span className="rs-num">{total}</span>
          </button>
          {GROUPS.filter((g) => g.id !== 'other' && (counts[g.id] > 0 || m.type === g.id)).map((g) => (
            <button key={g.id} className={`rs-media__chip${m.type === g.id ? ' is-on' : ''}`} aria-pressed={m.type === g.id} onClick={() => setMedia({ type: m.type === g.id ? 'all' : g.id })}>
              {g.label} <span className="rs-num">{counts[g.id]}</span>
            </button>
          ))}
          <button className={`rs-media__chip rs-media__chip--unused${m.unusedOnly ? ' is-on' : ''}`} aria-pressed={m.unusedOnly} title="Only media no node in this project uses" onClick={() => setMedia({ unusedOnly: !m.unusedOnly })}>
            Unused <span className="rs-num">{unused}</span>
          </button>
        </div>
        <div className="rs-media__views">
          <div className="rs-media__seg" role="group" aria-label="Organize by">
            {VIEWS.map((v) => (
              <button key={v.id} className={m.view === v.id ? 'is-on' : ''} aria-pressed={m.view === v.id} title={v.tip} onClick={() => setMedia({ view: v.id })}>
                {v.label}
              </button>
            ))}
          </div>
          {m.view === 'bins' && (
            <button className="rs-btn rs-btn--icon rs-btn--ghost" title={selected > 0 ? `New bin with the ${selected} selected` : 'New bin'} aria-label="New bin" onClick={onNewBin}>
              <Icon name="folderPlus" />
            </button>
          )}
          <span className="rs-media__spacer" />
          <button className={`rs-btn rs-btn--icon rs-btn--ghost${m.density === 'grid' ? ' is-on' : ''}`} title="Thumbnails" aria-label="Thumbnail grid" aria-pressed={m.density === 'grid'} onClick={() => setMedia({ density: 'grid' })}>
            <Icon name="grid" />
          </button>
          <button className={`rs-btn rs-btn--icon rs-btn--ghost${m.density === 'list' ? ' is-on' : ''}`} title="Compact list" aria-label="Compact list" aria-pressed={m.density === 'list'} onClick={() => setMedia({ density: 'list' })}>
            <Icon name="list" />
          </button>
        </div>
        <div className="rs-media__views">
          <label className="rs-media__sortlbl" htmlFor="rs-media-sort">Sort</label>
          <select id="rs-media-sort" className="rs-select rs-media__sort" value={m.sortKey} onChange={(e) => setMedia({ sortKey: e.target.value as SortKey })} onKeyDown={(e) => e.stopPropagation()}>
            {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
              <option key={k} value={k}>{SORT_LABELS[k]}</option>
            ))}
          </select>
          <button className="rs-btn rs-btn--icon rs-btn--ghost" title={m.sortDir === 'asc' ? 'Ascending (click for descending)' : 'Descending (click for ascending)'} aria-label="Reverse sort order" onClick={() => setMedia({ sortDir: m.sortDir === 'asc' ? 'desc' : 'asc' })}>
            <Icon name={m.sortDir === 'asc' ? 'sortUp' : 'sortDown'} />
          </button>
        </div>
      </div>
    </>
  );
}
