import { describe, expect, it } from 'vitest';
import { floatToHalf, halfToFloat } from './encoders/float';
import { CODEC_TABLE, rowById, stillRow } from './export-codecs';
import { MEMORY_LIMIT, encodeAudioOwn, encodeStillOwn, engineHalfToLinear, engineHalfToStraight16, estimateBytes, frameModeOf, hapFormatOf, streamsToSink, tooBigMessage } from './own-export';
import { FILE_PICKER_THRESHOLD, openOutputSink } from './sinks';
import type { FfmpegExportClient } from './desktop';

const half = (...v: number[]) => Uint16Array.from(v.map(floatToHalf));
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));

describe('which pixels each format gets', () => {
  it('alpha formats get straight alpha, the others the picture over black; HAP Alpha and the GPU path decide by format', () => {
    const mode = (id: string, q: 'fast' | 'better' = 'fast', gpu = true) => frameModeOf(rowById(id)!, { hapQuality: q }, gpu);
    expect(mode('hap')).toBe('hap-gpu');
    expect(mode('hap-alpha')).toBe('hap-gpu');
    expect(mode('hap', 'better')).toBe('over-black'); // CPU, opaque
    expect(mode('hap-alpha', 'better')).toBe('straight');
    expect(mode('hap-q', 'fast', false)).toBe('over-black');
    expect(mode('mjpeg')).toBe('over-black');
    for (const id of ['png', 'raw-mov', 'gif', 'apng']) expect(mode(id), id).toBe('straight');
    expect(hapFormatOf(rowById('hap-q')!)).toBe('HapY');
    expect(hapFormatOf(rowById('png')!)).toBeNull();
  });
});

describe('float stills are written linear', () => {
  it('display-encoded values are linearised; values above 1.0 stay above 1.0', () => {
    const lv = engineHalfToLinear(half(0.5, 0.25, 2, 1), true);
    expect(lv[0]).toBeCloseTo(lin(0.5), 3); // 0.214
    expect(lv[1]).toBeCloseTo(lin(0.25), 3);
    expect(lv[2]).toBeGreaterThan(1); // 2.0 encoded is brighter than 1.0 linear
    expect(lv[3]).toBe(1);
  });
  it('with alpha: straight color is linearised, then premultiplied again (OpenEXR convention)', () => {
    // a 50 % red whose engine value is premultiplied 0.5 -> straight 1.0 -> linear 1.0 -> premultiplied 0.5
    const lv = engineHalfToLinear(half(0.5, 0, 0, 0.5), true);
    expect(lv[0]).toBeCloseTo(0.5, 3);
    expect(lv[3]).toBeCloseTo(0.5, 3);
    // a 50 % mid gray: straight 0.5 -> linear 0.214 -> premultiplied 0.107
    expect(engineHalfToLinear(half(0.25, 0.25, 0.25, 0.5), true)[0]).toBeCloseTo(lin(0.5) * 0.5, 3);
  });
  it('without alpha (Radiance HDR) the picture is first placed over black, then linearised', () => {
    const lv = engineHalfToLinear(half(0.25, 0.25, 0.25, 0.5), false);
    expect(lv[0]).toBeCloseTo(lin(0.25), 3);
    expect(lv[3]).toBe(1);
  });
  it('16-bit TIFF is straight and display encoded, clipped to 0..1', () => {
    const u = engineHalfToStraight16(half(0.25, 0, 0, 0.5, 3, 1, 0, 1));
    expect(u[0]).toBe(32768); // 0.25 / 0.5 = 0.5
    expect(u[3]).toBe(32768);
    expect(u[4]).toBe(65535); // 3.0 clipped
    expect(u[7]).toBe(65535);
  });
  it('writes OpenEXR, HDR and TIFF 16 files with their signatures', async () => {
    const px = half(0.5, 0.5, 0.5, 1, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1);
    const exr = await encodeStillOwn(stillRow('exr')!, { half: px }, 2, 2);
    expect(Array.from(exr.subarray(0, 4))).toEqual([0x76, 0x2f, 0x31, 0x01]);
    const hdr = await encodeStillOwn(stillRow('hdr')!, { half: px }, 2, 2);
    expect(String.fromCharCode(...hdr.subarray(0, 10))).toBe('#?RADIANCE');
    const tif = await encodeStillOwn(stillRow('tiff16')!, { half: px }, 2, 2);
    expect(Array.from(tif.subarray(0, 4))).toEqual([0x49, 0x49, 42, 0]);
    await expect(encodeStillOwn(stillRow('exr')!, { rgba: new Uint8Array(16) }, 2, 2)).rejects.toThrow(/float/);
    expect(halfToFloat(half(1.5)[0])).toBe(1.5);
  });
  it('an 8-bit still row with its own encoder writes the file; a browser row is refused here', async () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(200);
    const qoi = await encodeStillOwn(stillRow('qoi')!, { rgba }, 4, 4);
    expect(String.fromCharCode(...qoi.subarray(0, 4))).toBe('qoif');
    await expect(encodeStillOwn(stillRow('png')!, { rgba }, 4, 4)).rejects.toThrow(/not written by the app/);
  });
});

describe('sound files', () => {
  const pcm = { sampleRate: 48000, channels: [Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 10) * 0.5)] };
  it('WAV bit depths, AIFF and FLAC by row', () => {
    const wav = (id: string) => encodeAudioOwn(rowById(id)!, pcm)[0];
    expect(new DataView(wav('wav').buffer).getUint16(34, true)).toBe(16);
    expect(new DataView(wav('wav24').buffer).getUint16(34, true)).toBe(24);
    expect(new DataView(wav('wav32f').buffer).getUint16(34, true)).toBe(32);
    expect(String.fromCharCode(...encodeAudioOwn(rowById('aiff')!, pcm)[0].subarray(0, 4))).toBe('FORM');
    expect(String.fromCharCode(...encodeAudioOwn(rowById('flac24')!, pcm)[0].subarray(0, 4))).toBe('fLaC');
    expect(() => encodeAudioOwn(rowById('mp3')!, pcm)).toThrow(/not written by the app/);
  });
});

describe('size estimates and sinks', () => {
  it('a 4K HAP second is more than a gigabyte of pixels, so the web version streams it or refuses it with a plain message', () => {
    const row = rowById('hap-alpha')!;
    const est = estimateBytes(row, { width: 3840, height: 2160, frames: 200, hapSnappy: false });
    expect(est).toBeGreaterThan(MEMORY_LIMIT);
    expect(streamsToSink(row)).toBe(true);
    expect(streamsToSink(rowById('gif')!)).toBe(false);
    expect(tooBigMessage(est)).toMatch(/GB of memory in the browser.*smaller size.*Smaller files.*desktop app.*image sequence/);
    // Snappy lowers the estimate, HAP Q is as big as HAP Alpha, HAP is half of that
    expect(estimateBytes(row, { width: 1920, height: 1080, frames: 10, hapSnappy: true })).toBeLessThan(estimateBytes(row, { width: 1920, height: 1080, frames: 10, hapSnappy: false }));
    expect(estimateBytes(rowById('hap')!, { width: 1920, height: 1080, frames: 10, hapSnappy: false })).toBeLessThan(estimateBytes(row, { width: 1920, height: 1080, frames: 10, hapSnappy: false }) * 0.6);
  });

  it('memory sink for small files, a refusal above the limit, a picker for big files, the desktop file when there is one', async () => {
    const small = await openOutputSink({}, { name: 'a.mov', mime: 'video/quicktime', estimate: 1e6 });
    expect(small.kind).toBe('memory');
    await small.sink.write(new Uint8Array([1, 2, 3]));
    const done = await small.result();
    expect(done.blob.size).toBe(3);
    expect(done.savedPath).toBeUndefined();
    await expect(openOutputSink({}, { name: 'a.mov', mime: 'video/quicktime', estimate: MEMORY_LIMIT + 1 })).rejects.toThrow(/GB of memory in the browser/);

    const written: [number, number][] = [];
    const picker = async () => ({
      name: 'big.mov',
      createWritable: async () => ({ write: async (c: unknown) => void written.push(c instanceof Uint8Array ? [-1, c.length] : [(c as { position: number }).position, (c as { data: Uint8Array }).data.length]), close: async () => undefined, abort: async () => undefined }),
      getFile: async () => ({ size: 7, arrayBuffer: async () => new ArrayBuffer(7) }) as unknown as File,
    });
    const big = await openOutputSink({ picker }, { name: 'big.mov', mime: 'video/quicktime', estimate: FILE_PICKER_THRESHOLD + 1 });
    expect(big.kind).toBe('file-system');
    await big.sink.write(new Uint8Array(5));
    await big.sink.writeAt!(new Uint8Array(2), 8);
    expect(written).toEqual([[-1, 5], [8, 2]]);
    expect((await big.result()).savedPath).toBe('big.mov');
    // the picker is skipped for small files, and a refused picker (no user gesture) falls back to memory
    expect((await openOutputSink({ picker }, { name: 'a.mov', mime: 'video/quicktime', estimate: 1000 })).kind).toBe('memory');
    const denied = async () => {
      throw new DOMException('no gesture', 'SecurityError');
    };
    expect((await openOutputSink({ picker: denied }, { name: 'a.mov', mime: 'video/quicktime', estimate: FILE_PICKER_THRESHOLD + 1 })).kind).toBe('memory');
    const canceled = async () => {
      throw new DOMException('x', 'AbortError');
    };
    await expect(openOutputSink({ picker: canceled }, { name: 'a.mov', mime: 'video/quicktime', estimate: FILE_PICKER_THRESHOLD + 1 })).rejects.toMatchObject({ name: 'AbortError' });

    const calls: string[] = [];
    const desktop = {
      fileStart: async (r: { name: string; ext: string }) => (calls.push(`start ${r.name}.${r.ext}`), { saved: true, id: 'x1', path: 'C:/out/a.mov' }),
      fileWrite: async (_id: string, at: number, d: Uint8Array) => void calls.push(`write ${at} ${d.length}`),
      fileFinish: async () => (calls.push('finish'), { path: 'C:/out/a.mov', bytes: 9 }),
      fileCancel: async () => void calls.push('cancel'),
    } as unknown as FfmpegExportClient;
    const d = await openOutputSink({ desktop }, { name: 'a.mov', mime: 'video/quicktime', estimate: 10 });
    expect(d.kind).toBe('desktop');
    await d.sink.write(new Uint8Array(4));
    await d.sink.write(new Uint8Array(6));
    await d.sink.writeAt!(new Uint8Array(2), 20);
    const r = await d.result();
    expect(r.savedPath).toBe('C:/out/a.mov');
    expect(calls).toEqual(['start a.mov', 'write 0 4', 'write 4 6', 'write 20 2', 'finish']);
    const closed = { fileStart: async () => ({ saved: false }), fileWrite: async () => undefined, fileFinish: async () => ({ path: '', bytes: 0 }) } as unknown as FfmpegExportClient;
    await expect(openOutputSink({ desktop: closed }, { name: 'a.mov', mime: 'x', estimate: 1 })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('every row has a route and the table has no duplicate entries for one format', () => {
    for (const r of CODEC_TABLE) expect(['builtin-webcodecs', 'own', 'ffmpeg']).toContain(r.route);
    const hapRows = CODEC_TABLE.filter((r) => /^HAP/.test(r.label));
    expect(hapRows.map((r) => r.route)).toEqual(['own', 'own', 'own']);
    expect(CODEC_TABLE.filter((r) => r.label === 'Animated GIF')).toHaveLength(1);
  });
});
