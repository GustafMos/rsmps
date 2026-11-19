import { expect, it } from 'vitest';
import { harness } from '../../testing';

const scene = (x: number, y: number): [number, number, number, number] => [Math.round((x / 95) * 255), Math.round((y / 53) * 255), 60, 255];

it('camera shake moves the picture, fills the frame, and strength 0 is off', async () => {
  const t = await harness();
  const src = t.fromFn(96, 54, scene);
  const sp = await t.pixels(src as never);
  const out = (await t.run('camera-shake', { look: 'earthquake', blur: 0 }, { image: src })).image;
  const px = await t.pixels(out as never);
  let diff = 0;
  for (let y = 4; y < 50; y += 4) for (let x = 4; x < 92; x += 4) diff += Math.abs(px.at(x, y)[0] - sp.at(x, y)[0]);
  expect(diff).toBeGreaterThan(200);
  for (const [x, y] of [[0, 0], [95, 0], [0, 53], [95, 53]]) expect(px.at(x, y)[3]).toBe(255);
  const clear = await t.pixels((await t.run('camera-shake', { look: 'earthquake', blur: 0.5, edge: 'clear' }, { image: src })).image as never);
  expect(Math.min(clear.at(0, 0)[3], clear.at(95, 0)[3], clear.at(0, 53)[3], clear.at(95, 53)[3])).toBeLessThan(255);
  expect((await t.run('camera-shake', { strength: 0 }, { image: src })).image).toBe(src);
});

it('gate weave keeps the frame filled and a slip shows the dark frame line', async () => {
  const t = await harness();
  const src = t.solid(96, 54, [200, 200, 200, 255]);
  const px = await t.pixels((await t.run('gate-weave', { look: 'worn' }, { image: src })).image as never);
  expect(px.at(0, 0)[3]).toBe(255);
  expect(px.at(48, 27)[1]).toBeGreaterThan(140);
  // slips on every frame: somewhere a dark line crosses the picture
  const slip = await t.pixels((await t.run('gate-weave', { look: 'custom', drift: 0, jump: 0, tilt: 0, slips: 0.5, exposure: 0 }, { image: src })).image as never);
  let darkest = 255;
  for (let y = 0; y < 54; y++) darkest = Math.min(darkest, slip.at(48, y)[1]);
  expect(darkest).toBeLessThan(60);
});

it('light leak adds warm light at an edge and nothing when strength is 0', async () => {
  const t = await harness();
  const src = t.solid(96, 54, [40, 40, 40, 255]);
  const px = await t.pixels((await t.run('light-leak', { look: 'rollEnd', animated: false }, { image: src })).image as never);
  let best = [0, 0, 0, 0];
  for (let y = 0; y < 54; y += 2) for (let x = 0; x < 96; x += 2) if (px.at(x, y)[0] > best[0]) best = px.at(x, y);
  expect(best[0]).toBeGreaterThan(150);
  expect(best[0]).toBeGreaterThanOrEqual(best[2]); // warm: red at or above blue
  expect((await t.run('light-leak', { strength: 0 }, { image: src })).image).toBe(src);
});
