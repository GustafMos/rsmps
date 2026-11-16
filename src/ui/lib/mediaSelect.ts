/** Media panel selection: click / ctrl-click / shift-click range. Pure. Arrow-key movement lives in mediaLayout (it needs the rows). */

export interface Sel {
  ids: ReadonlySet<string>;
  /** Where a shift-range starts. */
  anchor: string | null;
  /** The keyboard cursor (the item with focus). */
  cursor: string | null;
}

export const NO_SEL: Sel = { ids: new Set(), anchor: null, cursor: null };

/** `order` is every selectable id as the panel currently shows them (collapsed bins left out). */
export function clickSelect(sel: Sel, order: readonly string[], id: string, mods: { ctrl?: boolean; shift?: boolean }): Sel {
  if (mods.shift && sel.anchor && order.includes(sel.anchor) && order.includes(id)) {
    const a = order.indexOf(sel.anchor);
    const b = order.indexOf(id);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    const ids = new Set(mods.ctrl ? [...sel.ids, ...range] : range);
    return { ids, anchor: sel.anchor, cursor: id };
  }
  if (mods.ctrl || mods.shift) {
    const ids = new Set(sel.ids);
    ids.has(id) ? ids.delete(id) : ids.add(id);
    return { ids, anchor: id, cursor: id };
  }
  return { ids: new Set([id]), anchor: id, cursor: id };
}

/** Move the cursor (arrow keys); with shift the selection grows from the anchor to it. */
export function moveSelect(sel: Sel, order: readonly string[], to: string | null, extend: boolean): Sel {
  if (!to) return sel;
  if (!extend) return { ids: new Set([to]), anchor: to, cursor: to };
  return clickSelect({ ...sel, anchor: sel.anchor ?? sel.cursor ?? to }, order, to, { shift: true });
}

/** Drop ids that no longer exist or are hidden by a filter. */
export function pruneSel(sel: Sel, visible: ReadonlySet<string>): Sel {
  let dirty = sel.cursor !== null && !visible.has(sel.cursor);
  const ids = new Set<string>();
  for (const id of sel.ids) visible.has(id) ? ids.add(id) : (dirty = true);
  if (sel.anchor && !visible.has(sel.anchor)) dirty = true;
  return dirty ? { ids, anchor: sel.anchor && visible.has(sel.anchor) ? sel.anchor : null, cursor: sel.cursor && visible.has(sel.cursor) ? sel.cursor : null } : sel;
}

/** What a context menu / drag acts on: the whole selection when the clicked item is in it, else just that item. */
export function targetsOf(sel: Sel, id: string): string[] {
  return sel.ids.has(id) ? [...sel.ids] : [id];
}
