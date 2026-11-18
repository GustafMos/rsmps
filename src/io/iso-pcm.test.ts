import { describe, expect, it } from 'vitest';
import { pcmBytesToFloat, pcmLayoutOf, readIsoPcm, readIsoPcmTable } from './iso-pcm';

/* A tiny MP4 builder: just the boxes the reader looks at. */
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const be32 = (...v: number[]): Uint8Array => {
  const out = new Uint8Array(v.length * 4);
  v.forEach((x, i) => new DataView(out.buffer).setUint32(i * 4, x));
  return out;
};
const text = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const box = (type: string, ...payload: Uint8Array[]): Uint8Array => {
  const body = cat(...payload);
  return cat(be32(body.length + 8), text(type), body);
};

interface Track {
  id: number;
  handler: 'soun' | 'vide';
  /** [first chunk (1-based), entries per chunk] runs. */
  stsc: [number, number][];
  /** A constant entry size, or one size per entry. */
  sizes: number | number[];
  entries: number;
  /** Frames each entry lasts. */
  delta: number;
  /** Chunk payloads, written into mdat in this order (interleaved with `between`). */
  chunks: Uint8Array[];
}

/** ftyp, mdat (chunks of all tracks interleaved, with junk between them), moov. */
function mp4(tracks: Track[], opts: { moovFirst?: boolean } = {}): Uint8Array {
  const ftyp = box('ftyp', text('isom'), be32(0), text('isom'));
  const build = (base: number) => {
    const offsets: number[][] = tracks.map(() => []);
    const data: Uint8Array[] = [];
    let at = base + 8;
    const most = Math.max(...tracks.map((t) => t.chunks.length));
    for (let c = 0; c < most; c++) {
      tracks.forEach((t, k) => {
        if (c >= t.chunks.length) return;
        offsets[k].push(at);
        data.push(t.chunks[c]);
        at += t.chunks[c].length;
      });
    }
    const traks = tracks.map((t, k) =>
      box(
        'trak',
        box('tkhd', be32(0, 0, 0, t.id, 0, 0)),
        box(
          'mdia',
          box('hdlr', be32(0, 0), text(t.handler), be32(0, 0, 0)),
          box(
            'minf',
            box(
              'stbl',
              box('stts', be32(0, 1, t.entries, t.delta)),
              box('stsc', be32(0, t.stsc.length), ...t.stsc.map(([first, n]) => be32(first, n, 1))),
              box('stsz', typeof t.sizes === 'number' ? be32(0, t.sizes, t.entries) : be32(0, 0, t.entries, ...t.sizes)),
              box('stco', be32(0, offsets[k].length, ...offsets[k])),
            ),
          ),
        ),
      ),
    );
    return { mdat: box('mdat', ...data), moov: box('moov', ...traks) };
  };
  if (!opts.moovFirst) {
    const b = build(ftyp.length);
    return cat(ftyp, b.mdat, b.moov);
  }
  const probe = build(0);
  const b = build(ftyp.length + probe.moov.length);
  return cat(ftyp, b.moov, b.mdat);
}

const readerOf = (file: Uint8Array) => async (start: number, end: number) => file.slice(start, end);

/** `frames` of 16-bit little-endian stereo: left = frame index, right = -frame index. */
function s16(from: number, frames: number): Uint8Array {
  const out = new Uint8Array(frames * 4);
  const v = new DataView(out.buffer);
  for (let i = 0; i < frames; i++) {
    v.setInt16(i * 4, from + i, true);
    v.setInt16(i * 4 + 2, -(from + i), true);
  }
  return out;
}
const video = (id: number): Track => ({ id, handler: 'vide', stsc: [[1, 1]], sizes: [5, 7, 9], entries: 3, delta: 1, chunks: [new Uint8Array(5).fill(255), new Uint8Array(7).fill(255), new Uint8Array(9).fill(255)] });
const expectRamp = (ch: Float32Array[], frames: number) => {
  expect(ch).toHaveLength(2);
  expect(ch[0]).toHaveLength(frames);
  for (const i of [0, 1, 99, 100, 101, 255, 256, frames - 1]) {
    expect(Math.round(ch[0][i] * 32768)).toBe(i);
    expect(Math.round(ch[1][i] * 32768) + i).toBe(0);
  }
};

describe('PCM sound of MP4 / MOV files', () => {
  it('reads the phone layout: one table entry per recorded buffer (the demuxer took one frame of each: ticking)', async () => {
    // 3 chunks of 2 buffers of 100 frames = 600 frames, interleaved with video chunks.
    const sound: Track = { id: 2, handler: 'soun', stsc: [[1, 2]], sizes: 400, entries: 6, delta: 100, chunks: [s16(0, 200), s16(200, 200), s16(400, 200)] };
    const file = mp4([video(1), sound]);
    const table = await readIsoPcmTable(readerOf(file), file.length, 4, 2);
    expect(table?.blocks).toBe(true);
    expect(table?.bytes).toBe(2400);
    const pcm = await readIsoPcm(readerOf(file), file.length, { codec: 'pcm-s16', channels: 2, trackId: 2 });
    expect(pcm?.blocks).toBe(true);
    expectRamp(pcm!.channels, 600);
  });
  it('reads buffers of different sizes and a changing number of buffers per chunk', async () => {
    const sound: Track = { id: 1, handler: 'soun', stsc: [[1, 2], [3, 1]], sizes: [400, 404, 396, 400, 200], entries: 5, delta: 100, chunks: [s16(0, 201), s16(201, 199), s16(400, 50)] };
    const file = mp4([sound, video(2)], { moovFirst: true });
    const pcm = await readIsoPcm(readerOf(file), file.length, { codec: 'pcm-s16', channels: 2 });
    expectRamp(pcm!.channels, 450);
  });
  it('reads the QuickTime layout (one entry per frame, size = frame, 1 or one sample) the same way', async () => {
    for (const size of [4, 1, 2]) {
      const sound: Track = { id: 2, handler: 'soun', stsc: [[1, 256], [2, 300], [3, 44]], sizes: size, entries: 600, delta: 1, chunks: [s16(0, 256), s16(256, 300), s16(556, 44)] };
      const file = mp4([video(1), sound]);
      const pcm = await readIsoPcm(readerOf(file), file.length, { codec: 'pcm-s16', channels: 2, trackId: 2 });
      expect(pcm?.blocks).toBe(false);
      expectRamp(pcm!.channels, 600);
    }
  });
  it('trusts the table when the description states the wrong sample width (packed 24-bit labelled 32-bit)', async () => {
    const frames = 300;
    const bytes = new Uint8Array(frames * 6);
    for (let i = 0; i < frames; i++) {
      const l = i * 256;
      const r = -i * 256 + (1 << 24);
      bytes.set([l & 255, (l >> 8) & 255, (l >> 16) & 255, r & 255, (r >> 8) & 255, (r >> 16) & 255], i * 6);
    }
    const sound: Track = { id: 1, handler: 'soun', stsc: [[1, 300]], sizes: 6, entries: frames, delta: 1, chunks: [bytes] };
    const file = mp4([sound]);
    const pcm = await readIsoPcm(readerOf(file), file.length, { codec: 'pcm-s32', channels: 2 });
    expectRamp(pcm!.channels, frames);
  });
  it('honours the length cap, a file cut short, and says no to what it cannot read', async () => {
    const sound: Track = { id: 2, handler: 'soun', stsc: [[1, 2]], sizes: 400, entries: 6, delta: 100, chunks: [s16(0, 200), s16(200, 200), s16(400, 200)] };
    const file = mp4([sound]);
    const capped = await readIsoPcm(readerOf(file), file.length, { codec: 'pcm-s16', channels: 2 }, 250);
    expect(capped!.channels[0]).toHaveLength(250);
    expect(Math.round(capped!.channels[0][249] * 32768)).toBe(249);
    expect(await readIsoPcm(readerOf(file), file.length, { codec: 'aac', channels: 2 })).toBeNull();
    expect(await readIsoPcm(readerOf(file), file.length, { codec: null, channels: 2 })).toBeNull();
    const onlyVideo = mp4([video(1)]);
    expect(await readIsoPcm(readerOf(onlyVideo), onlyVideo.length, { codec: 'pcm-s16', channels: 2 })).toBeNull();
    const junk = new Uint8Array(64).fill(7);
    expect(await readIsoPcm(readerOf(junk), junk.length, { codec: 'pcm-s16', channels: 2 })).toBeNull();
    const empty: Track = { ...sound, entries: 0, chunks: [] }; // a fragmented file: no samples in moov
    const frag = mp4([empty]);
    expect(await readIsoPcm(readerOf(frag), frag.length, { codec: 'pcm-s16', channels: 2 })).toBeNull();
  });
  it('converts every sample format', () => {
    const one = (codec: string, bytes: number[]) => {
      const out = [new Float32Array(1)];
      expect(pcmBytesToFloat(Uint8Array.from(bytes), pcmLayoutOf(codec)!, out, 0)).toBe(1);
      return out[0][0];
    };
    expect(one('pcm-u8', [192])).toBeCloseTo(0.5, 6);
    expect(one('pcm-s8', [0xc0])).toBeCloseTo(-0.5, 6);
    expect(one('pcm-s16', [0x00, 0x40])).toBeCloseTo(0.5, 6);
    expect(one('pcm-s16be', [0xc0, 0x00])).toBeCloseTo(-0.5, 6);
    expect(one('pcm-s24', [0x00, 0x00, 0x40])).toBeCloseTo(0.5, 6);
    expect(one('pcm-s24be', [0xc0, 0x00, 0x00])).toBeCloseTo(-0.5, 6);
    expect(one('pcm-s32', [0, 0, 0, 0x40])).toBeCloseTo(0.5, 6);
    expect(one('pcm-s32be', [0xc0, 0, 0, 0])).toBeCloseTo(-0.5, 6);
    expect(one('pcm-f32', [...new Uint8Array(new Float32Array([0.25]).buffer)])).toBeCloseTo(0.25, 6);
    expect(one('pcm-f64be', [...new Uint8Array(new Float64Array([-0.25]).buffer)].reverse())).toBeCloseTo(-0.25, 6);
    expect(pcmLayoutOf('pcm-s64')).toBeNull();
    expect(pcmLayoutOf('opus')).toBeNull();
  });
});
