/**
 * Two-finger pinch-zoom and pan for the node graph (touch screens). Pure maths plus a small pointer tracker; GraphView feeds it
 * pointer events. Mouse and trackpad (wheel, middle button, Space-drag) do not go through here at all.
 */
export interface Pt {
  x: number;
  y: number;
}
export interface ViewState {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 2.5;

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * New pan/zoom after the two fingers moved from `prev` to `next` (client coordinates; `origin` = top-left of the graph panel).
 * The point of the graph that was under the old midpoint stays under the new midpoint: that is the pan, and the change in finger
 * distance is the zoom (clamped; a clamp never shifts the anchor).
 */
export function pinchView(view: ViewState, prev: readonly [Pt, Pt], next: readonly [Pt, Pt], origin: Pt = { x: 0, y: 0 }, min = MIN_ZOOM, max = MAX_ZOOM): ViewState {
  const m0 = mid(prev[0], prev[1]);
  const m1 = mid(next[0], next[1]);
  const d0 = dist(prev[0], prev[1]);
  const d1 = dist(next[0], next[1]);
  const k = d0 > 1 && d1 > 0 ? d1 / d0 : 1; // fingers nearly on top of each other: pan only
  const zoom = Math.min(max, Math.max(min, view.zoom * k));
  const wx = (m0.x - origin.x - view.x) / view.zoom;
  const wy = (m0.y - origin.y - view.y) / view.zoom;
  return { zoom, x: m1.x - origin.x - wx * zoom, y: m1.y - origin.y - wy * zoom };
}

/**
 * Follows touch pointers. `active` is true from the moment a second finger lands until every finger has lifted, so the finger left
 * over after a pinch does not start dragging a node or the background.
 */
export class PinchTracker {
  private pts = new Map<number, Pt>();
  active = false;

  down(id: number, p: Pt): void {
    this.pts.set(id, p);
    if (this.pts.size >= 2) this.active = true;
  }

  /** The two tracked fingers before and after this move, or null when this is not a two-finger move. */
  move(id: number, p: Pt): { prev: [Pt, Pt]; next: [Pt, Pt] } | null {
    if (!this.pts.has(id)) return null;
    if (!this.active || this.pts.size < 2) {
      this.pts.set(id, p);
      return null;
    }
    const ids = [...this.pts.keys()].slice(0, 2);
    const prev: [Pt, Pt] = [this.pts.get(ids[0])!, this.pts.get(ids[1])!];
    this.pts.set(id, p);
    if (!ids.includes(id)) return null; // a third finger changes nothing
    const next: [Pt, Pt] = [this.pts.get(ids[0])!, this.pts.get(ids[1])!];
    return { prev, next };
  }

  up(id: number): void {
    this.pts.delete(id);
    if (this.pts.size === 0) this.active = false;
  }

  reset(): void {
    this.pts.clear();
    this.active = false;
  }
}
