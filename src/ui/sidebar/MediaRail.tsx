import { outputNodes } from '../../engine/graph';
import { Icon } from '../components/Icon';
import { GROUPS, countByGroup, type TypeFilter } from '../lib/mediaFilter';
import { useApp, useEd } from '../store/context';
import { openMediaOn, toggleMediaPanel } from '../store/media';
import { GROUP_ICON } from './MediaThumb';
import { useMediaItems } from './useMediaData';

/**
 * The media panel folded to a slim vertical rail: one icon per kind of media with its count, an Outputs button and the import button.
 * No thumbnails are made while it is shown. Dropping files on it imports them.
 */
export function MediaRail({ busy, onImport }: { busy: boolean; onImport: () => void }) {
  const items = useMediaItems();
  const counts = countByGroup(items);
  const { io } = useApp();
  const outputs = useEd((s) => outputNodes(s.graph, io.registry).length);
  const open = (type: TypeFilter) => openMediaOn(type);
  return (
    <div className="rs-rail" role="toolbar" aria-orientation="vertical" aria-label="Media (collapsed)">
      <button className="rs-btn rs-btn--icon rs-btn--ghost" title="Open the media panel" aria-label="Open media panel" onClick={toggleMediaPanel}>
        <Icon name="chevRight" />
      </button>
      <button className="rs-btn rs-btn--icon rs-btn--ghost" title="Import files" aria-label="Import files" onClick={onImport} disabled={busy}>
        <Icon name="plus" />
      </button>
      <div className="rs-rail__sep" />
      <RailButton icon="folder" label="All media" count={items.length} onClick={() => open('all')} />
      {GROUPS.filter((g) => g.id !== 'other' && counts[g.id] > 0).map((g) => (
        <RailButton key={g.id} icon={GROUP_ICON[g.id]} label={g.label} count={counts[g.id]} onClick={() => open(g.id)} />
      ))}
      <div className="rs-rail__spacer" />
      <RailButton icon="export" label="Outputs" count={outputs} onClick={toggleMediaPanel} />
    </div>
  );
}

function RailButton({ icon, label, count, onClick }: { icon: Parameters<typeof Icon>[0]['name']; label: string; count: number; onClick: () => void }) {
  return (
    <button className="rs-btn rs-btn--icon rs-btn--ghost rs-rail__btn" title={`${label} (${count})`} aria-label={`${label}, ${count}`} onClick={onClick}>
      <Icon name={icon} />
      <span className="rs-rail__badge rs-num">{count > 99 ? '99+' : count}</span>
    </button>
  );
}
