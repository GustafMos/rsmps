import { expect, it } from 'vitest';
import type { Host, LiveSource } from '../../types';
import { harness } from '../../testing';

const nullHost: Host = { assetInfo: () => null, assetFrame: async () => null };

function liveHost(t: { solid: (w: number, h: number, c: [number, number, number, number]) => { texture: GPUTexture; width: number; height: number } }, seen: LiveSource[]): Host {
  return {
    ...nullHost,
    async liveFrame(source) {
      seen.push(source);
      const img = t.solid(8, 4, [255, 0, 0, 255]);
      return { texture: img.texture, width: img.width, height: img.height };
    },
  };
}

it('camera-in asks the host for the chosen device and mirrors horizontally', async () => {
  const seen: LiveSource[] = [];
  const base = await harness();
  const t = await harness([], liveHost(base, seen));
  // Left half red, right half blue source, mirrored: left becomes blue.
  const host: Host = {
    ...nullHost,
    async liveFrame(source) {
      seen.push(source);
      const img = t.fromFn(8, 4, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
      return { texture: img.texture, width: 8, height: 4 };
    },
  };
  const t2 = await harness([], host);
  const out = await t2.run('camera-in', { device: 'cam1', resolution: '1280x720', mirror: true });
  const px = await t2.pixels(out.image as never);
  expect(px.at(0, 0)).toEqual([0, 0, 255, 255]);
  expect(px.at(7, 0)).toEqual([255, 0, 0, 255]);
  expect(seen[0]).toMatchObject({ kind: 'camera', deviceId: 'cam1', width: 1280, height: 720 });
  const off = await t2.run('camera-in', { mirror: false });
  const p2 = await t2.pixels(off.image as never);
  expect(p2.at(0, 0)).toEqual([255, 0, 0, 255]);
});

it('camera-in and url-in explain themselves when the host has no live support', async () => {
  const t = await harness();
  await expect(t.run('camera-in', {})).rejects.toThrow(/not available/);
  await expect(t.run('url-in', { url: 'http://x/y.jpg' })).rejects.toThrow(/not available/);
  await expect(t.run('url-in', { url: '' })).rejects.toThrow(/address/);
});

it('url-in passes address, type and refresh to the host and keeps the stream size', async () => {
  const seen: LiveSource[] = [];
  const base = await harness();
  const t = await harness([], liveHost(base, seen));
  const out = await t.run('url-in', { url: 'http://cam/shot.jpg', kind: 'image', refresh: 5 });
  expect((out.image as { width: number }).width).toBe(8);
  expect(seen[0]).toMatchObject({ kind: 'url', url: 'http://cam/shot.jpg', mode: 'image', refresh: 5 });
});
