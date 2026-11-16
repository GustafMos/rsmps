import { describe, expect, it } from 'vitest';
import { packFrame, packLossless, unpackBytes } from './pixel-codec';
import { RamColdStore } from './ram-store';

function frame(w: number, h: number, kind: 'noise' | 'flat'): Uint8Array {
  const d = new Uint8Array(w * h * 4);
  let s = 12345;
  for (let i = 0; i < d.length; i += 4) {
    if (kind === 'flat') d.set([(i / 4) % w < w / 2 ? 255 : 0, 40, 90, 255], i);
    else {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const a = 128 + (s >>> 24) / 2;
      d.set([(s >>> 8) & 0x7f, (s >>> 12) & 0x7f, (s >>> 16) & 0x7f, a], i); // premultiplied-looking: colour <= alpha
    }
  }
  return d;
}

describe('RAM frame packing', () => {
  it('lossless packs round-trip exactly (graphics and noise)', async () => {
    for (const kind of ['flat', 'noise'] as const) {
      const px = frame(97, 61, kind);
      const packed = await packLossless(px, 97, 61);
      expect(packed.codec === 'deflate' || packed.codec === 'raw').toBe(true);
      const back = await unpackBytes(packed);
      expect(Array.from(back)).toEqual(Array.from(px));
      if (kind === 'flat') expect(packed.bytes).toBeLessThan(px.length / 20);
    }
  });

  it("'lossless' quality never uses a lossy codec; 'compressed' stays exact when the picture deflates well", async () => {
    const flat = frame(64, 64, 'flat');
    const noisy = frame(64, 64, 'noise');
    for (const px of [flat, noisy]) {
      const p = await packFrame(px, 64, 64, 'lossless');
      expect(p.codec === 'deflate' || p.codec === 'raw').toBe(true);
      expect(Array.from(await unpackBytes(p))).toEqual(Array.from(px));
    }
    const c = await packFrame(flat, 64, 64, 'compressed');
    expect(Array.from(await unpackBytes(c))).toEqual(Array.from(flat));
  });

  it('the RAM tier returns exactly what it was given and respects its byte budget', async () => {
    const store = new RamColdStore(40_000);
    const a = frame(100, 50, 'flat');
    expect(await store.put('a', { data: a, width: 100, height: 50 })).toBe(true);
    const got = await store.get('a');
    expect(got && Array.from(got.data)).toEqual(Array.from(a));
    expect(store.ratio).toBeLessThan(0.2);
    // noise does not fit in a small budget: refused rather than evicting everything
    const tiny = new RamColdStore(1000);
    expect(await tiny.put('n', { data: frame(100, 50, 'noise'), width: 100, height: 50 })).toBe(false);
    // LRU: the oldest entries go first
    const lru = new RamColdStore(6000);
    for (let i = 0; i < 12; i++) await lru.put(`k${i}`, { data: frame(40 + i, 40, 'noise'), width: 40 + i, height: 40 });
    expect(lru.bytes).toBeLessThanOrEqual(6000);
    expect(lru.has('k0')).toBe(false);
  });
});
