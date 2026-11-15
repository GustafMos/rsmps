import { expect, it } from 'vitest';
import { squaresSource, TestGraph } from '../../lib/track-testutil';
import { harness } from '../../testing';
import type { ImageValue, MaskValue } from '../../types';

// Detect → Track → Regions To Mask → Invert (any effect), and → Region Overlay, on two moving squares.
it('detect → track → mask drives an effect only on the tracked parts', async () => {
  const t = await harness([
    squaresSource('test-pipe', 96, (f) => [
      { cx: 0.2 + 0.02 * f, cy: 0.3, hs: 0.08, color: [255, 255, 255] },
      { cx: 0.8 - 0.02 * f, cy: 0.7, hs: 0.08, color: [255, 255, 255] },
    ], [30, 30, 30]),
  ]);
  const g = new TestGraph(t, { width: 96, height: 96, fps: 10, duration: 4 });
  const src = g.add('test-pipe');
  const det = g.add('detect-blobs', { threshold: 0.8, blur: 0 });
  const trk = g.add('track');
  const mask = g.add('regions-to-mask', { feather: 1 });
  const inv = g.add('invert');
  const hud = g.add('region-overlay', { style: 'brackets', showLabel: false });
  g.wire(src, 'image', det, 'image');
  g.wire(det, 'regions', trk, 'regions');
  g.wire(src, 'image', mask, 'image');
  g.wire(trk, 'regions', mask, 'regions');
  g.wire(src, 'image', inv, 'image');
  g.wire(mask, 'mask', inv, 'mask');
  g.wire(src, 'image', hud, 'image');
  g.wire(trk, 'regions', hud, 'regions');

  const ids = new Set<string>();
  for (let f = 0; f < 12; f++) {
    const r = await g.regions(trk, f);
    expect(r).toHaveLength(2);
    ids.add(r.map((x) => x.id).sort().join(','));
  }
  expect(ids.size).toBe(1);

  const m = (await g.eval(mask, 5, 'mask')) as MaskValue;
  const mp = await t.pixels(m);
  expect(mp.at(Math.round(0.3 * 96), Math.round(0.3 * 96))[0]).toBe(255);
  expect(mp.at(48, 90)[0]).toBe(0);

  const effect = await t.pixels((await g.eval(inv, 5)) as ImageValue);
  expect(effect.at(Math.round(0.3 * 96), Math.round(0.3 * 96))[0]).toBe(0); // white square inverted
  expect(effect.at(48, 90)[0]).toBe(30); // background untouched

  const hudPx = await t.pixels((await g.eval(hud, 5)) as ImageValue);
  let changed = 0;
  const base = await t.pixels((await g.eval(src, 5)) as ImageValue);
  for (let i = 0; i < hudPx.data.length; i++) if (hudPx.data[i] !== base.data[i]) changed++;
  expect(changed).toBeGreaterThan(100);
});
