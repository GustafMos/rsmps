import { describe, expect, it } from 'vitest';
import { lookAtQuat } from '../../lib/scan-coverage';
import { emptyScan, type ScanData, type ScanShot } from '../../lib/scan-data';
import { harness } from '../../testing';
import type { Host, ImageValue } from '../../types';

const shot = (asset: string, i: number): ScanShot => {
  const pos: [number, number, number] = [Math.cos(i), 1, -2 + Math.sin(i)];
  return { asset, t: i, pos, quat: lookAtQuat(pos, [0, 0, -2]), w: 16, h: 16, fx: 20, fy: 20, cx: 8, cy: 8, sharp: 0.9 };
};
const scanOf = (assets: string[]): ScanData => ({ ...emptyScan(), shots: assets.map(shot) });

describe('3D Scan node', () => {
  const frames = new Map<string, ImageValue>();
  const host: Host = {
    assetInfo: (id) => {
      const f = frames.get(id);
      return f ? { id, name: id, kind: 'image', width: f.width, height: f.height, duration: 0, fps: 0, hasAudio: false } : null;
    },
    assetFrame: async (id) => {
      const f = frames.get(id);
      return f ? { texture: f.texture, width: f.width, height: f.height } : null;
    },
  };
  const setup = async () => {
    const t = await harness([], host);
    frames.set('red', t.solid(16, 16, [255, 0, 0, 255]));
    frames.set('green', t.solid(16, 16, [0, 255, 0, 255]));
    frames.set('blue', t.solid(16, 16, [0, 0, 255, 255]));
    return t;
  };
  const colour = async (t: Awaited<ReturnType<typeof setup>>, params: Record<string, unknown>, seconds: number) => {
    const out = await t.run('scan-3d', params, {}, { seconds, project: { fps: 10, duration: 3, loop: true } });
    return { out, rgb: (await t.pixels(out.image as never)).at(8, 8).slice(0, 3).join(',') };
  };

  it('the slideshow shows the photos in order over the loop and wraps', async () => {
    const t = await setup();
    const p = { scan: scanOf(['red', 'green', 'blue']) };
    const seen = [];
    for (const s of [0, 0.9, 1.0, 1.9, 2.0, 2.9]) seen.push((await colour(t, p, s)).rgb);
    expect(seen).toEqual(['255,0,0', '255,0,0', '0,255,0', '0,255,0', '0,0,255', '0,0,255']);
    expect((await colour(t, p, 0)).out.shots).toBe(3);
  });

  it('"One photo" holds the chosen photo, clamped to the number of photos', async () => {
    const t = await setup();
    const p = { scan: scanOf(['red', 'green', 'blue']), show: 'one' };
    expect((await colour(t, { ...p, photo: 2 }, 2.5)).rgb).toBe('0,255,0');
    expect((await colour(t, { ...p, photo: 99 }, 0)).rgb).toBe('0,0,255');
  });

  it('an empty scan, or no scan at all, is a clear empty picture and zero shots, not an error', async () => {
    const t = await setup();
    for (const scan of [null, emptyScan(), 'garbage', { v: 9 }]) {
      const { out } = await colour(t, { scan }, 0);
      expect(out.shots).toBe(0);
      const img = out.image as ImageValue;
      expect(img.width).toBeGreaterThan(0);
      const px = (await t.pixels(img)).at(2, 2);
      expect(px[3]).toBe(255); // opaque dark picture
      expect(px[0]).toBeLessThan(60);
    }
  });

  it('a missing photo gives a plain sentence', async () => {
    const t = await setup();
    await expect(colour(t, { scan: scanOf(['gone']) }, 0)).rejects.toThrow(/missing from Media/);
  });
});
