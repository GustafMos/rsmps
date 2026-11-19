/**
 * The whole way through the media library: a HAP file made by FFmpeg is imported, probed and its frames are served as
 * engine textures, compared with FFmpeg's own decode. Skipped where no FFmpeg with a HAP encoder is installed.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { testGpu } from '../engine/testing';
import type { LibraryAsset } from './api';
import { HAP_FFMPEG, ffmpegDecode, makeHapClip, pictureDiff } from './hap-test-helpers';
import { Library } from './library';

describe.skipIf(!HAP_FFMPEG)('HAP clips in the media library', () => {
  // no IndexedDB in Node: the library warns that the file is not kept for the next session, which is not what is tested here
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined); // the demuxer's "Unsupported video codec" line
  afterAll(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  const W = 128;
  const H = 72;
  const premultiply = (px: Uint8Array): Uint8Array => {
    const out = px.slice();
    for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) out[i + c] = Math.round((out[i + c] * out[i + 3]) / 255);
    return out;
  };

  for (const [format, label] of [['hap', 'HAP'], ['hap_alpha', 'HAP Alpha'], ['hap_q', 'HAP Q']] as const) {
    it(`${label}: imported as a video with its size, length and frame rate; any frame, in any order, matches FFmpeg`, async () => {
      const gpu = await testGpu();
      const lib = new Library(gpu);
      const bytes = makeHapClip({ format, width: W, height: H, frames: 6, sound: format === 'hap' });
      const theirs = ffmpegDecode(bytes);
      const [info] = await lib.add([new File([bytes as BlobPart], `clip ${format}.mov`, { type: 'video/quicktime' })]);
      expect(info).toMatchObject({ kind: 'video', width: W, height: H, hasAudio: format === 'hap' });
      expect((info as LibraryAsset).codec).toBe(label);
      expect(info.fps).toBeCloseTo(25, 3);
      expect(info.duration).toBeCloseTo(6 / 25, 2);
      for (const n of [5, 0, 3, 3, 1]) {
        const frame = await lib.assetFrame(info.id, (n + 0.5) / 25, 0);
        expect(frame, `frame ${n}`).not.toBeNull();
        expect([frame!.width, frame!.height, frame!.texture.format]).toEqual([W, H, 'rgba8unorm']);
        const got = new Uint8Array(await gpu.readRaw(frame!));
        const d = pictureDiff(got, premultiply(theirs.subarray(n * W * H * 4, (n + 1) * W * H * 4)));
        expect(d.max, `frame ${n}`).toBeLessThanOrEqual(8);
        expect(d.mean, `frame ${n}`).toBeLessThan(1.5);
      }
      // a frame that was just made is served again from the store, not read a second time
      const a = await lib.assetFrame(info.id, 0.05, 0);
      const b = await lib.assetFrame(info.id, 0.06, 0);
      expect(b).toBe(a);
      // two requests for one frame at the same moment share the work
      const [c, d2] = await Promise.all([lib.assetFrame(info.id, 0.17, 0), lib.assetFrame(info.id, 0.175, 0)]);
      expect(d2).toBe(c);
      // a smaller copy for previews
      const small = await lib.assetFrame(info.id, 0, 64);
      expect([small!.width, small!.height]).toEqual([64, 36]);
      expect(lib.assetProblem(info.id)).toBeNull();
      await lib.remove(info.id);
      expect(await lib.assetFrame(info.id, 0, 0)).toBeNull();
      lib.dispose();
    });
  }

  it('the sound of a HAP clip is read like that of any other clip', async () => {
    const lib = new Library(await testGpu());
    const bytes = makeHapClip({ format: 'hap', width: 64, height: 48, frames: 25, sound: true });
    const [info] = await lib.add([new File([bytes as BlobPart], 'tone.mov')]);
    const pcm = await lib.assetAudio(info.id);
    expect(pcm).not.toBeNull();
    expect(pcm!.sampleRate).toBe(48000);
    expect(pcm!.channels[0].length).toBeGreaterThan(40000);
    expect(Math.max(...pcm!.channels[0].subarray(0, 2000))).toBeGreaterThan(0.05); // a tone, not silence
    lib.dispose();
  });

  it('a HAP clip whose stored label does not say HAP (imported by an older version) is still found and played', async () => {
    const gpu = await testGpu();
    const lib = new Library(gpu);
    const bytes = makeHapClip({ format: 'hap', width: W, height: H, frames: 3 });
    const [info] = await lib.add([new File([bytes as BlobPart], 'old.mov')]);
    delete (info as LibraryAsset).codec; // what an asset record written before HAP support looks like
    const frame = await lib.assetFrame(info.id, 0.05, 0);
    expect(frame).not.toBeNull();
    const theirs = ffmpegDecode(bytes);
    const d = pictureDiff(new Uint8Array(await gpu.readRaw(frame!)), theirs.subarray(W * H * 4, 2 * W * H * 4));
    expect(d.max).toBeLessThanOrEqual(8);
    expect(lib.assetProblem(info.id)).toBeNull();
    lib.dispose();
  });
});
