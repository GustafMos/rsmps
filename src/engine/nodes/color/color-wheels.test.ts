import { expect, it } from 'vitest';
import { type GradeOpts, WHEEL_SCALE, gradeReference, wheelVec } from '../../lib/color-math';
import { makeChart, maxDiff, to01 } from '../../lib/color-testutil';
import { harness } from '../../testing';

const SPACES = ['display', 'linear', 'log'] as const;

it('identity values are the identity in every working space, in both modes', async () => {
  const t = await harness();
  const src = makeChart(t);
  const a = await t.pixels(src);
  for (const space of SPACES) for (const mode of ['lgg', 'cdl']) {
    const out = await t.pixels((await t.run('color-wheels', { mode, space }, { image: src })).image as never);
    expect(maxDiff(a.data, out.data), `${mode} ${space}`).toBeLessThanOrEqual(1);
  }
});

it('ASC CDL: slope, offset and power behave as specified (display space)', async () => {
  const t = await harness();
  const grey = (v: number) => t.solid(4, 4, [v, v, v, 255]);
  const run = async (v: number, p: Record<string, unknown>) => (await t.pixels((await t.run('color-wheels', { mode: 'cdl', ...p }, { image: grey(v) })).image as never)).at(1, 1);
  expect(Math.abs((await run(64, { slopeR: 2, slopeG: 2, slopeB: 2 }))[0] - 128)).toBeLessThanOrEqual(1);
  expect(Math.abs((await run(51, { cdlOffsetR: 0.1, cdlOffsetG: 0.1, cdlOffsetB: 0.1 }))[1] - 77)).toBeLessThanOrEqual(1);
  expect(Math.abs((await run(128, { powerR: 2, powerG: 2, powerB: 2 }))[2] - 64)).toBeLessThanOrEqual(1);
  // per-channel slope only moves that channel
  const px = await run(100, { slopeR: 1.5 });
  expect(px[0]).toBe(150);
  expect(px[1]).toBe(100);
  // saturation 0 collapses to Rec.709 luma of the (display) values
  const c = (await t.pixels((await t.run('color-wheels', { mode: 'cdl', saturation: 0 }, { image: t.solid(4, 4, [200, 100, 50, 255]) })).image as never)).at(1, 1);
  const y = 0.2126 * 200 + 0.7152 * 100 + 0.0722 * 50;
  expect(Math.abs(c[0] - y)).toBeLessThanOrEqual(1);
  expect(Math.abs(c[1] - y)).toBeLessThanOrEqual(1);
});

it('lift moves black, gain moves white, gamma moves the middle only', async () => {
  const t = await harness();
  const ramp = t.fromFn(256, 2, (x) => [x, x, x, 255]);
  const at = async (p: Record<string, unknown>, x: number) => (await t.pixels((await t.run('color-wheels', p, { image: ramp })).image as never)).at(x, 0)[0];
  expect(await at({ liftMaster: 0.1 }, 0)).toBeGreaterThanOrEqual(25);
  expect(await at({ liftMaster: 0.1 }, 255)).toBe(255);
  expect(await at({ gainMaster: -0.2 }, 255)).toBeLessThanOrEqual(205);
  expect(await at({ gainMaster: -0.2 }, 0)).toBe(0);
  expect(await at({ gammaMaster: 1 }, 0)).toBe(0);
  expect(await at({ gammaMaster: 1 }, 255)).toBe(255);
  expect(Math.abs((await at({ gammaMaster: 1 }, 64)) - 128)).toBeLessThanOrEqual(1); // 0.25^(1/2) = 0.5
  expect(await at({ gammaMaster: -0.5 }, 128)).toBeLessThan(80);
  expect(Math.abs((await at({ offsetMaster: 0.1 }, 100)) - 126)).toBeLessThanOrEqual(1);
});

it('wheel colours tint only their own range; neutral grey wheels do nothing', async () => {
  const t = await harness();
  const ramp = t.fromFn(256, 2, (x) => [x, x, x, 255]);
  const blue = [0.4, 0.5, 0.9, 1];
  const shadows = (await t.pixels((await t.run('color-wheels', { liftColor: blue }, { image: ramp })).image as never));
  expect(shadows.at(20, 0)[2]).toBeGreaterThan(shadows.at(20, 0)[0] + 8);
  expect(Math.abs(shadows.at(255, 0)[2] - shadows.at(255, 0)[0])).toBeLessThanOrEqual(1);
  const highs = (await t.pixels((await t.run('color-wheels', { gainColor: [0.95, 0.6, 0.35, 1] }, { image: ramp })).image as never));
  expect(highs.at(230, 0)[0]).toBeGreaterThan(highs.at(230, 0)[2] + 15);
  expect(Math.abs(highs.at(10, 0)[0] - highs.at(10, 0)[2])).toBeLessThanOrEqual(5); // gain acts in proportion to the value
});

it('matches the CPU reference in all working spaces (lift/gamma/gain/offset/contrast/saturation)', async () => {
  const t = await harness();
  const src = makeChart(t);
  const input = await t.pixels(src);
  for (const space of SPACES) {
    const p = {
      mode: 'lgg', space,
      liftColor: [0.55, 0.5, 0.45, 1], liftMaster: 0.02,
      gammaColor: [0.5, 0.55, 0.5, 1], gammaMaster: 0.15,
      gainColor: [0.5, 0.5, 0.6, 1], gainMaster: 0.1,
      offsetColor: [0.52, 0.5, 0.5, 1], offsetMaster: -0.01,
      contrast: 1.2, pivot: 0.4, saturation: 1.3,
    };
    const lift = wheelVec(p.liftColor, p.liftMaster, WHEEL_SCALE.lift);
    const gamma = wheelVec(p.gammaColor, p.gammaMaster, WHEEL_SCALE.gamma).map((v) => 1 + v) as [number, number, number];
    const gain = wheelVec(p.gainColor, p.gainMaster, WHEEL_SCALE.gain).map((v) => 1 + v) as [number, number, number];
    const offset = wheelVec(p.offsetColor, p.offsetMaster, WHEEL_SCALE.offset);
    const out = await t.pixels((await t.run('color-wheels', p, { image: src })).image as never);
    const space2 = { display: 'srgb', linear: 'linear', log: 'cineon' }[space];
    // pivot conversion identical to the node's: display value -> working space
    const { tfEncode, tfDecode } = await import('../../lib/color-math');
    const o: GradeOpts = { mode: 'lgg', lift, gamma, gain, offset, slope: [1, 1, 1], cdlOffset: [0, 0, 0], power: [1, 1, 1], contrast: p.contrast, pivot: tfEncode(space2 as 'srgb', tfDecode('srgb', p.pivot)), saturation: p.saturation };
    let worst = 0;
    for (let y = 0; y < input.height; y += 9) for (let x = 0; x < input.width; x += 7) {
      const ref = gradeReference(to01(input.at(x, y)), o, space);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out.at(x, y)[k] - ref[k] * 255));
    }
    expect(worst, space).toBeLessThanOrEqual(3);
  }
});

it('keeps alpha and honours the mask', async () => {
  const t = await harness();
  const half = (await t.pixels((await t.run('color-wheels', { gainMaster: 0.3 }, { image: t.solid(4, 4, [100, 100, 100, 90]) })).image as never)).at(1, 1);
  expect(half[3]).toBe(90);
  const out = await t.pixels((await t.run('color-wheels', { gainMaster: 0.5 }, { image: t.solid(8, 2, [100, 100, 100, 255]), mask: t.maskFn(8, 2, (x) => (x < 4 ? 0 : 1)) })).image as never);
  expect(out.at(1, 0)[0]).toBe(100);
  expect(out.at(6, 0)[0]).toBeGreaterThan(130);
});
