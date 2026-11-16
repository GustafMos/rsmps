/** Media panel: type groups, filtering, sorting and the sections of the three views (Bins / By type / Flat). Pure. */
import type { AssetInfo, MediaOrg } from '../../engine/types';
import { binOf } from './mediaOrg';

export type TypeGroup = 'video' | 'sequence' | 'image' | 'audio' | 'model3d' | 'lut' | 'subtitles' | 'textures' | 'other';

/** Display order of the groups (chips, "By type" view, sort by type). */
export const GROUPS: readonly { id: TypeGroup; label: string; singular: string }[] = [
  { id: 'video', label: 'Video', singular: 'video' },
  { id: 'image', label: 'Images', singular: 'image' },
  { id: 'sequence', label: 'Sequences', singular: 'sequence' },
  { id: 'audio', label: 'Audio', singular: 'audio' },
  { id: 'model3d', label: '3D', singular: '3D model' },
  { id: 'lut', label: 'LUTs', singular: 'LUT' },
  { id: 'subtitles', label: 'Subtitles', singular: 'subtitles' },
  { id: 'textures', label: 'Textures', singular: 'texture' },
  { id: 'other', label: 'Other', singular: 'file' },
];
const GROUP_INDEX = new Map(GROUPS.map((g, i) => [g.id, i]));
export const groupLabel = (g: TypeGroup): string => GROUPS[GROUP_INDEX.get(g) ?? GROUPS.length - 1].label;

export interface MediaItem {
  id: string;
  name: string;
  kind: string;
  group: TypeGroup;
  width: number;
  height: number;
  duration: number;
  bytes: number;
  /** Position in the library (it lists assets oldest first), used for "Date added". */
  order: number;
}

export interface MediaMeta {
  sequence: boolean;
  bytes: number;
  shelf?: string;
}

export function groupOf(kind: string, meta: Pick<MediaMeta, 'sequence' | 'shelf'>): TypeGroup {
  if (meta.shelf === 'textures') return 'textures';
  switch (kind) {
    case 'video':
      return meta.sequence ? 'sequence' : 'video';
    case 'image':
      return 'image';
    case 'audio':
    case 'midi':
      return 'audio';
    case 'model':
    case 'splat':
      return 'model3d';
    case 'lut':
      return 'lut';
    case 'subtitles':
      return 'subtitles';
    default:
      return 'other';
  }
}

export function toItem(info: AssetInfo, meta: MediaMeta, order: number): MediaItem {
  return { id: info.id, name: info.name, kind: info.kind, group: groupOf(info.kind, meta), width: info.width, height: info.height, duration: info.duration, bytes: meta.bytes, order };
}

/** Secondary line of an asset ("1920×1080 · 4.0s", "audio · 2.1s", "LUT"). */
export function describeItem(a: MediaItem): string {
  if (a.group === 'audio') return `${a.kind} · ${a.duration.toFixed(1)}s`;
  if (a.group === 'video' || a.group === 'sequence') return `${a.width}×${a.height} · ${a.duration.toFixed(1)}s`;
  if (a.width > 0 && a.height > 0) return `${a.width}×${a.height}`;
  return GROUPS[GROUP_INDEX.get(a.group) ?? 0].singular;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export type TypeFilter = 'all' | TypeGroup;

export function countByGroup(items: readonly MediaItem[]): Record<TypeGroup, number> {
  const out = Object.fromEntries(GROUPS.map((g) => [g.id, 0])) as Record<TypeGroup, number>;
  for (const a of items) out[a.group]++;
  return out;
}

export interface Query {
  type: TypeFilter;
  text: string;
  unusedOnly: boolean;
}

export const NO_QUERY: Query = { type: 'all', text: '', unusedOnly: false };
export const isFiltering = (q: Query): boolean => q.type !== 'all' || q.text.trim() !== '' || q.unusedOnly;

/** Words are ANDed; each must be part of the name or of the type's label. */
export function matchesText(a: MediaItem, text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${a.name} ${groupLabel(a.group)} ${a.kind}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

export function filterItems(items: readonly MediaItem[], q: Query, used: ReadonlySet<string>): MediaItem[] {
  return items.filter((a) => (q.type === 'all' || a.group === q.type) && (!q.unusedOnly || !used.has(a.id)) && matchesText(a, q.text));
}

export type SortKey = 'name' | 'added' | 'type' | 'duration' | 'size';
export const SORT_LABELS: Record<SortKey, string> = { name: 'Name', added: 'Date added', type: 'Type', duration: 'Duration', size: 'Size' };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortItems(items: readonly MediaItem[], key: SortKey, dir: 'asc' | 'desc'): MediaItem[] {
  const cmp = (a: MediaItem, b: MediaItem): number => {
    switch (key) {
      case 'added':
        return a.order - b.order;
      case 'type':
        return (GROUP_INDEX.get(a.group) ?? 99) - (GROUP_INDEX.get(b.group) ?? 99) || collator.compare(a.name, b.name);
      case 'duration':
        return a.duration - b.duration || collator.compare(a.name, b.name);
      case 'size':
        return a.bytes - b.bytes || collator.compare(a.name, b.name);
      default:
        return collator.compare(a.name, b.name) || a.order - b.order;
    }
  };
  const out = [...items].sort(cmp);
  return dir === 'desc' ? out.reverse() : out;
}

export type ViewMode = 'bins' | 'type' | 'flat';

export interface Section {
  /** Stable id: the bin id, 'unsorted', 'type:<group>' or 'all'. Used for collapse state and drops. */
  id: string;
  label: string;
  kind: 'bin' | 'unsorted' | 'type' | 'flat';
  binId?: string;
  color?: number;
  items: MediaItem[];
  /** Items of this section before search / type filtering (shows "3 / 12" while filtering). */
  total: number;
}

export const UNSORTED = 'unsorted';

/**
 * The sections the panel shows. `all` is every visible asset, `shown` those passing the filters. While filtering, sections left empty
 * disappear (a bin you are not searching in is noise); with no filter, bins always show, even empty ones, so they can take drops.
 */
export function buildSections(all: readonly MediaItem[], shown: readonly MediaItem[], org: MediaOrg, view: ViewMode, key: SortKey, dir: 'asc' | 'desc', filtering: boolean): Section[] {
  const sorted = sortItems(shown, key, dir);
  if (view === 'flat') return [{ id: 'all', label: 'All media', kind: 'flat', items: sorted, total: all.length }];
  if (view === 'type') {
    const totals = countByGroup(all);
    return GROUPS.map((g) => ({ id: `type:${g.id}`, label: g.label, kind: 'type' as const, items: sorted.filter((a) => a.group === g.id), total: totals[g.id] })).filter((s) => (filtering ? s.items.length > 0 : s.total > 0));
  }
  const totalIn = new Map<string, number>();
  const byBin = new Map<string, MediaItem[]>();
  for (const a of all) {
    const b = binOf(org, a.id) ?? UNSORTED;
    totalIn.set(b, (totalIn.get(b) ?? 0) + 1);
  }
  for (const a of sorted) {
    const b = binOf(org, a.id) ?? UNSORTED;
    (byBin.get(b) ?? byBin.set(b, []).get(b)!).push(a);
  }
  const out: Section[] = org.bins.map((b) => ({ id: b.id, label: b.name, kind: 'bin' as const, binId: b.id, color: b.color, items: byBin.get(b.id) ?? [], total: totalIn.get(b.id) ?? 0 }));
  out.push({ id: UNSORTED, label: 'Unsorted', kind: 'unsorted', items: byBin.get(UNSORTED) ?? [], total: totalIn.get(UNSORTED) ?? 0 });
  return filtering ? out.filter((s) => s.items.length > 0) : out.filter((s) => s.kind !== 'unsorted' || s.total > 0 || org.bins.length === 0);
}
