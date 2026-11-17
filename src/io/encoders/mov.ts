/**
 * QuickTime MOV muxer for all-intra video (every sample is a sync sample) with an optional uncompressed PCM audio track.
 * Layout: ftyp, mdat (16-byte header with a 64-bit size only when needed), moov. Sample data is not copied: `finish()` returns blob
 * parts [head, ...samples, moov], so the caller must hand over each sample as its own buffer and not reuse it afterwards.
 * Streaming: with `sink` set, nothing is kept. ftyp and a 64-bit `mdat` header go out first, each sample is written as it is added and the
 * `moov` index is appended at the END (valid QuickTime; every reader that handles FFmpeg's default MOV handles it). The mdat size is then
 * patched with one seek-write; a sink that cannot seek needs `declaredPayload` (the exact byte count of all samples), which fixed-size
 * frames (HAP without Snappy, raw MOV) allow.
 * Timing: media timescale = fps*1000 for integer rates (sample delta 1000) or the rational numerator (30000/1001 -> 30000, delta 1001).
 * No edit lists. Chunk offsets switch to co64 when the file passes 4 GiB. Written from the QuickTime File Format / ISO 14496-12 layouts.
 */
import type { ByteSink } from './sink';
import { ByteWriter, concat, toFps, type Fps } from './util';

export interface MovVideoConfig {
  /** Sample entry fourcc, e.g. 'Hap1', 'jpeg', 'png ', 'raw '. */
  fourcc: string;
  /** Shown by QuickTime-style readers, at most 31 characters. */
  compressorName: string;
  /** 24 or 32 (32 = the track carries alpha). */
  depth: 24 | 32;
}

export interface MovAudioConfig {
  sampleRate: number;
  channels: number;
  /** 16 = 'sowt' (little-endian), 24 = 'in24' (big-endian). */
  bits: 16 | 24;
}

export interface MovOptions {
  width: number;
  height: number;
  fps: number | Fps;
  video: MovVideoConfig;
  audio?: MovAudioConfig;
  /** Write through this sink instead of collecting the file; finish with `close()`. */
  sink?: ByteSink;
  /** Total bytes of all video and audio samples when known up front (needed for a sink that cannot seek). */
  declaredPayload?: number;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  let n = 8;
  for (const p of payload) n += p.length;
  const out = new Uint8Array(n);
  const v = new DataView(out.buffer);
  v.setUint32(0, n);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let at = 8;
  for (const p of payload) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const w = () => new ByteWriter(64);
const full = (version: number, flags: number) => w().u8(version).u8((flags >> 16) & 255).u8((flags >> 8) & 255).u8(flags & 255);
const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
const pascal = (s: string, size: number) => {
  const out = new Uint8Array(size);
  const t = s.slice(0, size - 1);
  out[0] = t.length;
  for (let i = 0; i < t.length; i++) out[1 + i] = t.charCodeAt(i);
  return out;
};

/** The sample timing a frame rate gets: media timescale and sample delta. */
export function movTiming(fps: number | Fps): { timescale: number; delta: number } {
  const f = toFps(fps);
  return f.den === 1 ? { timescale: f.num * 1000, delta: 1000 } : { timescale: f.num, delta: f.den };
}

interface Chunk {
  track: 0 | 1;
  /** Kept only when the muxer collects the file itself. */
  data?: Uint8Array;
  size: number;
  samples: number;
  /** Absolute file position (sink mode). */
  offset?: number;
}

export class MovMuxer {
  private chunks: Chunk[] = [];
  private videoSizes: number[] = [];
  private audioFrames = 0;
  private readonly timing: { timescale: number; delta: number };
  private readonly sink?: ByteSink;
  private pos = 0;
  private started = false;
  private readonly ftyp = box('ftyp', w().ascii('qt  ').u32(0x00000200).ascii('qt  ').result());
  constructor(private readonly o: MovOptions) {
    if (!(o.width >= 1 && o.height >= 1)) throw new Error('mov: invalid size.');
    if (o.video.fourcc.length !== 4) throw new Error('mov: fourcc must be 4 characters.');
    this.timing = movTiming(o.fps);
    this.sink = o.sink;
    if (o.sink && !o.sink.seekable && o.declaredPayload === undefined) throw new Error('mov: a sink that cannot seek needs declaredPayload (use a seekable sink or fixed-size frames).');
  }

  get videoFrames(): number {
    return this.videoSizes.length;
  }

  /** True when samples go straight to a sink (the caller must `await` addVideo / addAudio and end with `close()`). */
  get streaming(): boolean {
    return !!this.sink;
  }

  /** Bytes of media data so far (samples only). */
  get payloadBytes(): number {
    return this.chunks.reduce((n, c) => n + c.size, 0);
  }

  private async put(track: 0 | 1, samples: number, data: Uint8Array): Promise<void> {
    const sink = this.sink!;
    if (!this.started) {
      this.started = true;
      const head = concat([this.ftyp, w().u32(1).ascii('mdat').u64((this.o.declaredPayload ?? 0) + 16).result()]);
      await sink.write(head);
      this.pos = head.length;
    }
    const offset = this.pos;
    await sink.write(data);
    this.pos += data.length;
    this.chunks.push({ track, size: data.length, samples, offset });
  }

  addVideo(sample: Uint8Array): void | Promise<void> {
    this.videoSizes.push(sample.length);
    if (this.sink) return this.put(0, 1, sample);
    this.chunks.push({ track: 0, data: sample, size: sample.length, samples: 1 });
  }

  /** One Float32Array per channel (-1..1). Converted to 16-bit LE or 24-bit BE PCM. */
  addAudio(channels: Float32Array[]): void | Promise<void> {
    const a = this.o.audio;
    if (!a) throw new Error('mov: no audio track was configured.');
    const frames = channels[0]?.length ?? 0;
    if (!frames) return;
    const bps = a.bits / 8;
    const out = new Uint8Array(frames * a.channels * bps);
    let o = 0;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < a.channels; c++) {
        const x = Math.max(-1, Math.min(1, channels[Math.min(c, channels.length - 1)][i] ?? 0));
        if (a.bits === 16) {
          const n = Math.round(x < 0 ? x * 0x8000 : x * 0x7fff);
          out[o++] = n & 255;
          out[o++] = (n >> 8) & 255;
        } else {
          const n = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
          out[o++] = (n >> 16) & 255;
          out[o++] = (n >> 8) & 255;
          out[o++] = n & 255;
        }
      }
    }
    this.audioFrames += frames;
    if (this.sink) return this.put(1, frames, out);
    this.chunks.push({ track: 1, data: out, size: out.length, samples: frames });
  }

  /** In-memory result: blob parts [head, ...samples, moov]. */
  finish(): Uint8Array[] {
    if (this.sink) throw new Error('mov: this muxer writes to a sink; call close().');
    const payload = this.payloadBytes;
    const big = payload + 8 > 0xffffffff;
    const ftyp = this.ftyp;
    const mdatHead = big ? w().u32(1).ascii('mdat').u64(payload + 16).result() : w().u32(payload + 8).ascii('mdat').result();
    const base = ftyp.length + mdatHead.length;
    const offsets: number[][] = [[], []];
    const counts: number[][] = [[], []];
    let at = base;
    for (const c of this.chunks) {
      offsets[c.track].push(at);
      counts[c.track].push(c.samples);
      at += c.size;
    }
    return [concat([ftyp, mdatHead]), ...this.chunks.map((c) => c.data!), this.moov(offsets, counts, at > 0xffffffff)];
  }

  /** Sink mode: append the index, patch the mdat size, close the sink. The file is complete afterwards. */
  async close(): Promise<void> {
    const sink = this.sink;
    if (!sink) throw new Error('mov: no sink; use finish().');
    if (!this.started) {
      // no sample at all: still a valid (empty) file
      this.started = true;
      const head = concat([this.ftyp, w().u32(1).ascii('mdat').u64(16).result()]);
      await sink.write(head);
      this.pos = head.length;
    }
    const headLen = this.ftyp.length + 16;
    const payload = this.pos - headLen;
    const declared = this.o.declaredPayload;
    if (declared !== undefined && declared !== payload) throw new Error(`mov: ${payload} bytes of samples were written but ${declared} were declared.`);
    const offsets: number[][] = [[], []];
    const counts: number[][] = [[], []];
    for (const c of this.chunks) {
      offsets[c.track].push(c.offset!);
      counts[c.track].push(c.samples);
    }
    await sink.write(this.moov(offsets, counts, this.pos > 0xffffffff));
    if (declared === undefined) await sink.writeAt!(w().u64(payload + 16).result(), this.ftyp.length + 8);
    await sink.close();
  }

  private moov(offsets: number[][], counts: number[][], co64: boolean): Uint8Array {
    const { width, height, video, audio } = this.o;
    const { timescale, delta } = this.timing;
    const nFrames = this.videoSizes.length;

    const MOVIE_TS = 1000;
    const videoSeconds = (nFrames * delta) / timescale;
    const audioSeconds = audio ? this.audioFrames / audio.sampleRate : 0;
    const movieDuration = Math.round(Math.max(videoSeconds, audioSeconds) * MOVIE_TS);

    const chunkOffsets = (list: number[]) => {
      const b = full(0, 0).u32(list.length);
      for (const o of list) co64 ? b.u64(o) : b.u32(o);
      return box(co64 ? 'co64' : 'stco', b.result());
    };
    const stscFor = (cnt: number[]) => {
      const runs: [number, number][] = [];
      cnt.forEach((n, i) => {
        if (!runs.length || runs[runs.length - 1][1] !== n) runs.push([i + 1, n]);
      });
      const b = full(0, 0).u32(runs.length);
      for (const [first, n] of runs) b.u32(first).u32(n).u32(1);
      return box('stsc', b.result());
    };
    const dinf = box('dinf', box('dref', full(0, 0).u32(1).result(), box('alis', full(0, 1).result())));
    const hdlr = (sub: string, name: string) =>
      box('hdlr', full(0, 0).ascii('mhlr').ascii(sub).u32(0).u32(0).u32(0).bytes(pascal(name, name.length + 1)).result());
    const dhlr = box('hdlr', full(0, 0).ascii('dhlr').ascii('alis').u32(0).u32(0).u32(0).u8(0).result());
    const tkhd = (id: number, duration: number, audioTrack: boolean) => {
      const b = full(0, 7).u32(0).u32(0).u32(id).u32(0).u32(duration).u32(0).u32(0).u16(0).u16(0).u16(audioTrack ? 0x0100 : 0).u16(0);
      for (const m of MATRIX) b.u32(m);
      b.u32(audioTrack ? 0 : width * 65536).u32(audioTrack ? 0 : height * 65536);
      return box('tkhd', b.result());
    };
    const mdhd = (ts: number, duration: number) => box('mdhd', full(0, 0).u32(0).u32(0).u32(ts).u32(duration).u16(0x55c4).u16(0).result());

    // Video track.
    const entry = w()
      .zeros(6)
      .u16(1)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(0)
      .u32(0x400)
      .u16(width)
      .u16(height)
      .u32(0x00480000)
      .u32(0x00480000)
      .u32(0)
      .u16(1)
      .bytes(pascal(video.compressorName, 32))
      .u16(video.depth)
      .u16(0xffff)
      .result();
    const vsizes = full(0, 0).u32(0).u32(nFrames);
    for (const s of this.videoSizes) vsizes.u32(s);
    const vstbl = box(
      'stbl',
      box('stsd', full(0, 0).u32(1).result(), box(video.fourcc, entry)),
      box('stts', full(0, 0).u32(1).u32(nFrames).u32(delta).result()),
      stscFor(counts[0]),
      box('stsz', vsizes.result()),
      chunkOffsets(offsets[0]),
    );
    const vtrak = box(
      'trak',
      tkhd(1, Math.round((videoSeconds * MOVIE_TS)), false),
      box(
        'mdia',
        mdhd(timescale, nFrames * delta),
        hdlr('vide', 'VideoHandler'),
        box('minf', box('vmhd', full(0, 1).u16(0).u16(0).u16(0).u16(0).result()), dhlr, dinf, vstbl),
      ),
    );

    const traks = [vtrak];
    if (audio) {
      const bps = audio.bits / 8;
      const v1 = audio.bits === 24;
      const ae = w().zeros(6).u16(1).u16(v1 ? 1 : 0).u16(0).u32(0).u16(audio.channels).u16(audio.bits).u16(0).u16(0).u32(audio.sampleRate * 65536);
      if (v1) ae.u32(1).u32(bps).u32(bps * audio.channels).u32(bps);
      const astbl = box(
        'stbl',
        box('stsd', full(0, 0).u32(1).result(), box(audio.bits === 16 ? 'sowt' : 'in24', ae.result())),
        box('stts', full(0, 0).u32(1).u32(this.audioFrames).u32(1).result()),
        stscFor(counts[1]),
        box('stsz', full(0, 0).u32(bps * audio.channels).u32(this.audioFrames).result()),
        chunkOffsets(offsets[1]),
      );
      traks.push(
        box(
          'trak',
          tkhd(2, Math.round(audioSeconds * MOVIE_TS), true),
          box(
            'mdia',
            mdhd(audio.sampleRate, this.audioFrames),
            hdlr('soun', 'SoundHandler'),
            box('minf', box('smhd', full(0, 0).u16(0).u16(0).result()), dhlr, dinf, astbl),
          ),
        ),
      );
    }
    const mvhd = full(0, 0).u32(0).u32(0).u32(MOVIE_TS).u32(movieDuration).u32(0x00010000).u16(0x0100).zeros(10);
    for (const m of MATRIX) mvhd.u32(m);
    mvhd.zeros(24).u32(traks.length + 1);
    return box('moov', box('mvhd', mvhd.result()), ...traks);
  }
}

export function createMovMuxer(o: MovOptions): MovMuxer {
  return new MovMuxer(o);
}
