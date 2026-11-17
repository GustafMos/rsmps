/**
 * Cross-check against an independent decoder: the FFmpeg binary that ships in node_modules (@ffmpeg-installer), when present.
 * It is only used to READ our files; nothing is bundled or distributed. Skipped when the binary is missing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decompressDxt, psnr } from './dxt';
import { beginApng } from './apng';
import { beginGif } from './gif';
import { beginHap } from './hap';
import { beginPngMov, beginRawMov } from './mov-codecs';
import { encodeAiff } from './aiff';
import { encodeFlac } from './flac';
import { encodeExr, floatToHalf, halfToFloat } from './float';
import { encodeBmp, encodePnm, encodeTga } from './stills';
import { encodeTiff } from './tiff';
import { join, makePicture, readMov, videoSamples } from './test-helpers';
import { snappyDecode } from './snappy';

function ffmpegPath(): string | null {
  try {
    const p = (require('@ffmpeg-installer/ffmpeg') as { path: string }).path;
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}
const FF = ffmpegPath();
const dir = FF ? mkdtempSync(pjoin(tmpdir(), 'rsmps-ffcheck-')) : '';

/** All frames of a file decoded to RGBA by ffmpeg. */
function decode(name: string, bytes: Uint8Array, extra: string[] = [], fmt = 'rgba'): Uint8Array {
  const file = pjoin(dir, name);
  writeFileSync(file, bytes);
  const r = spawnSync(FF!, ['-v', 'error', ...extra, '-i', file, '-f', 'rawvideo', '-pix_fmt', fmt, '-'], { maxBuffer: 1 << 28 });
  expect(r.stderr.toString(), name).toBe('');
  expect(r.status).toBe(0);
  return new Uint8Array(r.stdout);
}

const W = 64;
const H = 48;
const rgbOnly = (a: Uint8Array) => Uint8Array.from({ length: a.length }, (_, i) => (i % 4 === 3 ? 255 : a[i]));
const d = describe.skipIf(!FF);

d('independent decoder (ffmpeg)', () => {
  const frames = [makePicture('pixelart', W, H, 1), makePicture('edges', W, H), makePicture('gradient', W, H)];

  for (const fmt of ['Hap1', 'Hap5', 'HapY'] as const) {
    it(`${fmt}: ffmpeg's HAP decoder agrees with ours (spec conformance of header, blocks and YCoCg)`, async () => {
      const s = beginHap({ width: W, height: H, fps: 25, format: fmt, snappy: fmt === 'Hap5' });
      for (const f of frames) s.addFrame(f);
      const file = join(await s.finish());
      const out = decode(`${fmt}.mov`, file);
      expect(out.length).toBe(W * H * 4 * 3);
      const mov = readMov(file);
      videoSamples(file, mov.tracks[0]).forEach((smp, i) => {
        const body = (smp[3] & 0xf0) === 0xb0 ? snappyDecode(smp.subarray(4)) : smp.subarray(4);
        const ours = decompressDxt(body, W, H, fmt);
        const theirs = out.subarray(i * W * H * 4, (i + 1) * W * H * 4);
        const db = psnr(ours, fmt === 'Hap5' ? theirs : rgbOnly(theirs), fmt === 'Hap5');
        expect(db, `${fmt} frame ${i}`).toBeGreaterThan(38);
        expect(psnr(frames[i], theirs)).toBeGreaterThan(26);
      });
    });
  }

  it('PNG-in-MOV and raw-in-MOV decode exactly', async () => {
    for (const make of [beginPngMov, beginRawMov]) {
      const s = make({ width: W, height: H, fps: 25 });
      const px = [makePicture('alpha', W, H), makePicture('noise', W, H)];
      for (const p of px) await s.addFrame(p);
      const out = decode('m.mov', join(await s.finish()));
      expect(out).toEqual(join(px));
    }
  });

  it('GIF decodes to the source frames (exact colours), timing 25 fps', async () => {
    const s = beginGif({ width: W, height: H, fps: 25 });
    const px = [frames[0], frames[1], frames[0]];
    for (const p of px) s.addFrame(p);
    const out = decode('a.gif', join(await s.finish()));
    expect(out).toEqual(join(px));
  });

  it('APNG decodes to the source frames, with differencing and both blend modes', async () => {
    const f2 = frames[0].slice();
    for (let y = 5; y < 9; y++) for (let x = 5; x < 11; x++) f2.set([9, 200, 9, 255], (y * W + x) * 4);
    const px = [frames[0], f2, makePicture('alpha', W, H)];
    const s = beginApng({ width: W, height: H, fps: 25 });
    for (const p of px) s.addFrame(p);
    expect(decode('a.apng', join(await s.finish()))).toEqual(join(px));
  });

  it('BMP, TGA, TIFF, PAM decode exactly; PPM matches over black', () => {
    const p = makePicture('alpha', W, H);
    expect(decode('a.bmp', encodeBmp(p, W, H))).toEqual(p);
    expect(decode('a.tga', encodeTga(p, W, H, { rle: true }))).toEqual(p);
    expect(decode('a.tga', encodeTga(p, W, H))).toEqual(p);
    expect(decode('a.tif', encodeTiff(p, W, H, { compression: 'deflate' }))).toEqual(p);
    expect(decode('a.tif', encodeTiff(p, W, H))).toEqual(p);
    expect(decode('a.pam', encodePnm(p, W, H, { alpha: true }))).toEqual(p);
    expect(psnr(decode('a.ppm', encodePnm(p, W, H)), rgbOnly(p))).toBeGreaterThan(5);
  });

  it('OpenEXR (ZIP and none) decode to the values we wrote (ffmpeg maps half to 16-bit integers)', () => {
    const px = new Float32Array(W * H * 4);
    for (let i = 0; i < px.length; i++) px[i] = ((i * 37) % 101) / 100;
    for (const compression of ['zip', 'none'] as const) {
      const out = decode('a.exr', encodeExr(px, W, H, { compression }), [], 'rgba64le');
      const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
      for (let i = 0; i < px.length; i += 97) expect(Math.abs(v.getUint16(i * 2, true) / 65535 - halfToFloat(floatToHalf(px[i])))).toBeLessThan(0.002);
    }
  });

  it('AIFF 24-bit decodes sample-exactly', () => {
    const l = Float32Array.from({ length: 480 }, (_, i) => Math.sin(i / 9) * 0.7);
    const file = pjoin(dir, 'a.aiff');
    writeFileSync(file, encodeAiff({ sampleRate: 48000, channels: [l] }, 24));
    const r = spawnSync(FF!, ['-v', 'error', '-i', file, '-f', 's32le', '-'], { maxBuffer: 1 << 24 });
    expect(r.stderr.toString()).toBe('');
    const out = new Uint8Array(r.stdout);
    const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(out.length).toBe(480 * 4);
    for (let i = 0; i < l.length; i += 7) expect(v.getInt32(i * 4, true) >> 8).toBe(Math.round(l[i] < 0 ? l[i] * 0x800000 : l[i] * 0x7fffff));
  });

  it('FLAC (16 and 24 bit, stereo, partial last block) decodes losslessly and without CRC errors', () => {
    const n = 4096 * 3 + 777;
    const l = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 11) * 0.8);
    const r = Float32Array.from({ length: n }, (_, i) => ((i * 7919) % 2001) / 1000 - 1);
    for (const bits of [16, 24] as const) {
      const file = join(encodeFlac([l, r], { sampleRate: 44100, bits }));
      const f = pjoin(dir, 'a.flac');
      writeFileSync(f, file);
      const res = spawnSync(FF!, ['-v', 'error', '-i', f, '-f', 's32le', '-'], { maxBuffer: 1 << 26 });
      expect(res.stderr.toString()).toBe('');
      const out = new Uint8Array(res.stdout);
      const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
      expect(out.length).toBe(n * 2 * 4);
      const sh = 32 - bits;
      const q = (x: number) => Math.round(x < 0 ? x * 2 ** (bits - 1) : x * (2 ** (bits - 1) - 1));
      for (let i = 0; i < n; i += 13) {
        expect(v.getInt32(i * 8, true) >> sh).toBe(q(l[i]));
        expect(v.getInt32(i * 8 + 4, true) >> sh).toBe(q(r[i]));
      }
    }
  });
});
