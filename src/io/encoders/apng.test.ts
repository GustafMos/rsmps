import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { beginApng } from './apng';
import { join, makePicture } from './test-helpers';
import { crc32 } from './util';

interface Chunk {
  type: string;
  data: Uint8Array;
}

export function readChunks(png: Uint8Array): Chunk[] {
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Chunk[] = [];
  let at = 8;
  while (at < png.length) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    expect(v.getUint32(at + 8 + len), `crc of ${type}`).toBe(crc32(png, at + 4, at + 8 + len));
    out.push({ type, data: png.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
  }
  return out;
}

function unfilter(raw: Uint8Array, w: number, h: number, bpp: number): Uint8Array {
  const stride = w * bpp;
  const out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i];
      const a = i >= bpp ? out[y * stride + i - bpp] : 0;
      const b = y ? out[(y - 1) * stride + i] : 0;
      const c = y && i >= bpp ? out[(y - 1) * stride + i - bpp] : 0;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = (x + p) & 255;
    }
  }
  return out;
}

/** Independent APNG reader: returns the composed canvas after each frame and the timing. */
export function readApng(file: Uint8Array) {
  const chunks = readChunks(file);
  const ihdr = new DataView(chunks[0].data.buffer, chunks[0].data.byteOffset, 13);
  const w = ihdr.getUint32(0), h = ihdr.getUint32(4), colorType = chunks[0].data[9];
  const plte = chunks.find((c) => c.type === 'PLTE')?.data;
  const trns = chunks.find((c) => c.type === 'tRNS')?.data;
  const actl = chunks.find((c) => c.type === 'acTL');
  expect(actl).toBeTruthy();
  const av = new DataView(actl!.data.buffer, actl!.data.byteOffset, 8);
  const numFrames = av.getUint32(0);
  const numPlays = av.getUint32(4);
  // chunk order: acTL before the first IDAT; fcTL before its data
  expect(chunks.findIndex((c) => c.type === 'acTL')).toBeLessThan(chunks.findIndex((c) => c.type === 'IDAT'));
  let seq = 0;
  const frames: { fctl: { w: number; h: number; x: number; y: number; num: number; den: number; dispose: number; blend: number }; z: Uint8Array[] }[] = [];
  for (const c of chunks) {
    const v = new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);
    if (c.type === 'fcTL') {
      expect(v.getUint32(0)).toBe(seq++);
      frames.push({ fctl: { w: v.getUint32(4), h: v.getUint32(8), x: v.getUint32(12), y: v.getUint32(16), num: v.getUint16(20), den: v.getUint16(22), dispose: c.data[24], blend: c.data[25] }, z: [] });
    } else if (c.type === 'IDAT') frames[frames.length - 1].z.push(c.data);
    else if (c.type === 'fdAT') {
      expect(v.getUint32(0)).toBe(seq++);
      frames[frames.length - 1].z.push(c.data.subarray(4));
    }
  }
  expect(frames).toHaveLength(numFrames);
  expect(chunks[chunks.length - 1].type).toBe('IEND');
  const canvas = new Uint8Array(w * h * 4);
  const shown: Uint8Array[] = [];
  for (const f of frames) {
    const { fctl } = f;
    const bpp = colorType === 3 ? 1 : 4;
    const px = unfilter(unzlibSync(join(f.z)), fctl.w, fctl.h, bpp);
    const before = canvas.slice();
    for (let y = 0; y < fctl.h; y++) {
      for (let x = 0; x < fctl.w; x++) {
        let r: number, g: number, b: number, a: number;
        if (colorType === 3) {
          const i = px[y * fctl.w + x];
          [r, g, b] = [plte![i * 3], plte![i * 3 + 1], plte![i * 3 + 2]];
          a = trns && i < trns.length ? trns[i] : 255;
        } else [r, g, b, a] = px.subarray((y * fctl.w + x) * 4, (y * fctl.w + x) * 4 + 4);
        const o = ((fctl.y + y) * w + fctl.x + x) * 4;
        if (fctl.blend === 0 || a === 255) canvas.set([r, g, b, a], o);
        else if (a > 0) {
          const ba = canvas[o + 3] / 255;
          const sa = a / 255;
          const oa = sa + ba * (1 - sa);
          for (let c = 0; c < 3; c++) canvas[o + c] = Math.round(([r, g, b][c] * sa + canvas[o + c] * ba * (1 - sa)) / oa);
          canvas[o + 3] = Math.round(oa * 255);
        }
      }
    }
    shown.push(canvas.slice());
    if (fctl.dispose === 1) for (let y = 0; y < fctl.h; y++) canvas.fill(0, ((fctl.y + y) * w + fctl.x) * 4, ((fctl.y + y) * w + fctl.x + fctl.w) * 4);
    else if (fctl.dispose === 2) canvas.set(before);
  }
  return { w, h, colorType, numPlays, frames: frames.map((f) => f.fctl), shown, chunks };
}

const run = async (pics: Uint8Array[], w: number, h: number, o: object = {}) => {
  const s = beginApng({ width: w, height: h, fps: 25, ...o });
  for (const p of pics) s.addFrame(p);
  return join(await s.finish());
};

describe('APNG encoder', () => {
  const w = 24;
  const h = 16;
  it('structure: acTL, sequence numbers, IDAT for frame 0, CRCs, loop count, exact delay fractions', async () => {
    const pics = [makePicture('gradient', w, h), makePicture('noise', w, h), makePicture('edges', w, h)];
    const a = readApng(await run(pics, w, h, { fps: 29.97, loop: 4 }));
    expect(a.numPlays).toBe(4);
    expect(a.frames).toHaveLength(3);
    expect(a.frames.every((f) => f.num === 1001 && f.den === 30000)).toBe(true);
    expect(a.chunks.filter((c) => c.type === 'IDAT')).toHaveLength(1);
    expect(a.chunks.filter((c) => c.type === 'fdAT')).toHaveLength(2);
    expect(a.colorType).toBe(6);
  });

  it('round trip is lossless, including differencing with both blend modes', async () => {
    const base = makePicture('pixelart', w, h);
    const f2 = base.slice();
    for (let y = 4; y < 8; y++) for (let x = 6; x < 12; x++) f2.set([255, 0, 255, 255], (y * w + x) * 4); // opaque change: OVER eligible
    const f3 = f2.slice();
    f3.set([10, 20, 30, 90], (5 * w + 7) * 4); // semi-transparent change: must use SOURCE
    const f4 = f3.slice();
    f4.fill(0, 0, 4); // pixel becomes fully transparent
    const pics = [base, f2, f3, f4, makePicture('alpha', w, h)];
    const a = readApng(await run(pics, w, h));
    a.shown.forEach((s, i) => expect(s, `frame ${i}`).toEqual(pics[i]));
    expect(a.frames[1]).toMatchObject({ x: 6, y: 4, w: 6, h: 4 });
    expect(a.frames[2]).toMatchObject({ x: 7, y: 5, w: 1, h: 1, blend: 0 });
    expect(a.frames[0]).toMatchObject({ x: 0, y: 0, w, h });
  });

  it('merges identical frames into one longer delay', async () => {
    const p = makePicture('pixelart', w, h);
    const a = readApng(await run([p, p, p, makePicture('edges', w, h)], w, h, { fps: 10 }));
    expect(a.frames).toHaveLength(2);
    expect(a.frames[0].num / a.frames[0].den).toBeCloseTo(0.3, 10);
    expect(a.frames[1].num / a.frames[1].den).toBeCloseTo(0.1, 10);
  });

  it('palette mode with transparency is lossless and smaller', async () => {
    const pics = [makePicture('pixelart', w, h), makePicture('edges', w, h)];
    pics[1][3] = 77;
    const rgba = await run(pics, w, h, { diff: false });
    const pal = await run(pics, w, h, { diff: false, mode: 'palette' });
    const a = readApng(pal);
    expect(a.colorType).toBe(3);
    a.shown.forEach((s, i) => expect(s).toEqual(pics[i]));
    expect(pal.length).toBeLessThan(rgba.length);
    expect(readApng(await run(pics, w, h, { mode: 'auto' })).colorType).toBe(3);
    const many = [makePicture('noise', w, h)];
    expect(readApng(await run(many, w, h, { mode: 'auto' })).colorType).toBe(6);
    await expect(run(many, w, h, { mode: 'palette' })).rejects.toThrow(/256/);
  });

  it('frame 0 alone is a valid PNG (ancillary APNG chunks removed)', async () => {
    const p = makePicture('gradient', w, h);
    const a = readApng(await run([p, makePicture('edges', w, h)], w, h));
    const keep = a.chunks.filter((c) => ['IHDR', 'IDAT', 'IEND'].includes(c.type));
    const raw = unzlibSync(join(keep.filter((c) => c.type === 'IDAT').map((c) => c.data)));
    expect(unfilter(raw, w, h, 4)).toEqual(p);
  });

  it('uses adaptive filters (smooth content compresses better than filter 0 alone)', async () => {
    const p = makePicture('gradient', 128, 96);
    const file = await run([p], 128, 96);
    expect(file.length).toBeLessThan(128 * 96 * 4 * 0.2);
  });
});
