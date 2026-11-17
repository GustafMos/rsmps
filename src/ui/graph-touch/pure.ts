/** Pure helpers of the touch layer for the node graph (tested without a DOM). */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Auto-pan while dragging a node or a wire toward the edge of the graph: the view should move so the content slides under the finger.
 * Returns the view offset change per frame (to ADD to view.x / view.y): content moves right when the finger is at the left edge, and so on.
 * Zero in the middle; grows linearly across the `zone` px next to each edge up to `max` px per frame.
 */
export function edgePanVelocity(x: number, y: number, r: Rect, zone = 44, max = 14): { dx: number; dy: number } {
  const axis = (p: number, lo: number, hi: number): number => {
    if (p < lo + zone) return Math.min(1, (lo + zone - p) / zone) * max;
    if (p > hi - zone) return -Math.min(1, (p - (hi - zone)) / zone) * max;
    return 0;
  };
  // never pan when the pointer is outside the panel on the far side (a drop on the toolbar etc. would run away)
  const inside = x >= r.left - 60 && x <= r.right + 60 && y >= r.top - 60 && y <= r.bottom + 60;
  return inside ? { dx: axis(x, r.left, r.right), dy: axis(y, r.top, r.bottom) } : { dx: 0, dy: 0 };
}

/** Remembers the last tap and says whether the next one makes a double tap on the same thing. */
export class DoubleTap {
  private last: { t: number; x: number; y: number; key: string } | null = null;
  constructor(private readonly gapMs = 350, private readonly slop = 32) {}
  /** Call on every completed tap. True when it completes a double tap (the memory is then cleared). */
  tap(t: number, x: number, y: number, key: string): boolean {
    const l = this.last;
    if (l && l.key === key && t - l.t <= this.gapMs && Math.hypot(x - l.x, y - l.y) <= this.slop) {
      this.last = null;
      return true;
    }
    this.last = { t, x, y, key };
    return false;
  }
  reset(): void {
    this.last = null;
  }
}

/** A press is a tap when it was short and barely moved. */
export function isTap(dtMs: number, moved: number, maxMs = 450, slop = 8): boolean {
  return dtMs <= maxMs && moved <= slop;
}

export interface View {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Raise a framed view to a zoom at which node titles can be read, keeping the same point of the graph in the middle of the panel
 * (or `focus`, a point in graph coordinates, when given). A view that is already legible is returned as is.
 */
export function legibleView(v: View, panel: { width: number; height: number }, minZoom: number, focus?: { x: number; y: number }): View {
  if (v.zoom >= minZoom) return v;
  const cx = focus ? focus.x : (panel.width / 2 - v.x) / v.zoom;
  const cy = focus ? focus.y : (panel.height / 2 - v.y) / v.zoom;
  return { zoom: minZoom, x: panel.width / 2 - cx * minZoom, y: panel.height / 2 - cy * minZoom };
}

/** Nodes in evaluation order: every node comes after the nodes that feed it. Ties keep the left-to-right, top-to-bottom order. Cycles are tolerated. */
export function evaluationOrder<N extends { id: string; x: number; y: number }>(nodes: readonly N[], edges: readonly { from: { node: string }; to: { node: string } }[]): N[] {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0] as const));
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (!byId.has(e.from.node) || !byId.has(e.to.node) || e.from.node === e.to.node) continue;
    indeg.set(e.to.node, (indeg.get(e.to.node) ?? 0) + 1);
    (out.get(e.from.node) ?? out.set(e.from.node, []).get(e.from.node)!).push(e.to.node);
  }
  const spatial = (a: N, b: N) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id);
  const ready = nodes.filter((n) => indeg.get(n.id) === 0).sort(spatial);
  const result: N[] = [];
  const seen = new Set<string>();
  while (ready.length) {
    const n = ready.shift()!;
    result.push(n);
    seen.add(n.id);
    for (const to of out.get(n.id) ?? []) {
      const d = (indeg.get(to) ?? 1) - 1;
      indeg.set(to, d);
      if (d === 0) {
        ready.push(byId.get(to)!);
        ready.sort(spatial);
      }
    }
  }
  for (const n of [...nodes].sort(spatial)) if (!seen.has(n.id)) result.push(n); // part of a cycle: still listed
  return result;
}
