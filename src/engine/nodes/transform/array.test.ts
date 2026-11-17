import { describe, expect, it } from 'vitest';
import { defineNode } from '../../define';
import { addNode, connect, createGraph } from '../../graph';
import { seamRatio } from '../../lib/copy-testutil';
import array from './array.node';
import { LOOP_SEAM_OK, harness } from '../../testing';

const RED: [number, number, number, number] = [255, 0, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const near = (a: number[], b: number[], tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

describe('array', () => {
  it('grid: copies sit in their cells (2x2 of a half red / half blue picture)', async () => {
    const t = await harness();
    const src = t.fromFn(8, 8, (x) => (x < 4 ? RED : BLUE));
    const out = await t.pixels((await t.run('array', { mode: 'grid', columns: 2, rows: 2, spacing: [0, 0], outputSize: 'input' }, { image: src })).image as never);
    expect([out.width, out.height]).toEqual([8, 8]);
    // each copy is 4x4 and shows the whole picture: red on its left half, blue on its right half
    for (const [cx, cy] of [[0, 0], [4, 0], [0, 4], [4, 4]]) {
      expect(near(out.at(cx, cy + 1), RED)).toBe(true);
      expect(near(out.at(cx + 3, cy + 1), BLUE)).toBe(true);
    }
  });

  it('infinite grid: moving it wraps content in from beyond the frame (same as scroll)', async () => {
    const t = await harness();
    const src = t.fromFn(8, 2, (x) => [x * 30, 0, 0, 255]);
    const out = await t.pixels((await t.run('array', { mode: 'infinite', columns: 1, rows: 1, spacing: [0, 0], offset: [0.5, 0], outputSize: 'input' }, { image: src })).image as never);
    expect(out.at(0, 0)[0]).toBe(120); // source texel 4 has moved to x = 0 and the rest wrapped
    expect(out.at(4, 0)[0]).toBe(0);
    expect(out.at(7, 1)[0]).toBe(90);
  });

  it('finite grid: moving it exposes real edges, with transparency beyond', async () => {
    const t = await harness();
    const src = t.solid(8, 8, RED);
    const out = await t.pixels((await t.run('array', { mode: 'grid', columns: 1, rows: 1, spacing: [0, 0], offset: [0.5, 0], outputSize: 'input' }, { image: src })).image as never);
    expect(out.at(1, 4)[3]).toBe(0);
    expect(out.at(6, 4)).toEqual(RED);
  });

  it('keeps transparency of the source', async () => {
    const t = await harness();
    const src = t.fromFn(8, 8, (x) => [255, 0, 0, x < 4 ? 0 : 255]);
    const out = await t.pixels((await t.run('array', { mode: 'infinite', columns: 1, rows: 1, spacing: [0, 0], outputSize: 'input' }, { image: src })).image as never);
    expect(out.at(1, 1)[3]).toBe(0);
    expect(out.at(6, 1)[3]).toBe(255);
  });

  it('per-copy recolour: fill gradient runs from colour A to colour B across the copies', async () => {
    const t = await harness();
    const src = t.solid(8, 4, [10, 10, 10, 255]);
    const out = await t.pixels(
      (await t.run('array', { mode: 'grid', columns: 2, rows: 1, spacing: [0, 0], outputSize: 'input', tintMode: 'fill', tintA: [1, 0, 0, 1], tintB: [0, 0, 1, 1] }, { image: src })).image as never,
    );
    // output is 8x4 and two 4-wide copies fit exactly (fit scales each copy to 4x2: they are centred vertically)
    expect(near(out.at(1, 2), [255, 0, 0, 255])).toBe(true);
    expect(near(out.at(6, 2), [0, 0, 255, 255])).toBe(true);
  });

  it('hue and brightness steps change later copies', async () => {
    const t = await harness();
    const src = t.solid(8, 4, [200, 60, 60, 255]);
    const out = await t.pixels((await t.run('array', { mode: 'grid', columns: 2, rows: 1, spacing: [0, 0], outputSize: 'input', hueStep: 120, brightnessStep: -0.5 }, { image: src })).image as never);
    const a = out.at(1, 2);
    const b = out.at(6, 2);
    expect(a[0]).toBeGreaterThan(190);
    expect(b[1]).toBeGreaterThan(b[0]); // hue moved from red toward green
    expect(b[1]).toBeLessThan(a[0]); // and dimmed
  });

  it('line: N copies along a direction with opacity falloff', async () => {
    const t = await harness();
    const src = t.solid(4, 4, RED);
    const project = { width: 24, height: 4 };
    const out = await t.pixels((await t.run('array', { mode: 'linear', count: 3, fit: false, distance: [150, 0], fade: 0.5 }, { image: src }, { project })).image as never);
    // centres at 12 - 6, 12, 12 + 6 = 6, 12, 18
    expect(out.at(6, 2)[3]).toBe(255);
    expect(Math.abs(out.at(12, 2)[3] - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(out.at(18, 2)[3] - 64)).toBeLessThanOrEqual(2);
    expect(out.at(9, 2)[3]).toBe(0);
  });

  it('ring: copies around a centre, none at the centre', async () => {
    const t = await harness();
    const src = t.solid(4, 4, RED);
    const out = await t.pixels((await t.run('array', { mode: 'radial', count: 4, fit: false, radius: 0.375 }, { image: src }, { project: { width: 16, height: 16 } })).image as never);
    // radius = 0.375 * 16 = 6 from the centre (8, 8): top (8, 2), right (14, 8), bottom (8, 14), left (2, 8)
    for (const [x, y] of [[8, 2], [13, 8], [8, 13], [2, 8]]) expect(out.at(x, y)).toEqual(RED);
    expect(out.at(8, 8)[3]).toBe(0);
  });

  it('sprite sheet: each copy shows its own sprite', async () => {
    const t = await harness();
    const src = t.fromFn(4, 2, (x) => (x < 2 ? RED : BLUE));
    const out = await t.pixels((await t.run('array', { mode: 'grid', columns: 2, rows: 1, spacing: [0, 0], outputSize: 'input', sheetColumns: 2, sheetRows: 1 }, { image: src })).image as never);
    expect(out.at(0, 0)).toEqual(RED);
    expect(out.at(1, 1)).toEqual(RED);
    expect(out.at(2, 0)).toEqual(BLUE);
    expect(out.at(3, 1)).toEqual(BLUE);
  });

  it('mirror flips alternate columns', async () => {
    const t = await harness();
    const src = t.fromFn(8, 8, (x) => (x < 4 ? RED : BLUE));
    const out = await t.pixels((await t.run('array', { mode: 'grid', columns: 2, rows: 1, spacing: [0, 0], outputSize: 'input', mirror: 'x' }, { image: src })).image as never);
    // copies are 4 wide: copy 0 normal (red left), copy 1 flipped (blue left)
    expect(near(out.at(4, 2), BLUE)).toBe(true);
    expect(near(out.at(7, 2), RED)).toBe(true);
  });

  it('is exact for a stepped (rotated) small grid and ignores the grid index order flag only visually', async () => {
    const t = await harness();
    const src = t.solid(8, 8, RED);
    const a = await t.run('array', { mode: 'grid', columns: 3, rows: 3, stepRotate: 10, outputSize: 'input' }, { image: src });
    const b = await t.run('array', { mode: 'grid', columns: 3, rows: 3, stepRotate: 10, firstOnTop: true, outputSize: 'input' }, { image: src });
    expect((await t.pixels(a.image as never)).at(4, 4)[3]).toBe(255);
    expect((await t.pixels(b.image as never)).at(4, 4)[3]).toBe(255);
  });

  it('loops seamlessly when scrolling an infinite grid by whole cells, and moves', async () => {
    const t = await harness();
    const src = t.fromFn(16, 16, (x, y) => [x * 15, y * 15, 40, 255]);
    const r = await seamRatio(t, 'array', { mode: 'infinite', columns: 2, rows: 2, spacing: [0, 0], scrollX: 1, scrollY: -2, outputSize: 'input' }, { image: src });
    expect(r.wrap).toBeLessThan(r.max * 1.2 + 0.5);
    expect(r.motion).toBeGreaterThan(1);
    const c = await seamRatio(t, 'array', { mode: 'infinite', columns: 2, rows: 2, spacing: [0, 0], scrollX: 2, hueStep: 30, tintMode: 'multiply', outputSize: 'input' }, { image: src });
    expect(c.wrap).toBeLessThan(c.max * 1.2 + 0.5);
    expect(c.motion).toBeGreaterThan(0.5);
    // scrolling one cell with a 2-copy colour period: with Loop on the colours are closed for the user (their index moves toward the cell the copy ends in)
    const params = { mode: 'infinite', columns: 2, rows: 1, spacing: [0, 0], scrollX: 1, hueStep: 90, outputSize: 'input' };
    const fixed = await seamRatio(t, 'array', params, { image: src });
    expect(fixed.seam, fixed.text).toBeLessThan(LOOP_SEAM_OK);
    expect(fixed.motion).toBeGreaterThan(1);
    // ... and with Loop OFF nothing is done for them: the colours still swap at the seam
    const bad = await t.loopCheck('array', params, { image: src }, { frames: 16, fps: 8, size: 48, project: { loop: false } });
    expect(bad.seam, bad.text).toBeGreaterThan(2);
  });

  it('copies shown a different moment: time slices cycle through earlier frames', async () => {
    const clock = defineNode({
      id: 'test-clock',
      title: 'clock',
      category: 'input',
      description: 'colour = frame',
      inputs: {},
      outputs: { image: { type: 'image' } },
      params: {},
      render: (ctx) => {
        const f = ctx.time.frame;
        const data = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < 16; i++) data.set([f * 10, 0, 0, 255], i * 4);
        return { image: ctx.gpu.upload(data, 4, 4, 1) };
      },
    });
    const t = await harness([clock]);
    let g = createGraph('t');
    g.project = { ...g.project, fps: 10, duration: 4, loop: true, width: 8, height: 4 };
    const c = addNode(g, t.registry, 'test-clock');
    const a = addNode(c.graph, t.registry, 'array', { x: 1, y: 0 }, { mode: 'grid', columns: 2, rows: 1, spacing: [0, 0], timeSlices: 2, timeStep: 2 });
    g = connect(a.graph, t.registry, { node: c.node.id, port: 'image' }, { node: a.node.id, port: 'image' });
    const img = (await t.evalGraph(g, a.node.id, { seconds: 0.5 })) as never;
    const px = await t.pixels(img);
    expect(near(px.at(1, 2), [50, 0, 0, 255])).toBe(true); // copy 0: frame 5
    expect(near(px.at(6, 2), [30, 0, 0, 255])).toBe(true); // copy 1: two frames earlier
  });

  it('cost does not depend on the copy count: one pass, no new shader when numbers move', async () => {
    const t = await harness();
    const src = t.fromFn(16, 16, (x, y) => [x * 15, y * 15, 40, 255]);
    await t.run('array', { mode: 'grid', columns: 2, rows: 2, outputSize: 'input' }, { image: src });
    const s0 = t.gpu.stats().objects;
    await t.run('array', { mode: 'grid', columns: 100, rows: 100, spacing: [3, 3], jitterPos: 20, outputSize: 'input' }, { image: src });
    const s1 = t.gpu.stats().objects;
    expect(s1.submits - s0.submits).toBe(1); // 10,000 copies: one pass
    expect(s1.pipelinesCreated - s0.pipelinesCreated).toBe(0);
    for (const mode of ['linear', 'radial', 'infinite']) await t.run('array', { mode, count: 5000, columns: 7 }, { image: src });
    const s2 = t.gpu.stats().objects;
    await t.run('array', { mode: 'radial', count: 77777, radius: 0.41, scale: 0.37, hueStep: 3 }, { image: src });
    await t.run('array', { mode: 'linear', count: 9, distance: [13, 5], stepScale: 1.1 }, { image: src });
    expect(t.gpu.stats().objects.pipelinesCreated - s2.pipelinesCreated).toBe(0);
  });

  it('Loop on closes scrolling cases that cannot loop by themselves, and says so', async () => {
    const t = await harness();
    const src = t.fromFn(16, 16, (x, y) => [x * 15, y * 15, 40, 255]);
    const cases: Record<string, Record<string, unknown>> = {
      'finite grid scrolls like a conveyor': { mode: 'grid', columns: 4, rows: 2, scrollX: 1, outputSize: 'input' },
      'brick offset with an odd vertical scroll': { mode: 'infinite', columns: 3, rows: 3, spacing: [0, 0], scrollY: 1, stagger: 0.5, outputSize: 'input' },
      'mirrored tiles with an odd horizontal scroll': { mode: 'infinite', columns: 3, rows: 3, spacing: [0, 0], scrollX: 1, mirror: 'x', outputSize: 'input' },
      'jitter rides on the copy': { mode: 'infinite', columns: 3, rows: 3, spacing: [0, 0], scrollX: 1, jitterPos: 20, outputSize: 'input' },
      'brightness steps': { mode: 'grid', columns: 3, rows: 3, scrollX: 2, brightnessStep: 0.1, outputSize: 'input' },
    };
    for (const [name, params] of Object.entries(cases)) {
      const r = await seamRatio(t, 'array', params, { image: src }, 24);
      expect(r.seam, `${name}: ${r.text}`).toBeLessThan(LOOP_SEAM_OK);
      expect(r.motion, name).toBeGreaterThan(0.5);
    }
    const off = await t.loopCheck('array', cases['finite grid scrolls like a conveyor'], { image: src }, { frames: 24, fps: 8, size: 48, project: { loop: false } });
    expect(off.seam, off.text).toBeGreaterThan(2); // Loop off: the finite grid just leaves, unchanged
    const def = array;
    const p = { ...Object.fromEntries(Object.entries(def.params).map(([k, d]) => [k, (d as { default: unknown }).default])), mode: 'infinite', columns: 3, rows: 3, scrollX: 1, jitterPos: 20 } as never;
    expect(def.summary!(p, undefined, { loop: true, frames: 24, fps: 8 })).toContain('scroll X 1 → 3 to loop');
    expect(def.summary!(p, undefined, { loop: false, frames: 24, fps: 8 })).not.toContain('to loop');
  });
});
