import type { Registry } from '../../engine/define';
import type { GraphDoc } from '../../engine/types';
import { nodeRects } from './geometry';
import { layoutFor } from './layout';

interface R { x: number; y: number; w: number; h: number }
const MARGIN = 10;

const hit = (a: R, b: R, m = MARGIN) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;

/**
 * Nodes that were added or moved by an edit must not sit on top of nodes the user did not touch. The moved nodes keep their
 * relative layout and slide together to the nearest free spot (candidates: just right / left / below / above of whatever they hit).
 * Untouched nodes never move. Big layout operations (auto-layout, load: more than `max` nodes changed) are left alone.
 */
export function separateMoved(prev: GraphDoc, next: GraphDoc, registry: Registry, max = 8): GraphDoc {
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  const moved = new Set<string>();
  for (const n of next.nodes) {
    const p = before.get(n.id);
    if (!p || p.x !== n.x || p.y !== n.y) moved.add(n.id);
  }
  if (!moved.size || moved.size > max) return next;
  const rects = nodeRects(next, registry);
  const fixedRects = [...rects].filter(([id]) => !moved.has(id)).map(([, r]) => r);
  const group = [...moved].map((id) => rects.get(id)!);
  const collides = (dx: number, dy: number) => group.some((g) => fixedRects.some((f) => hit({ ...g, x: g.x + dx, y: g.y + dy }, f)));
  if (!collides(0, 0)) return next;

  let best: { dx: number; dy: number } | null = null;
  const consider = (dx: number, dy: number) => {
    if (best && Math.hypot(dx, dy) >= Math.hypot(best.dx, best.dy)) return;
    if (!collides(dx, dy)) best = { dx, dy };
  };
  const gx0 = Math.min(...group.map((g) => g.x)), gx1 = Math.max(...group.map((g) => g.x + g.w));
  const gy0 = Math.min(...group.map((g) => g.y)), gy1 = Math.max(...group.map((g) => g.y + g.h));
  for (const f of fixedRects) {
    consider(f.x + f.w + MARGIN + 2 - gx0, 0);
    consider(f.x - MARGIN - 2 - gx1, 0);
    consider(0, f.y + f.h + MARGIN + 2 - gy0);
    consider(0, f.y - MARGIN - 2 - gy1);
  }
  if (!best) {
    const right = Math.max(...fixedRects.map((f) => f.x + f.w));
    best = { dx: right + MARGIN * 3 - gx0, dy: 0 };
  }
  const { dx, dy } = best as { dx: number; dy: number };
  return { ...next, nodes: next.nodes.map((n) => (moved.has(n.id) ? { ...n, x: Math.round(n.x + dx), y: Math.round(n.y + dy) } : n)) };
}

/**
 * A node whose body grew (a param got wired, a layer list got longer, a hidden param became visible) pushes the nodes below it
 * down by just enough to keep a gap, cascading. Nothing moves back when it shrinks again.
 */
export function pushForGrowth(prev: GraphDoc, next: GraphDoc, registry: Registry): GraphDoc {
  const prevH = new Map<string, number>();
  for (const n of prev.nodes) prevH.set(n.id, layoutFor(prev, n, registry.get(n.type)).height);
  const grown: string[] = [];
  for (const n of next.nodes) {
    const h = prevH.get(n.id);
    if (h !== undefined && layoutFor(next, n, registry.get(n.type)).height > h + 0.5) grown.push(n.id);
  }
  if (!grown.length) return next;
  let g = next;
  const queue = [...grown];
  let guard = 0;
  while (queue.length && guard++ < 60) {
    const id = queue.shift()!;
    const rects = nodeRects(g, registry);
    const r = rects.get(id)!;
    const below = [...rects].filter(([oid, o]) => oid !== id && o.y >= r.y + 4 && o.x < r.x + r.w && r.x < o.x + o.w && o.y < r.y + r.h + MARGIN).sort((a, b) => a[1].y - b[1].y);
    const shifts = new Map<string, number>();
    for (const [oid, o] of below) {
      const d = r.y + r.h + MARGIN - o.y;
      if (d > 0) shifts.set(oid, d);
    }
    if (!shifts.size) continue;
    g = { ...g, nodes: g.nodes.map((n) => (shifts.has(n.id) ? { ...n, y: Math.round(n.y + shifts.get(n.id)!) } : n)) };
    queue.push(...shifts.keys());
  }
  return g;
}
