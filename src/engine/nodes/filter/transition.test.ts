import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { TRANSITION_MODES } from '../../lib/fx-transition';
import type { Harness } from '../../testing';
import type { ImageValue } from '../../types';

const MODES = TRANSITION_MODES.map(([id]) => id);
const pa = (w: number, h: number) => (x: number, y: number): [number, number, number, number] => [40 + 180 * (x / w), 60 + 120 * (y / h), 200 - 120 * (x / w), 255];
const pb = (w: number, h: number) => (x: number, y: number): [number, number, number, number] => [230 - 150 * (y / h), 40 + 40 * Math.sin(x / (w / 5)) + 60, 60 + 150 * (x / w), 255];

async function run(t: Harness, a: ImageValue, b: ImageValue, params: Record<string, unknown>, map?: ImageValue) {
  const inputs: Record<string, ImageValue> = { a, b };
  if (map) inputs.map = map;
  return t.pixels((await t.run('transition', params, inputs)).image as never);
}
const meanDiff = (p: { data: Uint8ClampedArray }, q: { data: Uint8ClampedArray }) => {
  let s = 0;
  for (let i = 0; i < p.data.length; i++) s += Math.abs(p.data[i] - q.data[i]);
  return s / p.data.length;
};

describe('transition', () => {
  it('lists the modes of every family', () => {
    expect(MODES.length).toBeGreaterThanOrEqual(28);
    for (const family of ['Dither', 'Wipe', 'Warp', 'Glitch', 'Blend']) expect(TRANSITION_MODES.some(([, l]) => l.startsWith(family))).toBe(true);
  });

  it('every mode shows exactly A at 0 and exactly B at 1, and is close to them just inside', async () => {
    const t = await harness();
    const A = t.fromFn(64, 48, pa(64, 48));
    const B = t.fromFn(64, 48, pb(64, 48));
    const pxA = await t.pixels(A);
    const pxB = await t.pixels(B);
    for (const mode of MODES) {
      const z = await run(t, A, B, { mode, progress: 0 });
      expect(meanDiff(z, pxA), `${mode} at 0`).toBe(0);
      const o = await run(t, A, B, { mode, progress: 1 });
      expect(meanDiff(o, pxB), `${mode} at 1`).toBe(0);
      const near0 = await run(t, A, B, { mode, progress: 0.02 });
      expect(meanDiff(near0, pxA), `${mode} near 0`).toBeLessThan(14);
      const near1 = await run(t, A, B, { mode, progress: 0.98 });
      expect(meanDiff(near1, pxB), `${mode} near 1`).toBeLessThan(14);
    }
  });

  it('the middle of each style looks different from a plain crossfade, and from A and B', async () => {
    const t = await harness();
    const A = t.fromFn(64, 48, pa(64, 48));
    const B = t.fromFn(64, 48, pb(64, 48));
    const base = await run(t, A, B, { mode: 'crossfade', progress: 0.5 });
    const pxA = await t.pixels(A);
    const pxB = await t.pixels(B);
    let different = 0;
    for (const mode of MODES) {
      const m = await run(t, A, B, { mode, progress: 0.5 });
      if (meanDiff(m, base) > 4) different++;
      expect(meanDiff(m, pxA) + meanDiff(m, pxB), mode).toBeGreaterThan(3);
    }
    expect(different).toBeGreaterThanOrEqual(MODES.length - 4);
  });

  it('is deterministic, and the seed changes the random styles', async () => {
    const t = await harness();
    const A = t.fromFn(64, 48, pa(64, 48));
    const B = t.fromFn(64, 48, pb(64, 48));
    const one = await run(t, A, B, { mode: 'noise-dissolve', progress: 0.5, seed: 3 });
    const two = await run(t, A, B, { mode: 'noise-dissolve', progress: 0.5, seed: 3 });
    expect(meanDiff(one, two)).toBe(0);
    const other = await run(t, A, B, { mode: 'noise-dissolve', progress: 0.5, seed: 9 });
    expect(meanDiff(one, other)).toBeGreaterThan(5);
  });

  it('dither dissolves use exactly A and B pixels (no blending) and the share follows progress', async () => {
    const t = await harness();
    const A = t.solid(64, 64, [255, 0, 0, 255]);
    const B = t.solid(64, 64, [0, 0, 255, 255]);
    for (const mode of ['bayer-2', 'bayer-4', 'bayer-8', 'blue-noise', 'diffusion', 'noise-dissolve']) {
      const share = async (p: number) => {
        const px = await run(t, A, B, { mode, progress: p, cell: 1, softness: 0 });
        let blue = 0;
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const c = px.at(x, y); if (c[2] === 255 && c[0] === 0) blue++; else if (mode.startsWith('bayer')) expect([c[0], c[2]], mode).toEqual([255, 0]); }
        return blue / 4096;
      };
      expect(Math.abs((await share(0.25)) - 0.25), mode).toBeLessThan(0.12);
      expect(Math.abs((await share(0.75)) - 0.75), mode).toBeLessThan(0.12);
    }
  });

  it('wipes move across the picture: linear, iris, clock', async () => {
    const t = await harness();
    const A = t.solid(64, 64, [255, 0, 0, 255]);
    const B = t.solid(64, 64, [0, 0, 255, 255]);
    const isB = (p: { at(x: number, y: number): number[] }, x: number, y: number) => p.at(x, y)[2] > 128;
    const lin = await run(t, A, B, { mode: 'linear', progress: 0.5, angle: 0, softness: 0 });
    expect(isB(lin, 5, 32)).toBe(true);
    expect(isB(lin, 58, 32)).toBe(false);
    const rev = await run(t, A, B, { mode: 'linear', progress: 0.5, angle: 0, softness: 0, invert: true });
    expect(isB(rev, 5, 32)).toBe(false);
    const iris = await run(t, A, B, { mode: 'iris', progress: 0.4, softness: 0 });
    expect(isB(iris, 32, 32)).toBe(true);
    expect(isB(iris, 2, 2)).toBe(false);
    const clock = await run(t, A, B, { mode: 'clock', progress: 0.3, softness: 0 });
    expect(isB(clock, 45, 20)).toBe(true); // top right quadrant first
    expect(isB(clock, 10, 50)).toBe(false);
  });

  it('push slides both pictures; luma wipe follows the map', async () => {
    const t = await harness();
    const A = t.fromFn(64, 32, (x) => (x < 32 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    const B = t.solid(64, 32, [0, 0, 255, 255]);
    const push = await run(t, A, B, { mode: 'push', progress: 0.5, angle: 0 });
    expect(push.at(40, 10)[0]).toBeGreaterThan(200); // A's red left half slid to the right
    expect(push.at(5, 10)[2]).toBeGreaterThan(200); // B enters from the left
    const map = t.fromFn(64, 32, (x) => (x < 32 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const luma = await run(t, t.solid(64, 32, [255, 0, 0, 255]), B, { mode: 'luma', lumaFrom: 'map', progress: 0.5, softness: 0.05 }, map);
    expect(luma.at(10, 10)[2]).toBeGreaterThan(200); // dark side of the map changes first
    expect(luma.at(55, 10)[0]).toBeGreaterThan(200);
  });

  it('B is fitted to A when the sizes differ, and the output keeps the size of A', async () => {
    const t = await harness();
    const A = t.solid(64, 32, [255, 0, 0, 255]);
    const B = t.fromFn(40, 40, (x, y) => (y < 20 ? [0, 0, 255, 255] : [0, 255, 0, 255]));
    const out = (await t.run('transition', { mode: 'crossfade', progress: 1 }, { a: A, b: B })).image as ImageValue;
    expect([out.width, out.height]).toEqual([64, 32]);
    const px = await t.pixels(out);
    expect(px.at(32, 3)[2]).toBeGreaterThan(200); // top of B (cover crops the middle band)
    expect(px.at(32, 28)[1]).toBeGreaterThan(200);
    const stretch = await t.pixels((await t.run('transition', { mode: 'crossfade', progress: 1, fit: 'stretch' }, { a: A, b: B })).image as never);
    expect(stretch.at(32, 3)[2]).toBeGreaterThan(200);
  });

  it('styles look the same at 2x resolution with unit 2', async () => {
    const t = await harness();
    const mk = (w: number, unit: number) => ({ a: t.fromFn(w, w * 0.75, pa(w, w * 0.75), unit), b: t.fromFn(w, w * 0.75, pb(w, w * 0.75), unit) });
    const small = mk(48, 1);
    const big = mk(96, 2);
    const slack: Record<string, number> = { 'tv-roll': 40, 'noise-dissolve': 40, 'glitch-cut': 40, 'blue-noise': 40, diffusion: 40, 'pixelate-through': 30, mosh: 30 };
    for (const mode of MODES) {
      const params = { mode, progress: 0.5, cell: 12 };
      const a = await run(t, small.a, small.b, params);
      const b = await run(t, big.a, big.b, params);
      let sum = 0;
      for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) for (let c = 0; c < 3; c++) {
        let m = 0;
        for (let d = 0; d < 4; d++) m += b.at(x * 2 + (d & 1), y * 2 + (d >> 1))[c];
        sum += Math.abs(a.at(x, y)[c] - m / 4);
      }
      expect(sum / (a.width * a.height * 3), mode).toBeLessThan(slack[mode] ?? 22);
    }
  });

  it('transparent pictures keep their alpha through a dissolve', async () => {
    const t = await harness();
    const px = await run(t, t.solid(32, 32, [0, 0, 0, 0]), t.solid(32, 32, [255, 255, 255, 255]), { mode: 'bayer-4', progress: 0.5, cell: 1, softness: 0 });
    let opaque = 0;
    let clear = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const a = px.at(x, y)[3]; if (a === 255) opaque++; else if (a === 0) clear++; }
    expect(opaque + clear).toBe(1024);
    expect(opaque).toBeGreaterThan(300);
    expect(clear).toBeGreaterThan(300);
  });
});

describe('transition-auto', () => {
  it('plays A, the change, B and back, so the loop repeats seamlessly', async () => {
    const t = await harness();
    const A = t.fromFn(32, 32, pa(32, 32));
    const B = t.fromFn(32, 32, pb(32, 32));
    const inputs = { a: A, b: B };
    const project = { fps: 10, duration: 2, loop: true, width: 32, height: 32 };
    const at = async (seconds: number, params: Record<string, unknown> = {}) => t.pixels((await t.run('transition-auto', { mode: 'bayer-4', cell: 1, start: 0.25, duration: 0.25, holdB: 0.1, ...params }, inputs, { seconds, project })).image as never);
    const pxA = await t.pixels(A);
    const pxB = await t.pixels(B);
    expect(meanDiff(await at(0), pxA)).toBe(0); // before the start
    expect(meanDiff(await at(0.4), pxA)).toBe(0); // 20% of the loop
    expect(meanDiff(await at(1.0), pxB)).toBe(0); // 50%: held B (start 25% + 25% takes = 50%)
    expect(meanDiff(await at(0.75), pxB)).toBeGreaterThan(1); // 37%: halfway
    expect(meanDiff(await at(0.75), pxA)).toBeGreaterThan(1);
    expect(meanDiff(await at(1.9), pxA)).toBe(0); // back at A near the end
    const r = await t.loopCheck('transition-auto', { mode: 'bayer-4', cell: 1 }, inputs);
    expect(r.seam).toBe(0);
    expect(r.motion).toBeGreaterThan(0);
    const oneWay = await at(1.9, { pingPong: false });
    expect(meanDiff(oneWay, pxB)).toBe(0);
  });
});
