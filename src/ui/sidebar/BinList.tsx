import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { Icon } from '../components/Icon';
import { ASSET_MIME } from '../graph/gestures';
import { binColor } from '../lib/mediaOrg';
import { METRICS, rowOfItem, visibleRange, type Density, type Row } from '../lib/mediaLayout';
import type { Section } from '../lib/mediaFilter';
import type { Sel } from '../lib/mediaSelect';
import { AssetCell, AssetRow, type AssetProps } from './AssetCell';
import { RenameField } from './RenameField';

export interface ListActions {
  onSelect: (id: string, e: MouseEvent) => void;
  onOpen: (id: string) => void;
  onAssetMenu: (id: string, e: MouseEvent) => void;
  onAssetDrag: (id: string, e: DragEvent) => void;
  onAssetRenamed: (id: string, name: string | null) => void;
  onRemove: (id: string) => void;
  onToggle: (sectionId: string) => void;
  onSectionMenu: (s: Section, e: MouseEvent) => void;
  onBinRenamed: (binId: string, name: string | null) => void;
  onStartBinRename: (binId: string) => void;
  onRecolor: (binId: string) => void;
  /** Assets dragged out of this panel were dropped on a section (a bin id, or null = Unsorted). */
  onDropAssets: (binId: string | null, ids: string[]) => void;
  /** Files from the desktop were dropped on a section. */
  onDropFiles: (binId: string | null, files: File[]) => void;
}

interface Props extends ListActions {
  rows: readonly Row[];
  height: number;
  cols: number;
  density: Density;
  filtering: boolean;
  sel: Sel;
  usage: ReadonlyMap<string, readonly string[]>;
  renamingAsset: string | null;
  renamingBin: string | null;
  empty: ReactNode;
  onKeyDown: (e: React.KeyboardEvent) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}

/** The scrolling, virtual list of sections and assets: only the rows inside the window are in the DOM, so hundreds of assets stay cheap. */
export function BinList(p: Props) {
  const [view, setView] = useState({ top: 0, h: 400 });
  const [dropOn, setDropOn] = useState<string | null>(null);
  const raf = useRef(0);
  const el = p.scrollRef;

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const measure = () => setView((v) => (v.h === node.clientHeight ? v : { ...v, h: node.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [el]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // a click anywhere else (the graph may not take focus itself) must hand the keys back: Delete there deletes nodes, not media
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const node = el.current;
      if (node && document.activeElement === node && !node.contains(e.target as Node | null)) node.blur();
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [el]);

  // keep the keyboard cursor in view
  const cursor = p.sel.cursor;
  useEffect(() => {
    const node = el.current;
    const row = cursor ? rowOfItem(p.rows, cursor) : null;
    if (!node || !row) return;
    if (row.y < node.scrollTop) node.scrollTop = row.y - METRICS.head;
    else if (row.y + row.h > node.scrollTop + node.clientHeight) node.scrollTop = row.y + row.h - node.clientHeight + METRICS.pad;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  const [from, to] = visibleRange(p.rows, view.top, view.h);

  const accepts = (e: DragEvent) => e.dataTransfer.types.includes(ASSET_MIME) || e.dataTransfer.types.includes('Files');
  const zone = (section: { id: string; kind: Section['kind']; binId?: string }) => {
    if (section.kind !== 'bin' && section.kind !== 'unsorted') return {};
    const bin = section.kind === 'bin' ? (section.binId ?? null) : null;
    return {
      onDragOver: (e: DragEvent) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = e.dataTransfer.types.includes(ASSET_MIME) ? 'move' : 'copy';
        if (dropOn !== section.id) setDropOn(section.id);
      },
      onDragLeave: (e: DragEvent) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropOn((cur) => (cur === section.id ? null : cur));
      },
      onDrop: (e: DragEvent) => {
        setDropOn(null);
        const raw = e.dataTransfer.getData(ASSET_MIME);
        if (raw) {
          e.preventDefault();
          e.stopPropagation();
          try {
            p.onDropAssets(bin, JSON.parse(raw) as string[]);
          } catch {
            /* not ours */
          }
        } else if (e.dataTransfer.files.length) {
          e.preventDefault();
          e.stopPropagation();
          p.onDropFiles(bin, Array.from(e.dataTransfer.files));
        }
      },
    };
  };

  return (
    <div
      ref={el}
      className="rs-media__scroll"
      role="listbox"
      aria-multiselectable="true"
      aria-label="Media"
      aria-activedescendant={cursor ? `media-${cursor}` : undefined}
      tabIndex={0}
      onKeyDown={p.onKeyDown}
      onScroll={(e) => {
        const top = e.currentTarget.scrollTop;
        cancelAnimationFrame(raf.current);
        raf.current = requestAnimationFrame(() => setView((v) => (v.top === top ? v : { ...v, top })));
      }}
    >
      {p.rows.length === 0 ? (
        p.empty
      ) : (
        <div className="rs-media__space" style={{ height: p.height }}>
          {p.rows.slice(from, to).map((r) => {
            const style = { top: r.y, height: r.h };
            if (r.kind === 'head') {
              const s = r.section;
              return (
                <div key={`h:${s.id}`} className={`rs-media__headrow${dropOn === s.id ? ' is-drop' : ''}`} style={style} {...zone(s)}>
                  <SectionHead section={r.section} collapsed={r.collapsed} filtering={p.filtering} renaming={p.renamingBin === s.id} actions={p} />
                </div>
              );
            }
            if (r.kind === 'empty') {
              return (
                <div key={`e:${r.sectionId}`} className={`rs-media__emptyrow${dropOn === r.sectionId ? ' is-drop' : ''}`} style={style} {...zone({ id: r.sectionId, kind: 'bin', binId: r.sectionId })}>
                  {r.text}
                </div>
              );
            }
            const sec = r.sectionId;
            const kind: Section['kind'] = sec === 'unsorted' ? 'unsorted' : sec.startsWith('type:') || sec === 'all' ? 'type' : 'bin';
            return (
              <div
                key={`i:${r.items[0].id}`}
                className={`rs-media__itemrow rs-media__itemrow--${p.density}${dropOn === sec ? ' is-drop' : ''}`}
                style={{ ...style, gridTemplateColumns: p.density === 'grid' ? `repeat(${p.cols}, minmax(0, 1fr))` : undefined }}
                {...zone({ id: sec, kind, binId: sec })}
              >
                {r.items.map((item) => {
                  const props: AssetProps = {
                    item,
                    selected: p.sel.ids.has(item.id),
                    cursor: p.sel.cursor === item.id,
                    uses: p.usage.get(item.id)?.length ?? 0,
                    renaming: p.renamingAsset === item.id,
                    onClick: (e) => p.onSelect(item.id, e),
                    onOpen: () => p.onOpen(item.id),
                    onMenu: (e) => p.onAssetMenu(item.id, e),
                    onDragStart: (e) => p.onAssetDrag(item.id, e),
                    onRenamed: (name) => p.onAssetRenamed(item.id, name),
                    onRemove: () => p.onRemove(item.id),
                  };
                  return p.density === 'grid' ? <AssetCell key={item.id} {...props} /> : <AssetRow key={item.id} {...props} />;
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SectionHead({ section: s, collapsed, filtering, renaming, actions }: { section: Section; collapsed: boolean; filtering: boolean; renaming: boolean; actions: ListActions }) {
  const isBin = s.kind === 'bin' && !!s.binId;
  const count = filtering ? `${s.items.length}/${s.total}` : String(s.total);
  return (
    <div
      className="rs-media__head"
      onClick={() => actions.onToggle(s.id)}
      onContextMenu={isBin ? (e) => actions.onSectionMenu(s, e) : undefined}
      aria-expanded={!collapsed}
      role="button"
      title={collapsed ? 'Expand' : 'Collapse'}
    >
      <Icon name={collapsed ? 'chevRight' : 'chevDown'} size={12} />
      {isBin && (
        <button
          className="rs-media__dot"
          style={{ background: binColor(s.color ?? 0) }}
          title="Change the bin colour"
          aria-label={`Change colour of ${s.label}`}
          onClick={(e) => { e.stopPropagation(); actions.onRecolor(s.binId!); }}
        />
      )}
      {renaming && isBin ? (
        <RenameField value={s.label} label="Bin name" onDone={(name) => actions.onBinRenamed(s.binId!, name)} />
      ) : (
        <span className="rs-media__headname" onDoubleClick={isBin ? (e) => { e.stopPropagation(); actions.onStartBinRename(s.binId!); } : undefined}>
          {s.label}
        </span>
      )}
      <span className="rs-media__count rs-num">{count}</span>
      {isBin && (
        <button className="rs-media__more rs-btn rs-btn--icon rs-btn--ghost" title="Bin options" aria-label={`Options for ${s.label}`} onClick={(e) => { e.stopPropagation(); actions.onSectionMenu(s, e); }}>
          <Icon name="more" size={12} />
        </button>
      )}
    </div>
  );
}
