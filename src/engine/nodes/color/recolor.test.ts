import { expect, it } from 'vitest';
import { savePreview } from '../../lib/util-preview';
import { harness } from '../../testing';
import type { ImageValue } from '../../types';

const near = (a: number[], b: number[], tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

it('fill: a black logo on transparent becomes white and keeps its alpha (including soft edges)', async () => {
  const t = await harness();
  const logo = t.fromFn(8, 4, (x) => (x < 2 ? [0, 0, 0, 255] : x < 4 ? [10, 10, 10, 128] : [0, 0, 0, 0]));
  const px = await t.pixels((await t.run('recolor', {}, { image: logo })).image as ImageValue);
  expect(px.at(0, 0)).toEqual([255, 255, 255, 255]);
  expect(near(px.at(2, 0), [255, 255, 255, 128])).toBe(true);
  expect(px.at(6, 0)[3]).toBe(0);
});

it('fill with a chosen colour; colour alpha scales the result', async () => {
  const t = await harness();
  const src = t.solid(4, 4, [30, 200, 90, 255]);
  const px = await t.pixels((await t.run('recolor', { color: [1, 0, 0.5, 0.5] }, { image: src })).image as ImageValue);
  expect(near(px.at(1, 1), [255, 0, 128, 128], 2)).toBe(true);
});

it('ink: black artwork on white paper becomes a white shape on transparency, anti-aliased edges stay soft', async () => {
  const t = await harness();
  // black square, one mid-grey column of edge pixels, white paper
  const art = t.fromFn(10, 4, (x) => (x < 4 ? [0, 0, 0, 255] : x === 4 ? [128, 128, 128, 255] : [255, 255, 255, 255]));
  const px = await t.pixels((await t.run('recolor', { mode: 'ink', ink: [1, 1, 1, 1] }, { image: art })).image as ImageValue);
  expect(px.at(1, 1)).toEqual([255, 255, 255, 255]);
  expect(px.at(8, 1)[3]).toBe(0);
  const edge = px.at(4, 1);
  expect(edge[3]).toBeGreaterThan(80);
  expect(edge[3]).toBeLessThan(180);
  expect(near([edge[0], edge[1], edge[2]], [255, 255, 255])).toBe(true);
});

it('ink: coloured ink, and paper kept as a chosen colour when not transparent', async () => {
  const t = await harness();
  const art = t.fromFn(6, 2, (x) => (x < 3 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const px = await t.pixels((await t.run('recolor', { mode: 'ink', ink: [1, 0.5, 0, 1], transparentPaper: false, paperFill: [0, 0, 0.5, 1] }, { image: art })).image as ImageValue);
  expect(near(px.at(0, 0), [255, 128, 0, 255])).toBe(true);
  expect(near(px.at(5, 0), [0, 0, 128, 255])).toBe(true);
  // a cream paper is detected when picked, tolerance covers slightly dirty paper
  const cream = t.fromFn(6, 2, (x) => (x < 3 ? [20, 20, 20, 255] : [240 - (x % 2) * 6, 230, 200, 255]));
  const px2 = await t.pixels((await t.run('recolor', { mode: 'ink', paper: [240 / 255, 230 / 255, 200 / 255, 1], paperTolerance: 0.05, paperSoftness: 0.5 }, { image: cream })).image as ImageValue);
  expect(px2.at(0, 0)[3]).toBe(255);
  expect(px2.at(3, 0)[3]).toBe(0);
  expect(px2.at(4, 0)[3]).toBe(0);
});

it('swap: the picked colour (with tolerance) is replaced, other colours stay', async () => {
  const t = await harness();
  const src = t.fromFn(4, 1, (x) => [[255, 0, 0, 255], [240, 20, 10, 255], [0, 200, 0, 255], [255, 0, 0, 100]][x] as [number, number, number, number]);
  const px = await t.pixels((await t.run('recolor', { mode: 'swap', from: [1, 0, 0, 1], to: [0, 0, 1, 1], tolerance: 0.15, softness: 0.05 }, { image: src })).image as ImageValue);
  expect(px.at(0, 0)).toEqual([0, 0, 255, 255]);
  expect(near(px.at(1, 0), [0, 0, 255, 255])).toBe(true); // within tolerance
  expect(px.at(2, 0)).toEqual([0, 200, 0, 255]); // untouched
  expect(near(px.at(3, 0), [0, 0, 255, 100])).toBe(true); // alpha kept
  // tolerance 0 only matches the exact colour
  const strict = await t.pixels((await t.run('recolor', { mode: 'swap', from: [1, 0, 0, 1], to: [0, 0, 1, 1], tolerance: 0, softness: 0.01 }, { image: src })).image as ImageValue);
  expect(strict.at(0, 0)).toEqual([0, 0, 255, 255]);
  expect(strict.at(1, 0)[0]).toBeGreaterThan(150);
});

it('duotone: black takes the dark colour, white the light colour, alpha kept', async () => {
  const t = await harness();
  const src = t.fromFn(3, 1, (x) => [[0, 0, 0, 255], [255, 255, 255, 255], [255, 255, 255, 90]][x] as [number, number, number, number]);
  const px = await t.pixels((await t.run('recolor', { mode: 'duotone', dark: [0, 0, 1, 1], light: [1, 1, 0, 1] }, { image: src })).image as ImageValue);
  expect(px.at(0, 0)).toEqual([0, 0, 255, 255]);
  expect(px.at(1, 0)).toEqual([255, 255, 0, 255]);
  expect(near(px.at(2, 0), [255, 255, 0, 90])).toBe(true);
});

it('maskable: a mask limits the recolouring and mix blends', async () => {
  const t = await harness();
  const src = t.solid(8, 4, [0, 0, 0, 255]);
  const mask = t.maskFn(8, 4, (x) => (x < 4 ? 1 : 0));
  const px = await t.pixels((await t.run('recolor', {}, { image: src, mask })).image as ImageValue);
  expect(px.at(1, 1)).toEqual([255, 255, 255, 255]);
  expect(px.at(6, 1)).toEqual([0, 0, 0, 255]);
  const half = await t.pixels((await t.run('recolor', { mix: 0.5 }, { image: src })).image as ImageValue);
  expect(near(half.at(1, 1), [128, 128, 128, 255], 3)).toBe(true);
});

it('preview: every mode on a small logo', async () => {
  const t = await harness();
  const logo = t.fromFn(48, 32, (x, y) => {
    const d = Math.hypot(x - 24, y - 16);
    return d < 11 && d > 5 ? [0, 0, 0, 255] : [255, 255, 255, 255];
  });
  const alpha = t.fromFn(48, 32, (x, y) => {
    const d = Math.hypot(x - 24, y - 16);
    return d < 11 && d > 5 ? [0, 0, 0, 255] : [0, 0, 0, 0];
  });
  const run = async (params: Record<string, unknown>, image: ImageValue) => t.pixels((await t.run('recolor', params, { image })).image as ImageValue);
  await savePreview('recolor-modes', [
    await t.pixels(logo),
    await run({ mode: 'ink', ink: [1, 1, 1, 1] }, logo),
    await run({}, alpha),
    await run({ mode: 'swap', from: [0, 0, 0, 1], to: [0.9, 0.2, 0.2, 1] }, logo),
    await run({ mode: 'duotone', dark: [0.1, 0.1, 0.4, 1], light: [1, 0.85, 0.5, 1] }, logo),
  ], 4, 3);
});
