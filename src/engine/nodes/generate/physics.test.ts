import { describe, expect, it } from 'vitest';
import { createGraph } from '../../graph';
import { clearRuns } from '../../lib/physics/sim';
import { harness } from '../../testing';
import type { GraphDoc, ImageValue } from '../../types';

/** Physics node on the real GPU: the preview picture, and a body driving an SDF Shape through the Move XYZ / Rotate XYZ wires. */
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());
const T = { timeout: 180_000 };
const proj = { width: 128, height: 128, fps: 30, loop: false, duration: 10 };

type N = [id: string, type: string, params?: Record<string, unknown>];
type E = [from: string, fromPort: string, to: string, toPort: string];
const mk = (nodes: N[], edges: E[]): GraphDoc => {
  const g = createGraph('t');
  return {
    ...g,
    project: { ...g.project, ...proj },
    nodes: nodes.map(([id, type, params], i) => ({ id, type, x: i * 100, y: 0, params: params ?? {} })),
    edges: edges.map(([a, ap, b, bp], i) => ({ id: `e${i}`, from: { node: a, port: ap }, to: { node: b, port: bp } })),
  };
};
const view = { rotX: 0, rotY: 0, rotZ: 0, cameraType: 'orthographic', scale: 0.5, ambient: 1, specular: 0, ao: 0 };
const ball = (y: number) => [{ shape: 'sphere', size: [0.5, 1, 1], pos: [0, y, 0], bounce: 0 }];

/** Centroid of the pixels the test accepts. */
function centroid(px: { width: number; height: number; data: Uint8ClampedArray | Uint8Array }, pick: (r: number, g: number, b: number, a: number) => boolean): { x: number; y: number; n: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++) {
      const o = (y * px.width + x) * 4;
      if (pick(px.data[o], px.data[o + 1], px.data[o + 2], px.data[o + 3])) {
        sx += x;
        sy += y;
        n++;
      }
    }
  return { x: n ? sx / n : -1, y: n ? sy / n : -1, n };
}

describe('physics node', () => {
  it('the preview shows the body above the floor at frame 0 and resting on it later', T, async () => {
    clearRuns();
    const t = await H();
    const g = mk([['p', 'physics', { bodies: ball(3), floorHeight: -1, viewTurn: 0, viewTilt: 0, viewDistance: 9 }]], []);
    const orange = (r: number, gg: number, b: number) => (r > 200 && gg > 120 && gg < 220 && b < 140) || (b > 200 && r > 90 && r < 140 && gg > 130 && gg < 170);
    const at = async (s: number) => centroid(await t.pixels((await t.evalGraph(g, 'p', { seconds: s, port: 'image' })) as ImageValue), orange);
    const first = await at(0);
    const later = await at(3);
    expect(first.n).toBeGreaterThan(20);
    expect(later.n).toBeGreaterThan(20);
    expect(later.y).toBeGreaterThan(first.y + 10); // lower in the picture (row grows downward)
  });

  it('outputs the body pose and the sim starts at the start pose', T, async () => {
    clearRuns();
    const t = await H();
    const out0 = await t.run('physics', { bodies: ball(3) }, {}, { seconds: 0, project: proj });
    expect(out0.pos1).toEqual([0, 3, 0]);
    expect(out0.pos2).toBeNull();
    const out = await t.run('physics', { bodies: ball(3) }, {}, { seconds: 4, project: proj });
    const y = (out.pos1 as number[])[1];
    expect(y).toBeGreaterThan(-0.55);
    expect(y).toBeLessThan(-0.4);
  });

  it('a Physics node drives an SDF Shape: the drawn shape sits where the body is', T, async () => {
    clearRuns();
    const t = await H();
    const g = mk(
      [
        ['p', 'physics', { bodies: ball(1.2), floorHeight: -1 }],
        ['s', 'sdf-shape', { shape: 'sphere', radius: 0.5 }],
        ['r', 'sdf-render', view],
      ],
      [
        ['p', 'pos1', 's', 'pos@xyz'],
        ['p', 'rot1', 's', 'rot@xyz'],
        ['s', 'sdf', 'r', 'scene'],
      ],
    );
    const alpha = (r: number, gg: number, b: number, a: number) => a > 128;
    const at = async (s: number) => centroid(await t.pixels((await t.evalGraph(g, 'r', { seconds: s, port: 'image' })) as ImageValue), alpha);
    const a = await at(0);
    const b = await at(3);
    // 32 px per scene unit, origin at (64, 64), y up: start y = 1.2, rest y = -0.5
    expect(a.y).toBeCloseTo(64 - 1.2 * 32, -1);
    expect(b.y).toBeCloseTo(64 + 0.5 * 32, -1);
    expect(Math.abs(a.x - 64)).toBeLessThan(2);
  });

  it('two Physics nodes with the same settings agree, and a changed setting changes the result', T, async () => {
    clearRuns();
    const t = await H();
    const a = await t.run('physics', { bodies: ball(3) }, {}, { seconds: 1, project: proj });
    const b = await t.run('physics', { bodies: ball(3), floor: false }, {}, { seconds: 1, project: proj });
    const c = await t.run('physics', { bodies: ball(3) }, {}, { seconds: 1, project: proj });
    expect(c.pos1).toEqual(a.pos1);
    expect(b.pos1).not.toBeNull();
    // with no floor the ball keeps falling: lower than the one resting on the floor at 4 s
    const d = await t.run('physics', { bodies: ball(3), floor: false }, {}, { seconds: 4, project: proj });
    expect((d.pos1 as number[])[1]).toBeLessThan(-1);
  });

  it('Push now kicks once when the wired number rises', T, async () => {
    clearRuns();
    const t = await H();
    const params = { bodies: ball(0), gravity: 0, floor: false };
    const g = mk([['p', 'physics', params], ['v', 'vector', { x: 4 }], ['n', 'value', { value: 1 }]], [['v', 'vector', 'p', 'push'], ['n', 'value', 'p', 'pushNow']]);
    const out = { pos1: await t.evalGraph(g, 'p', { seconds: 1, port: 'pos1' }) };
    // pushNow is 1 at every frame: it rose above 0 only at frame 1 (the first simulated frame), so exactly one kick of 4 units per second
    const x = (out.pos1 as number[])[0];
    expect(x).toBeGreaterThan(3.5);
    expect(x).toBeLessThan(4.2);
  });
  it('with Loop on, every loop starts again from the start pose, frame by frame the same', T, async () => {
    clearRuns();
    const t = await H();
    const loopProj = { ...proj, loop: true, duration: 2 };
    const at = (seconds: number) => t.run('physics', { bodies: ball(3) }, {}, { seconds, project: loopProj });
    const first = await at(0);
    const mid = await at(1);
    const wrapped = await at(2); // the clock wraps to frame 0
    const again = await at(3); // frame 30 of the next loop
    expect(wrapped.pos1).toEqual(first.pos1);
    expect(wrapped.rot1).toEqual(first.rot1);
    expect(again.pos1).toEqual(mid.pos1);
    expect(first.pos1).toEqual([0, 3, 0]);
  });
});
