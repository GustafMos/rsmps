/**
 * Presentation of a multi input's wires as rows. Wire order (index 0 = first wire) is what is stored and rendered; a
 * `top-first` input (a layer stack: the first wire is the bottom layer, later wires are drawn over it) lists the LAST wire
 * first, like the layer panel of a picture editor. Other inputs list the wires in wire order.
 */

/** Row position (0 = first row of the list) of wire `k` out of `n`. */
export function layerRowIndex(k: number, n: number, topFirst: boolean): number {
  return topFirst ? n - 1 - k : k;
}

export interface LayerRowInfo {
  /** wire index (position among the wires into the input) */
  k: number;
  label: string;
  role: 'top' | 'middle' | 'bottom' | 'plain';
}

/**
 * Rows in display order. Top-first: "Top", then "2", "3"... counted from the top, and "Bottom" (+ " · note") for the first wire.
 * A single wire is the bottom. Other inputs: plain numbers in wire order (the first gets " · note" when a note is given).
 */
export function layerRows(n: number, topFirst: boolean, firstNote?: string): LayerRowInfo[] {
  const rows: LayerRowInfo[] = [];
  for (let r = 0; r < n; r++) {
    const k = layerRowIndex(r, n, topFirst); // the mapping is its own inverse
    if (!topFirst) {
      rows.push({ k, label: k === 0 && firstNote ? `1 · ${firstNote}` : String(k + 1), role: 'plain' });
    } else if (k === 0) {
      rows.push({ k, label: firstNote ? `Bottom · ${firstNote}` : 'Bottom', role: 'bottom' });
    } else if (r === 0) {
      rows.push({ k, label: 'Top', role: 'top' });
    } else {
      rows.push({ k, label: String(r + 1), role: 'middle' });
    }
  }
  return rows;
}

/** Wire-index change for "move up" (towards the top of the list). Top-first lists: up = later wire. */
export const moveUpDelta = (topFirst: boolean): number => (topFirst ? 1 : -1);
