import type { DragEvent, MouseEvent } from 'react';
import { Icon } from '../components/Icon';
import { describeItem, groupLabel, type MediaItem } from '../lib/mediaFilter';
import { GROUP_ICON, MediaThumb } from './MediaThumb';
import { RenameField } from './RenameField';

export interface AssetProps {
  item: MediaItem;
  selected: boolean;
  /** The keyboard cursor is on it (drawn with the focus ring while the list has focus). */
  cursor: boolean;
  /** How many nodes of this project use it. */
  uses: number;
  renaming: boolean;
  onClick: (e: MouseEvent) => void;
  onOpen: () => void;
  onMenu: (e: MouseEvent) => void;
  onDragStart: (e: DragEvent) => void;
  onRenamed: (name: string | null) => void;
  onRemove: () => void;
}

const useText = (n: number) => `Used by ${n} node${n === 1 ? '' : 's'} in this project`;

function common(p: AssetProps) {
  return {
    id: `media-${p.item.id}`,
    role: 'option' as const,
    'aria-selected': p.selected,
    draggable: !p.renaming,
    onClick: p.onClick,
    onDoubleClick: p.onOpen,
    onContextMenu: p.onMenu,
    onDragStart: p.onDragStart,
    title: `${p.item.name}\n${describeItem(p.item)}\nDrag onto the graph to create a node. Double-click or Enter adds it.`,
  };
}

/** Grid view: thumbnail with the name under it. */
export function AssetCell(p: AssetProps) {
  const { item } = p;
  return (
    <div {...common(p)} className={`rs-media__cell${p.selected ? ' is-sel' : ''}${p.cursor ? ' is-cursor' : ''}`}>
      <MediaThumb item={item} size={60} />
      {p.uses > 0 && (
        <span className="rs-media__use rs-num" title={useText(p.uses)}>
          {p.uses}
        </span>
      )}
      <button className="rs-media__rm rs-btn rs-btn--icon rs-btn--ghost" title="Remove from library" aria-label={`Remove ${item.name} from library`} onClick={(e) => { e.stopPropagation(); p.onRemove(); }}>
        <Icon name="close" size={11} />
      </button>
      {p.renaming ? <RenameField value={item.name} label="Asset name" onDone={p.onRenamed} /> : <span className="rs-media__name">{item.name}</span>}
    </div>
  );
}

/** List view: small thumbnail, name, type icon, resolution or duration. */
export function AssetRow(p: AssetProps) {
  const { item } = p;
  return (
    <div {...common(p)} className={`rs-media__row${p.selected ? ' is-sel' : ''}${p.cursor ? ' is-cursor' : ''}`}>
      <MediaThumb item={item} size={24} />
      {p.renaming ? <RenameField value={item.name} label="Asset name" onDone={p.onRenamed} /> : <span className="rs-media__name">{item.name}</span>}
      {p.uses > 0 && (
        <span className="rs-media__use rs-media__use--row rs-num" title={useText(p.uses)}>
          {p.uses}
        </span>
      )}
      <span className="rs-media__sub rs-num">{describeItem(item)}</span>
      <span className="rs-media__type" title={groupLabel(item.group)}>
        <Icon name={GROUP_ICON[item.group]} size={12} />
      </span>
      <button className="rs-media__rm rs-btn rs-btn--icon rs-btn--ghost" title="Remove from library" aria-label={`Remove ${item.name} from library`} onClick={(e) => { e.stopPropagation(); p.onRemove(); }}>
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}
