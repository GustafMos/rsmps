import { expect, it } from 'vitest';
import { harness } from '../../testing';
import type { Host, TextSpec } from '../../types';

const proj = { width: 64, height: 64, lengthMode: 'absolute' as const };

/** A fake rasteriser: every call returns a solid 20x10 white block and records the spec it was given. */
const calls: TextSpec[] = [];
const host: Host = {
  assetInfo: () => null,
  assetFrame: async () => null,
  rasterizeText: (spec) => {
    calls.push(spec);
    return { data: new Uint8ClampedArray(20 * 10 * 4).fill(255), width: 20, height: 10 };
  },
};

let withHost: ReturnType<typeof harness> | null = null;
let headless: ReturnType<typeof harness> | null = null;
const H = () => (withHost ??= harness([], host));
const N = () => (headless ??= harness());

it('headless (no rasterizeText): outputs a fully transparent image of canvas size', async () => {
  const t = await N();
  const out = await t.run('text', { text: 'Hi' }, {}, { project: proj });
  const img = out.image as { width: number; height: number };
  expect([img.width, img.height]).toEqual([64, 64]);
  const px = await t.pixels(img as never);
  expect(px.data.every((v) => v === 0)).toBe(true);
});

it('draws the rasterised bitmap centred at the position, tinted with the colour', async () => {
  const t = await H();
  const out = await t.run('text', { text: 'Hi', color: [1, 0, 0, 1], x: 0.5, y: 0.5 }, {}, { project: proj });
  const px = await t.pixels(out.image as never);
  expect(px.at(32, 32)).toEqual([255, 0, 0, 255]);
  expect(px.at(21, 32)[3]).toBe(0); // left of the 20px-wide block (22..41)
  expect(px.at(22, 28)[3]).toBe(255);
  expect(px.at(41, 36)[3]).toBe(255);
  expect(px.at(42, 32)[3]).toBe(0);
  expect(px.at(32, 26)[3]).toBe(0); // above the 10px-tall block (27..36)
  const spec = calls[calls.length - 1];
  expect(spec.text).toBe('Hi');
  expect(spec.maxWidthPx).toBe(64);
});

it('left / right alignment anchor the edges at the position', async () => {
  const t = await H();
  const left = await t.pixels((await t.run('text', { text: 'Hi', align: 'left', x: 0.25, y: 0.5 }, {}, { project: proj })).image as never);
  expect(left.at(16, 32)[3]).toBe(255);
  expect(left.at(15, 32)[3]).toBe(0);
  const right = await t.pixels((await t.run('text', { text: 'Hi', align: 'right', x: 0.75, y: 0.5 }, {}, { project: proj })).image as never);
  expect(right.at(47, 32)[3]).toBe(255);
  expect(right.at(48, 32)[3]).toBe(0);
});

it('outline grows the shape in its own colour, text stays on top; length scales with unit', async () => {
  const t = await H();
  const params = { text: 'Hi', color: [1, 0, 0, 1], outline: 4, outlineColor: [0, 0, 1, 1] };
  const px = await t.pixels((await t.run('text', params, {}, { project: proj })).image as never);
  expect(px.at(32, 32)).toEqual([255, 0, 0, 255]);
  const o = px.at(19, 32); // 3 texels outside the left edge
  expect(o[2]).toBeGreaterThan(200);
  expect(o[0]).toBeLessThan(40);
  expect(o[3]).toBe(255);
  expect(px.at(12, 32)[3]).toBe(0);
  // unit 2 doubles the outline reach (spec bitmap is fixed size, so only the outline is compared)
  const big = await t.pixels((await t.run('text', params, { size: t.solid(64, 64, [0, 0, 0, 255], 2) })).image as never);
  expect(big.at(15, 32)[3]).toBeGreaterThan(200); // 7 texels out with an 8-texel outline
  expect(big.at(10, 32)[3]).toBe(0);
});

it('empty text gives a transparent image', async () => {
  const t = await H();
  const px = await t.pixels((await t.run('text', { text: '  ' }, {}, { project: proj })).image as never);
  expect(px.at(32, 32)[3]).toBe(0);
});
