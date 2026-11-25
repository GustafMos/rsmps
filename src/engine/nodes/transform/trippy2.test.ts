import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { hyperbolicEdge, minCorners } from './hyperbolic.node';

const scene = (x: number, y: number): [number, number, number, number] => (Math.hypot(x - 30, y - 20) < 12 ? [240, 60, 40, 255] : [Math.round((x / 95) * 200), Math.round((y / 63) * 200), 100, 255]);

it('droste: the picture contains itself at the chosen ratio', async () => {
  const t = await harness();
  const src = t.fromFn(96, 64, scene);
  const px = await t.pixels((await t.run('droste', { arms: 0, ratio: 2, zoom: 0 }, { image: src })).image as never);
  const sp = await t.pixels(src as never);
  // outside the inner copy: the picture itself
  expect(Math.abs(px.at(4, 4)[0] - sp.at(4, 4)[0])).toBeLessThan(12);
  // a point of the inner copy (half size, centred) shows what the full picture has at twice the distance from the middle
  const inner = px.at(48 + 18, 32 + 12);
  const outer = sp.at(48 + 36, 32 + 24);
  expect(Math.abs(inner[0] - outer[0]) + Math.abs(inner[1] - outer[1])).toBeLessThan(30);
});

it('hyperbolic tiling: the edge circle meets the rim at right angles; the disc is filled and its outside is black', async () => {
  for (const [p, q] of [[5, 4], [7, 3], [4, 5], [3, 7]]) {
    const e = hyperbolicEdge(p, q);
    expect(e.d * e.d - e.r * e.r).toBeCloseTo(1, 6); // orthogonal to the unit circle
    expect(e.d - e.r).toBeLessThan(1);
  }
  expect(minCorners(3)).toBe(7);
  expect(minCorners(4)).toBe(5);
  expect(minCorners(5)).toBe(4);
  expect(minCorners(7)).toBe(3);
  const t = await harness();
  const src = t.fromFn(96, 64, scene);
  const px = await t.pixels((await t.run('hyperbolic', { drift: 0, spin: 0, lines: 0 }, { image: src })).image as never);
  expect(px.at(1, 1)).toEqual([0, 0, 0, 255]);
  expect(px.at(48, 32)[3]).toBe(255);
  expect(px.at(48, 32)[0] + px.at(48, 32)[1] + px.at(48, 32)[2]).toBeGreaterThan(60);
  // five-fold symmetry: a point and the same point a fifth of a turn round look alike
  const at = (ang: number) => px.at(Math.round(48 + 14 * Math.cos(ang)), Math.round(32 + 14 * Math.sin(ang)));
  const a = at(0.3);
  const b = at(0.3 + (2 * Math.PI) / 5);
  expect(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1])).toBeLessThan(60);
});

it('liquid warp moves the picture and strength 0 leaves it alone', async () => {
  const t = await harness();
  const src = t.fromFn(96, 64, scene);
  const sp = await t.pixels(src as never);
  const px = await t.pixels((await t.run('liquid-warp', { look: 'marble' }, { image: src })).image as never);
  let diff = 0;
  for (let y = 4; y < 60; y += 4) for (let x = 4; x < 92; x += 4) diff += Math.abs(px.at(x, y)[0] - sp.at(x, y)[0]);
  expect(diff).toBeGreaterThan(800);
  expect((await t.run('liquid-warp', { strength: 0 }, { image: src })).image).toBe(src);
});

it('droste: every copy shape renders; a mid-grey driver changes nothing and a patterned one bends the spiral', async () => {
  const t = await harness();
  const src = t.fromFn(96, 64, scene);
  for (const shape of ['frame', 'round', 'square', 'diamond', 'hexagon', 'triangle', 'star', 'flower', 'heart']) {
    const px = await t.pixels((await t.run('droste', { shape, zoom: 0 }, { image: src })).image as never);
    expect(px.at(48, 32)[3], shape).toBe(255);
    expect(px.at(2, 2)[3], shape).toBe(255);
  }
  const plain = await t.pixels((await t.run('droste', { zoom: 0 }, { image: src })).image as never);
  const grey = await t.pixels((await t.run('droste', { zoom: 0, drive: 1, driveTurn: 1 }, { image: src, driver: t.solid(8, 8, [128, 128, 128, 255]) })).image as never);
  const stripes = t.fromFn(96, 64, (x) => (x % 16 < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const bent = await t.pixels((await t.run('droste', { zoom: 0, drive: 0.5 }, { image: src, driver: stripes })).image as never);
  let same = 0;
  let moved = 0;
  let n = 0;
  for (let y = 3; y < 61; y += 4)
    for (let x = 3; x < 93; x += 4) {
      same += Math.abs(plain.at(x, y)[0] - grey.at(x, y)[0]);
      moved += Math.abs(plain.at(x, y)[0] - bent.at(x, y)[0]);
      n++;
    }
  // 128 of 255 is a hair above the middle, so "nothing" is "next to nothing"
  expect(same / n).toBeLessThan(6);
  expect(moved / n).toBeGreaterThan(8);
});
