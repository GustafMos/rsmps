import { describe, expect, it } from 'vitest';
import { beginGif, gifDelays, lzwEncode } from './gif';
import { join, makePicture, rng } from './test-helpers';

export interface GifFrame {
  rgba: Uint8Array;
  delay: number;
  rect: [number, number, number, number];
  disposal: number;
  local: boolean;
}

function lzwDecode(data: Uint8Array, minCode: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  const clear = 1 << minCode;
  const eoi = clear + 1;
  let size = minCode + 1;
  let next = eoi + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Int32Array(4096);
  for (let i = 0; i < clear; i++) {
    suffix[i] = i;
    length[i] = 1;
    prefix[i] = -1;
  }
  let bitPos = 0;
  let prev = -1;
  let o = 0;
  const emit = (code: number) => {
    const n = length[code];
    let c = code;
    for (let i = n - 1; i >= 0; i--) {
      if (o + i < count) out[o + i] = suffix[c];
      c = prefix[c];
    }
    o += n;
  };
  const first = (code: number) => {
    let c = code;
    while (prefix[c] >= 0) c = prefix[c];
    return suffix[c];
  };
  while (o < count) {
    let code = 0;
    for (let i = 0; i < size; i++) {
      const b = (data[(bitPos + i) >> 3] >> ((bitPos + i) & 7)) & 1;
      code |= b << i;
    }
    bitPos += size;
    if (bitPos > data.length * 8 + 8) throw new Error('lzw: out of data');
    if (code === clear) {
      size = minCode + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) break;
    if (prev < 0) {
      emit(code);
      prev = code;
      continue;
    }
    if (code < next) {
      if (next < 4096) {
        prefix[next] = prev;
        suffix[next] = first(code);
        length[next] = length[prev] + 1;
        next++;
      }
      emit(code);
    } else {
      if (code !== next) throw new Error('lzw: bad code');
      prefix[next] = prev;
      suffix[next] = first(prev);
      length[next] = length[prev] + 1;
      next++;
      emit(code);
    }
    if (next === 1 << size && size < 12) size++;
    prev = code;
  }
  return out;
}

/** Small independent GIF decoder: composes frames on a canvas honouring disposal and transparency. */
export function decodeGif(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(String.fromCharCode(...bytes.subarray(0, 6))).toBe('GIF89a');
  const w = v.getUint16(6, true);
  const h = v.getUint16(8, true);
  const packed = bytes[10];
  let at = 13;
  let gct: Uint8Array | null = null;
  if (packed & 0x80) {
    const n = 2 << (packed & 7);
    gct = bytes.subarray(at, at + n * 3);
    at += n * 3;
  }
  let loop: number | null = null;
  const canvas = new Uint8Array(w * h * 4);
  const frames: GifFrame[] = [];
  let gce = { delay: 0, trans: -1, disposal: 0 };
  while (bytes[at] !== 0x3b) {
    if (bytes[at] === 0x21) {
      const label = bytes[at + 1];
      let p = at + 2;
      const first = p + 1;
      if (label === 0xf9) {
        const pk = bytes[first];
        gce = { delay: v.getUint16(first + 1, true), trans: pk & 1 ? bytes[first + 3] : -1, disposal: (pk >> 2) & 7 };
      }
      if (label === 0xff && String.fromCharCode(...bytes.subarray(first, first + 11)) === 'NETSCAPE2.0') loop = v.getUint16(first + 11 + 2, true);
      while (bytes[p] !== 0) p += bytes[p] + 1;
      at = p + 1;
    } else if (bytes[at] === 0x2c) {
      const x = v.getUint16(at + 1, true), y = v.getUint16(at + 3, true), rw = v.getUint16(at + 5, true), rh = v.getUint16(at + 7, true);
      const pk = bytes[at + 9];
      at += 10;
      let table = gct;
      if (pk & 0x80) {
        const n = 2 << (pk & 7);
        table = bytes.subarray(at, at + n * 3);
        at += n * 3;
      }
      const minCode = bytes[at++];
      const chunks: Uint8Array[] = [];
      while (bytes[at] !== 0) {
        chunks.push(bytes.subarray(at + 1, at + 1 + bytes[at]));
        at += bytes[at] + 1;
      }
      at++;
      const idx = lzwDecode(join(chunks), minCode, rw * rh);
      const before = canvas.slice();
      for (let j = 0; j < rh; j++) {
        for (let i = 0; i < rw; i++) {
          const c = idx[j * rw + i];
          if (c === gce.trans) continue;
          const o = ((y + j) * w + x + i) * 4;
          canvas[o] = table![c * 3];
          canvas[o + 1] = table![c * 3 + 1];
          canvas[o + 2] = table![c * 3 + 2];
          canvas[o + 3] = 255;
        }
      }
      frames.push({ rgba: canvas.slice(), delay: gce.delay, rect: [x, y, rw, rh], disposal: gce.disposal, local: !!(pk & 0x80) });
      if (gce.disposal === 2) {
        for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) canvas.fill(0, ((y + j) * w + x + i) * 4, ((y + j) * w + x + i) * 4 + 4);
      } else if (gce.disposal === 3) canvas.set(before);
      gce = { delay: 0, trans: -1, disposal: 0 };
    } else throw new Error('unexpected byte ' + bytes[at]);
  }
  return { w, h, frames, loop };
}

const play = async (frames: Uint8Array[], w: number, h: number, o: Parameters<typeof beginGif>[0] extends infer T ? Partial<T> : never) => {
  const s = beginGif({ width: w, height: h, fps: 25, ...o });
  for (const f of frames) s.addFrame(f);
  return decodeGif(join(await s.finish()));
};

describe('GIF delays', () => {
  it('25 fps is 4 cs, 24 fps alternates with exact average, 30 and 29.97 stay exact', () => {
    expect(gifDelays(25, 5)).toEqual([4, 4, 4, 4, 4]);
    const d24 = gifDelays(24, 24);
    expect(d24.reduce((a, b) => a + b, 0)).toBe(100);
    expect(new Set(d24)).toEqual(new Set([4, 5]));
    expect(gifDelays(24, 6)).toEqual([4, 4, 5, 4, 4, 4]);
    expect(gifDelays(30, 30).reduce((a, b) => a + b, 0)).toBe(100);
    expect(gifDelays(29.97, 30000).reduce((a, b) => a + b, 0)).toBe(100100);
    expect(gifDelays(10, 3)).toEqual([10, 10, 10]);
  });
});

describe('LZW', () => {
  it('round-trips random, flat and long structured data across table resets', () => {
    const r = rng(3);
    for (const [bits, data] of [
      [2, Uint8Array.from({ length: 20000 }, () => (r() * 4) | 0)],
      [8, Uint8Array.from({ length: 50000 }, () => (r() * 256) | 0)],
      [8, new Uint8Array(70000)],
      [4, Uint8Array.from({ length: 60000 }, (_, i) => (i * 3 + (i >> 5)) & 15)],
      [2, new Uint8Array([1])],
    ] as [number, Uint8Array][]) {
      const enc = lzwEncode(data, bits);
      expect(lzwDecode(enc, bits, data.length)).toEqual(data);
    }
  });
});

describe('GIF encoder', () => {
  it('pixel art with few colours is exact, with exact delays and loop', async () => {
    const w = 40;
    const h = 30;
    const frames = [makePicture('pixelart', w, h, 1), makePicture('pixelart', w, h, 2), makePicture('edges', w, h)];
    // make frame 2 differ from frame 1 only in a small area to exercise differencing
    frames[1] = frames[0].slice();
    for (let y = 10; y < 14; y++) for (let x = 20; x < 26; x++) frames[1].set([255, 0, 255, 255], (y * w + x) * 4);
    const g = await play(frames, w, h, { fps: 24 });
    expect(g.loop).toBe(0);
    expect(g.frames).toHaveLength(3);
    g.frames.forEach((f, i) => expect(f.rgba).toEqual(frames[i]));
    expect(g.frames[1].rect).toEqual([20, 10, 6, 4]);
    expect(g.frames.map((f) => f.delay)).toEqual([4, 4, 5]);
  });

  it('keeps an exact 256-colour frame exact', async () => {
    const w = 16;
    const h = 16;
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < 256; i++) px.set([i, 255 - i, (i * 7) & 255, 255], i * 4);
    const g = await play([px], w, h, {});
    expect(g.frames[0].rgba).toEqual(px);
  });

  it('merges identical frames into one longer delay', async () => {
    const p = makePicture('pixelart', 20, 20);
    const g = await play([p, p, p, makePicture('edges', 20, 20)], 20, 20, { fps: 10 });
    expect(g.frames).toHaveLength(2);
    expect(g.frames.map((f) => f.delay)).toEqual([30, 10]);
  });

  it('delays of the file sum to the duration at 24 fps', async () => {
    const frames = Array.from({ length: 48 }, (_, i) => makePicture(i % 2 ? 'pixelart' : 'edges', 12, 12));
    const g = await play(frames, 12, 12, { fps: 24 });
    expect(g.frames.reduce((s, f) => s + f.delay, 0)).toBe(200);
  });

  it('1-bit transparency with the threshold, including pixels that become transparent again', async () => {
    const w = 16;
    const h = 8;
    const a = makePicture('pixelart', w, h);
    const b = a.slice();
    for (let x = 0; x < 6; x++) b[x * 4 + 3] = 0; // row 0 turns transparent
    const c = a.slice();
    for (let y = 0; y < h; y++) c[(y * w + 15) * 4 + 3] = 100; // below the threshold
    const g = await play([a, b, c], w, h, {});
    const want = (src: Uint8Array) => {
      const o = src.slice();
      for (let i = 0; i < o.length; i += 4) if (o[i + 3] < 128) o.fill(0, i, i + 4);
      return o;
    };
    expect(g.frames[0].rgba).toEqual(want(a));
    expect(g.frames[1].rgba).toEqual(want(b));
    expect(g.frames[2].rgba).toEqual(want(c));
  });

  it('loop option: forever, n times, none', async () => {
    const p = makePicture('pixelart', 8, 8);
    expect((await play([p, makePicture('edges', 8, 8)], 8, 8, { loop: 3 })).loop).toBe(3);
    expect((await play([p], 8, 8, { loop: -1 })).loop).toBeNull();
  });

  it('photographic frames are quantised close to the source, and dithering changes the result', async () => {
    const w = 64;
    const h = 48;
    const src = makePicture('gradient', w, h);
    const err = (a: Uint8Array, b: Uint8Array) => {
      let s = 0;
      for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c++) s += (a[i + c] - b[i + c]) ** 2;
      return Math.sqrt(s / (w * h * 3));
    };
    const plain = (await play([src], w, h, { colors: 32 })).frames[0].rgba;
    const fs = (await play([src], w, h, { colors: 32, dither: 'floyd' })).frames[0].rgba;
    const ord = (await play([src], w, h, { colors: 32, dither: 'ordered' })).frames[0].rgba;
    expect(err(src, plain)).toBeLessThan(14);
    expect(fs).not.toEqual(plain);
    expect(ord).not.toEqual(plain);
    // dithered pictures keep the local mean colour close even though single pixels differ more
    const mean = (a: Uint8Array) => a.reduce((s, v, i) => s + (i % 4 === 3 ? 0 : v), 0) / (w * h * 3);
    expect(Math.abs(mean(fs) - mean(src))).toBeLessThan(3);
    const distinct = new Set<number>();
    for (let i = 0; i < fs.length; i += 4) distinct.add((fs[i] << 16) | (fs[i + 1] << 8) | fs[i + 2]);
    expect(distinct.size).toBeLessThanOrEqual(32);
  });

  it('global palette mode produces a single table shared by all frames', async () => {
    const frames = [makePicture('pixelart', 20, 20), makePicture('edges', 20, 20), makePicture('gradient', 20, 20)];
    const g = await play(frames, 20, 20, { palette: 'global', colors: 64 });
    expect(g.frames.every((f) => !f.local)).toBe(true);
    expect(g.frames).toHaveLength(3);
    // the exactly representable frames (< 64 colours together) are still exact when the union fits
    const small = await play([makePicture('pixelart', 20, 20), makePicture('edges', 20, 20)], 20, 20, { palette: 'global' });
    expect(small.frames[0].rgba).toEqual(makePicture('pixelart', 20, 20));
    expect(small.frames[1].rgba).toEqual(makePicture('edges', 20, 20));
  });

  it('without differencing every frame is full size', async () => {
    const a = makePicture('pixelart', 16, 16);
    const b = a.slice();
    b.set([1, 2, 3, 255], 0);
    const g = await play([a, b], 16, 16, { diff: false });
    expect(g.frames.map((f) => f.rect)).toEqual([[0, 0, 16, 16], [0, 0, 16, 16]]);
    expect(g.frames[1].rgba).toEqual(b);
  });

  it('rejects wrong sized data and empty animations', async () => {
    const s = beginGif({ width: 4, height: 4 });
    expect(() => s.addFrame(new Uint8Array(12))).toThrow();
    await expect(s.finish()).rejects.toThrow(/no frames/);
  });
});
