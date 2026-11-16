/**
 * Media panel layout: sections become fixed-height rows (a header, a row of grid cells, a list row or an empty-bin hint), so a library
 * of hundreds of assets renders only the rows on screen. Also the arrow-key movement, which needs the rows to find "the cell above".
 */
import type { MediaItem, Section } from './mediaFilter';

export type Density = 'grid' | 'list';

export const METRICS = { head: 26, gridRow: 94, listRow: 34, empty: 30, gridMin: 76, gap: 4, pad: 4 } as const;

export type Row =
  | { kind: 'head'; y: number; h: number; section: Section; collapsed: boolean }
  | { kind: 'items'; y: number; h: number; sectionId: string; items: MediaItem[] }
  | { kind: 'empty'; y: number; h: number; sectionId: string; text: string };

type NoY<T> = T extends unknown ? Omit<T, 'y'> : never;

/** How many grid cells fit in a row of `width` px. */
export function columnsFor(width: number): number {
  const w = Math.max(0, width - METRICS.pad * 2);
  return Math.max(1, Math.floor((w + METRICS.gap) / (METRICS.gridMin + METRICS.gap)));
}

export function layoutRows(sections: readonly Section[], collapsed: ReadonlySet<string>, cols: number, density: Density): { rows: Row[]; height: number } {
  const rows: Row[] = [];
  let y = METRICS.pad;
  const push = (r: NoY<Row>) => {
    rows.push({ ...r, y } as Row);
    y += r.h;
  };
  const perRow = density === 'grid' ? Math.max(1, cols) : 1;
  const rowH = density === 'grid' ? METRICS.gridRow : METRICS.listRow;
  for (const s of sections) {
    const closed = s.kind !== 'flat' && collapsed.has(s.id);
    if (s.kind !== 'flat') push({ kind: 'head', h: METRICS.head, section: s, collapsed: closed });
    if (closed) continue;
    if (!s.items.length) {
      if (s.kind === 'bin') push({ kind: 'empty', h: METRICS.empty, sectionId: s.id, text: s.total > 0 ? 'No matches in this bin' : 'Empty. Drag media here' });
      continue;
    }
    for (let i = 0; i < s.items.length; i += perRow) push({ kind: 'items', h: rowH, sectionId: s.id, items: s.items.slice(i, i + perRow) });
  }
  return { rows, height: y + METRICS.pad };
}

/** Index range [from, to) of the rows to render for a scroll window, with `overscan` extra rows on both sides. */
export function visibleRange(rows: readonly Row[], top: number, height: number, overscan = 2): [number, number] {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].y + rows[mid].h <= top) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < rows.length && rows[end].y < top + height) end++;
  return [Math.max(0, lo - overscan), Math.min(rows.length, end + overscan)];
}

/** Every item id in display order (collapsed sections contribute nothing). */
export function orderedIds(rows: readonly Row[]): string[] {
  const out: string[] = [];
  for (const r of rows) if (r.kind === 'items') for (const a of r.items) out.push(a.id);
  return out;
}

/** The row holding an item (its y and height), to scroll it into view. */
export function rowOfItem(rows: readonly Row[], id: string): Row | null {
  return rows.find((r) => r.kind === 'items' && r.items.some((a) => a.id === id)) ?? null;
}

export type CursorKey = 'left' | 'right' | 'up' | 'down' | 'home' | 'end';

/** Where an arrow key takes the keyboard cursor. */
export function moveCursor(rows: readonly Row[], from: string | null, key: CursorKey): string | null {
  const itemRows = rows.filter((r): r is Extract<Row, { kind: 'items' }> => r.kind === 'items');
  const flat = itemRows.flatMap((r) => r.items.map((a) => a.id));
  if (!flat.length) return null;
  if (key === 'home') return flat[0];
  if (key === 'end') return flat[flat.length - 1];
  const at = from ? flat.indexOf(from) : -1;
  if (at < 0) return flat[0];
  if (key === 'left') return flat[Math.max(0, at - 1)];
  if (key === 'right') return flat[Math.min(flat.length - 1, at + 1)];
  const ri = itemRows.findIndex((r) => r.items.some((a) => a.id === from));
  const col = itemRows[ri].items.findIndex((a) => a.id === from);
  const target = itemRows[ri + (key === 'down' ? 1 : -1)];
  if (!target) return from;
  return target.items[Math.min(col, target.items.length - 1)].id;
}
