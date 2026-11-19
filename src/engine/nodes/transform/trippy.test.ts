import { expect, it } from 'vitest';
import { harness } from '../../testing';

const scene = (x: number, y: number): [number, number, number, number] => (Math.hypot(x - 30, y - 20) < 12 ? [240, 60, 40, 255] : [Math.round((x / 95) * 200), Math.round((y / 63) * 200), 100, 255]);

it('fractal mirror is mirror-symmetric left-right and top-bottom, and changes the picture', async () => {
  const t = await harness();
  const src = t.fromFn(96, 64, scene);
  const px = await t.pixels((await t.run('fractal-mirror', { spin: 0, breathe: 0 }, { image: src })).image as never);
  const sp = await t.pixels(src as never);
  let asym = 0;
  let change = 0;
  for (let y = 4; y < 32; y += 4)
    for (let x = 4; x < 48; x += 4) {
      asym += Math.abs(px.at(x, y)[0] - px.at(95 - x, y)[0]) + Math.abs(px.at(x, y)[0] - px.at(x, 63 - y)[0]);
      change += Math.abs(px.at(x, y)[0] - sp.at(x, y)[0]);
    }
  expect(asym / 77).toBeLessThan(8);
  expect(change).toBeGreaterThan(500);
});

it('kaleidoscope regions: "the same spot" repeats one picture in every square; every shape renders opaque', async () => {
  const t = await harness();
  const src = t.fromFn(96, 64, scene);
  // squares a quarter of the height (16 px), all looking at the same spot, no spin, no rim shading
  const px = await t.pixels((await t.run('kaleido-regions', { shape: 'squares', size: 0.25, look: 'same', spin: 0, edges: 0, counter: false }, { image: src })).image as never);
  for (const [x, y] of [[20, 20], [27, 25], [35, 30]]) {
    const a = px.at(x, y);
    const b = px.at(x + 16, y);
    const c = px.at(x, y + 16);
    expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])).toBeLessThan(12);
    expect(Math.abs(a[0] - c[0]) + Math.abs(a[1] - c[1])).toBeLessThan(12);
  }
  for (const shape of ['squares', 'hexagons', 'cells', 'rings']) {
    const o = await t.pixels((await t.run('kaleido-regions', { shape }, { image: src })).image as never);
    expect(o.at(48, 32)[3], shape).toBe(255);
    expect(o.at(3, 3)[3], shape).toBe(255);
  }
});
