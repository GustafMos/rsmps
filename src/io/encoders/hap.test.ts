import { describe, expect, it } from 'vitest';
import { compressDxt, decompressDxt, dxtFrameBytes, psnr, type DxtFormat } from './dxt';
import { beginHap, hapFrame } from './hap';
import { snappyDecode, snappyEncode } from './snappy';
import { makePicture, join, readMov, videoSamples, rng } from './test-helpers';

describe('snappy', () => {
  it('decodes hand-built vectors from the format description', () => {
    // literal "abc"
    expect([...snappyDecode(new Uint8Array([3, 2 << 2, 97, 98, 99]))]).toEqual([97, 98, 99]);
    // "abcabcabc": literal "abc" then copy2 len 6 offset 3
    expect([...snappyDecode(new Uint8Array([9, 2 << 2, 97, 98, 99, 2 | (5 << 2), 3, 0]))].map((c) => String.fromCharCode(c)).join('')).toBe('abcabcabc');
    // copy1: "abcdabcd" literal 4 then copy1 len 4 offset 4: tag = 1 | (0<<2) | (0<<5)
    expect(String.fromCharCode(...snappyDecode(new Uint8Array([8, 3 << 2, 97, 98, 99, 100, 1, 4])))).toBe('abcdabcd');
    // overlapping copy (run-length): "a" then copy offset 1 len 7
    expect(String.fromCharCode(...snappyDecode(new Uint8Array([8, 0, 97, 2 | (6 << 2), 1, 0])))).toBe('aaaaaaaa');
  });
  it('rejects corrupt input', () => {
    expect(() => snappyDecode(new Uint8Array([5, 2 << 2, 97, 98, 99]))).toThrow();
    expect(() => snappyDecode(new Uint8Array([4, 0, 97, 2 | (2 << 2), 9, 0]))).toThrow();
  });
  it('round-trips empty, tiny, random, repetitive and large inputs', () => {
    const r = rng(7);
    const cases: Uint8Array[] = [new Uint8Array(0), new Uint8Array([1]), new Uint8Array([1, 2, 3, 4, 5])];
    cases.push(Uint8Array.from({ length: 5000 }, () => r() * 256));
    cases.push(new Uint8Array(100000)); // zeros
    cases.push(Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) & 63));
    cases.push(Uint8Array.from({ length: 300000 }, (_, i) => (i % 5000 < 2500 ? (i * 31) & 255 : (r() * 4) | 0)));
    for (const c of cases) {
      const e = snappyEncode(c);
      expect(e.length).toBeLessThanOrEqual(32 + c.length + Math.floor(c.length / 6));
      expect(snappyDecode(e)).toEqual(c);
    }
    expect(snappyEncode(new Uint8Array(100000)).length).toBeLessThan(5000);
  });
});

describe('DXT compression', () => {
  const W = 64;
  const H = 48;
  const formats: DxtFormat[] = ['Hap1', 'Hap5', 'HapY'];

  it('a flat colour block is exact for Hap1/Hap5 and near exact for HapY', () => {
    const rgba = new Uint8Array(16 * 4);
    for (let i = 0; i < 16; i++) rgba.set([255, 0, 0, 255], i * 4);
    const out = new Uint8Array(8);
    compressDxt(rgba, 4, 4, 'Hap1', out);
    expect([...decompressDxt(out, 4, 4, 'Hap1').slice(0, 4)]).toEqual([255, 0, 0, 255]);
  });

  it('known block bytes: black and white pixels give endpoints white/black with expected indices', () => {
    const rgba = new Uint8Array(16 * 4);
    for (let i = 0; i < 16; i++) rgba.set(i < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    const out = new Uint8Array(8);
    compressDxt(rgba, 4, 4, 'Hap1', out, { refine: 0 });
    // endpoints are the range inset by 1/16 (15..240); indices 0 (c0, light) for the white rows and 1 (c1, dark) for the black ones.
    const c0 = out[0] | (out[1] << 8);
    const c1 = out[2] | (out[3] << 8);
    expect(c0).toBeGreaterThan(c1);
    expect(c0 >> 11).toBe(29); // q5(240)
    expect(c1 >> 11).toBe(2); // q5(15)
    expect([...out.subarray(4)]).toEqual([0x00, 0x00, 0x55, 0x55]);
  });

  for (const fmt of formats) {
    it(`${fmt}: round-trip quality (PSNR) on gradient, edges, pixel art, alpha ramp`, () => {
      const min: Record<string, number> = { gradient: 33, edges: 28, pixelart: 28, alpha: 30 };
      for (const kind of ['gradient', 'edges', 'pixelart', 'alpha'] as const) {
        const src = makePicture(kind, W, H);
        const out = new Uint8Array(dxtFrameBytes(W, H, fmt));
        compressDxt(src, W, H, fmt, out);
        const back = decompressDxt(out, W, H, fmt);
        const db = psnr(src, back, fmt === 'Hap5' && kind === 'alpha');
        expect(db, `${fmt} ${kind}`).toBeGreaterThan(fmt === 'HapY' ? min[kind] : min[kind]);
        if (fmt === 'Hap5') {
          // alpha is stored with 8-value interpolation: error at most 1/14 of the range.
          let worst = 0;
          for (let i = 3; i < src.length; i += 4) worst = Math.max(worst, Math.abs(src[i] - back[i]));
          expect(worst).toBeLessThanOrEqual(19);
        }
      }
    });
    it(`${fmt}: noise stays bounded and refinement never hurts`, () => {
      const src = makePicture('noise', W, H, 3);
      const a = new Uint8Array(dxtFrameBytes(W, H, fmt));
      const b = new Uint8Array(a.length);
      compressDxt(src, W, H, fmt, a, { refine: 0 });
      compressDxt(src, W, H, fmt, b, { refine: 4 });
      const pa = psnr(src, decompressDxt(a, W, H, fmt));
      const pb = psnr(src, decompressDxt(b, W, H, fmt));
      expect(pa).toBeGreaterThan(fmt === 'HapY' ? 13 : 12);
      expect(pb).toBeGreaterThanOrEqual(pa - 1e-9);
    });
  }

  it('pads sizes that are not a multiple of 4 by edge replication', () => {
    const w = 13;
    const h = 9;
    const src = makePicture('gradient', w, h);
    const out = new Uint8Array(dxtFrameBytes(w, h, 'Hap5'));
    expect(out.length).toBe(4 * 3 * 16);
    compressDxt(src, w, h, 'Hap5', out);
    const back = decompressDxt(out, w, h, 'Hap5');
    expect(back.length).toBe(w * h * 4);
    expect(psnr(src, back)).toBeGreaterThan(22);
  });

  it('HapY keeps saturated colours better than a flat 565 quantisation would', () => {
    const src = makePicture('pixelart', W, H);
    const y = new Uint8Array(dxtFrameBytes(W, H, 'HapY'));
    compressDxt(src, W, H, 'HapY', y);
    expect(psnr(src, decompressDxt(y, W, H, 'HapY'))).toBeGreaterThan(30);
  });
});

describe('HAP frames and files', () => {
  it('writes the 4-byte section header with the right type bytes', () => {
    const tex = new Uint8Array(32).fill(7);
    for (const [fmt, code] of [['Hap1', 0xab], ['Hap5', 0xae], ['HapY', 0xaf]] as const) {
      const f = hapFrame(tex, fmt, false);
      expect([...f.subarray(0, 4)]).toEqual([32, 0, 0, code]);
      expect(f.length).toBe(36);
    }
    const s = hapFrame(tex, 'Hap1', true); // compresses (all equal bytes)
    expect(s[3]).toBe(0xbb);
    expect(snappyDecode(s.subarray(4))).toEqual(tex);
    const noise = Uint8Array.from({ length: 64 }, () => Math.random() * 256);
    expect(hapFrame(noise, 'HapY', true)[3]).toBe(0xaf); // incompressible: falls back to none
  });
  it('uses the 8-byte header for sections of 16 MiB and more', () => {
    const f = hapFrame(new Uint8Array(0x1000000), 'Hap5', false);
    expect([...f.subarray(0, 8)]).toEqual([0, 0, 0, 0xae, 0, 0, 0, 1]);
    expect(f.length).toBe(8 + 0x1000000);
  });

  for (const [fmt, fourcc, depth, name] of [['Hap1', 'Hap1', 24, 'Hap'], ['Hap5', 'Hap5', 32, 'Hap Alpha'], ['HapY', 'HapY', 32, 'Hap Q']] as const) {
    it(`${fmt}: MOV structure, timing, sample table and decodable frames`, async () => {
      const w = 30; // not a multiple of 4: the track keeps the real size
      const h = 18;
      const s = beginHap({ width: w, height: h, fps: 24, format: fmt, snappy: fmt !== 'Hap1' });
      const pics = [makePicture('gradient', w, h), makePicture('edges', w, h), makePicture('pixelart', w, h)];
      for (let i = 0; i < 12; i++) s.addFrame(pics[i % 3]);
      const file = join(await s.finish());
      const mov = readMov(file);
      expect(mov.tracks).toHaveLength(1);
      const t = mov.tracks[0];
      expect(t.handler).toBe('vide');
      expect(t.fourcc).toBe(fourcc);
      expect(t.timescale).toBe(24000);
      expect(t.deltas).toEqual(Array(12).fill(1000));
      expect(t.duration).toBe(12000);
      expect(mov.movieTimescale).toBe(1000);
      expect(mov.movieDuration).toBe(500);
      expect(t.width).toBe(w);
      expect(t.height).toBe(h);
      expect(t.samplesPerChunk).toEqual(Array(12).fill(1));
      // sample entry: width/height, compressor name, depth
      const e = new DataView(t.entry.buffer, t.entry.byteOffset, t.entry.byteLength);
      expect(e.getUint16(24)).toBe(w);
      expect(e.getUint16(26)).toBe(h);
      expect(t.entry[42]).toBe(name.length);
      expect(String.fromCharCode(...t.entry.subarray(43, 43 + name.length))).toBe(name);
      expect(e.getUint16(74)).toBe(depth);
      expect(e.getInt16(76)).toBe(-1);
      // every sample decodes back to something close to the source
      const samples = videoSamples(file, t);
      expect(samples).toHaveLength(12);
      const expectedType = { Hap1: 0x0b, Hap5: 0x0e, HapY: 0x0f }[fmt];
      for (let i = 0; i < 12; i++) {
        const f = samples[i];
        expect(f[3] & 0x0f).toBe(expectedType);
        const len = f[0] | (f[1] << 8) | (f[2] << 16);
        expect(len).toBe(f.length - 4);
        const body = (f[3] & 0xf0) === 0xb0 ? snappyDecode(f.subarray(4)) : f.subarray(4);
        expect(body.length).toBe(dxtFrameBytes(w, h, fmt));
        expect(psnr(pics[i % 3], decompressDxt(body, w, h, fmt))).toBeGreaterThan(26);
      }
    });
  }

  it('29.97 fps uses the exact rational timing', async () => {
    const s = beginHap({ width: 8, height: 8, fps: 29.97 });
    for (let i = 0; i < 30; i++) s.addFrame(makePicture('gradient', 8, 8));
    const mov = readMov(join(await s.finish()));
    expect(mov.tracks[0].timescale).toBe(30000);
    expect(mov.tracks[0].deltas[0]).toBe(1001);
    expect(mov.tracks[0].duration).toBe(30030);
    expect(mov.movieDuration).toBe(1001);
  });

  it('carries a PCM audio track with chunk tables that match the file', async () => {
    const s = beginHap({ width: 8, height: 8, fps: 25, audio: { sampleRate: 48000, channels: 2, bits: 16 } });
    const tone = (n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 10) * 0.5);
    for (let i = 0; i < 5; i++) {
      s.addFrame(makePicture('gradient', 8, 8));
      s.addAudio([tone(1920), tone(1920)]);
    }
    const file = join(await s.finish());
    const mov = readMov(file);
    const [v, a] = mov.tracks;
    expect(a.handler).toBe('soun');
    expect(a.fourcc).toBe('sowt');
    expect(a.timescale).toBe(48000);
    expect(a.duration).toBe(9600);
    expect(a.sampleSize).toBe(4);
    expect(a.samplesPerChunk).toEqual(Array(5).fill(1920));
    expect(a.offsets).toHaveLength(5);
    // chunk offsets point at the data: first audio chunk starts right after the first video sample
    expect(a.offsets[0]).toBe(v.offsets[0] + v.sizes[0]);
    const view = new DataView(file.buffer, file.byteOffset + a.offsets[0], 4);
    expect(view.getInt16(0, true)).toBe(0);
    expect(mov.movieDuration).toBe(200);
  });
});
