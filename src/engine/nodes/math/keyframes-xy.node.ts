import { defineNode } from '../../define';
import { evalCurve, presetLinear } from '../../lib/util-curve';
import { LOOP_MODES } from './keyframes.node';

type Pt = [number, number];

/** Catmull-Rom through the points, `t` 0..1 across the whole path (closed paths wrap). */
function pathAt(points: Pt[], t: number, closed: boolean): Pt {
  const n = points.length;
  if (n === 0) return [0, 0];
  if (n === 1) return points[0];
  const segs = closed ? n : n - 1;
  const x = closed ? (t - Math.floor(t)) * segs : Math.min(1, Math.max(0, t)) * segs;
  const i = Math.min(segs - 1, Math.floor(x));
  const s = x - i;
  const at = (k: number): Pt => {
    if (closed) return points[((k % n) + n) % n];
    if (k < 0) return [2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]]; // reflect: straight ends
    if (k >= n) return [2 * points[n - 1][0] - points[n - 2][0], 2 * points[n - 1][1] - points[n - 2][1]];
    return points[k];
  };
  const p0 = at(i - 1);
  const p1 = at(i);
  const p2 = at(i + 1);
  const p3 = at(i + 2);
  const cr = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * s + (2 * a - 5 * b + 4 * c - d) * s * s + (-a + 3 * b - 3 * c + d) * s * s * s);
  return [cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])];
}

function validPoints(raw: unknown): Pt[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is Pt => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]]);
}

export default defineNode({
  id: 'keyframes-xy',
  title: 'Motion Path',
  category: 'math',
  description: 'Move a point along a path over the loop: either two keyframe curves (x and y) or a smooth spline through a list of points. Outputs the position, the direction of travel and the speed.',
  keywords: ['path', 'motion', 'spline', 'position', 'trajectory', 'orbit', 'follow', 'x y', 'keyframe', 'curve'],
  inputs: { time: { type: 'number', label: 'Position (0..1)' } },
  outputs: {
    x: { type: 'number', label: 'X' },
    y: { type: 'number', label: 'Y' },
    angle: { type: 'number', label: 'Direction (degrees)' },
    speed: { type: 'number', label: 'Speed' },
  },
  params: {
    mode: {
      type: 'enum',
      default: 'path',
      options: [
        { value: 'path', label: 'Spline through points' },
        { value: 'curves', label: 'Two curves' },
      ],
      label: 'Path from',
    },
    points: {
      type: 'json',
      default: [
        [0.2, 0.5],
        [0.5, 0.2],
        [0.8, 0.5],
        [0.5, 0.8],
      ],
      label: 'Points',
      hint: 'List of [x, y] pairs, traveled in order and evenly timed.',
      visibleIf: (p) => p.mode === 'path',
    },
    closed: { type: 'bool', default: true, label: 'Close the path', hint: 'The last point flows back to the first.', visibleIf: (p) => p.mode === 'path' },
    xCurve: { type: 'curve', default: presetLinear(), label: 'X over the loop', visibleIf: (p) => p.mode === 'curves' },
    yCurve: { type: 'curve', default: presetLinear(), label: 'Y over the loop', visibleIf: (p) => p.mode === 'curves' },
    repeat: { type: 'number', default: 1, min: 1, max: 256, softMax: 32, step: 1, integer: true, unit: 'cycles', label: 'Laps per loop' },
    loop: { type: 'enum', default: 'project', options: LOOP_MODES, label: 'At the end', visibleIf: (p) => p.mode === 'curves' },
  },
  summary: (p) => (p.mode === 'path' ? `${validPoints(p.points).length} points${p.closed ? ' · closed' : ''}` : 'x / y curves'),
  render(ctx) {
    const p = ctx.params;
    const wired = ctx.in.time;
    let t: number;
    let loopCurves: boolean;
    let perSecond = 1; // converts "per unit of t" into the speed output
    if (typeof wired === 'number') {
      t = wired;
      loopCurves = p.loop === 'always';
    } else {
      const u = ctx.time.phase * p.repeat;
      t = p.repeat > 1 || p.mode === 'path' ? u - Math.floor(u) : u;
      loopCurves = p.loop === 'always' || (p.loop === 'project' && ctx.time.loop);
      perSecond = p.repeat / Math.max(1e-9, ctx.time.duration);
    }
    const pts = validPoints(p.points);
    const pos = (tt: number): Pt => (p.mode === 'path' ? pathAt(pts, tt, p.closed) : [evalCurve(p.xCurve, tt, { loop: loopCurves }), evalCurve(p.yCurve, tt, { loop: loopCurves })]);
    const here = pos(t);
    const periodic = p.mode === 'path' ? p.closed : loopCurves;
    const h = 1e-4;
    const t0 = periodic ? t - h : Math.max(0, t - h);
    const t1 = periodic ? t + h : Math.min(1, t + h);
    const a = pos(t0);
    const b = pos(t1);
    const span = t1 - t0;
    const dx = span > 0 ? (b[0] - a[0]) / span : 0;
    const dy = span > 0 ? (b[1] - a[1]) / span : 0;
    const len = Math.hypot(dx, dy);
    return { x: here[0], y: here[1], angle: len > 1e-9 ? (Math.atan2(dy, dx) * 180) / Math.PI : 0, speed: len * perSecond };
  },
});
