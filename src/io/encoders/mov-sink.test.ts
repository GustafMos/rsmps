import { describe, expect, it } from 'vitest';
import { beginHap, hapFixedFrameBytes } from './hap';
import { beginPngMov, beginRawMov } from './mov-codecs';
import { MemorySink, type ByteSink } from './sink';
import { join, makePicture, parseBoxes, readMov, videoSamples } from './test-helpers';

/** A sink that cannot seek and only ever appends (a plain download stream). */
class AppendOnly implements ByteSink {
  readonly seekable = false;
  parts: Uint8Array[] = [];
  closed = false;
  write(d: Uint8Array) {
    this.parts.push(d);
  }
  close() {
    this.closed = true;
  }
}

const W = 40;
const H = 24;
const pics = () => (['gradient', 'alpha', 'noise', 'edges'] as const).map((k, i) => makePicture(k, W, H, i + 1));
const tone = () => Float32Array.from({ length: 4800 }, (_, i) => Math.sin(i / 20) * 0.4);

/** What matters for a player: sample bytes, sizes, timing, track layout. */
function summary(file: Uint8Array) {
  const m = readMov(file);
  return m.tracks.map((t) => ({
    handler: t.handler,
    fourcc: t.fourcc,
    timescale: t.timescale,
    duration: t.duration,
    sizes: t.sizes,
    deltas: t.deltas,
    sampleSize: t.sampleSize,
    width: t.width,
    height: t.height,
    samples: t.handler === 'vide' ? videoSamples(file, t).map((s) => Buffer.from(s).toString('base64')) : [],
  }));
}

describe('MOV muxer through a sink', () => {
  for (const format of ['Hap1', 'Hap5', 'HapY'] as const) {
    it(`${format}: the streamed file holds the same samples, tables and timing as the in-memory file (moov at the end, wide mdat)`, async () => {
      const mem = beginHap({ width: W, height: H, fps: 25, format, snappy: true, refine: 0, audio: { sampleRate: 48000, channels: 1, bits: 16 } });
      const sink = new MemorySink();
      const str = beginHap({ width: W, height: H, fps: 25, format, snappy: true, refine: 0, audio: { sampleRate: 48000, channels: 1, bits: 16 }, sink });
      for (const p of pics()) {
        await mem.addFrame(p);
        await str.addFrame(p);
        await mem.addAudio([tone()]);
        await str.addAudio([tone()]);
      }
      const a = join(await mem.finish());
      expect(await str.finish()).toEqual([]); // nothing is kept in memory
      const b = sink.concat();
      expect(summary(b)).toEqual(summary(a));
      const top = parseBoxes(b).map((x) => x.type);
      expect(top).toEqual(['ftyp', 'mdat', 'moov']);
      // the wide mdat covers exactly the samples
      const mdat = parseBoxes(b)[1];
      expect(mdat.headSize).toBe(16);
      expect(mdat.start + mdat.size).toBe(parseBoxes(b)[2].start);
      const t = readMov(b).tracks[0];
      expect(t.offsets[0]).toBe(mdat.start + 16);
    });
  }

  it('raw and PNG MOV stream the same way', async () => {
    for (const begin of [beginRawMov, beginPngMov]) {
      const mem = begin({ width: W, height: H, fps: 24 });
      const sink = new MemorySink();
      const str = begin({ width: W, height: H, fps: 24, sink });
      for (const p of pics()) {
        await mem.addFrame(p);
        await str.addFrame(p);
      }
      const a = join(await mem.finish());
      await str.finish();
      expect(summary(sink.concat())).toEqual(summary(a));
    }
  });

  it('a sink that cannot seek works when the frame size is fixed (HAP without Snappy): the declared size is right', async () => {
    const frames = 6;
    const mem = beginHap({ width: W, height: H, fps: 30, format: 'Hap1', refine: 0 });
    const sink = new AppendOnly();
    const str = beginHap({ width: W, height: H, fps: 30, format: 'Hap1', refine: 0, sink, frames });
    for (let i = 0; i < frames; i++) {
      const p = makePicture('gradient', W, H, i + 1);
      await mem.addFrame(p);
      await str.addFrame(p);
    }
    const a = join(await mem.finish());
    await str.finish();
    expect(sink.closed).toBe(true);
    const b = join(sink.parts);
    expect(summary(b)).toEqual(summary(a));
    const mdat = parseBoxes(b)[1];
    expect(mdat.size).toBe(16 + frames * hapFixedFrameBytes(mem.textureBytes));
  });

  it('refuses a non-seekable sink when the size is not known up front (Snappy)', () => {
    expect(() => beginHap({ width: W, height: H, fps: 25, snappy: true, sink: new AppendOnly(), frames: 3 })).toThrow(/declaredPayload/);
  });

  it('a declared payload that does not match is reported', async () => {
    const s = beginRawMov({ width: 4, height: 4, fps: 25, sink: new AppendOnly(), declaredPayload: 999 });
    await s.addFrame(makePicture('noise', 4, 4));
    await expect(s.finish()).rejects.toThrow(/declared/);
  });

  it('an empty export is still a readable file', async () => {
    const sink = new MemorySink();
    const s = beginRawMov({ width: 4, height: 4, fps: 25, sink });
    await s.finish();
    expect(parseBoxes(sink.concat()).map((b) => b.type)).toEqual(['ftyp', 'mdat', 'moov']);
  });
});
