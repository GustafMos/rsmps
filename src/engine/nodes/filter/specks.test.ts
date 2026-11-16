import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import type { Harness } from '../../testing';
import type { ImageValue } from '../../types';

const GREY: [number, number, number, number] = [60, 60, 60, 255];
const flat = (t: Harness, w: number, h: number, unit = 1) => t.solid(w, h, GREY, unit);

/** Pixels that differ from the flat grey input. */
async function changed(t: Harness, img: ImageValue) {
  const px = await t.pixels(img);
  let n = 0;
  for (let i = 0; i < px.data.length; i += 4) if (Math.abs(px.data[i] - 60) + Math.abs(px.data[i + 1] - 60) + Math.abs(px.data[i + 2] - 60) > 12) n++;
  return { n, px, fraction: n / (px.width * px.height) };
}
/** Mean horizontal run length of bright pixels (streaks are long, dots are short). */
function meanRun(px: { at(x: number, y: number): number[]; width: number; height: number }) {
  let runs = 0;
  let total = 0;
  for (let y = 0; y < px.height; y++) {
    let run = 0;
    for (let x = 0; x <= px.width; x++) {
      const on = x < px.width && px.at(x, y)[0] > 100;
      if (on) run++;
      else if (run) {
        runs++;
        total += run;
        run = 0;
      }
    }
  }
  return runs ? total / runs : 0;
}

describe('specks (shared generator: Specks node and Analog Video dropouts)', () => {
  const base = { speckBand: 'uniform', speckColorMode: 'white', speckDark: 0, speckBurst: 0 };

  it('amount 0 leaves the picture untouched', async () => {
    const t = await harness();
    const src = flat(t, 64, 64);
    expect((await t.run('specks', { amount: 0 }, { image: src })).image).toBe(src);
    const a = await t.run('analog-video', { composite: 0, chromaBlur: 0, chromaShift: 0, lumaBlur: 0, ringing: 0, jitter: 0.01, dropouts: 0 }, { image: src });
    expect((await changed(t, a.image as ImageValue)).n).toBe(0);
  });

  it('is deterministic by seed and the seed changes the pattern', async () => {
    const t = await harness();
    const src = flat(t, 256, 128);
    const run = async (speckSeed: number) => (await t.run('specks', { amount: 0.5, speckSeed }, { image: src })).image as ImageValue;
    const a = await run(3);
    const b = await run(3);
    const c = await run(4);
    expect(await t.diff(a, b)).toBe(0);
    expect(await t.diff(a, c)).toBeGreaterThan(0);
    expect((await changed(t, a)).n).toBeGreaterThan(30);
  });

  it('loops by construction and flickers while animating (both nodes); frozen without Animate', async () => {
    const t = await harness();
    const src = flat(t, 128, 128);
    const s = await t.loopCheck('specks', { amount: 0.8, animate: true, speckFlicker: 1, speckDriftX: 1 }, { image: src });
    expect(s.seam).toBe(0);
    expect(s.motion).toBeGreaterThan(0.05);
    const off = { composite: 0, chromaBlur: 0, chromaShift: 0, lumaBlur: 0, ringing: 0 };
    const a = await t.loopCheck('analog-video', { ...off, dropouts: 0.8, animate: true, speckFlicker: 1 }, { image: src });
    expect(a.seam).toBe(0);
    expect(a.motion).toBeGreaterThan(0.05);
    const still = await t.loopCheck('specks', { amount: 0.8 }, { image: src });
    expect(still.motion).toBe(0);
    // flicker 0 + drift: one fixed pattern travelling around the picture, back where it started after the loop
    const drift = await t.loopCheck('specks', { amount: 0.8, animate: true, speckFlicker: 0, speckDriftX: 1 }, { image: src });
    expect(drift.seam).toBe(0);
    expect(drift.motion).toBeGreaterThan(0.05);
  });

  it('the number of specks scales with amount', async () => {
    const t = await harness();
    const src = flat(t, 384, 216);
    const f = async (amount: number) => (await changed(t, (await t.run('specks', { ...base, amount }, { image: src })).image as ImageValue)).fraction;
    const [a, b, c] = [await f(0.1), await f(0.3), await f(0.9)];
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a * 1.8);
    expect(c).toBeGreaterThan(b * 1.8);
  });

  it('a proxy covers the same fraction of the picture as full size', async () => {
    const t = await harness();
    const params = { ...base, amount: 0.8, speckSeed: 5 };
    const full = await changed(t, (await t.run('specks', params, { image: flat(t, 960, 540, 1) })).image as ImageValue);
    const proxy = await changed(t, (await t.run('specks', params, { image: flat(t, 320, 180, 1 / 3) })).image as ImageValue);
    expect(full.fraction).toBeGreaterThan(0.004);
    const ratio = proxy.fraction / full.fraction;
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.6);
  });

  it('streaks are thin horizontal dashes on the scan lines', async () => {
    const t = await harness();
    const img = (await t.run('specks', { ...base, amount: 0.5, speckShape: 'streak', speckSoft: 0 }, { image: flat(t, 512, 256) })).image as ImageValue;
    const { px } = await changed(t, img);
    expect(meanRun(px)).toBeGreaterThan(8);
    // a bright pixel almost never has another bright pixel 8 rows above it (specks are one or two scan lines thick)
    let lit = 0;
    let stacked = 0;
    for (let y = 8; y < px.height; y++)
      for (let x = 0; x < px.width; x++)
        if (px.at(x, y)[0] > 100) {
          lit++;
          if (px.at(x, y - 8)[0] > 100) stacked++;
        }
    expect(lit).toBeGreaterThan(100);
    expect(stacked / lit).toBeLessThan(0.15);
  });

  it('shape changes the pixels: dots are short, streaks long, scratches are vertical', async () => {
    const t = await harness();
    const src = flat(t, 512, 256);
    const mk = async (extra: Record<string, unknown>) => (await changed(t, (await t.run('specks', { ...base, amount: 0.6, ...extra }, { image: src })).image as ImageValue)).px;
    const streak = await mk({ speckShape: 'streak' });
    const dot = await mk({ speckShape: 'dot', speckThickness: 2 });
    expect(meanRun(streak)).toBeGreaterThan(meanRun(dot) * 2);
    const scratch = await mk({ speckShape: 'scratch', amount: 1, speckSoft: 0, speckThickness: 2 });
    let best = 0;
    for (let x = 0; x < scratch.width; x++) {
      let run = 0;
      for (let y = 0; y < scratch.height; y++) {
        if (scratch.at(x, y)[0] > 100) {
          run++;
          best = Math.max(best, run);
        } else run = 0;
      }
    }
    expect(best).toBeGreaterThan(40);
  });

  it('colour, alpha and blend params change the specks as expected', async () => {
    const t = await harness();
    const src = flat(t, 384, 192);
    const run = async (extra: Record<string, unknown>) => await t.pixels((await t.run('specks', { ...base, amount: 0.7, speckShape: 'dash', speckSoft: 0, ...extra }, { image: src })).image as ImageValue);
    const maxOf = (px: Awaited<ReturnType<typeof run>>, c: number) => {
      let m = 0;
      for (let i = c; i < px.data.length; i += 4) m = Math.max(m, px.data[i]);
      return m;
    };
    const white = await run({});
    expect(maxOf(white, 0)).toBeGreaterThan(230);
    const black = await run({ speckColorMode: 'black' });
    let darkest = 255;
    for (let i = 0; i < black.data.length; i += 4) darkest = Math.min(darkest, black.data[i]);
    expect(darkest).toBeLessThan(15);
    const red = await run({ speckColorMode: 'custom', speckColor: [1, 0, 0, 1], speckChroma: 0 });
    expect(maxOf(red, 0)).toBeGreaterThan(230);
    expect(maxOf(red, 1)).toBeLessThan(80);
    const half = await run({ speckAlpha: 0.5 });
    expect(maxOf(half, 0)).toBeLessThan(maxOf(white, 0) - 40);
    const add = await run({ speckColorMode: 'custom', speckColor: [0.2, 0.2, 0.2, 1], speckBlend: 'add', speckChroma: 0 });
    expect(maxOf(add, 0)).toBeGreaterThan(60 + 25);
    expect(maxOf(add, 0)).toBeLessThan(60 + 80);
    // From the picture: brightened but not pure white over a grey picture
    const pic = await run({ speckColorMode: 'picture', speckBrightness: 0.5, speckChroma: 1 });
    expect(maxOf(pic, 0)).toBeGreaterThan(100);
    expect(maxOf(pic, 0)).toBeLessThan(235);
  });

  it('sliders never compile a new shader, and transparent pixels stay transparent', async () => {
    const t = await harness();
    const src = flat(t, 64, 64);
    const off = { composite: 0, chromaBlur: 0, chromaShift: 0, lumaBlur: 0, ringing: 0 };
    const run = async (extra: Record<string, unknown>) => {
      for (const seconds of [0, 0.7, 1.3]) {
        await t.run('specks', { animate: true, amount: 0.5, ...extra }, { image: src }, { seconds });
        await t.run('analog-video', { ...off, animate: true, dropouts: 0.5, ...extra }, { image: src }, { seconds });
      }
    };
    await run({});
    const before = t.gpu.stats().objects.pipelinesCreated;
    for (const extra of [{ speckBurst: 0.9 }, { speckLenMax: 90 }, { speckThickness: 3 }, { speckShape: 'dot' }, { speckShape: 'scratch' }, { speckColorMode: 'random' }, { speckBlend: 'screen' }, { speckBand: 'bottom' }, { speckFlicker: 5, speckDriftX: 2 }, { speckSoft: 0.9, speckAlpha: 0.4 }, { speckSeed: 77 }]) await run(extra);
    expect(t.gpu.stats().objects.pipelinesCreated - before).toBe(0);
    const clear = await t.pixels((await t.run('specks', { amount: 1 }, { image: t.solid(32, 32, [0, 0, 0, 0]) })).image as ImageValue);
    expect(clear.at(16, 16)[3]).toBe(0);
  });

  it('Analog Video presets carry specks and the group parameters take effect', async () => {
    const t = await harness();
    const src = flat(t, 384, 216);
    const worn = await changed(t, (await t.run('analog-video', { preset: 'wornVhs' }, { image: src })).image as ImageValue);
    expect(worn.n).toBeGreaterThan(50);
    const off = { composite: 0, chromaBlur: 0, chromaShift: 0, lumaBlur: 0, ringing: 0, dropouts: 0.8, speckColorMode: 'white' };
    const a = (await t.run('analog-video', off, { image: src })).image as ImageValue;
    const b = (await t.run('analog-video', { ...off, speckShape: 'block' }, { image: src })).image as ImageValue;
    expect((await changed(t, a)).n).toBeGreaterThan(50);
    expect(await t.diff(a, b)).toBeGreaterThan(0);
  });
});
