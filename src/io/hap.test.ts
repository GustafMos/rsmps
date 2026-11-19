import { describe, expect, it } from 'vitest';
import { compressDxt, decompressDxt, dxtFrameBytes } from './encoders/dxt';
import { hapFrame } from './encoders/hap';
import { createMovMuxer } from './encoders/mov';
import { snappyDecode, snappyDecodeInto, snappyEncode, snappyLength } from './encoders/snappy';
import { join, makePicture } from './encoders/test-helpers';
import { hapName, hapTextureBytes, hapToRgba, parseHapFrame, type HapFrame } from './hap';
import { HAP_FFMPEG, ffmpegDecode, hapSamples, makeHapClip, pictureDiff } from './hap-test-helpers';

const W = 64;
const H = 48;

/** A section header as the HAP specification writes it: short form, or the long form when asked. */
function sec(type: number, body: Uint8Array, long = false): Uint8Array {
  const out = new Uint8Array((long ? 8 : 4) + body.length);
  if (long) {
    out[3] = type;
    new DataView(out.buffer).setUint32(4, body.length, true);
  } else {
    out[0] = body.length & 255;
    out[1] = (body.length >> 8) & 255;
    out[2] = (body.length >> 16) & 255;
    out[3] = type;
  }
  out.set(body, out.length - body.length);
  return out;
}
const u32s = (v: number[]): Uint8Array => new Uint8Array(new Uint32Array(v).buffer);

describe('HAP frame container', () => {
  const blocks = new Uint8Array(dxtFrameBytes(W, H, 'Hap5'));
  compressDxt(makePicture('alpha', W, H), W, H, 'Hap5', blocks);

  it('names the HAP family and nothing else', () => {
    expect(hapName('Hap1')).toBe('HAP');
    expect(hapName('Hap5')).toBe('HAP Alpha');
    expect(hapName('HapY')).toBe('HAP Q');
    expect(hapName('HapM')).toBe('HAP Q Alpha');
    for (const other of ['avc1', 'hap1', 'toString', null, 7, undefined]) expect(hapName(other)).toBeNull();
  });

  it('reads plain and Snappy frames, with the short and the long header', () => {
    for (const snappy of [false, true]) {
      const f = parseHapFrame(hapFrame(blocks, 'Hap5', snappy), { width: W, height: H });
      expect(f.format).toBe('bc3');
      expect(f.data).toEqual(blocks);
    }
    const long = parseHapFrame(sec(0xae, blocks, true));
    expect(long.data).toEqual(blocks);
    expect(parseHapFrame(sec(0xbb, snappyEncode(blocks), true)).format).toBe('bc1');
    expect(parseHapFrame(sec(0xaf, blocks)).format).toBe('ycocg-bc3');
    expect(parseHapFrame(sec(0xac, blocks)).format).toBe('bc7');
  });

  it('reads chunked frames: mixed plain and Snappy chunks, with and without an offset table', () => {
    const cut = [0, 1000, 1001, 3000, blocks.length];
    const parts = cut.slice(1).map((end, i) => blocks.subarray(cut[i], end));
    const kinds = [0x0b, 0x0a, 0x0b, 0x0a];
    const packed = parts.map((p, i) => (kinds[i] === 0x0b ? snappyEncode(p) : p));
    const sizes = packed.map((p) => p.length);
    const body = join(packed);
    const noOffsets = sec(0xce, join([sec(0x01, join([sec(0x02, new Uint8Array(kinds)), sec(0x03, u32s(sizes))])), body]));
    expect(parseHapFrame(noOffsets, { width: W, height: H }).data).toEqual(blocks);
    // with an offset table the chunks may sit anywhere after the tables: store them in reverse order
    const reversed = join([...packed].reverse());
    const offsets = packed.map((_, i) => packed.slice(i + 1).reduce((s, p) => s + p.length, 0));
    const withOffsets = sec(0xce, join([sec(0x01, join([sec(0x03, u32s(sizes)), sec(0x04, u32s(offsets)), sec(0x02, new Uint8Array(kinds))])), reversed]), true);
    expect(parseHapFrame(withOffsets).data).toEqual(blocks);
  });

  it('refuses damaged frames and kinds it does not read, with a readable message', () => {
    const good = hapFrame(blocks, 'Hap5', true);
    expect(() => parseHapFrame(good.subarray(0, good.length - 5))).toThrow(/cut short/);
    expect(() => parseHapFrame(new Uint8Array(2))).toThrow(/cut short/);
    expect(() => parseHapFrame(sec(0xa2, blocks))).toThrow(/not supported/); // BC6 (HDR)
    expect(() => parseHapFrame(sec(0xde, blocks))).toThrow(/packing/);
    expect(() => parseHapFrame(sec(0xce, sec(0x01, sec(0x02, new Uint8Array([0x0b])))))).toThrow(/chunk tables/);
    expect(() => parseHapFrame(sec(0xce, join([sec(0x01, join([sec(0x02, new Uint8Array([0x0a])), sec(0x03, u32s([9999]))])), blocks.subarray(0, 100)])))).toThrow(/cut short/);
    expect(() => parseHapFrame(hapFrame(blocks.subarray(0, 64), 'Hap5', false), { width: W, height: H })).toThrow(/smaller than the picture/);
    const broken = snappyEncode(blocks);
    broken[0] ^= 0x10; // the stated size no longer matches
    expect(() => parseHapFrame(sec(0xbe, broken))).toThrow(/snappy/);
  });

  it('Snappy decodes into the middle of a buffer and reports sizes', () => {
    const src = makePicture('pixelart', 40, 40);
    const packed = snappyEncode(src);
    expect(snappyLength(packed)).toBe(src.length);
    expect(snappyDecode(packed)).toEqual(src);
    const out = new Uint8Array(src.length + 20).fill(7);
    expect(snappyDecodeInto(packed, out, 10)).toBe(src.length);
    expect(out.subarray(10, 10 + src.length)).toEqual(src);
    expect([...out.subarray(0, 10), ...out.subarray(10 + src.length)].every((v) => v === 7)).toBe(true);
    expect(() => snappyDecodeInto(packed, new Uint8Array(src.length - 1))).toThrow(/does not fit/);
  });
});

describe('HAP blocks decoded on the CPU', () => {
  it('agrees with the reference decoder of the HAP writer for every format, at sizes that are not multiples of 4', () => {
    for (const [w, h] of [[W, H], [45, 27], [1, 1], [5, 3]]) {
      for (const kind of ['gradient', 'noise', 'alpha', 'pixelart'] as const) {
        const src = makePicture(kind, w, h, 3);
        for (const fmt of ['Hap1', 'Hap5', 'HapY'] as const) {
          const blocks = new Uint8Array(dxtFrameBytes(w, h, fmt));
          compressDxt(src, w, h, fmt, blocks);
          const ours = hapToRgba(parseHapFrame(hapFrame(blocks, fmt, true), { width: w, height: h }), w, h);
          const ref = decompressDxt(blocks, w, h, fmt);
          for (let i = 3; i < ref.length; i += 4) if (fmt === 'Hap1') ref[i] = 255; // HAP is opaque: DXT1's "transparent" index is plain black
          expect(pictureDiff(ours, ref).max, `${fmt} ${kind} ${w}x${h}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('premultiplies when asked, shows a single channel as grey, and refuses BC7', () => {
    const src = makePicture('alpha', W, H);
    const blocks = new Uint8Array(dxtFrameBytes(W, H, 'Hap5'));
    compressDxt(src, W, H, 'Hap5', blocks);
    const frame: HapFrame = { format: 'bc3', data: blocks };
    const straight = hapToRgba(frame, W, H);
    const pre = hapToRgba(frame, W, H, { premultiply: true });
    for (let i = 0; i < straight.length; i += 4 * 37) {
      const a = straight[i + 3];
      expect(pre[i + 3]).toBe(a);
      for (let c = 0; c < 3; c++) expect(pre[i + c]).toBe(Math.round((straight[i + c] * a) / 255));
    }
    // the first 8 bytes of every DXT5 block are a one-channel (BC4) block of the alpha
    const alphaOnly = new Uint8Array(hapTextureBytes('bc4', W, H));
    for (let b = 0; b < alphaOnly.length / 8; b++) alphaOnly.set(blocks.subarray(b * 16, b * 16 + 8), b * 8);
    const grey = hapToRgba({ format: 'bc4', data: alphaOnly }, W, H);
    for (let i = 0; i < grey.length; i += 4) expect([grey[i], grey[i + 1], grey[i + 2], grey[i + 3]]).toEqual([straight[i + 3], straight[i + 3], straight[i + 3], 255]);
    expect(() => hapToRgba({ format: 'bc7', data: blocks }, W, H)).toThrow(/graphics card/);
    expect(() => hapToRgba({ format: 'bc1', data: blocks.subarray(0, 8) }, W, H)).toThrow(/smaller than the picture/);
  });
});

describe.skipIf(!HAP_FFMPEG)('HAP files written by FFmpeg, compared with FFmpeg\'s own decode', () => {
  const cases = [
    { format: 'hap', fourcc: 'Hap1', bc: 'bc1', chunks: 1, compressor: 'snappy' },
    { format: 'hap', fourcc: 'Hap1', bc: 'bc1', chunks: 4, compressor: 'snappy' },
    { format: 'hap', fourcc: 'Hap1', bc: 'bc1', chunks: 1, compressor: 'none' },
    { format: 'hap_alpha', fourcc: 'Hap5', bc: 'bc3', chunks: 1, compressor: 'snappy' },
    { format: 'hap_alpha', fourcc: 'Hap5', bc: 'bc3', chunks: 3, compressor: 'snappy' },
    { format: 'hap_q', fourcc: 'HapY', bc: 'ycocg-bc3', chunks: 1, compressor: 'snappy' },
    { format: 'hap_q', fourcc: 'HapY', bc: 'ycocg-bc3', chunks: 8, compressor: 'none' },
  ] as const;
  for (const c of cases) {
    it(`${c.format}, ${c.chunks} chunk(s), ${c.compressor}`, async () => {
      const w = 128;
      const h = 72;
      const file = makeHapClip({ format: c.format, width: w, height: h, frames: 3, chunks: c.chunks, compressor: c.compressor });
      const { fourcc, width, height, samples } = await hapSamples(file);
      expect(fourcc).toBe(c.fourcc);
      expect([width, height, samples.length]).toEqual([w, h, 3]);
      const theirs = ffmpegDecode(file);
      expect(theirs.length).toBe(w * h * 4 * 3);
      // how FFmpeg packed the frame, so a change there shows up here and not as a mystery (without Snappy it never makes chunks)
      const top = samples[0][3];
      expect(top >> 4).toBe(c.compressor === 'none' ? 0x0a : c.chunks > 1 ? 0x0c : 0x0b);
      samples.forEach((s, i) => {
        const frame = parseHapFrame(s, { width: w, height: h });
        expect(frame.format).toBe(c.bc);
        const ours = hapToRgba(frame, w, h);
        const d = pictureDiff(ours, theirs.subarray(i * w * h * 4, (i + 1) * w * h * 4));
        // the two decoders round the in-between colours of a block differently: a few levels at most
        expect(d.max, `frame ${i}`).toBeLessThanOrEqual(6);
        expect(d.mean, `frame ${i}`).toBeLessThan(1);
      });
      // the alpha clip really has transparency in it (otherwise the alpha path would be untested)
      if (c.format === 'hap_alpha') expect(theirs[3]).toBeLessThan(10);
    });
  }

  it('HAP Q Alpha (colour and alpha as two textures in one frame) decodes like FFmpeg decodes it', async () => {
    const src = makePicture('alpha', W, H);
    for (let i = 0; i < src.length; i += 4) src[i + 2] = (i / 4) % W; // more colour variety than the plain alpha picture
    const colour = new Uint8Array(dxtFrameBytes(W, H, 'HapY'));
    compressDxt(src, W, H, 'HapY', colour);
    const dxt5 = new Uint8Array(dxtFrameBytes(W, H, 'Hap5'));
    compressDxt(src, W, H, 'Hap5', dxt5);
    const alpha = new Uint8Array(hapTextureBytes('bc4', W, H));
    for (let b = 0; b < alpha.length / 8; b++) alpha.set(dxt5.subarray(b * 16, b * 16 + 8), b * 8);
    const sample = sec(0x0d, join([sec(0xbf, snappyEncode(colour)), sec(0xa1, alpha)]));
    const frame = parseHapFrame(sample, { width: W, height: H });
    expect(frame.format).toBe('ycocg-bc3');
    expect(frame.alpha).toEqual(alpha);
    const mux = createMovMuxer({ width: W, height: H, fps: 25, video: { fourcc: 'HapM', compressorName: 'Hap Q Alpha', depth: 32 } });
    await mux.addVideo(sample);
    const file = join(await mux.finish());
    const theirs = ffmpegDecode(file, 'hapm.mov');
    const ours = hapToRgba(frame, W, H);
    const d = pictureDiff(ours, theirs);
    expect(d.max).toBeLessThanOrEqual(6);
    expect(d.mean).toBeLessThan(1);
    expect(ours[3]).toBe(0);
    expect(ours[(W - 1) * 4 + 3]).toBeGreaterThan(240);
  });
});
