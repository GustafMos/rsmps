import type { Registry } from '../../engine/define';
import type { Edge, GraphDoc } from '../../engine/types';
import { layoutFor, socketWorld, wirePoints, type NodeLayout } from './layout';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function nodeRects(graph: GraphDoc, registry: Registry): Map<string, Rect> {
  const m = new Map<string, Rect>();
  for (const n of graph.nodes) {
    const l = layoutFor(graph, n, registry.get(n.type));
    m.set(n.id, { x: n.x, y: n.y, w: l.width, h: l.height });
  }
  return m;
}

export const FRAME_PAD = 24;
export const FRAME_HEAD = 32;

/** Frames have no stored geometry: they wrap their member nodes. */
export function frameRects(graph: GraphDoc, registry: Registry, exclude?: ReadonlySet<string>): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const rects = nodeRects(graph, registry);
  for (const n of graph.nodes) {
    if (!n.frame || exclude?.has(n.id)) continue;
    const r = rects.get(n.id)!;
    const cur = out.get(n.frame);
    if (!cur) out.set(n.frame, { x: r.x, y: r.y, w: r.w, h: r.h });
    else {
      const x2 = Math.max(cur.x + cur.w, r.x + r.w);
      const y2 = Math.max(cur.y + cur.h, r.y + r.h);
      cur.x = Math.min(cur.x, r.x);
      cur.y = Math.min(cur.y, r.y);
      cur.w = x2 - cur.x;
      cur.h = y2 - cur.y;
    }
  }
  for (const r of out.values()) {
    r.x -= FRAME_PAD;
    r.y -= FRAME_PAD + FRAME_HEAD;
    r.w += FRAME_PAD * 2;
    r.h += FRAME_PAD * 2 + FRAME_HEAD;
  }
  return out;
}

export function edgeEndpoints(
  graph: GraphDoc,
  registry: Registry,
  e: Edge,
  offsets?: ReadonlyMap<string, { dx: number; dy: number }>,
  layouts?: Map<string, NodeLayout>,
) {
  const a = graph.nodes.find((n) => n.id === e.from.node);
  const b = graph.nodes.find((n) => n.id === e.to.node);
  if (!a || !b) return null;
  const la = layouts?.get(a.id) ?? layoutFor(graph, a, registry.get(a.type));
  const lb = layouts?.get(b.id) ?? layoutFor(graph, b, registry.get(b.type));
  const oa = offsets?.get(a.id);
  const ob = offsets?.get(b.id);
  return {
    from: socketWorld(a, la, 'out', e.from.port, oa ? { x: oa.dx, y: oa.dy } : undefined),
    to: socketWorld(b, lb, 'in', e.to.port, ob ? { x: ob.dx, y: ob.dy } : undefined),
  };
}

export function edgePolylines(graph: GraphDoc, registry: Registry, skipNodes?: ReadonlySet<string>): Map<string, { x: number; y: number }[]> {
  const out = new Map<string, { x: number; y: number }[]>();
  for (const e of graph.edges) {
    if (skipNodes && (skipNodes.has(e.from.node) || skipNodes.has(e.to.node))) continue;
    const ep = edgeEndpoints(graph, registry, e);
    if (ep) out.set(e.id, wirePoints(ep.from, ep.to));
  }
  return out;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function boundsOf(rects: Iterable<Rect>): Rect | null {
  let x1 = Infinity,
    y1 = Infinity,
    x2 = -Infinity,
    y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function distToPolyline(p: { x: number; y: number }, pts: { x: number; y: number }[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distToSegment(p, pts[i], pts[i + 1]));
  return best;
}

function distToSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function segmentsIntersect(p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, p4: { x: number; y: number }): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (d === 0) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export function polylineCrosses(pts: { x: number; y: number }[], a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  for (let i = 0; i < pts.length - 1; i++) if (segmentsIntersect(pts[i], pts[i + 1], a, b)) return true;
  return false;
}
