import { describe, expect, it } from 'vitest';
import {
  MAX_PANES,
  backToFront,
  cross,
  dot,
  fitDistance,
  gridShape,
  layoutCounts,
  layoutPanes,
  layoutRadius,
  len,
  orbitCamera,
  paneFrame,
  rayHit,
  sub,
  timing,
  type FrameFlow,
  type FrameLayout,
  type LayoutOptions,
} from './frame-array';

const opts = (layout: FrameLayout, over: Partial<LayoutOptions> = {}): LayoutOptions => ({ layout, count: 8, aspect: 16 / 9, spacing: 1, arc: 360, fan: [0.1, 0.06], grid: [3, 2, 3], ...over });
const LAYOUTS: FrameLayout[] = ['stack', 'row', 'ring', 'helix', 'grid', 'tunnel'];
const topts = (flow: FrameFlow, span = 1, travel = 0, nowSlot = 0, totalFrames = 48) => ({ flow, span, travel, nowSlot, totalFrames });

describe('frame array layout', () => {
  it('counts panes and never exceeds the limit', () => {
    expect(layoutCounts(opts('stack'))).toEqual({ count: 8, stride: 1, steps: 8 });
    expect(layoutCounts(opts('grid'))).toEqual({ count: 18, stride: 6, steps: 3 });
    expect(layoutCounts(opts('tunnel', { count: 10 }))).toEqual({ count: 10, stride: 4, steps: 3 });
    expect(layoutCounts(opts('row', { count: 500 })).count).toBe(MAX_PANES);
    const [nx, ny, nz] = gridShape([8, 8, 8]);
    expect(nx * ny * nz).toBeLessThanOrEqual(MAX_PANES);
    expect(gridShape([4, 4, 2])).toEqual([4, 4, 2]);
  });

  it('gives every pane its own place, the right size, and square corners', () => {
    for (const layout of LAYOUTS) {
      const o = opts(layout);
      const panes = layoutPanes(o);
      expect(panes).toHaveLength(layoutCounts(o).count);
      for (const p of panes) {
        expect(len(p.right)).toBeCloseTo(o.aspect / 2, 9);
        expect(len(p.up)).toBeCloseTo(0.5, 9);
        expect(dot(p.right, p.up)).toBeCloseTo(0, 9);
        expect(p.fade).toBe(1);
        expect(p.slot).toBe(p.index);
      }
      for (let a = 0; a < panes.length; a++)
        for (let b = a + 1; b < panes.length; b++) expect(len(sub(panes[a].center, panes[b].center))).toBeGreaterThan(0.05);
    }
  });

  it('stack: later panes are farther into the screen; row: farther to the right', () => {
    const stack = layoutPanes(opts('stack'));
    for (let k = 1; k < stack.length; k++) expect(stack[k].center[2]).toBeLessThan(stack[k - 1].center[2]);
    const row = layoutPanes(opts('row'));
    for (let k = 1; k < row.length; k++) expect(row[k].center[0] - row[k - 1].center[0]).toBeGreaterThan(16 / 9);
  });

  it('ring: a closed circle of panes facing outward', () => {
    const panes = layoutPanes(opts('ring', { count: 12 }));
    const r = len(panes[0].center);
    for (const p of panes) {
      expect(p.center[1]).toBeCloseTo(0, 9);
      expect(len(p.center)).toBeCloseTo(r, 6);
      // the face of the pane points away from the middle
      expect(dot(cross(p.right, p.up), p.center)).toBeGreaterThan(0);
    }
    // the last pane is as close to the first as any neighbours are
    expect(len(sub(panes[11].center, panes[0].center))).toBeCloseTo(len(sub(panes[1].center, panes[0].center)), 6);
  });

  it('helix climbs, grid fills a block, tunnel has four walls', () => {
    const helix = layoutPanes(opts('helix', { arc: 720, count: 12 }));
    for (let k = 1; k < helix.length; k++) expect(helix[k].center[1]).toBeLessThan(helix[k - 1].center[1]);
    const grid = layoutPanes(opts('grid'));
    expect(new Set(grid.map((p) => p.center[0].toFixed(4))).size).toBe(3);
    expect(new Set(grid.map((p) => p.center[1].toFixed(4))).size).toBe(2);
    expect(new Set(grid.map((p) => p.center[2].toFixed(4))).size).toBe(3);
    const tunnel = layoutPanes(opts('tunnel', { count: 8 }));
    for (const p of tunnel) {
      // every wall is half a pane height from the middle line of the corridor, and faces it
      expect(Math.hypot(p.center[0], p.center[1])).toBeCloseTo(0.5, 9);
      expect(dot(cross(p.right, p.up), [p.center[0], p.center[1], 0])).toBeLessThan(0);
    }
  });

  it('a whole trip along the layout puts a pane where another one was', () => {
    for (const layout of LAYOUTS) {
      const o = opts(layout);
      const rest = layoutPanes(o);
      const { stride, count } = layoutCounts(o);
      const moved = layoutPanes(o, 1);
      for (const p of moved) {
        // one step on: the place (and so the moment shown) of the pane one step ahead; the last step wraps to the first
        const target = rest.find((q) => q.slot === p.slot)!;
        expect(target).toBeDefined();
        expect(len(sub(p.center, target.center))).toBeLessThan(1e-9);
        if (p.index + stride < count) expect(p.slot).toBe(p.index + stride);
      }
      // half way between two places a pane at the very end is on its way out
      const half = layoutPanes(o, 0.5);
      expect(Math.min(...half.map((p) => p.fade))).toBe(0);
      expect(layoutPanes(o, 0.5, false).every((p) => p.fade === 1)).toBe(true);
    }
  });

  it('the camera fits the layout at distance 1', () => {
    for (const layout of LAYOUTS) {
      const o = opts(layout);
      const fov = 40;
      const cam = orbitCamera(-30, 20, fitDistance(layoutRadius(o), fov), fov);
      for (const p of layoutPanes(o)) {
        for (const sx of [-1, 1])
          for (const sy of [-1, 1]) {
            const corner = [0, 1, 2].map((i) => p.center[i] + sx * p.right[i] + sy * p.up[i] - cam.pos[i]) as [number, number, number];
            const depth = dot(corner, cam.forward);
            expect(depth).toBeGreaterThan(0);
            expect(Math.abs(dot(corner, cam.up) / depth)).toBeLessThanOrEqual(cam.tanHalf + 1e-9);
          }
      }
    }
  });

  it('a line of sight finds the right spot on a pane', () => {
    const o = opts('row', { count: 3 });
    const panes = layoutPanes(o);
    const cam = orbitCamera(0, 0, 10, 40);
    const aspect = 16 / 9;
    // straight ahead: the middle of the middle pane
    const mid = rayHit(cam, 0, 0, aspect, panes[1])!;
    expect(mid.u).toBeCloseTo(0.5, 9);
    expect(mid.v).toBeCloseTo(0.5, 9);
    expect(mid.distance).toBeCloseTo(10, 9);
    expect(rayHit(cam, 0, 0, aspect, panes[0])).toBeNull();
    // toward the top left corner of the left pane: near the top left of its picture
    const c = panes[0].center;
    const sx = (c[0] - 0.9 * (o.aspect / 2)) / (10 * cam.tanHalf * aspect);
    const sy = (0.9 * 0.5) / (10 * cam.tanHalf);
    const hit = rayHit(cam, sx, sy, aspect, panes[0])!;
    expect(hit.u).toBeCloseTo(0.05, 6);
    expect(hit.v).toBeCloseTo(0.05, 6);
    // from behind, the picture is seen mirrored
    const back = orbitCamera(180, 0, 10, 40);
    const behind = rayHit(back, 0.02, 0, aspect, panes[1])!;
    expect(behind.u).toBeLessThan(0.5);
  });

  it('paints the farthest pane first', () => {
    const panes = layoutPanes(opts('stack'));
    const front = backToFront(panes, orbitCamera(0, 0, 20, 40)).map((p) => p.index);
    expect(front).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
    const back = backToFront(panes, orbitCamera(180, 0, 20, 40)).map((p) => p.index);
    expect(back).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('frame array timing', () => {
  it('every pane plays: neighbours are a fixed time apart', () => {
    const o = opts('row', { count: 6 });
    const counts = layoutCounts(o);
    const to = topts('play', 0.5);
    const tm = timing(to, counts);
    expect(tm).toEqual({ travelSteps: 0, framesPerSlot: 4, still: false });
    const offsets = layoutPanes(o).map((p) => paneFrame(p, tm, to, 7, true).offset);
    expect(offsets).toEqual([0, 4, 8, 12, 16, 20]);
    // a negative span looks back in time
    const back = topts('play', -0.5);
    expect(layoutPanes(o).map((p) => paneFrame(p, timing(back, counts), back, 7, true).offset)).toEqual([0, -4, -8, -12, -16, -20]);
    // the present moment in the middle: earlier frames on one side, later on the other
    const middle = topts('play', 0.5, 0, 2);
    const mm = layoutPanes(o).map((p) => paneFrame(p, timing(middle, counts), middle, 7, true));
    expect(mm.map((f) => f.offset)).toEqual([-8, -4, 0, 4, 8, 12]);
    expect(mm.map((f) => f.now)).toEqual([0, 0, 1, 0, 0, 0]);
  });

  it('frames flow past: a pane holds one frame while it travels, and the loop joins', () => {
    for (const layout of LAYOUTS) {
      for (const span of [1, 0.5, 0.3, -1]) {
        const o = opts(layout);
        const counts = layoutCounts(o);
        const T = 48;
        const to = topts('flow', span, 0, 0, T);
        const tm = timing(to, counts);
        expect(Number.isInteger(tm.travelSteps)).toBe(true);
        expect(tm.travelSteps).not.toBe(0);
        // one step of travel is exactly the time between two steps of panes
        expect(tm.travelSteps * counts.stride * tm.framesPerSlot).toBeCloseTo(-T, 9);
        const held = new Map<number, Set<number>>();
        for (let f = 0; f < T; f++) {
          for (const p of layoutPanes(o, (tm.travelSteps * f) / T)) {
            const abs = (((f + paneFrame(p, tm, to, f, true).offset) % T) + T) % T;
            if (!held.has(p.index)) held.set(p.index, new Set());
            held.get(p.index)!.add(abs);
          }
        }
        // a pane changes its frame only when it wraps from one end of the layout to the other
        const wraps = Math.abs(tm.travelSteps) / counts.steps;
        for (const frames of held.values()) expect(frames.size).toBeLessThanOrEqual(Math.ceil(wraps) + 1);
        // the picture at the end of the loop is the picture at its start
        const start = layoutPanes(o, 0).map((p) => `${p.slot.toFixed(6)}:${paneFrame(p, tm, to, 0, true).offset}`).sort();
        const end = layoutPanes(o, tm.travelSteps).map((p) => `${p.slot.toFixed(6)}:${paneFrame(p, tm, to, 0, true).offset}`).sort();
        expect(end).toEqual(start);
      }
    }
  });

  it('still frames with a playhead: the frames stay, the mark of the present moves', () => {
    const o = opts('row', { count: 6 });
    const counts = layoutCounts(o);
    const to = topts('sheet', 1);
    const tm = timing(to, counts);
    expect(tm.travelSteps).toBe(0);
    const panes = layoutPanes(o);
    for (const f of [0, 5, 17, 40]) {
      const shown = panes.map((p) => (f + paneFrame(p, tm, to, f, true).offset) % 48);
      expect(shown).toEqual([0, 8, 16, 24, 32, 40]);
    }
    expect(panes.map((p) => paneFrame(p, tm, to, 16, true).now)).toEqual([0, 0, 1, 0, 0, 0]);
    // just before the loop ends the first pane is "now" again
    expect(paneFrame(panes[0], tm, to, 46, true).now).toBeCloseTo(0.75, 9);
  });

  it('custom travel keeps a whole number of steps', () => {
    const tm = timing(topts('custom', 0.5, 2.6), layoutCounts(opts('stack')));
    expect(tm.travelSteps).toBe(3);
    expect(tm.still).toBe(false);
  });
});
