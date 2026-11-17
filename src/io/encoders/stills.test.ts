import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { encodeAiff, extended80 } from './aiff';
import { encodeExr, encodeHdr, floatToHalf, halfToFloat } from './float';
import { encodeQoi } from './qoi';
import { encodeBmp, encodeIco, encodePnm, encodeTga, resizeRgba } from './stills';
import { join, makePicture, rng } from './test-helpers';
import { encodeTiff, encodeTiffPages } from './tiff';

const pics = ['gradient', 'noise', 'edges', 'alpha', 'pixelart'] as const;

// ---------------------------------------------------------------- QOI
function decodeQoi(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect(String.fromCharCode(...b.subarray(0, 4))).toBe('qoif');
  const w = v.getUint32(4), h = v.getUint32(8), channels = b[12];
  const out = new Uint8Array(w * h * 4);
  const index = new Uint8Array(64 * 4);
  let r = 0, g = 0, bl = 0, a = 255;
  let p = 14;
  let run = 0;
  for (let i = 0; i < w * h; i++) {
    if (run > 0) run--;
    else {
      const t = b[p++];
      if (t === 0xfe) [r, g, bl] = [b[p++], b[p++], b[p++]];
      else if (t === 0xff) [r, g, bl, a] = [b[p++], b[p++], b[p++], b[p++]];
      else if ((t & 0xc0) === 0) [r, g, bl, a] = index.subarray(t * 4, t * 4 + 4);
      else if ((t & 0xc0) === 0x40) {
        r = (r + ((t >> 4) & 3) - 2) & 255;
        g = (g + ((t >> 2) & 3) - 2) & 255;
        bl = (bl + (t & 3) - 2) & 255;
      } else if ((t & 0xc0) === 0x80) {
        const t2 = b[p++];
        const dg = (t & 63) - 32;
        r = (r + dg - 8 + ((t2 >> 4) & 15)) & 255;
        g = (g + dg) & 255;
        bl = (bl + dg - 8 + (t2 & 15)) & 255;
      } else run = t & 63;
      const h64 = (r * 3 + g * 5 + bl * 7 + a * 11) % 64;
      index.set([r, g, bl, a], h64 * 4);
    }
    out.set([r, g, bl, a], i * 4);
  }
  expect([...b.subarray(p, p + 8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  expect(b.length).toBe(p + 8);
  return { w, h, channels, rgba: out };
}

describe('QOI', () => {
  for (const kind of pics) {
    it(`round-trips ${kind} exactly`, () => {
      const src = makePicture(kind, 37, 21, 4);
      const d = decodeQoi(encodeQoi(src, 37, 21));
      expect([d.w, d.h, d.channels]).toEqual([37, 21, 4]);
      expect(d.rgba).toEqual(src);
    });
  }
  it('uses runs, index and diff ops: flat and pixel art are tiny', () => {
    const flat = new Uint8Array(100 * 100 * 4).fill(255);
    expect(encodeQoi(flat, 100, 100).length).toBeLessThan(14 + 8 + 5 + 4 * 160 + 1);
    const art = makePicture('pixelart', 64, 64);
    expect(encodeQoi(art, 64, 64).length).toBeLessThan(64 * 64 * 4 * 0.2);
  });
  it('3 channels composites over black', () => {
    const src = new Uint8Array([200, 100, 50, 128, 0, 0, 0, 255]);
    const d = decodeQoi(encodeQoi(src, 2, 1, { alpha: false }));
    expect(d.channels).toBe(3);
    expect([...d.rgba.subarray(0, 4)]).toEqual([100, 50, 25, 255]);
  });
  it('wraps differences like the reference (255 -> 0 is a +1 diff)', () => {
    const src = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
    expect(decodeQoi(encodeQoi(src, 3, 1)).rgba).toEqual(src);
  });
});

// ---------------------------------------------------------------- TGA
function decodeTga(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const type = b[2], w = v.getUint16(12, true), h = v.getUint16(14, true), bpp = b[16], desc = b[17];
  expect(bpp).toBe(32);
  expect(desc & 0x20).toBe(0x20);
  const out = new Uint8Array(w * h * 4);
  let p = 18;
  let i = 0;
  while (i < w * h) {
    if (type === 2) {
      out.set([b[p + 2], b[p + 1], b[p], b[p + 3]], i * 4);
      p += 4;
      i++;
    } else {
      const t = b[p++];
      const n = (t & 127) + 1;
      if (t & 128) {
        for (let k = 0; k < n; k++) out.set([b[p + 2], b[p + 1], b[p], b[p + 3]], (i + k) * 4);
        p += 4;
      } else {
        for (let k = 0; k < n; k++, p += 4) out.set([b[p + 2], b[p + 1], b[p], b[p + 3]], (i + k) * 4);
      }
      i += n;
    }
  }
  expect(String.fromCharCode(...b.subarray(b.length - 18, b.length - 2))).toBe('TRUEVISION-XFILE');
  return { w, h, rgba: out, type };
}

describe('TGA', () => {
  for (const rle of [false, true]) {
    for (const kind of pics) {
      it(`${rle ? 'RLE' : 'raw'} ${kind} round-trips`, () => {
        const src = makePicture(kind, 33, 17, 8);
        const d = decodeTga(encodeTga(src, 33, 17, { rle }));
        expect(d.type).toBe(rle ? 10 : 2);
        expect(d.rgba).toEqual(src);
      });
    }
  }
  it('RLE shrinks flat art and does not cross rows', () => {
    const art = makePicture('pixelart', 64, 64);
    expect(encodeTga(art, 64, 64, { rle: true }).length).toBeLessThan(encodeTga(art, 64, 64).length / 2);
    const d = decodeTga(encodeTga(new Uint8Array(5 * 3 * 4).fill(9), 5, 3, { rle: true }));
    expect(d.rgba.every((x) => x === 9)).toBe(true);
  });
});

// ---------------------------------------------------------------- BMP
function decodeBmp(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect(String.fromCharCode(b[0], b[1])).toBe('BM');
  expect(v.getUint32(2, true)).toBe(b.length);
  const off = v.getUint32(10, true);
  const hs = v.getUint32(14, true);
  const w = v.getUint32(18, true), h = v.getInt32(22, true), bits = v.getUint16(28, true);
  const bpp = bits / 8;
  const stride = Math.ceil((w * bpp) / 4) * 4;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = off + (h - 1 - y) * stride + x * bpp;
      out.set([b[s + 2], b[s + 1], b[s], bpp === 4 ? b[s + 3] : 255], (y * w + x) * 4);
    }
  }
  return { w, h, bits, hs, rgba: out, compression: v.getUint32(30, true) };
}

describe('BMP', () => {
  it('32-bit V5 with alpha round-trips (and odd widths need no padding)', () => {
    for (const kind of pics) {
      const src = makePicture(kind, 13, 7);
      const d = decodeBmp(encodeBmp(src, 13, 7));
      expect([d.bits, d.hs, d.compression]).toEqual([32, 124, 3]);
      expect(d.rgba).toEqual(src);
    }
  });
  it('24-bit rows are padded to 4 bytes and alpha is composited over the background', () => {
    const src = makePicture('alpha', 13, 5);
    const b = encodeBmp(src, 13, 5, { alpha: false, background: [255, 255, 255] });
    const d = decodeBmp(b);
    expect([d.bits, d.hs]).toEqual([24, 40]);
    expect(b.length).toBe(54 + Math.ceil((13 * 3) / 4) * 4 * 5);
    expect(d.rgba[3]).toBe(255);
    expect([...d.rgba.subarray(0, 3)]).toEqual([255, 255, 255]); // alpha 0 column over white
    const opaque = makePicture('gradient', 13, 5);
    expect(decodeBmp(encodeBmp(opaque, 13, 5, { alpha: false })).rgba).toEqual(opaque);
  });
});

// ---------------------------------------------------------------- PNM
describe('PPM and PAM', () => {
  it('P6 header and pixels', () => {
    const src = makePicture('gradient', 5, 4);
    const b = encodePnm(src, 5, 4);
    const head = 'P6\n5 4\n255\n';
    expect(new TextDecoder().decode(b.subarray(0, head.length))).toBe(head);
    expect(b.length).toBe(head.length + 60);
    expect(b[head.length]).toBe(src[0]);
  });
  it('P7 RGB_ALPHA keeps alpha', () => {
    const src = makePicture('alpha', 5, 4);
    const b = encodePnm(src, 5, 4, { alpha: true });
    const end = new TextDecoder('latin1').decode(b).indexOf('ENDHDR\n') + 7;
    expect(new TextDecoder().decode(b.subarray(0, end))).toContain('TUPLTYPE RGB_ALPHA');
    expect(b.subarray(end)).toEqual(src);
  });
});

// ---------------------------------------------------------------- ICO
function readPngRgba(png: Uint8Array) {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const w = v.getUint32(16), h = v.getUint32(20);
  let at = 8;
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const len = v.getUint32(at);
    if (String.fromCharCode(...png.subarray(at + 4, at + 8)) === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = unzlibSync(join(idat));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    expect(raw[y * (w * 4 + 1)]).toBe(0);
    out.set(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)), y * w * 4);
  }
  return { w, h, rgba: out };
}

describe('ICO', () => {
  it('has a directory with PNG entries for each size', () => {
    const src = makePicture('pixelart', 64, 64);
    const ico = encodeIco(src, 64, 64, { sizes: [16, 32, 256, 32] });
    const v = new DataView(ico.buffer);
    expect([v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true)]).toEqual([0, 1, 3]);
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      const e = 6 + i * 16;
      const size = ico[e] || 256;
      seen.push(size);
      expect(ico[e + 1] || 256).toBe(size);
      expect(v.getUint16(e + 6, true)).toBe(32);
      const off = v.getUint32(e + 12, true);
      const len = v.getUint32(e + 8, true);
      const png = ico.subarray(off, off + len);
      expect([...png.subarray(0, 4)]).toEqual([137, 80, 78, 71]);
      const d = readPngRgba(png);
      expect([d.w, d.h]).toEqual([size, size]);
    }
    expect(seen).toEqual([16, 32, 256]);
  });
  it('nearest scaling keeps pixel art colours exact and upscales whole pixels', () => {
    const src = makePicture('pixelart', 16, 16);
    const ico = encodeIco(src, 16, 16, { sizes: [32] });
    const v = new DataView(ico.buffer);
    const d = readPngRgba(ico.subarray(v.getUint32(18, true), v.getUint32(18, true) + v.getUint32(14, true)));
    expect([...d.rgba.subarray(0, 4)]).toEqual([...src.subarray(0, 4)]);
    expect([...d.rgba.subarray(4, 8)]).toEqual([...src.subarray(0, 4)]);
    expect([...d.rgba.subarray(32 * 4, 32 * 4 + 4)]).toEqual([...src.subarray(0, 4)]);
  });
  it('non-square pictures are centred in the square with transparent padding', () => {
    const src = makePicture('gradient', 32, 16);
    const ico = encodeIco(src, 32, 16, { sizes: [32] });
    const v = new DataView(ico.buffer);
    const d = readPngRgba(ico.subarray(v.getUint32(18, true), v.getUint32(18, true) + v.getUint32(14, true)));
    expect(d.rgba[3]).toBe(0);
    expect(d.rgba[(8 * 32) * 4 + 3]).toBe(255);
  });
  it('box scaling averages and rejects bad sizes', () => {
    const px = new Uint8Array([0, 0, 0, 255, 100, 100, 100, 255, 0, 0, 0, 255, 100, 100, 100, 255]);
    expect([...resizeRgba(px, 2, 2, 1, 1, 'box')]).toEqual([50, 50, 50, 255]);
    expect(() => encodeIco(px, 2, 2, { sizes: [300] })).toThrow();
  });
});

// ---------------------------------------------------------------- TIFF
interface Ifd {
  tags: Map<number, number[]>;
  next: number;
}
function readTiff(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect([b[0], b[1], v.getUint16(2, true)]).toEqual([0x49, 0x49, 42]);
  const pages: { w: number; h: number; ch: number; bits: number; rgba: Uint8Array | Uint16Array; tags: Map<number, number[]> }[] = [];
  let at = v.getUint32(4, true);
  while (at) {
    const n = v.getUint16(at, true);
    const tags = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const e = at + 2 + i * 12;
      const tag = v.getUint16(e, true), type = v.getUint16(e + 2, true), count = v.getUint32(e + 4, true);
      const size = { 3: 2, 4: 4, 5: 8 }[type as 3 | 4 | 5];
      const base = size * count <= 4 ? e + 8 : v.getUint32(e + 8, true);
      const vals: number[] = [];
      for (let k = 0; k < count; k++) vals.push(type === 3 ? v.getUint16(base + k * 2, true) : v.getUint32(base + k * size, true));
      tags.set(tag, vals);
    }
    const ifd: Ifd = { tags, next: v.getUint32(at + 2 + n * 12, true) };
    const w = tags.get(256)![0], h = tags.get(257)![0], ch = tags.get(277)![0], bits = tags.get(258)![0];
    const comp = tags.get(259)![0];
    const pred = tags.get(317)?.[0] ?? 1;
    const offs = tags.get(273)!, cnts = tags.get(279)!, rps = tags.get(278)![0];
    const stride = w * ch * (bits / 8);
    const raw = new Uint8Array(stride * h);
    offs.forEach((o, i) => {
      let strip = b.subarray(o, o + cnts[i]);
      if (comp === 8) strip = unzlibSync(strip);
      else expect(comp).toBe(1);
      raw.set(strip, i * rps * stride);
    });
    if (pred === 2) {
      for (let y = 0; y < h; y++) {
        if (bits === 8) for (let i = ch; i < stride; i++) raw[y * stride + i] = (raw[y * stride + i] + raw[y * stride + i - ch]) & 255;
        else {
          const dv = new DataView(raw.buffer, y * stride, stride);
          for (let i = ch; i < w * ch; i++) dv.setUint16(i * 2, (dv.getUint16(i * 2, true) + dv.getUint16((i - ch) * 2, true)) & 0xffff, true);
        }
      }
    }
    let rgba: Uint8Array | Uint16Array = raw;
    if (bits === 16) {
      const u = new Uint16Array(w * h * ch);
      const dv = new DataView(raw.buffer);
      for (let i = 0; i < u.length; i++) u[i] = dv.getUint16(i * 2, true);
      rgba = u;
    }
    pages.push({ w, h, ch, bits, rgba, tags });
    at = ifd.next;
  }
  return pages;
}

describe('TIFF', () => {
  for (const compression of ['none', 'deflate'] as const) {
    it(`8-bit RGBA ${compression}: round trip, ExtraSamples = unassociated alpha, multiple strips`, () => {
      const src = makePicture('alpha', 300, 200);
      const [p] = readTiff(encodeTiff(src, 300, 200, { compression }));
      expect([p.w, p.h, p.ch, p.bits]).toEqual([300, 200, 4, 8]);
      expect(p.tags.get(338)).toEqual([2]);
      expect(p.tags.get(262)).toEqual([2]);
      expect(p.tags.get(273)!.length).toBeGreaterThan(1);
      expect(p.rgba).toEqual(src);
    });
    it(`16-bit RGBA ${compression}: round trip`, () => {
      const r = rng(5);
      const src = Uint16Array.from({ length: 31 * 17 * 4 }, (_, i) => (i % 4 === 3 ? 65535 : Math.floor(r() * 65536)));
      const [p] = readTiff(encodeTiff(src, 31, 17, { compression }));
      expect(p.bits).toBe(16);
      expect(p.tags.get(339)).toEqual([1, 1, 1, 1]);
      expect(p.rgba).toEqual(src);
    });
  }
  it('deflate with predictor shrinks smooth pictures', () => {
    const src = makePicture('gradient', 128, 128);
    expect(encodeTiff(src, 128, 128, { compression: 'deflate' }).length).toBeLessThan(encodeTiff(src, 128, 128).length / 4);
  });
  it('RGB only, resolution tags and multi-page files', () => {
    const a = makePicture('gradient', 10, 8);
    const b = makePicture('edges', 12, 6);
    const pages = readTiff(encodeTiffPages([{ width: 10, height: 8, data: a }, { width: 12, height: 6, data: b }], { alpha: false, dpi: 144 }));
    expect(pages).toHaveLength(2);
    expect(pages[0].ch).toBe(3);
    expect(pages[0].tags.has(338)).toBe(false);
    expect(pages[0].tags.has(282)).toBe(true);
    const rgb = (src: Uint8Array) => Uint8Array.from({ length: (src.length / 4) * 3 }, (_, i) => src[((i / 3) | 0) * 4 + (i % 3)]);
    expect(pages[0].rgba).toEqual(rgb(a));
    expect(pages[1].rgba).toEqual(rgb(b));
  });
});

// ---------------------------------------------------------------- float formats
describe('half floats', () => {
  it('round-trips representable values and rounds like IEEE', () => {
    for (const v of [0, 1, -1, 0.5, 65504, 2 ** -14, 2 ** -24, -3.140625, Infinity]) expect(halfToFloat(floatToHalf(v))).toBe(v);
    expect(floatToHalf(1)).toBe(0x3c00);
    expect(floatToHalf(-2)).toBe(0xc000);
    expect(floatToHalf(1e6)).toBe(0x7c00);
    expect(floatToHalf(1 + 2 ** -11)).toBe(0x3c00); // ties to even
    expect(floatToHalf(1 + 3 * 2 ** -11)).toBe(0x3c02);
    expect(Number.isNaN(halfToFloat(floatToHalf(NaN)))).toBe(true);
  });
});

function decodeHdr(b: Uint8Array) {
  const text = new TextDecoder('latin1').decode(b.subarray(0, 120));
  expect(text.startsWith('#?RADIANCE\n')).toBe(true);
  const m = /-Y (\d+) \+X (\d+)\n/.exec(text)!;
  const h = +m[1], w = +m[2];
  let p = m.index + m[0].length;
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const row = new Uint8Array(w * 4);
    if (w >= 8 && b[p] === 2 && b[p + 1] === 2) {
      expect((b[p + 2] << 8) | b[p + 3]).toBe(w);
      p += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < w) {
          const n = b[p++];
          if (n > 128) {
            const val = b[p++];
            for (let k = 0; k < n - 128; k++) row[(x + k) * 4 + c] = val;
            x += n - 128;
          } else {
            for (let k = 0; k < n; k++) row[(x + k) * 4 + c] = b[p++];
            x += n;
          }
        }
      }
    } else {
      row.set(b.subarray(p, p + w * 4));
      p += w * 4;
    }
    for (let x = 0; x < w; x++) {
      const e = row[x * 4 + 3];
      const f = e === 0 ? 0 : 2 ** (e - 136);
      for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = (row[x * 4 + c] + 0.5) * f * (e === 0 ? 0 : 1);
    }
  }
  expect(p).toBe(b.length);
  return { w, h, rgb: out };
}

describe('Radiance HDR', () => {
  it('values come back within RGBE precision, for RLE and narrow rows', () => {
    for (const w of [5, 64]) {
      const h = 6;
      const r = rng(2);
      const px = new Float32Array(w * h * 4);
      for (let i = 0; i < px.length; i += 4) {
        const s = 10 ** (r() * 6 - 3);
        px.set([r() * s, r() * s, r() * s, 1], i);
      }
      px.fill(0, 0, 4 * w); // black first row exercises the zero exponent
      px.fill(0.25, 4 * w, 8 * w); // a flat row exercises runs
      const d = decodeHdr(encodeHdr(px, w, h));
      for (let i = 0; i < w * h; i++) {
        const mx = Math.max(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
        for (let c = 0; c < 3; c++) expect(Math.abs(d.rgb[i * 3 + c] - px[i * 4 + c])).toBeLessThanOrEqual(mx / 128 + 1e-12);
      }
    }
  });
  it('accepts half-float input', () => {
    const half = Uint16Array.from([floatToHalf(2), floatToHalf(1), floatToHalf(0.5), floatToHalf(1)]);
    const d = decodeHdr(encodeHdr(half, 1, 1));
    expect(d.rgb[0]).toBeCloseTo(2, 1);
  });
});

function readExr(b: Uint8Array) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect([b[0], b[1], b[2], b[3], v.getUint32(4, true)]).toEqual([0x76, 0x2f, 0x31, 0x01, 2]);
  let p = 8;
  const attrs = new Map<string, { type: string; at: number; size: number }>();
  while (b[p] !== 0) {
    let e = p;
    while (b[e] !== 0) e++;
    const name = String.fromCharCode(...b.subarray(p, e));
    let t = e + 1;
    while (b[t] !== 0) t++;
    const type = String.fromCharCode(...b.subarray(e + 1, t));
    const size = v.getUint32(t + 1, true);
    attrs.set(name, { type, at: t + 5, size });
    p = t + 5 + size;
  }
  p++;
  const dw = attrs.get('dataWindow')!.at;
  const w = v.getInt32(dw + 8, true) + 1, h = v.getInt32(dw + 12, true) + 1;
  const comp = b[attrs.get('compression')!.at];
  const lines = comp === 3 ? 16 : 1;
  const nBlocks = Math.ceil(h / lines);
  const out = new Uint16Array(w * h * 4);
  for (let i = 0; i < nBlocks; i++) {
    const off = Number(v.getBigUint64(p + i * 8, true));
    const y0 = v.getInt32(off, true);
    const size = v.getUint32(off + 4, true);
    expect(y0).toBe(i * lines);
    const n = Math.min(lines, h - y0);
    const expected = n * 4 * w * 2;
    let data = b.subarray(off + 8, off + 8 + size);
    if (comp === 3 && size < expected) {
      const t = unzlibSync(data);
      for (let k = 1; k < t.length; k++) t[k] = (t[k - 1] + t[k] - 128) & 255;
      const half = (t.length + 1) >> 1;
      const un = new Uint8Array(t.length);
      for (let k = 0; k < t.length; k++) un[k] = k % 2 === 0 ? t[k >> 1] : t[half + (k >> 1)];
      data = un;
    }
    expect(data.length).toBe(expected);
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let l = 0; l < n; l++) for (let c = 0; c < 4; c++) for (let x = 0; x < w; x++) out[((y0 + l) * w + x) * 4 + (3 - c)] = dv.getUint16((l * 4 + c) * w * 2 + x * 2, true);
  }
  return { w, h, comp, half: out, attrs };
}

describe('OpenEXR', () => {
  for (const compression of ['none', 'zip'] as const) {
    it(`${compression}: half RGBA round trip incl. partial last block`, () => {
      const w = 37, h = 35; // 35 lines: 16 + 16 + 3
      const r = rng(6);
      const px = new Float32Array(w * h * 4);
      for (let i = 0; i < px.length; i++) px[i] = (r() - 0.2) * 40;
      for (let i = 0; i < 4 * w * 20; i++) px[i] = 0.5; // compressible area
      const e = readExr(encodeExr(px, w, h, { compression }));
      expect([e.w, e.h, e.comp]).toEqual([w, h, compression === 'zip' ? 3 : 0]);
      for (let i = 0; i < px.length; i++) expect(e.half[i]).toBe(floatToHalf(px[i]));
      for (const name of ['channels', 'compression', 'dataWindow', 'displayWindow', 'lineOrder', 'pixelAspectRatio', 'screenWindowCenter', 'screenWindowWidth']) expect(e.attrs.has(name)).toBe(true);
    });
  }
  it('raw half input is written bit for bit and zip is smaller on smooth data', () => {
    const w = 64, h = 64;
    const half = new Uint16Array(w * h * 4);
    for (let i = 0; i < half.length; i++) half[i] = floatToHalf(((i >> 2) % w) / w);
    const z = encodeExr(half, w, h, { compression: 'zip' });
    expect(readExr(z).half).toEqual(half);
    expect(z.length).toBeLessThan(encodeExr(half, w, h, { compression: 'none' }).length);
  });
});

// ---------------------------------------------------------------- AIFF
describe('AIFF', () => {
  it('80-bit extended sample rates', () => {
    expect([...extended80(44100)]).toEqual([0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0]);
    expect([...extended80(48000)]).toEqual([0x40, 0x0e, 0xbb, 0x80, 0, 0, 0, 0, 0, 0]);
  });
  for (const bits of [16, 24] as const) {
    it(`${bits}-bit stereo: chunks, sizes and samples`, () => {
      const n = 101;
      const l = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.9);
      const rr = Float32Array.from({ length: n }, (_, i) => (i % 2 ? 1 : -1));
      const b = encodeAiff({ sampleRate: 48000, channels: [l, rr] }, bits);
      const v = new DataView(b.buffer);
      expect(String.fromCharCode(...b.subarray(0, 4))).toBe('FORM');
      expect(v.getUint32(4)).toBe(b.length - 8);
      expect(String.fromCharCode(...b.subarray(8, 12))).toBe('AIFF');
      expect(String.fromCharCode(...b.subarray(12, 16))).toBe('COMM');
      expect([v.getUint16(20), v.getUint32(22), v.getUint16(26)]).toEqual([2, n, bits]);
      expect(String.fromCharCode(...b.subarray(38, 42))).toBe('SSND');
      const data = 54;
      const bps = bits / 8;
      expect(v.getUint32(42)).toBe(8 + n * 2 * bps);
      const sample = (i: number, c: number) => {
        const o = data + (i * 2 + c) * bps;
        return bits === 16 ? v.getInt16(o) / 32768 : ((v.getInt8(o) << 16) | (b[o + 1] << 8) | b[o + 2]) / 8388608;
      };
      for (let i = 0; i < n; i++) {
        expect(Math.abs(sample(i, 0) - l[i])).toBeLessThan(1 / (bits === 16 ? 16000 : 4000000));
        expect(Math.abs(sample(i, 1) - rr[i])).toBeLessThan(1e-4);
      }
    });
  }
  it('pads odd chunks to even length', () => {
    const b = encodeAiff({ sampleRate: 44100, channels: [new Float32Array(3)] }, 24);
    expect(b.length % 2).toBe(0);
    expect(new DataView(b.buffer).getUint32(4)).toBe(b.length - 8);
  });
});
