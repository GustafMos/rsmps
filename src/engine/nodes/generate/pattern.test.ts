import { expect, it } from 'vitest';
import { harness } from '../../testing';

// one harness per file: creating many exhausts the headless GPU
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());

const A: [number, number, number, number] = [0, 0, 0, 1];
const B: [number, number, number, number] = [1, 1, 1, 1];
const proj = { width: 64, height: 64, lengthMode: 'absolute' as const };

it('checkerboard alternates every cell', async () => {
  const t = await H();
  const px = await t.pixels((await t.run('pattern', { kind: 'checker', cellSize: 8, colorA: A, colorB: B }, {}, { project: proj })).image as never);
  const v = (x: number, y: number) => px.at(x, y)[0];
  expect(v(3, 3)).toBeLessThan(10);
  expect(v(11, 3)).toBeGreaterThan(245);
  expect(v(11, 11)).toBeLessThan(10);
  expect(v(3, 11)).toBeGreaterThan(245);
});

it('stripes, grid, dots, hex and bricks draw pattern colour where expected', async () => {
  const t = await H();
  const run = async (kind: string, extra: Record<string, unknown> = {}) =>
    t.pixels((await t.run('pattern', { kind, cellSize: 16, lineWidth: 4, colorA: A, colorB: B, ...extra }, {}, { project: proj })).image as never);
  const st = await run('stripes');
  expect(st.at(0, 5)[0]).toBeGreaterThan(245); // line centred on x = 0 (wraps to 15..16)
  expect(st.at(8, 5)[0]).toBeLessThan(10);
  expect(st.at(8, 5)[0]).toBe(st.at(8, 40)[0]);
  const gr = await run('grid');
  expect(gr.at(8, 8)[0]).toBeLessThan(10);
  expect(gr.at(16, 8)[0]).toBeGreaterThan(245);
  expect(gr.at(8, 16)[0]).toBeGreaterThan(245);
  const dots = await run('dots', { lineWidth: 5 });
  expect(dots.at(8, 8)[0]).toBeGreaterThan(245);
  expect(dots.at(0, 0)[0]).toBeLessThan(10);
  const hex = await run('hex');
  const hv = new Set<number>();
  for (let y = 0; y < 64; y += 3) for (let x = 0; x < 64; x += 3) hv.add(hex.at(x, y)[0] > 128 ? 1 : 0);
  expect(hv.size).toBe(2);
  const br = await run('bricks');
  expect(br.at(8, 4)[0]).toBeLessThan(10); // inside a brick
  expect(br.at(8, 8)[0]).toBeGreaterThan(245); // horizontal mortar between rows
  expect(br.at(16, 4)[0]).toBeGreaterThan(245); // vertical mortar, first row
  expect(br.at(16, 12)[0]).toBeLessThan(10); // second row is offset
});

it('is transparent-capable and follows the size input', async () => {
  const t = await H();
  const out = await t.run('pattern', { kind: 'stripes', cellSize: 16, lineWidth: 4, colorA: [0, 0, 0, 0], colorB: B }, { size: t.solid(40, 24, [0, 0, 0, 255]) });
  const img = out.image as { width: number; height: number };
  expect([img.width, img.height]).toEqual([40, 24]);
  const px = await t.pixels(img as never);
  expect(px.at(8, 5)[3]).toBe(0);
});

it('lengths scale with unit (2x resolution, unit 2 gives the same picture)', async () => {
  const t = await H();
  const small = await t.run('pattern', { kind: 'grid', cellSize: 16, lineWidth: 4, colorA: A, colorB: B }, { size: t.solid(32, 32, [0, 0, 0, 255], 1) });
  const big = await t.run('pattern', { kind: 'grid', cellSize: 16, lineWidth: 4, colorA: A, colorB: B }, { size: t.solid(64, 64, [0, 0, 0, 255], 2) });
  const ps = await t.pixels(small.image as never);
  const pb = await t.pixels(big.image as never);
  expect(pb.at(16, 16)[0]).toBe(ps.at(8, 8)[0]);
  expect(pb.at(33, 33)[0]).toBe(ps.at(16, 16)[0]);
  expect(Math.abs(pb.at(48, 20)[0] - ps.at(24, 10)[0])).toBeLessThan(2);
});

it('scrolling loops exactly for every pattern and moves', async () => {
  const t = await H();
  for (const kind of ['checker', 'stripes', 'grid', 'dots', 'hex', 'bricks']) {
    const r = await t.loopCheck('pattern', { kind, cellSize: 10, lineWidth: 3, scrollX: 1, scrollY: 2, angle: 15 }, { size: t.solid(64, 64, [0, 0, 0, 255], 1) });
    expect(r.seam, kind).toBeLessThan(0.01);
    expect(r.motion, kind).toBeGreaterThan(0.5);
  }
});
