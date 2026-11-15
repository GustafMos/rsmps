import { expect, it } from 'vitest';
import { harness } from '../../testing';

it('extract shows a single channel as grey', async () => {
  const t = await harness();
  const src = t.solid(4, 4, [200, 100, 50, 255]);
  const px = await t.pixels((await t.run('channels', { operation: 'extract', channel: 'g' }, { image: src })).image as never);
  expect(px.at(1, 1).slice(0, 3)).toEqual([100, 100, 100]);
});

it('swap reorders channels', async () => {
  const t = await harness();
  const px = await t.pixels((await t.run('channels', { operation: 'swap', swap: 'bgr' }, { image: t.solid(4, 4, [200, 100, 50, 255]) })).image as never);
  expect(px.at(1, 1).slice(0, 3)).toEqual([50, 100, 200]);
});

it('luma-to-alpha and alpha-to-luma convert between brightness and transparency', async () => {
  const t = await harness();
  const a = await t.pixels((await t.run('channels', { operation: 'luma-to-alpha' }, { image: t.solid(4, 4, [255, 255, 255, 255]) })).image as never);
  expect(a.at(1, 1)[3]).toBe(255);
  const b = await t.pixels((await t.run('channels', { operation: 'luma-to-alpha', invert: true }, { image: t.solid(4, 4, [255, 255, 255, 255]) })).image as never);
  expect(b.at(1, 1)[3]).toBe(0);
  const c = await t.pixels((await t.run('channels', { operation: 'alpha-to-luma' }, { image: t.solid(4, 4, [255, 0, 0, 128]) })).image as never);
  expect(c.at(1, 1)[0]).toBeCloseTo(128, -1);
  expect(c.at(1, 1)[3]).toBe(255);
});

it('pack can fill a channel with a constant and keeps alpha', async () => {
  const t = await harness();
  const px = await t.pixels((await t.run('channels', { operation: 'pack', outR: 'one', outG: 'zero', outB: 'luma' }, { image: t.solid(4, 4, [100, 100, 100, 200]) })).image as never);
  expect(px.at(1, 1)[3]).toBe(200);
  expect(px.at(1, 1)[1]).toBe(0);
  expect(px.at(1, 1)[0]).toBeGreaterThan(250);
});
