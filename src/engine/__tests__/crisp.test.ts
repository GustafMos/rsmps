import { expect, it } from 'vitest';
import { harness } from '../testing';

it('enlarging a small (pixel-art) layer in Stack and Merge keeps hard texel edges', async () => {
  const t = await harness();
  const bg = t.solid(64, 64, [0, 0, 0, 255]);
  // 4x4 art image: left half black, right half white → enlarged 16x.
  const art = t.fromFn(4, 4, (x) => (x < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  for (const [type, inputs] of [
    ['stack', { images: [bg, art] }],
    ['merge', { background: bg, foreground: art }],
  ] as const) {
    const out = await t.run(type, {}, inputs as never);
    const px = await t.pixels(out.image as never);
    // With linear filtering the ramp between texel centres would span ~16 px; crisp sampling keeps it ≤ 2 px.
    let greys = 0;
    for (let x = 0; x < 64; x++) {
      const v = px.at(x, 32)[0];
      if (v > 8 && v < 247) greys++;
    }
    expect(greys, type).toBeLessThanOrEqual(2);
    expect(px.at(20, 32)[0]).toBe(0);
    expect(px.at(44, 32)[0]).toBe(255);
  }
});
