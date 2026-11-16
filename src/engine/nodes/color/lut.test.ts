import { expect, it } from 'vitest';
import { cubeText, parseCube, sampleCube, type V3 } from '../../lib/color-math';
import { makeChart, maxDiff, to01 } from '../../lib/color-testutil';
import { harness } from '../../testing';
import type { Host } from '../../types';

function hostWith(files: Record<string, string>): Host {
  const bytes = new Map<string, ArrayBuffer>();
  for (const [k, v] of Object.entries(files)) bytes.set(k, new TextEncoder().encode(v).buffer as ArrayBuffer);
  return { assetInfo: () => null, assetFrame: async () => null, assetBytes: async (id) => bytes.get(id) ?? null };
}

const id3 = (n: number) => cubeText('3d', n, (r, g, b) => [r, g, b]);
// a deliberately non-linear, cross-channel look so interpolation errors show
const look = (r: number, g: number, b: number): V3 => [Math.pow(r, 0.8) * 0.9 + 0.1 * g * b, 0.15 + 0.7 * g * g + 0.1 * r, 1 - b * 0.8 + 0.2 * Math.sin(3 * r)].map((v) => Math.min(1, Math.max(0, v))) as V3;

it('identity .cube files (3D and 1D, any size up to 65) are the identity', async () => {
  const files: Record<string, string> = {
    id17: id3(17),
    id2: id3(2),
    id33: id3(33),
    id65: id3(65),
    one256: cubeText('1d', 256, (r, g, b) => [r, g, b]),
    one17: cubeText('1d', 17, (r, g, b) => [r, g, b]),
  };
  const t = await harness([], hostWith(files));
  const src = makeChart(t);
  const a = await t.pixels(src);
  for (const id of Object.keys(files)) for (const interpolation of ['tetrahedral', 'trilinear']) {
    const out = await t.pixels((await t.run('lut', { lut: [id], interpolation }, { image: src })).image as never);
    expect(maxDiff(a.data, out.data), `${id} ${interpolation}`).toBeLessThanOrEqual(1);
  }
});

it('a real look matches the CPU reference for both interpolations (validates the WGSL against the TypeScript)', async () => {
  const text = cubeText('3d', 17, look);
  const t = await harness([], hostWith({ look: text }));
  const src = makeChart(t);
  const input = await t.pixels(src);
  const lut = parseCube(text);
  for (const interpolation of ['tetrahedral', 'trilinear'] as const) {
    const out = await t.pixels((await t.run('lut', { lut: ['look'], interpolation }, { image: src })).image as never);
    let worst = 0;
    for (let y = 0; y < input.height; y += 5) for (let x = 0; x < input.width; x += 3) {
      const ref = sampleCube(lut, to01(input.at(x, y)), interpolation);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out.at(x, y)[k] - ref[k] * 255));
    }
    expect(worst, interpolation).toBeLessThanOrEqual(1.5);
  }
});

it('1D LUT applies per channel; an inverting 1D LUT inverts', async () => {
  const t = await harness([], hostWith({ inv: cubeText('1d', 64, (r, g, b) => [1 - r, 1 - g, 1 - b]) }));
  const px = (await t.pixels((await t.run('lut', { lut: ['inv'] }, { image: t.solid(4, 4, [200, 100, 20, 255]) })).image as never)).at(1, 1);
  expect([px[0], px[1], px[2]]).toEqual([55, 155, 235]);
});

it('intensity mixes the picture and the LUT', async () => {
  const t = await harness([], hostWith({ inv: cubeText('1d', 64, (r, g, b) => [1 - r, 1 - g, 1 - b]) }));
  const half = (await t.pixels((await t.run('lut', { lut: ['inv'], intensity: 0.5 }, { image: t.solid(4, 4, [200, 100, 20, 255]) })).image as never)).at(1, 1);
  // the mix runs on the encoded values: halfway between 200 and 55
  expect(Math.abs(half[0] - 127.5)).toBeLessThanOrEqual(1.5);
  const none = (await t.pixels((await t.run('lut', { lut: ['inv'], intensity: 0 }, { image: t.solid(4, 4, [200, 100, 20, 255]) })).image as never)).at(1, 1);
  expect([none[0], none[1], none[2]]).toEqual([200, 100, 20]);
});

it('input / output spaces: an identity LUT between two log spaces still returns the picture', async () => {
  const t = await harness([], hostWith({ id: id3(33) }));
  const src = makeChart(t);
  const a = await t.pixels(src);
  for (const inSpace of ['logc3', 'slog3', 'linear']) {
    const out = await t.pixels((await t.run('lut', { lut: ['id'], inSpace, outSpace: inSpace }, { image: src })).image as never);
    // a 33-point LUT of a log curve is interpolated linearly: allow a little curvature error
    expect(maxDiff(a.data, out.data), inSpace).toBeLessThanOrEqual(inSpace === 'linear' ? 40 : 6);
  }
  // spaces really are applied: the identity LUT's output is read as LINEAR light, so sRGB 188 (0.737) comes out as linear 0.737 = sRGB 224
  const dark = (await t.pixels((await t.run('lut', { lut: ['id'], inSpace: 'srgb', outSpace: 'linear' }, { image: t.solid(4, 4, [188, 188, 188, 255]) })).image as never)).at(1, 1);
  expect(Math.abs(dark[0] - 224)).toBeLessThanOrEqual(2);
});

it('no LUT chosen passes the picture through; a missing or broken file is a readable error', async () => {
  const t = await harness([], hostWith({ bad: 'LUT_3D_SIZE 4\n0 0 0\n' }));
  const src = t.solid(4, 4, [10, 20, 30, 255]);
  const out = await t.pixels((await t.run('lut', {}, { image: src })).image as never);
  expect(out.at(1, 1).slice(0, 3)).toEqual([10, 20, 30]);
  await expect(t.run('lut', { lut: ['nope'] }, { image: src })).rejects.toThrow(/missing/);
  await expect(t.run('lut', { lut: ['bad'] }, { image: src })).rejects.toThrow(/Could not read the LUT: \.cube: expected 64 entries/);
});

it('keeps alpha and honours the mask', async () => {
  const t = await harness([], hostWith({ inv: cubeText('1d', 16, (r, g, b) => [1 - r, 1 - g, 1 - b]) }));
  const half = (await t.pixels((await t.run('lut', { lut: ['inv'] }, { image: t.solid(4, 4, [100, 100, 100, 99] as never) })).image as never)).at(1, 1);
  expect(half[3]).toBe(99);
  const out = await t.pixels((await t.run('lut', { lut: ['inv'] }, { image: t.solid(8, 2, [100, 100, 100, 255]), mask: t.maskFn(8, 2, (x) => (x < 4 ? 0 : 1)) })).image as never);
  expect(out.at(1, 0)[0]).toBe(100);
  expect(out.at(6, 0)[0]).toBe(155);
});

it('large LUTs are cached: the same file uploads once, however many sliders move', async () => {
  const t = await harness([], hostWith({ big: id3(65) }));
  const src = t.solid(16, 16, [90, 120, 150, 255]);
  await t.run('lut', { lut: ['big'], intensity: 1 }, { image: src });
  const before = t.gpu.stats();
  for (let i = 0; i < 6; i++) await t.run('lut', { lut: ['big'], intensity: 0.1 + i * 0.1 }, { image: src });
  const after = t.gpu.stats();
  expect(after.caches.dataTextureHits - before.caches.dataTextureHits).toBe(6);
  expect(after.objects.pipelinesCreated - before.objects.pipelinesCreated).toBe(0);
});
