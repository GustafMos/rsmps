import { expect, it } from 'vitest';
import { harness } from '../../testing';

it('mandelbrot: the inside colour in the body, palette colours outside, and the classic left-right shape', async () => {
  const t = await harness();
  const size = t.solid(96, 64, [0, 0, 0, 255]);
  const px = await t.pixels((await t.run('fractal', { cycle: 0, inside: [1, 1, 1, 1] }, { size })).image as never);
  // the main body sits a little left of the middle (the view is centred on -0.6)
  expect(px.at(48, 32)).toEqual([255, 255, 255, 255]);
  const corner = px.at(1, 1);
  expect(corner[0] + corner[1] + corner[2]).toBeLessThan(740); // not the inside colour
  // mirror symmetry top to bottom
  for (const x of [20, 40, 60, 80]) expect(Math.abs(px.at(x, 20)[1] - px.at(x, 43)[1])).toBeLessThan(40);
});

it('every fractal kind draws something that is not one flat colour; a wired picture is stamped into it', async () => {
  const t = await harness();
  const size = t.solid(64, 48, [0, 0, 0, 255]);
  for (const kind of ['mandelbrot', 'julia', 'ship', 'tricorn', 'newton', 'phoenix']) {
    const px = await t.pixels((await t.run('fractal', { kind }, { size })).image as never);
    const seen = new Set<string>();
    for (let y = 2; y < 48; y += 5) for (let x = 2; x < 64; x += 5) seen.add(px.at(x, y).join(','));
    expect(seen.size, kind).toBeGreaterThan(4);
  }
  const stamp = t.solid(8, 8, [0, 255, 0, 255]);
  const px = await t.pixels((await t.run('fractal', { kind: 'julia', trapScale: 0.3 }, { size, image: stamp })).image as never);
  let green = 0;
  for (let y = 0; y < 48; y += 2) for (let x = 0; x < 64; x += 2) { const c = px.at(x, y); if (c[1] > 60 && c[0] < 20 && c[2] < 20) green++; }
  expect(green).toBeGreaterThan(20);
});
