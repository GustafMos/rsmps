import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff } from '../../lib/fx-testutil';

/** pencil-ish line drawing on grey, unevenly lit, slightly tinted paper */
const sheet = (w: number, h: number) => (x: number, y: number): [number, number, number, number] => {
  const light = 0.55 + 0.4 * (x / w) * (1 - 0.3 * (y / h)); // left side in shadow
  let c: [number, number, number] = [255 * light, 250 * light, 235 * light]; // warm tint
  const line = Math.abs(y - h * 0.5) < Math.max(1, h * 0.03) && x > w * 0.2 && x < w * 0.8;
  if (line) c = [c[0] * 0.25, c[1] * 0.25, c[2] * 0.3];
  return [c[0], c[1], c[2], 255];
};

describe('paper-clean', () => {
  it('flattens uneven light and tint into clean white paper and keeps the line dark', async () => {
    const t = await harness();
    const src = t.fromFn(160, 96, sheet(160, 96));
    const px = await t.pixels((await t.run('paper-clean', { paperRadius: 30 }, { image: src })).image as never);
    for (const [x, y] of [[8, 8], [40, 20], [90, 80], [150, 10], [150, 85]]) {
      const [r, g, b] = px.at(x, y);
      expect(Math.min(r, g, b), `${x},${y}`).toBeGreaterThan(238);
    }
    const lineY = 48;
    expect(px.at(60, lineY)[0]).toBeLessThan(120);
    expect(px.at(120, lineY)[0]).toBeLessThan(120);
  });

  it('colour cast removal: off keeps the paper tint', async () => {
    const t = await harness();
    const src = t.fromFn(96, 64, () => [230, 215, 170, 255]);
    const on = await t.pixels((await t.run('paper-clean', { removeCast: 1, whitePoint: 1, blackPoint: 0 }, { image: src })).image as never);
    expect(Math.min(...on.at(40, 30).slice(0, 3))).toBeGreaterThan(248);
    const off = await t.pixels((await t.run('paper-clean', { removeCast: 0, whitePoint: 1, blackPoint: 0 }, { image: src })).image as never);
    const [r, , b] = off.at(40, 30);
    expect(r - b).toBeGreaterThan(20);
  });

  it('faint guides are erased while real marks stay', async () => {
    const t = await harness();
    const src = t.fromFn(96, 64, (x, y) => (y === 20 ? [205, 205, 215, 255] : y === 44 ? [40, 40, 45, 255] : [250, 250, 250, 255]));
    const keep = await t.pixels((await t.run('paper-clean', { guideSuppress: 0, paperRadius: 20, whitePoint: 0.97 }, { image: src })).image as never);
    expect(keep.at(40, 20)[0]).toBeLessThan(240);
    const gone = await t.pixels((await t.run('paper-clean', { guideSuppress: 0.25, paperRadius: 20, whitePoint: 0.97 }, { image: src })).image as never);
    expect(gone.at(40, 20)[0]).toBeGreaterThan(250);
    expect(gone.at(40, 44)[0]).toBeLessThan(80);
  });

  it('ink-only output is transparent paper with the ink colour kept', async () => {
    const t = await harness();
    const src = t.fromFn(160, 96, (x, y) => {
      const base = sheet(160, 96)(x, y);
      return Math.abs(y - 48) < 3 && x > 40 && x < 120 ? [Math.round(base[0] * 0.7), Math.round(base[1] * 0.12), Math.round(base[2] * 0.12), 255] : base;
    });
    const px = await t.pixels((await t.run('paper-clean', { output: 'ink', paperRadius: 30 }, { image: src })).image as never);
    expect(px.at(10, 10)[3]).toBe(0);
    expect(px.at(150, 80)[3]).toBe(0);
    const ink = px.at(80, 48);
    expect(ink[3]).toBeGreaterThan(200);
    expect(ink[0]).toBeGreaterThan(ink[1] + 20); // reddish ink stays reddish
  });

  it('paper radius follows resolution', async () => {
    const t = await harness();
    const d = await resolutionDiff(t, 'paper-clean', { paperRadius: 12 }, sheet, 48);
    expect(d).toBeLessThan(18);
  });
});
