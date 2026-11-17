import { unzlibSync } from 'fflate';
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import { describe, expect, it } from 'vitest';
import { beginHap } from './hap';
import { beginMjpegMov, beginPngMov, beginRawMov } from './mov-codecs';
import { createMovMuxer } from './mov';
import { join, makePicture, readMov, videoSamples } from './test-helpers';
import { crc32 } from './util';

function readPng(png: Uint8Array): { w: number; h: number; rgba: Uint8Array } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let at = 8;
  let w = 0, h = 0;
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    expect(v.getUint32(at + 8 + len)).toBe(crc32(png, at + 4, at + 8 + len));
    if (type === 'IHDR') {
      w = v.getUint32(at + 8);
      h = v.getUint32(at + 12);
      expect([png[at + 16], png[at + 17]]).toEqual([8, 6]);
    }
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = unzlibSync(join(idat));
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    expect(raw[y * (w * 4 + 1)]).toBe(0);
    rgba.set(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)), y * w * 4);
  }
  return { w, h, rgba };
}

describe('PNG, raw and Motion JPEG in MOV', () => {
  const w = 16;
  const h = 10;
  it('PNG-in-MOV: samples are complete lossless PNG files with alpha', async () => {
    const s = beginPngMov({ width: w, height: h, fps: 25 });
    const pics = [makePicture('alpha', w, h), makePicture('noise', w, h)];
    for (const p of pics) await s.addFrame(p);
    const file = join(await s.finish());
    const mov = readMov(file);
    expect(mov.tracks[0].fourcc).toBe('png ');
    const samples = videoSamples(file, mov.tracks[0]);
    samples.forEach((smp, i) => {
      const png = readPng(smp);
      expect([png.w, png.h]).toEqual([w, h]);
      expect(png.rgba).toEqual(pics[i]);
    });
  });

  it('raw-in-MOV: ARGB samples of exactly w*h*4 bytes', async () => {
    const s = beginRawMov({ width: w, height: h, fps: 24 });
    const p = makePicture('alpha', w, h);
    await s.addFrame(p);
    const file = join(await s.finish());
    const t = readMov(file).tracks[0];
    expect(t.fourcc).toBe('raw ');
    const smp = videoSamples(file, t)[0];
    expect(smp.length).toBe(w * h * 4);
    expect([...smp.subarray(0, 4)]).toEqual([p[3], p[0], p[1], p[2]]);
  });

  it('MJPEG-in-MOV: one JPEG per frame from the callback, sample entry jpeg', async () => {
    const fake = async (_rgba: Uint8Array | Uint8ClampedArray, _w: number, _h: number, q: number) => new Uint8Array([0xff, 0xd8, Math.round(q * 100), 0xff, 0xd9]);
    const s = beginMjpegMov({ width: w, height: h, fps: 25, quality: 0.5, jpeg: fake });
    await s.addFrame(makePicture('gradient', w, h));
    await s.addFrame(makePicture('gradient', w, h));
    const file = join(await s.finish());
    const t = readMov(file).tracks[0];
    expect(t.fourcc).toBe('jpeg');
    expect(videoSamples(file, t).map((x) => [...x])).toEqual([[0xff, 0xd8, 50, 0xff, 0xd9], [0xff, 0xd8, 50, 0xff, 0xd9]]);
  });

  it('rejects a frame of the wrong size', async () => {
    const s = beginPngMov({ width: w, height: h });
    await expect(Promise.resolve().then(() => s.addFrame(new Uint8Array(12)))).rejects.toThrow(/does not match/);
  });
});

describe('muxer details', () => {
  it('switches to 64-bit chunk offsets and mdat size past 4 GiB without allocating that much', () => {
    // Fake a huge sample with a length-only Uint8Array view: the muxer never reads sample bytes.
    const mux = createMovMuxer({ width: 4, height: 4, fps: 25, video: { fourcc: 'Hap1', compressorName: 'Hap', depth: 24 } });
    const huge = { length: 0x100000010 } as unknown as Uint8Array;
    mux.addVideo(huge);
    mux.addVideo(new Uint8Array(4));
    const parts = mux.finish();
    const head = parts[0];
    const moov = parts[parts.length - 1];
    // ftyp (20) + mdat with size==1 and a 64-bit size
    expect(new DataView(head.buffer, head.byteOffset).getUint32(20)).toBe(1);
    expect(new DataView(head.buffer, head.byteOffset).getUint32(28)).toBe(1);
    const tag = String.fromCharCode(...moov.subarray(0, 8).subarray(4));
    expect(tag).toBe('moov');
    expect(new TextDecoder('latin1').decode(moov)).toContain('co64');
  });
});

describe('read-back with mediabunny', () => {
  async function packets(file: Uint8Array) {
    const input = new Input({ source: new BufferSource(file.slice().buffer), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const stamps: number[] = [];
    for await (const p of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) stamps.push(p.timestamp);
    return { codec: track.codec, w: track.codedWidth, h: track.codedHeight, stamps };
  }

  for (const [name, make] of [
    ['png', () => beginPngMov({ width: 16, height: 8, fps: 25 })],
    ['raw', () => beginRawMov({ width: 16, height: 8, fps: 25 })],
    ['hap', () => beginHap({ width: 16, height: 8, fps: 25, format: 'Hap5' })],
  ] as const) {
    it(`${name}: opens as MOV and lists the packets at exact frame times when the track is recognised`, async () => {
      const s = make();
      for (let i = 0; i < 6; i++) await s.addFrame(makePicture('gradient', 16, 8, i + 1));
      const file = join(await s.finish());
      const r = await packets(file);
      // mediabunny only lists tracks whose codec it knows; report-only when it does not.
      if (r) {
        expect([r.w, r.h]).toEqual([16, 8]);
        expect(r.stamps.map((t) => Math.round(t * 25))).toEqual([0, 1, 2, 3, 4, 5]);
      }
      console.log(`mediabunny ${name}:`, r ? `codec=${r.codec} packets=${r.stamps.length}` : 'track not exposed (unknown codec)');
    });
  }
});
