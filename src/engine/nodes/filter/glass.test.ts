import { expect, it } from 'vitest';
import { harness } from '../../testing';
import { GLASS_SHAPES, glassRotation } from './glass.node';

it('the turn matrix is a pure rotation and does what its angles say', () => {
  const r = glassRotation(0.4, -0.7, 1.1);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const dot = r[i][0] * r[j][0] + r[i][1] * r[j][1] + r[i][2] * r[j][2];
      expect(dot).toBeCloseTo(i === j ? 1 : 0, 9);
    }
  const id = glassRotation(0, 0, 0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(id[i][j]).toBeCloseTo(i === j ? 1 : 0, 12);
  // a quarter turn left-right carries the forward axis onto the sideways one
  const q = glassRotation(0, Math.PI / 2, 0);
  expect(q[0][2]).toBeCloseTo(1, 9);
});

const scene = (x: number, y: number): [number, number, number, number] => [Math.round((x / 95) * 255), Math.round((y / 63) * 255), 90, 255];

it('glass: outside the glass the picture is untouched; inside it is bent; bending 1 with no mirror shows it straight', async () => {
  const t = await harness();
  const src = t.fromFn(96, 64, scene);
  const sp = await t.pixels(src as never);
  const px = await t.pixels((await t.run('glass', { shape: 'sphere', size: 0.5, sway: 0, drift: 0, tilt: 0, turn: 0, roll: 0 }, { image: src })).image as never);
  expect(px.at(2, 2)).toEqual(sp.at(2, 2));
  expect(px.at(93, 61)).toEqual(sp.at(93, 61));
  let bent = 0;
  for (let y = 26; y < 40; y += 2) for (let x = 40; x < 56; x += 2) bent += Math.abs(px.at(x, y)[0] - sp.at(x, y)[0]) + Math.abs(px.at(x, y)[1] - sp.at(x, y)[1]);
  expect(bent).toBeGreaterThan(400);
  const clear = await t.pixels((await t.run('glass', { shape: 'sphere', size: 0.5, sway: 0, drift: 0, ior: 1, dispersion: 0, mirror: 0, glint: 0 }, { image: src })).image as never);
  let same = 0;
  let n = 0;
  for (let y = 26; y < 40; y += 2) for (let x = 40; x < 56; x += 2) { same += Math.abs(clear.at(x, y)[0] - sp.at(x, y)[0]); n++; }
  expect(same / n).toBeLessThan(6);
});

it('every glass shape renders, opaque, and changes the picture somewhere', async () => {
  const t = await harness();
  const src = t.fromFn(96, 64, scene);
  const sp = await t.pixels(src as never);
  for (const shape of Object.keys(GLASS_SHAPES)) {
    const px = await t.pixels((await t.run('glass', { shape, sway: 0, drift: 0, size: 0.8 }, { image: src })).image as never);
    let diff = 0;
    for (let y = 2; y < 62; y += 4) for (let x = 2; x < 94; x += 4) { diff += Math.abs(px.at(x, y)[0] - sp.at(x, y)[0]); expect(px.at(x, y)[3], shape).toBe(255); }
    expect(diff, shape).toBeGreaterThan(150);
  }
}, 120000);
