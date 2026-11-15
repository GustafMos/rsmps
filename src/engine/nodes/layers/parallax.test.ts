import { describe, expect, it } from 'vitest';
import type { Pixels } from '../../testing';
import { harness } from '../../lib/mask-test';

const W = 96;
const H = 64;
const PROJECT = { fps: 10, duration: 2, loop: true, width: W, height: H };

/** x centroid of pixels whose colour is close to `rgb` (and opaque). */
function centroidX(px: Pixels, rgb: [number, number, number]): number {
  let sx = 0;
  let n = 0;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++) {
      const c = px.at(x, y);
      if (Math.abs(c[0] - rgb[0]) + Math.abs(c[1] - rgb[1]) + Math.abs(c[2] - rgb[2]) < 40) {
        sx += x;
        n++;
      }
    }
  return n ? sx / n : NaN;
}

async function scene(t: Awaited<ReturnType<typeof harness>>) {
  const bg = t.solid(W, H, [20, 20, 30, 255]);
  const dot = (cx: number, cy: number, c: [number, number, number, number]) => t.fromFn(W, H, (x, y) => (Math.abs(x - cx) < 5 && Math.abs(y - cy) < 5 ? c : [0, 0, 0, 0]));
  const far = dot(48, 14, [0, 255, 0, 255]);
  const mid = dot(48, 32, [255, 255, 0, 255]);
  const near = dot(48, 50, [255, 0, 0, 255]);
  return { bg, layers: [far, mid, near] };
}

describe('parallax', () => {
  it('loops exactly and moves', async () => {
    const t = await harness();
    const { bg, layers } = await scene(t);
    // A circle with one cycle is at its far point at the middle of the loop, so loopCheck sees motion there.
    const r = await t.loopCheck('parallax', { motion: 'circle', amount: 8, cycles: 1 }, { background: bg, layers } as never);
    expect(r.seam).toBeLessThan(0.01);
    expect(r.motion).toBeGreaterThan(0.01);
    // Sway and figure-eight also close their loop (two cycles).
    for (const motion of ['sway-h', 'sway-v', 'figure-eight', 'push']) {
      const s = await t.loopCheck('parallax', { motion, amount: 8, cycles: 2 }, { background: bg, layers } as never);
      expect(s.seam).toBeLessThan(0.01);
    }
  });

  it('nearer layers move more than farther ones (sway horizontal)', async () => {
    const t = await harness();
    const { bg, layers } = await scene(t);
    // phase 0.25 = sin peak: the camera is at +amount.
    const px = await t.pixels((await t.run('parallax', { amount: 12, autoFit: false, overscan: 0 }, { background: bg, layers } as never, { seconds: 0.5, project: PROJECT })).image as never);
    const rest = await t.pixels((await t.run('parallax', { amount: 12, autoFit: false, overscan: 0 }, { background: bg, layers } as never, { seconds: 0, project: PROJECT })).image as never);
    const move = (rgb: [number, number, number]) => centroidX(px, rgb) - centroidX(rest, rgb);
    const mFar = move([0, 255, 0]);
    const mMid = move([255, 255, 0]);
    const mNear = move([255, 0, 0]);
    console.log('parallax shifts far/mid/near', mFar.toFixed(2), mMid.toFixed(2), mNear.toFixed(2));
    expect(mFar).toBeLessThan(-2); // opposite to the camera
    expect(mMid).toBeLessThan(mFar);
    expect(mNear).toBeLessThan(mMid);
    expect(Math.abs(mNear + 12)).toBeLessThan(1); // the nearest layer moves by the full amount
  });

  it('spread 0 makes every layer move together; vertical sway moves vertically', async () => {
    const t = await harness();
    const { bg, layers } = await scene(t);
    const flat = await t.pixels((await t.run('parallax', { amount: 12, spread: 0, autoFit: false }, { background: bg, layers } as never, { seconds: 0.5, project: PROJECT })).image as never);
    const flat0 = await t.pixels((await t.run('parallax', { amount: 12, spread: 0, autoFit: false }, { background: bg, layers } as never, { seconds: 0, project: PROJECT })).image as never);
    const a = centroidX(flat, [0, 255, 0]) - centroidX(flat0, [0, 255, 0]);
    const b = centroidX(flat, [255, 0, 0]) - centroidX(flat0, [255, 0, 0]);
    expect(Math.abs(a - b)).toBeLessThan(0.6);
    const v = await t.pixels((await t.run('parallax', { motion: 'sway-v', amount: 12, autoFit: false }, { background: bg, layers } as never, { seconds: 0.5, project: PROJECT })).image as never);
    expect(Math.abs(centroidX(v, [255, 0, 0]) - 48)).toBeLessThan(1); // no horizontal motion
  });

  it('manual mode is driven by the camera params and needs no time', async () => {
    const t = await harness();
    const { bg, layers } = await scene(t);
    const px = await t.pixels((await t.run('parallax', { motion: 'manual', cameraX: -10, autoFit: false }, { background: bg, layers } as never)).image as never);
    expect(centroidX(px, [255, 0, 0]) - 48).toBeGreaterThan(8); // camera left -> layers move right
    expect(centroidX(px, [255, 0, 0]) - 48).toBeLessThan(11);
    expect(centroidX(px, [0, 255, 0]) - 48).toBeLessThan(7);
  });

  it('auto overscan hides layer edges and the output keeps the background size', async () => {
    const t = await harness();
    const bg = t.solid(W, H, [255, 255, 255, 255]);
    const full = t.solid(W, H, [200, 40, 40, 255]);
    const out = (await t.run('parallax', { amount: 10 }, { background: bg, layers: [full] } as never, { seconds: 0.5, project: PROJECT })).image as never;
    const px = await t.pixels(out);
    expect([px.width, px.height]).toEqual([W, H]);
    for (let y = 0; y < H; y += 7) {
      expect(px.at(0, y)[1]).toBeLessThan(80); // still red at the edge: no white bg showing
      expect(px.at(W - 1, y)[1]).toBeLessThan(80);
    }
    const bare = await t.pixels((await t.run('parallax', { amount: 10, autoFit: false }, { background: bg, layers: [full] } as never, { seconds: 0.5, project: PROJECT })).image as never);
    expect(bare.at(W - 1, 5)[1]).toBeGreaterThan(200); // without overscan the edge shows the background
  });

  it('works with only a background', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('parallax', {}, { background: t.solid(32, 32, [10, 20, 30, 255]) })).image as never);
    expect(px.at(5, 5).slice(0, 3)).toEqual([10, 20, 30]);
  });
});
