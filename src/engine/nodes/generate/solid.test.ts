import { expect, it } from 'vitest';
import { harness } from '../../testing';

// one harness per file: creating many exhausts the headless GPU
let shared: ReturnType<typeof harness> | null = null;
const H = () => (shared ??= harness());

it('solid fills the canvas with the colour', async () => {
  const t = await H();
  const out = await t.run('solid', { color: [1, 0, 0, 1] }, {}, { project: { width: 32, height: 16 } });
  const img = out.image as { width: number; height: number };
  expect([img.width, img.height]).toEqual([32, 16]);
  const px = await t.pixels(out.image as never);
  expect(px.at(5, 5)).toEqual([255, 0, 0, 255]);
});

it('solid follows the size input and keeps transparency', async () => {
  const t = await H();
  const out = await t.run('solid', { color: [0, 1, 0, 0.5] }, { size: t.solid(20, 10, [0, 0, 0, 255], 2) });
  const img = out.image as { width: number; height: number; unit: number };
  expect([img.width, img.height, img.unit]).toEqual([20, 10, 2]);
  const px = await t.pixels(img as never);
  const [r, g, , a] = px.at(3, 3);
  expect(r).toBeLessThan(3);
  expect(g).toBeGreaterThan(250);
  expect(Math.abs(a - 128)).toBeLessThan(3);
});
