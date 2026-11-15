import { expect, it } from 'vitest';
import { harness } from '../../testing';

it('threshold splits dark and light and outputs a matching mask', async () => {
  const t = await harness();
  const src = t.fromFn(8, 1, (x) => (x < 4 ? [60, 60, 60, 255] : [200, 200, 200, 255]));
  const out = await t.run('threshold', { level: 0.5 }, { image: src });
  const img = await t.pixels(out.image as never);
  const mask = await t.pixels(out.mask as never);
  expect(img.at(1, 0)[0]).toBe(0);
  expect(img.at(6, 0)[0]).toBe(255);
  expect(mask.at(1, 0)[0]).toBe(0);
  expect(mask.at(6, 0)[0]).toBe(255);
});

it('softness gives intermediate values and alpha survives', async () => {
  const t = await harness();
  const out = await t.run('threshold', { level: 0.5, softness: 0.3 }, { image: t.solid(4, 4, [128, 128, 128, 255]) });
  const v = (await t.pixels(out.image as never)).at(1, 1)[0];
  expect(v).toBeGreaterThan(60);
  expect(v).toBeLessThan(200);
  const clear = await t.run('threshold', {}, { image: t.solid(4, 4, [255, 255, 255, 0]) });
  expect((await t.pixels(clear.image as never)).at(1, 1)[3]).toBe(0);
  expect((await t.pixels(clear.mask as never)).at(1, 1)[0]).toBe(0);
});
