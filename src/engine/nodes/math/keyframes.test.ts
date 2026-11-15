import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { presetLinear } from '../../lib/util-curve';
import { harness } from '../../testing';

const project = { fps: 10, duration: 2, loop: true };
const triangle = { keys: [{ t: 0, v: 0, interp: 'linear' as const }, { t: 0.5, v: 4, interp: 'linear' as const }, { t: 0.99, v: 0, interp: 'linear' as const }] };

describe('keyframes', () => {
  it('loops exactly and moves during the loop', async () => {
    const t = await harness();
    const at = async (params: Record<string, unknown>, seconds: number) => (await t.run('keyframes', params, {}, { seconds, project })).value as number;
    const p = { curve: triangle, repeat: 1 };
    const first = await at(p, 0);
    expect(await at(p, 2)).toBe(first);
    expect(await at(p, 1)).toBeCloseTo(4, 6);
    expect(await at(p, 0.5)).toBeCloseTo(2, 6);
    const twice = { curve: triangle, repeat: 2 };
    expect(await at(twice, 0.5)).toBeCloseTo(4, 6); // one full curve every second
    expect(await at(twice, 2)).toBe(await at(twice, 0));
    expect(await at({ ...p, scale: 0.5, offset: 1 }, 1)).toBeCloseTo(3, 6);
  });

  it('loop modes: always wraps the end into the start, never holds the end', async () => {
    const t = await harness();
    const curve = { keys: [{ t: 0, v: 0, interp: 'smooth' as const }, { t: 0.5, v: 1, interp: 'smooth' as const }] };
    const at = async (loop: string, seconds: number, loopProject = true) => (await t.run('keyframes', { curve, loop }, {}, { seconds, project: { ...project, loop: loopProject } })).value as number;
    expect(await at('always', 1.8, false)).toBeLessThan(0.9); // heading back down to the first key
    expect(await at('never', 1.8, true)).toBe(1);
    expect(await at('project', 1.8, true)).toBeLessThan(0.9);
    expect(await at('project', 1.8, false)).toBe(1);
  });

  it('a wired position replaces the clock and makes the node time independent', async () => {
    const t = await harness();
    const lin = presetLinear();
    expect((await t.run('keyframes', { curve: lin }, { time: 0.25 }, { seconds: 1.3, project })).value).toBeCloseTo(0.25, 9);
    expect((await t.run('keyframes', { curve: triangle }, { time: 0.5 }, { seconds: 0, project })).value).toBeCloseTo(4, 9);

    let g = createGraph();
    g.project = { ...g.project, ...project };
    const v = addNode(g, t.registry, 'value', { x: 0, y: 0 }, { value: 0.75 });
    const k = addNode(v.graph, t.registry, 'keyframes', { x: 0, y: 0 }, { curve: lin });
    g = connect(k.graph, t.registry, { node: v.node.id, port: 'value' }, { node: k.node.id, port: 'time' });
    const rendered: number[] = [];
    for (const s of [0, 0.5, 1, 1.5]) {
      const r = await t.engine.evaluate({ graph: g, node: k.node.id, seconds: s });
      expect(r.value).toBeCloseTo(0.75, 9);
      rendered.push(r.timings.has(k.node.id) ? 1 : 0);
    }
    expect(rendered).toEqual([1, 0, 0, 0]); // rendered once, then served from cache at every other time

    const free = addNode(createGraph(), t.registry, 'keyframes', { x: 0, y: 0 }, { curve: lin });
    free.graph.project = { ...free.graph.project, ...project };
    const seen: number[] = [];
    for (const s of [0, 0.5, 1]) {
      const r = await t.engine.evaluate({ graph: free.graph, node: free.node.id, seconds: s });
      seen.push(r.timings.has(free.node.id) ? 1 : 0);
    }
    expect(seen).toEqual([1, 1, 1]);
  });
});

describe('curve-remap', () => {
  it('shapes a number with the curve', async () => {
    const t = await harness();
    const curve = { keys: [{ t: 0, v: 0, interp: 'linear' as const }, { t: 0.5, v: 10, interp: 'linear' as const }, { t: 1, v: 0, interp: 'linear' as const }] };
    const out = async (value: number, extra: Record<string, unknown> = {}) => (await t.run('curve-remap', { curve, ...extra }, { value })).value as number;
    expect(await out(0.25)).toBeCloseTo(5, 9);
    expect(await out(0.75)).toBeCloseTo(5, 9);
    expect(await out(7)).toBeCloseTo(0, 9);
    expect(await out(10, { inMin: 0, inMax: 20 })).toBeCloseTo(10, 9);
    expect((await t.run('curve-remap', { curve })).value).toBeCloseTo(10, 9); // default number 0.5
  });
});

describe('keyframes-color', () => {
  it('moves through the colour stops and closes the loop', async () => {
    const t = await harness();
    const palette = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const at = async (params: Record<string, unknown>, seconds: number) => (await t.run('keyframes-color', { palette, ...params }, {}, { seconds, project })).color as number[];
    const a = await at({ loop: 'never' }, 0);
    expect(a.map((x) => Math.round(x * 100) / 100)).toEqual([1, 0, 0, 1]);
    const mid = await at({ loop: 'never' }, 1);
    expect(mid[1]).toBeCloseTo(1, 2);
    // looping: after the last stop it fades back to the first, and the loop closes exactly
    const looped0 = await at({ loop: 'always' }, 0);
    expect(await at({ loop: 'always' }, 2)).toEqual(looped0);
    const third = await at({ loop: 'always' }, 1.3333);
    expect(third[0] + third[1]).toBeLessThan(third[2] + 0.5);
    const end = await at({ loop: 'always' }, 1.9);
    expect(end[0]).toBeGreaterThan(0.5); // nearly back to red
  });

  it('a wired position picks the colour directly', async () => {
    const t = await harness();
    const palette = [[0, 0, 0], [1, 1, 1]];
    const c = (await t.run('keyframes-color', { palette }, { time: 1 })).color as number[];
    expect(c[0]).toBeCloseTo(1, 3);
  });
});

describe('keyframes-xy (Motion Path)', () => {
  it('follows a spline through points, closes the loop, and reports direction and speed', async () => {
    const t = await harness();
    const points = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const at = async (params: Record<string, unknown>, seconds: number) => await t.run('keyframes-xy', params, {}, { seconds, project });
    const start = await at({ points }, 0);
    expect([start.x, start.y]).toEqual([0, 0]);
    const wrapped = await at({ points }, 2);
    expect([wrapped.x, wrapped.y]).toEqual([0, 0]);
    const q = await at({ points }, 0.5); // a quarter of the loop = the second point
    expect(q.x).toBeCloseTo(1, 6);
    expect(q.y).toBeCloseTo(0, 6);
    expect(q.speed as number).toBeGreaterThan(0);
  });

  it('open straight path: angle and speed', async () => {
    const t = await harness();
    const out = await t.run('keyframes-xy', { points: [[0, 0], [1, 0]], closed: false }, {}, { seconds: 1, project });
    expect(out.x).toBeCloseTo(0.5, 6);
    expect(out.angle).toBeCloseTo(0, 4);
    expect(out.speed).toBeCloseTo(0.5, 3); // 1 unit over 2 seconds
    const diag = await t.run('keyframes-xy', { mode: 'curves' }, {}, { seconds: 1, project });
    expect(diag.x).toBeCloseTo(0.5, 6);
    expect(diag.angle).toBeCloseTo(45, 2);
    expect(diag.speed as number).toBeCloseTo(Math.SQRT2 / 2, 3);
  });
});
