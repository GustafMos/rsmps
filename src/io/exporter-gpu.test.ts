import { expect, it } from 'vitest';
import { harness } from '../engine/testing';
import { ExporterImpl } from './exporter';

/** The GPU helpers of the exporter (upscale/pad pass, motion signature) run on the real headless GPU. */
async function setup() {
  const t = await harness();
  const exporter = new ExporterImpl({ gpu: t.gpu } as never) as unknown as {
    compose(img: unknown, scale: number, even: boolean): { drawable: { texture: GPUTexture; width: number; height: number }; release(): void };
    signature(img: unknown): Promise<string>;
  };
  return { t, exporter };
}

it('compose upscales with nearest neighbour', async () => {
  const { t, exporter } = await setup();
  const src = t.fromFn(3, 2, (x, y) => [x * 100, y * 100, 0, 255]);
  const c = exporter.compose(src, 4, false);
  expect(c.drawable.width).toBe(12);
  expect(c.drawable.height).toBe(8);
  const px = await t.pixels({ ...src, texture: c.drawable.texture, width: 12, height: 8 });
  expect(px.at(0, 0)).toEqual([0, 0, 0, 255]);
  expect(px.at(3, 3)).toEqual([0, 0, 0, 255]);
  expect(px.at(4, 0)).toEqual([100, 0, 0, 255]);
  expect(px.at(11, 7)).toEqual([200, 100, 0, 255]);
  c.release();
});

it('compose pads odd sizes to even with transparent texels, without resampling', async () => {
  const { t, exporter } = await setup();
  const src = t.solid(3, 3, [255, 0, 0, 255]);
  const c = exporter.compose(src, 1, true);
  expect([c.drawable.width, c.drawable.height]).toEqual([4, 4]);
  const px = await t.pixels({ ...src, texture: c.drawable.texture, width: 4, height: 4 });
  expect(px.at(2, 2)).toEqual([255, 0, 0, 255]);
  expect(px.at(3, 0)[3]).toBe(0);
  expect(px.at(0, 3)[3]).toBe(0);
  c.release();
});

it('compose returns the input untouched when nothing changes', async () => {
  const { t, exporter } = await setup();
  const src = t.solid(4, 4, [1, 2, 3, 255]);
  expect(exporter.compose(src, 1, true).drawable.texture).toBe(src.texture);
});

it('signature differs for different images and matches for equal ones', async () => {
  const { t, exporter } = await setup();
  const a = await exporter.signature(t.solid(32, 32, [10, 20, 30, 255]));
  const a2 = await exporter.signature(t.solid(32, 32, [10, 20, 30, 255]));
  const b = await exporter.signature(t.solid(32, 32, [10, 20, 31, 255]));
  expect(a).toBe(a2);
  expect(a).not.toBe(b);
});
