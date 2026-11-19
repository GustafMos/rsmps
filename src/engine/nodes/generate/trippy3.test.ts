import { expect, it } from 'vitest';
import { harness } from '../../testing';

it('mandelbulb: a lit solid in the middle, background at the corners, transparent when the background alpha is 0', async () => {
  const t = await harness();
  const size = t.solid(64, 48, [0, 0, 0, 255]);
  const px = await t.pixels((await t.run('mandelbulb', { resolution: 'full', steps: 48, background: [0, 0, 1, 1] }, { size })).image as never);
  // somewhere in the middle the lit surface shows (the very centre can be a dark crease)
  let lit = 0;
  for (let y = 14; y < 34; y += 2) for (let x = 22; x < 42; x += 2) lit = Math.max(lit, px.at(x, y)[0] + px.at(x, y)[1]);
  expect(lit).toBeGreaterThan(80);
  const corner = px.at(1, 1);
  expect(corner[2]).toBeGreaterThan(corner[0] + 40);
  const clear = await t.pixels((await t.run('mandelbulb', { resolution: 'half', steps: 48, background: [0, 0, 0, 0] }, { size })).image as never);
  expect(clear.at(1, 1)[3]).toBe(0);
  expect(clear.at(32, 24)[3]).toBe(255);
}, 60000);

it('reaction diffusion: an even two-colour pattern with both colours present, at the chosen size', async () => {
  const t = await harness();
  const size = t.solid(160, 96, [0, 0, 0, 255]);
  const px = await t.pixels((await t.run('reaction-diffusion', { colorA: [0, 0, 0, 1], colorB: [1, 1, 1, 1], edgeWidth: 0, soft: 0.05, scale: 6 }, { size })).image as never);
  let on = 0;
  let flips = 0;
  let n = 0;
  for (let y = 4; y < 96; y += 8) {
    let prev = px.at(0, y)[0] > 127;
    for (let x = 0; x < 160; x++) {
      const v = px.at(x, y)[0] > 127;
      if (v) on++;
      if (v !== prev) flips++;
      prev = v;
      n++;
    }
  }
  expect(on / n).toBeGreaterThan(0.2);
  expect(on / n).toBeLessThan(0.8);
  // a row of 160 px with features about 6 % (10 px) wide changes colour somewhere between 4 and 30 times
  expect(flips / 12).toBeGreaterThan(4);
  expect(flips / 12).toBeLessThan(30);
});
