import { expect, it } from 'vitest';
import { harness } from '../../testing';

const H = 64;
// front: red grows to the right, green grows downward, blue 40. back: blue-ish, red grows to the right, green 200.
const frontFn = (x: number, y: number): [number, number, number, number] => [Math.round((x / 63) * 255), Math.round((y / 63) * 255), 40, 255];
const backFn = (x: number, y: number): [number, number, number, number] => [Math.round((x / 63) * 255), 200, 30 + y, 255];

const dirOf = (px: number, py: number, w = 2 * H, h = H) => {
  const lon = ((px + 0.5) / w - 0.5) * 2 * Math.PI;
  const lat = (0.5 - (py + 0.5) / h) * Math.PI;
  return { x: Math.cos(lat) * Math.sin(lon), y: Math.sin(lat), z: Math.cos(lat) * Math.cos(lon) };
};

it('the panorama is 2:1, its centre is the front centre and lon 180 is the back centre (flipped or not)', async () => {
  const t = await harness();
  const front = t.fromFn(H, H, frontFn);
  const back = t.fromFn(H, H, backFn);
  const out = (await t.run('fake-360', {}, { front, back })).image as never;
  const px = await t.pixels(out);
  expect(px.width).toBe(2 * H);
  expect(px.height).toBe(H);
  const c = px.at(H, H / 2);
  expect(Math.abs(c[0] - 128)).toBeLessThan(8);
  expect(Math.abs(c[1] - 128)).toBeLessThan(8);
  // lon 180: the left and right edges of the panorama, middle row, show the back centre (green 200)
  expect(Math.abs(px.at(0, H / 2)[1] - 200)).toBeLessThan(4);
  expect(Math.abs(px.at(2 * H - 1, H / 2)[1] - 200)).toBeLessThan(4);
  // just past 180 degrees (right side of the panorama's left edge): flipped back shows its left part (low red), unflipped its right part
  const flipped = px.at(4, H / 2)[0];
  const plain = await t.pixels((await t.run('fake-360', { flipBack: false }, { front, back })).image as never);
  expect(flipped).toBeLessThan(128);
  expect(plain.at(4, H / 2)[0]).toBeGreaterThan(128);
});

it('inside the front view the panorama is the exact pinhole projection', async () => {
  const t = await harness();
  const front = t.fromFn(H, H, frontFn);
  const px = await t.pixels((await t.run('fake-360', { frontView: 80 }, { front })).image as never);
  const tH = Math.tan((80 / 2) * (Math.PI / 180));
  for (const [x, y] of [[H + 14, H / 2 - 5], [H - 12, H / 2 + 6], [H + 5, H / 2 + 3]]) {
    const d = dirOf(x, y);
    const u = 0.5 + (0.5 * d.x) / d.z / tH;
    const v = 0.5 - (0.5 * d.y) / d.z / tH;
    const got = px.at(x, y);
    expect(Math.abs(got[0] - u * 255), `red at ${x},${y}`).toBeLessThan(7);
    expect(Math.abs(got[1] - v * 255), `green at ${x},${y}`).toBeLessThan(7);
  }
});

it('without a back picture the front is reused for the back', async () => {
  const t = await harness();
  const front = t.fromFn(H, H, frontFn);
  const solo = await t.pixels((await t.run('fake-360', { backView: 70 }, { front })).image as never);
  const both = await t.pixels((await t.run('fake-360', { backView: 70 }, { front, back: front })).image as never);
  let diff = 0;
  for (let i = 0; i < solo.data.length; i++) diff = Math.max(diff, Math.abs(solo.data[i] - both.data[i]));
  expect(diff).toBeLessThan(2);
});

it('all fill modes and outputs render without holes or NaN, and Turn moves the picture', async () => {
  const t = await harness();
  const front = t.fromFn(H, H, frontFn);
  const back = t.fromFn(H, H, backFn);
  for (const output of ['panorama', 'planet', 'look']) {
    for (const fill of ['stretch', 'mirror', 'blur', 'blend']) {
      const px = await t.pixels((await t.run('fake-360', { output, fill, tilt: 20, turn: 30, lookTurn: 100, lookTilt: -30 }, { front, back })).image as never);
      let lowAlpha = 0;
      let dark = 0;
      for (let i = 0; i < px.data.length; i += 4) {
        if (px.data[i + 3] < 250) lowAlpha++;
        if (px.data[i] + px.data[i + 1] + px.data[i + 2] < 15) dark++;
      }
      expect(lowAlpha, `${output}/${fill} transparent pixels`).toBe(0);
      expect(dark, `${output}/${fill} black pixels`).toBe(0);
    }
  }
  const a = await t.pixels((await t.run('fake-360', { turn: 0 }, { front, back })).image as never);
  const b = await t.pixels((await t.run('fake-360', { turn: 90 }, { front, back })).image as never);
  // turning by 90 degrees moves the front centre a quarter of the width to the right
  expect(Math.abs(b.at(H + H / 2, H / 2)[0] - a.at(H, H / 2)[0])).toBeLessThan(8);
});
