import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff } from '../../lib/fx-testutil';

const page = (w: number, h: number) => (x: number, y: number): [number, number, number, number] => {
  const speck = Math.abs(x - w * 0.2) < w * 0.012 + 0.6 && Math.abs(y - h * 0.2) < h * 0.012 + 0.6;
  const speck2 = Math.abs(x - w * 0.8) < w * 0.012 + 0.6 && Math.abs(y - h * 0.8) < h * 0.012 + 0.6;
  const line = Math.abs(y - h * 0.5) < Math.max(0.6, h * 0.01) && x > w * 0.25 && x < w * 0.75;
  return speck || speck2 || line ? [20, 20, 25, 255] : [250, 250, 250, 255];
};

describe('despeckle', () => {
  it('removes isolated specks and leaves the line alone', async () => {
    const t = await harness();
    const src = t.fromFn(128, 96, page(128, 96));
    const px = await t.pixels((await t.run('despeckle', { size: 5 }, { image: src })).image as never);
    const before = await t.pixels(src);
    expect(before.at(26, 19)[0]).toBeLessThan(60); // speck existed
    expect(px.at(26, 19)[0]).toBeGreaterThan(235);
    expect(px.at(102, 77)[0]).toBeGreaterThan(235);
    expect(px.at(64, 48)[0]).toBeLessThan(60); // line intact
    expect(px.at(40, 48)[0]).toBeLessThan(60);
    expect(px.at(5, 5)[0]).toBe(250);
  });

  it('keeps marks bigger than the size, and connected scribbles', async () => {
    const t = await harness();
    const src = t.fromFn(96, 64, (x, y) => (Math.hypot(x - 48, y - 32) < 9 ? [20, 20, 20, 255] : [250, 250, 250, 255]));
    const px = await t.pixels((await t.run('despeckle', { size: 4 }, { image: src })).image as never);
    expect(px.at(48, 32)[0]).toBeLessThan(60);
  });

  it('light pinholes inside dark areas can be filled', async () => {
    const t = await harness();
    const src = t.fromFn(96, 64, (x, y) => (Math.abs(x - 48) < 2 && Math.abs(y - 32) < 2 ? [250, 250, 250, 255] : x > 20 && x < 76 && y > 10 && y < 54 ? [20, 20, 20, 255] : [250, 250, 250, 255]));
    const off = await t.pixels((await t.run('despeckle', { size: 6 }, { image: src })).image as never);
    expect(off.at(48, 32)[0]).toBeGreaterThan(200);
    const on = await t.pixels((await t.run('despeckle', { size: 6, lightSpecks: true }, { image: src })).image as never);
    expect(on.at(48, 32)[0]).toBeLessThan(60);
  });

  it('keeps alpha', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('despeckle', {}, { image: t.solid(16, 16, [0, 0, 0, 0]) })).image as never);
    expect(px.at(8, 8)[3]).toBe(0);
  });

  it('size follows resolution', async () => {
    const t = await harness();
    const d = await resolutionDiff(t, 'despeckle', { size: 4 }, page, 64);
    expect(d).toBeLessThan(10);
  });
});
