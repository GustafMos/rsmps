import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { harness } from '../../testing';

const project = { fps: 10, duration: 2, loop: true };

describe('time / item / random', () => {
  it('time reports phase, frame and seconds', async () => {
    const t = await harness();
    const out = await t.run('time', {}, {}, { seconds: 1, project });
    expect(out.phase).toBe(0.5);
    expect(out.frame).toBe(10);
    expect(out.seconds).toBe(1);
    expect((await t.run('time', {}, {}, { seconds: 2, project })).phase).toBe(0);
  });

  it('item reports the batch position', async () => {
    const t = await harness();
    const out = await t.run('item', {}, {}, { item: 2, itemCount: 5 });
    expect([out.index, out.count, out.fraction]).toEqual([2, 5, 0.5]);
    const single = await t.run('item', {});
    expect([single.index, single.count, single.fraction]).toEqual([0, 1, 0]);
  });

  it('random is repeatable, in range and seed dependent', async () => {
    const t = await harness();
    const v = async (p: Record<string, unknown>, opts = {}) => (await t.run('random', p, {}, opts)).value as number;
    const a = await v({ seed: 5, min: 10, max: 20 });
    expect(a).toBe(await v({ seed: 5, min: 10, max: 20 }));
    expect(a).toBeGreaterThanOrEqual(10);
    expect(a).toBeLessThanOrEqual(20);
    const seen = new Set<number>();
    for (let s = 0; s < 20; s++) seen.add(await v({ seed: s }));
    expect(seen.size).toBeGreaterThan(17);
  });

  it('random can differ per batch file, and give whole numbers', async () => {
    const t = await harness();
    const at = async (item: number, perItem: boolean) => (await t.run('random', { seed: 2, perItem }, {}, { item, itemCount: 4 })).value as number;
    expect(await at(0, false)).toBe(await at(3, false));
    expect(await at(0, true)).not.toBe(await at(1, true));
    const counts = new Set<number>();
    for (let s = 0; s < 30; s++) {
      const n = (await t.run('random', { seed: s, min: 1, max: 6, whole: true })).value as number;
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(6);
      counts.add(n);
    }
    expect(counts.size).toBe(6);
  });
});

describe('colour nodes', () => {
  it('combine-color builds a colour', async () => {
    const t = await harness();
    expect((await t.run('combine-color', { r: 0.1, g: 0.2, b: 0.3, a: 0.4 })).color).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect((await t.run('combine-color', {}, { g: 0.5 })).color).toEqual([1, 0.5, 1, 1]);
  });

  it('separate-color splits a wired colour, and round-trips through combine-color', async () => {
    const t = await harness();
    let g = createGraph();
    const c = addNode(g, t.registry, 'color', { x: 0, y: 0 }, { color: [0.25, 0.5, 0.75, 1] });
    const s = addNode(c.graph, t.registry, 'separate-color');
    const m = addNode(s.graph, t.registry, 'combine-color');
    g = connect(m.graph, t.registry, { node: c.node.id, port: 'color' }, { node: s.node.id, port: 'color' });
    for (const port of ['r', 'g', 'b', 'a']) g = connect(g, t.registry, { node: s.node.id, port }, { node: m.node.id, port });
    expect(await t.evalGraph(g, s.node.id, { port: 'g' })).toBe(0.5);
    expect(await t.evalGraph(g, s.node.id, { port: 'b' })).toBe(0.75);
    expect(await t.evalGraph(g, m.node.id)).toEqual([0.25, 0.5, 0.75, 1]);
  });

  it('mix-color blends in the chosen space and hits the endpoints', async () => {
    const t = await harness();
    const mix = async (p: Record<string, unknown>) => (await t.run('mix-color', { a: [1, 0, 0, 1], b: [0, 0, 1, 0], ...p })).color as number[];
    expect(await mix({ space: 'srgb', factor: 0.5 })).toEqual([0.5, 0, 0.5, 0.5]);
    for (const space of ['srgb', 'linear', 'oklab']) {
      const a = await mix({ space, factor: 0 });
      const b = await mix({ space, factor: 1 });
      expect(a[0]).toBeCloseTo(1, 3);
      expect(a[2]).toBeCloseTo(0, 3);
      expect(b[0]).toBeCloseTo(0, 3);
      expect(b[2]).toBeCloseTo(1, 3);
    }
    const lin = await mix({ space: 'linear', factor: 0.5 });
    expect(lin[0]).toBeGreaterThan(0.7); // light-accurate mid is brighter than the plain 0.5
  });
});
