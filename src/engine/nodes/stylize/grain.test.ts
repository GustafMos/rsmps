import { expect, it } from 'vitest';
import { LOOP_SEAM_OK, harness } from '../../testing';
import { resolutionDiff } from '../../lib/fx-testutil';

function spread(px: { at(x: number, y: number): number[] }, n: number, ch = 0) {
  let min = 255;
  let max = 0;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const v = px.at(x, y)[ch];
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  return max - min;
}

it('grain adds variation around the original value', async () => {
  const t = await harness();
  const px = await t.pixels((await t.run('grain', { amount: 0.5, size: 1 }, { image: t.solid(32, 32, [128, 128, 128, 255]) })).image as never);
  expect(spread(px, 32)).toBeGreaterThan(30);
  let sum = 0;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) sum += px.at(x, y)[0];
  expect(Math.abs(sum / 1024 - 128)).toBeLessThan(8);
});

it('monochrome grain has equal channels, colour grain does not; alpha survives', async () => {
  const t = await harness();
  const src = t.solid(16, 16, [128, 128, 128, 255]);
  const mono = await t.pixels((await t.run('grain', { amount: 0.6, monochrome: true }, { image: src })).image as never);
  const col = await t.pixels((await t.run('grain', { amount: 0.6, monochrome: false }, { image: src })).image as never);
  let monoDiff = 0;
  let colDiff = 0;
  for (let i = 0; i < 16; i++) {
    monoDiff += Math.abs(mono.at(i, 3)[0] - mono.at(i, 3)[2]);
    colDiff += Math.abs(col.at(i, 3)[0] - col.at(i, 3)[2]);
  }
  expect(monoDiff).toBeLessThanOrEqual(16);
  expect(colDiff).toBeGreaterThan(40);
  const clear = await t.pixels((await t.run('grain', { amount: 1 }, { image: t.solid(8, 8, [0, 0, 0, 0]) })).image as never);
  expect(clear.at(2, 2)[3]).toBe(0);
});

it('animates per frame and loops seamlessly; static option holds still', async () => {
  const t = await harness();
  const src = t.solid(32, 32, [128, 128, 128, 255]);
  const r = await t.loopCheck('grain', { amount: 0.5 }, { image: src });
  expect(r.seam).toBeLessThan(LOOP_SEAM_OK);
  expect(r.motion).toBeGreaterThan(1);
  const still = await t.loopCheck('grain', { amount: 0.5, animated: false }, { image: src });
  expect(still.motion).toBe(0);
});

it('grain size follows resolution', async () => {
  const t = await harness();
  const d = await resolutionDiff(t, 'grain', { amount: 0.4, size: 2 }, () => () => [128, 128, 128, 255]);
  expect(d).toBeLessThan(2);
});
