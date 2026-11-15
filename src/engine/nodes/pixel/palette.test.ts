import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { BUILTIN_PALETTES } from '../../lib/pixel-palettes';
import { harness } from '../../testing';
import { defineNode } from '../../define';
import type { PaletteValue } from '../../types';

describe('palette', () => {
  it('built-in palettes: all of them load with their colours', async () => {
    const t = await harness();
    expect(BUILTIN_PALETTES.length).toBeGreaterThanOrEqual(8);
    const problems: string[] = [];
    for (const p of BUILTIN_PALETTES) {
      const out = (await t.run('palette', { source: 'builtin', builtin: p.id })).palette as PaletteValue;
      if (out.colors.length !== p.colors.length) problems.push(`${p.id}: ${out.colors.length} colours`);
    }
    expect(problems).toEqual([]);
    const pico = (await t.run('palette', { source: 'builtin', builtin: 'pico-8' })).palette as PaletteValue;
    expect(pico.colors[0]).toEqual([0, 0, 0]);
    expect(pico.colors[8].map((v) => Math.round(v * 255))).toEqual([255, 0, 77]);
  });

  it('custom colours pass through in order, and lightness sorting works', async () => {
    const t = await harness();
    const custom = [
      [1, 1, 1],
      [0, 0, 0],
      [0.5, 0.5, 0.5],
    ];
    const as = (await t.run('palette', { source: 'custom', custom })).palette as PaletteValue;
    expect(as.colors).toEqual(custom);
    const sorted = (await t.run('palette', { source: 'custom', custom, sort: 'lightness' })).palette as PaletteValue;
    expect(sorted.colors.map((c) => c[0])).toEqual([0, 0.5, 1]);
  });

  it('extracts the dominant colours of an image, deterministically (median cut and k-means)', async () => {
    const t = await harness();
    // Left third red, middle green, right blue (with a little noise-free variation).
    const img = t.fromFn(60, 20, (x) => (x < 20 ? [220, 30, 30, 255] : x < 40 ? [30, 200, 40, 255] : [30, 40, 210, 255]));
    for (const method of ['median-cut', 'kmeans']) {
      const a = (await t.run('palette', { source: 'extract', count: 3, method }, { image: img })).palette as PaletteValue;
      const b = (await t.run('palette', { source: 'extract', count: 3, method, lockFirstFrame: false }, { image: img })).palette as PaletteValue;
      expect(a.colors.length).toBe(3);
      expect(b.colors).toEqual(a.colors);
      const rgb = a.colors.map((c) => c.map((v) => Math.round(v * 255)));
      const near = (want: number[]) => rgb.some((c) => Math.abs(c[0] - want[0]) < 8 && Math.abs(c[1] - want[1]) < 8 && Math.abs(c[2] - want[2]) < 8);
      expect(near([220, 30, 30]) && near([30, 200, 40]) && near([30, 40, 210])).toBe(true);
    }
  });

  it('count larger than the number of colours returns only the distinct ones', async () => {
    const t = await harness();
    const img = t.fromFn(8, 8, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    const p = (await t.run('palette', { source: 'extract', count: 16 }, { image: img })).palette as PaletteValue;
    expect(p.colors.length).toBe(2);
  });

  it('"lock to first frame" keeps the palette of second 0 while the video changes', async () => {
    const t = await harness();
    const red = t.solid(16, 16, [250, 20, 20, 255]);
    const blue = t.solid(16, 16, [20, 20, 250, 255]);
    t.registry.register(
      defineNode({
        id: 'test-timed-source',
        title: 'timed',
        category: 'input',
        description: 'red at t=0, blue later',
        inputs: {},
        outputs: { image: { type: 'image' } },
        params: {},
        render: (ctx) => ({ image: ctx.time.seconds < 0.5 ? red : blue }),
      }),
    );
    const build = (lock: boolean) => {
      let g = createGraph('lock');
      const src = addNode(g, t.registry, 'test-timed-source');
      const pal = addNode(src.graph, t.registry, 'palette', { x: 0, y: 0 }, { source: 'extract', count: 2, lockFirstFrame: lock });
      g = connect(pal.graph, t.registry, { node: src.node.id, port: 'image' }, { node: pal.node.id, port: 'image' });
      return { g, id: pal.node.id };
    };
    const locked = build(true);
    const late = (await t.evalGraph(locked.g, locked.id, { seconds: 2, port: 'palette' })) as PaletteValue;
    expect(late.colors[0][0]).toBeGreaterThan(0.9); // red, from second 0
    const free = build(false);
    const lateFree = (await t.evalGraph(free.g, free.id, { seconds: 2, port: 'palette' })) as PaletteValue;
    expect(lateFree.colors[0][2]).toBeGreaterThan(0.9); // blue, from the current frame
  });
});
