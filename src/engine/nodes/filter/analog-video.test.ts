import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

describe('analog-video', () => {
  it('a clean setting returns the input untouched', async () => {
    const t = await harness();
    const src = t.solid(8, 8, [10, 20, 30, 255]);
    const out = await t.run('analog-video', { composite: 0, chromaBlur: 0, chromaShift: 0, lumaBlur: 0, ringing: 0 }, { image: src });
    expect(out.image).toBe(src);
  });

  it('chroma bleed: colour smears sideways while brightness edges stay sharp', async () => {
    const t = await harness();
    const src = t.fromFn(48, 8, (x) => (x < 24 ? [255, 0, 0, 255] : [0, 255, 0, 255]));
    const base = { composite: 0, lumaBlur: 0, ringing: 0 };
    const px = await t.pixels((await t.run('analog-video', { ...base, chromaBlur: 6, chromaShift: 0 }, { image: src })).image as never);
    // the red/green boundary becomes a gradual blend across several pixels
    expect(px.at(22, 4)[0]).toBeGreaterThan(px.at(26, 4)[0]);
    const mid = px.at(24, 4);
    expect(mid[0]).toBeGreaterThan(30);
    expect(mid[1]).toBeGreaterThan(30);
    // a delay pushes the colour to the right
    const late = await t.pixels((await t.run('analog-video', { ...base, chromaBlur: 0.5, chromaShift: 6 }, { image: src })).image as never);
    expect(late.at(27, 4)[0]).toBeGreaterThan(late.at(27, 4)[1]);
  });

  it('composite artefacts turn a one-pixel checkerboard into colour fringes, plain grey stays grey', async () => {
    const t = await harness();
    const params = { composite: 1, subcarrier: 2, chromaBlur: 0, chromaShift: 0, lumaBlur: 0, ringing: 0 };
    const checker = await t.pixels((await t.run('analog-video', params, { image: t.checker(32, 8, 1) })).image as never);
    let chroma = 0;
    for (let x = 8; x < 24; x++) {
      const [r, g, b] = checker.at(x, 4);
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
    }
    expect(chroma / 16).toBeGreaterThan(15);
    const grey = await t.pixels((await t.run('analog-video', params, { image: t.solid(32, 8, [128, 128, 128, 255]) })).image as never);
    const [r, g, b] = grey.at(16, 4);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(6);
  });

  it('ringing adds overshoot halos beside an edge', async () => {
    const t = await harness();
    const src = t.fromFn(48, 8, (x) => (x < 24 ? [60, 60, 60, 255] : [200, 200, 200, 255]));
    const px = await t.pixels((await t.run('analog-video', { composite: 0, chromaBlur: 0, lumaBlur: 0, chromaShift: 0, ringing: 1, ringWidth: 2 }, { image: src })).image as never);
    expect(px.at(22, 4)[0]).toBeLessThan(55);
    expect(px.at(26, 4)[0]).toBeGreaterThan(205);
  });

  it('ghosting adds a delayed faint copy', async () => {
    const t = await harness();
    const src = t.fromFn(64, 8, (x) => (x === 20 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const px = await t.pixels((await t.run('analog-video', { composite: 0, chromaBlur: 0, lumaBlur: 0, ringing: 0, chromaShift: 0, ghost: 0.6, ghostDelay: 10 }, { image: src })).image as never);
    expect(px.at(30, 4)[0]).toBeGreaterThan(40);
    expect(px.at(45, 4)[0]).toBeLessThan(10);
  });

  it('tape effects: dropouts make bright streaks, head switching ruins the bottom, wrinkle and tearing displace lines', async () => {
    const t = await harness();
    const dark = t.solid(128, 64, [20, 20, 20, 255]);
    const off = { composite: 0, chromaBlur: 0, chromaShift: 0, lumaBlur: 0, ringing: 0 };
    const d = await t.pixels((await t.run('analog-video', { ...off, dropouts: 1 }, { image: dark })).image as never);
    let white = 0;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) if (d.at(x, y)[0] > 100) white++;
    expect(white).toBeGreaterThan(20);
    const stripes = t.fromFn(128, 64, (x) => (x % 16 < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const h = await t.pixels((await t.run('analog-video', { ...off, headSwitch: 1 }, { image: stripes })).image as never);
    const clean = await t.pixels(stripes);
    let diffBottom = 0;
    let diffTop = 0;
    for (let x = 0; x < 128; x++) {
      diffBottom += Math.abs(h.at(x, 63)[0] - clean.at(x, 63)[0]);
      diffTop += Math.abs(h.at(x, 10)[0] - clean.at(x, 10)[0]);
    }
    expect(diffBottom).toBeGreaterThan(diffTop + 500);
    const tear = await t.pixels((await t.run('analog-video', { ...off, tearing: 1, tearPos: 0.5 }, { image: stripes })).image as never);
    let moved = 0;
    for (let x = 0; x < 128; x++) moved += Math.abs(tear.at(x, 32)[0] - clean.at(x, 32)[0]);
    expect(moved).toBeGreaterThan(1000);
  });

  it('vertical roll shifts the picture and draws a sync bar', async () => {
    const t = await harness();
    const src = t.fromFn(16, 64, (x, y) => (y < 32 ? [255, 255, 255, 255] : [60, 60, 60, 255]));
    const px = await t.pixels((await t.run('analog-video', { composite: 0, chromaBlur: 0, chromaShift: 0, lumaBlur: 0, ringing: 0, rollOffset: 0.25 }, { image: src })).image as never);
    expect(px.at(8, 8)[0]).toBeGreaterThan(200);
    expect(px.at(8, 28)[0]).toBeLessThan(120);
  });

  it('freezes unless Animate is on, then loops', async () => {
    const t = await harness();
    const src = t.solid(32, 32, [120, 120, 120, 255]);
    const params = { composite: 0, chromaBlur: 0, chromaShift: 0, lumaBlur: 0, ringing: 0, noise: 0.5, jitter: 2 };
    const still = await t.loopCheck('analog-video', params, { image: src });
    expect(still.motion).toBe(0);
    const anim = await t.loopCheck('analog-video', { ...params, animate: true }, { image: src });
    expect(anim.seam).toBe(0);
    expect(anim.motion).toBeGreaterThan(0.5);
  });

  it('presets produce distinct looks and alpha survives', async () => {
    const t = await harness();
    const src = t.fromFn(64, 32, (x, y) => (x < 32 ? [255, 40, 40, 255] : [30, 200, 60, 255]));
    const seen = new Set<string>();
    for (const preset of ['console', 'rf', 'vhs', 'wornVhs', 'broadcast']) {
      const px = await t.pixels((await t.run('analog-video', { preset }, { image: src })).image as never);
      seen.add(Array.from(px.at(33, 10)).join());
    }
    expect(seen.size).toBeGreaterThan(3);
    const clear = await t.pixels((await t.run('analog-video', { preset: 'vhs' }, { image: t.solid(16, 16, [0, 0, 0, 0]) })).image as never);
    expect(clear.at(8, 8)[3]).toBe(0);
  });

  it('lengths follow resolution (colour blur at 2x with unit 2)', async () => {
    const t = await harness();
    const mk = (w: number, u: number) => t.fromFn(w, 8, (x) => (x < w / 2 ? [255, 0, 0, 255] : [0, 255, 0, 255]), u);
    const p = { composite: 0, lumaBlur: 0, ringing: 0, chromaBlur: 4, chromaShift: 0 };
    const a = await t.pixels((await t.run('analog-video', p, { image: mk(48, 1) })).image as never);
    const b = await t.pixels((await t.run('analog-video', p, { image: mk(96, 2) })).image as never);
    expect(Math.abs(a.at(22, 4)[0] - b.at(44, 4)[0])).toBeLessThan(25);
  });
});
