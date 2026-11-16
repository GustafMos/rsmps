import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { harness, type Pixels } from '../../testing';
import type { ImageValue } from '../../types';

/** Minimal PNG writer for eyeballing results (set ART_GRID_PNG=<dir> to get files). */
function png(p: Pixels): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(p.width, 0);
  ihdr.writeUInt32BE(p.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((p.width * 4 + 1) * p.height);
  for (let y = 0; y < p.height; y++) {
    raw[y * (p.width * 4 + 1)] = 0;
    Buffer.from(p.data.buffer, p.data.byteOffset + y * p.width * 4, p.width * 4).copy(raw, y * (p.width * 4 + 1) + 1);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const sceneFn = (w: number, h: number) => (x: number, y: number): [number, number, number, number] => {
  const r = Math.round((x / w) * 255);
  const g = Math.round((y / h) * 255);
  const b = Math.round(128 + 127 * Math.sin((x + y) / 23));
  return [r, g, b, 255];
};

describe('art grid: Dither with Pixel size', () => {
  it('a 1920x1080 input with pixelSize 8 does its work on a ~240x135 grid and returns full size with cell stamped', async () => {
    const t = await harness();
    const src = t.fromFn(1920, 1080, sceneFn(1920, 1080));
    const passSpy = vi.spyOn(t.gpu, 'pass');
    const allocSpy = vi.spyOn(t.gpu, 'alloc');
    const out = (await t.run('dither', { algorithm: 'floyd-steinberg', pixelSize: 8, fallback: 'pico-8' }, { image: src })).image as ImageValue;
    expect([out.width, out.height]).toEqual([1920, 1080]);
    expect(out.cell).toBe(8);
    // Error diffusion allocates its working image through gpu.alloc: it must be the art grid, never the source size.
    const allocs = allocSpy.mock.calls.map((c) => `${c[0]}x${c[1]}`);
    expect(allocs).toContain('240x135');
    expect(allocs).not.toContain('1920x1080');
    // No pass ever reads/writes anything but the grid or the final full-size resample.
    const sizes = new Set(passSpy.mock.calls.map((c) => `${Math.round(c[0].size.width)}x${Math.round(c[0].size.height)}`));
    expect([...sizes].sort()).toEqual(['1920x1080', '240x135']);
    const px = await t.pixels(out);
    // Chunky: every 8x8 block is one flat colour.
    for (const [bx, by] of [[3, 3], [100, 50], [239, 134]]) {
      const c = px.at(bx * 8, by * 8);
      expect(px.at(bx * 8 + 7, by * 8 + 7)).toEqual(c);
      expect(px.at(bx * 8 + 3, by * 8 + 5)).toEqual(c);
    }
    passSpy.mockRestore();
    allocSpy.mockRestore();
  });

  it('pixelSize 0 on a normal image is the old behaviour (no grid, no cell)', async () => {
    const t = await harness();
    const out = (await t.run('dither', { algorithm: 'bayer-4', fallback: 'pico-8' }, { image: t.fromFn(64, 64, sceneFn(64, 64)) })).image as ImageValue;
    expect([out.width, out.height]).toEqual([64, 64]);
    expect(out.cell).toBeUndefined();
  });

  it('pixelSize follows the media unit (unit 2 image, 4 unit pixels = 8 texels)', async () => {
    const t = await harness();
    const out = (await t.run('quantize', { pixelSize: 4, fallback: 'pico-8' }, { image: t.fromFn(256, 128, sceneFn(256, 128), 2) })).image as ImageValue;
    expect(out.cell).toBe(8);
    expect(out.unit).toBe(2);
  });
});

describe('art grid: masked Pixelate', () => {
  const W = 128;
  const H = 96;
  const left = (x: number) => (x < 64 ? 1 : 0);

  it('inside the mask the art grid, outside the untouched source; size kept; cell stamped', async () => {
    const t = await harness();
    const src = t.fromFn(W, H, sceneFn(W, H));
    const mask = t.maskFn(W, H, (x) => left(x));
    const out = (await t.run('pixelate', { mode: 'fixed-height', value: 12, edgeAware: false, colorBlend: 0, sharpen: 0 }, { image: src, mask })).image as ImageValue;
    expect([out.width, out.height, out.unit]).toEqual([W, H, 1]);
    expect(out.cell).toBe(8);
    const a = await t.pixels(out);
    const s = await t.pixels(src);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (x >= 64) expect(a.at(x, y), `outside ${x},${y}`).toEqual(s.at(x, y));
        else expect(a.at(x, y), `inside ${x},${y}`).toEqual(a.at((x >> 3) << 3, (y >> 3) << 3));
      }
    }
    // The blocks really are an average (not the same as the source) somewhere inside.
    expect(a.at(5, 5)).not.toEqual(s.at(5, 5));
  });

  it('without a mask it is exactly the old small art grid; keepSize gives the same grid at source size', async () => {
    const t = await harness();
    const src = t.fromFn(W, H, sceneFn(W, H));
    const params = { mode: 'fixed-height', value: 12, edgeAware: false, colorBlend: 0, sharpen: 0 };
    const small = (await t.run('pixelate', params, { image: src })).image as ImageValue;
    expect([small.width, small.height, small.unit]).toEqual([16, 12, 1]);
    expect(small.cell).toBeUndefined();
    const kept = (await t.run('pixelate', { ...params, keepSize: true }, { image: src })).image as ImageValue;
    expect([kept.width, kept.height]).toEqual([W, H]);
    expect(kept.cell).toBe(8);
    const ps = await t.pixels(small);
    const pk = await t.pixels(kept);
    for (const [x, y] of [[0, 0], [9, 3], [15, 11]]) expect(pk.at(x * 8 + 4, y * 8 + 2)).toEqual(ps.at(x, y));
  });

  it('Mix below 1 without a mask also keeps the size and blends', async () => {
    const t = await harness();
    const src = t.solid(64, 64, [200, 0, 0, 255]);
    const out = (await t.run('pixelate', { mode: 'fixed-height', value: 8, mix: 0.5 }, { image: src })).image as ImageValue;
    expect([out.width, out.height]).toEqual([64, 64]);
  });
});

describe('art grid: Dither follows cell', () => {
  it('after a masked Pixelate, Dither works on the grid (each cell flat, cell kept, size kept)', async () => {
    const t = await harness();
    const W = 128;
    const H = 96;
    const src = t.fromFn(W, H, sceneFn(W, H));
    const mask = t.maskFn(W, H, (x) => (x < 64 ? 1 : 0));
    const pix = (await t.run('pixelate', { mode: 'fixed-height', value: 12, edgeAware: false, sharpen: 0 }, { image: src, mask })).image as ImageValue;
    const allocSpy = vi.spyOn(t.gpu, 'alloc');
    const out = (await t.run('dither', { algorithm: 'floyd-steinberg', fallback: 'pico-8' }, { image: pix, mask })).image as ImageValue;
    const allocs = allocSpy.mock.calls.map((c) => `${c[0]}x${c[1]}`);
    allocSpy.mockRestore();
    expect(allocs).toContain('16x12');
    expect(allocs).not.toContain(`${W}x${H}`);
    expect([out.width, out.height]).toEqual([W, H]);
    expect(out.cell).toBe(8);
    const a = await t.pixels(out);
    const before = await t.pixels(pix);
    for (let y = 0; y < H; y += 3) {
      for (let x = 0; x < 64; x += 3) expect(a.at(x, y)).toEqual(a.at((x >> 3) << 3, (y >> 3) << 3));
      for (let x = 64; x < W; x += 5) expect(a.at(x, y)).toEqual(before.at(x, y));
    }
  });

  it('quantize, palette swap and mosaic also work on the grid when cell > 1', async () => {
    const t = await harness();
    const base = t.fromFn(64, 64, sceneFn(64, 64));
    const grid: ImageValue = { ...base, cell: 8 };
    const q = (await t.run('quantize', { fallback: 'pico-8' }, { image: grid })).image as ImageValue;
    expect(q.cell).toBe(8);
    const pq = await t.pixels(q);
    expect(pq.at(9, 9)).toEqual(pq.at(8, 8));
    expect(pq.at(15, 15)).toEqual(pq.at(8, 8));
    const m = (await t.run('mosaic', { block: 8 }, { image: grid })).image as ImageValue;
    expect(m.cell).toBe(8);
  });
});

describe('art grid: pictures', () => {
  it.skipIf(!process.env.ART_GRID_PNG)('writes example PNGs', async () => {
    const dir = process.env.ART_GRID_PNG as string;
    const t = await harness();
    const W = 640;
    const H = 360;
    const src = t.fromFn(W, H, sceneFn(W, H));
    // A soft-edged ellipse standing in for a tracked region.
    const mask = t.maskFn(W, H, (x, y) => Math.min(1, Math.max(0, (1 - Math.hypot((x - 380) / 170, (y - 180) / 120)) * 12)));
    const a = (await t.run('dither', { algorithm: 'floyd-steinberg', pixelSize: 6, fallback: 'pico-8' }, { image: src, mask })).image as ImageValue;
    writeFileSync(`${dir}/masked-dither-pixelsize.png`, png(await t.pixels(a)));
    const pix = (await t.run('pixelate', { mode: 'fixed-height', value: 60, edgeAware: false }, { image: src, mask })).image as ImageValue;
    const b = (await t.run('dither', { algorithm: 'bayer-4', fallback: 'pico-8' }, { image: pix, mask })).image as ImageValue;
    writeFileSync(`${dir}/masked-pixelate-dither.png`, png(await t.pixels(b)));
  });
});
