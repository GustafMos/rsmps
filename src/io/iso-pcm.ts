/**
 * Uncompressed (PCM) sound of an MP4 / MOV file, read straight from the file's own tables.
 *
 * Why this exists: a PCM track can be stored in two ways.
 *   - QuickTime style: one table entry per PCM frame (48000 entries a second), grouped in chunks. Desktop tools write this.
 *   - Block style: one table entry per recorded buffer (about 1000 frames each). Phone apps write this (Blackmagic Camera
 *     with "Linear PCM" on Android, for one).
 * The demuxer the app uses for everything else assumes the first style, so for a block-style file it takes ONE frame out
 * of every buffer and leaves the rest silent: a click every 20 ms instead of the sound. This reader handles both: the
 * bytes of a chunk are always the sum of the sizes of its entries, and PCM is contiguous, so the chunks are simply read
 * in order and converted. Fragmented files (no chunk table in `moov`) are not handled here: the caller falls back.
 *
 * Pure apart from `read`: no DOM, no decoder. Tested in iso-pcm.test.ts with files built in memory.
 */

/** Reads bytes [start, end) of the file. */
export type ByteReader = (start: number, end: number) => Promise<Uint8Array>;

export interface IsoPcmTable {
  /** Bytes of one PCM frame according to the table, when it has one entry per frame and states a size (0 = not stated). */
  frameBytes: number;
  /** Byte ranges of the track's chunks, in playing order. Neighbouring chunks are merged. */
  ranges: { offset: number; size: number }[];
  /** True when the table has one entry per buffer (not one per PCM frame): the layout the general demuxer misreads. */
  blocks: boolean;
  /** Total bytes of sound. */
  bytes: number;
}

interface Box {
  type: string;
  /** Start of the payload. */
  start: number;
  /** End of the box. */
  end: number;
}

const u32 = (b: Uint8Array, at: number): number => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u64 = (b: Uint8Array, at: number): number => u32(b, at) * 2 ** 32 + u32(b, at + 4);
const fourcc = (b: Uint8Array, at: number): string => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** Child boxes inside `b[from, to)`. Stops quietly at anything malformed. */
function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32(b, at);
    let head = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = u64(b, at + 8);
      head = 16;
    } else if (size === 0) size = to - at;
    if (size < head || at + size > to) break;
    out.push({ type: fourcc(b, at + 4), start: at + head, end: at + size });
    at += size;
  }
  return out;
}
const child = (b: Uint8Array, parent: Box, type: string): Box | undefined => boxes(b, parent.start, parent.end).find((x) => x.type === type);

/** Find and load the `moov` box by walking the top-level boxes (a few small reads, wherever `moov` sits). */
async function readMoov(read: ByteReader, fileSize: number): Promise<Uint8Array | null> {
  let at = 0;
  for (let guard = 0; guard < 10000 && at + 8 <= fileSize; guard++) {
    const head = await read(at, Math.min(fileSize, at + 16));
    if (head.length < 8) return null;
    let size = u32(head, 0);
    let headLen = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = u64(head, 8);
      headLen = 16;
    } else if (size === 0) size = fileSize - at;
    if (size < headLen || at + size > fileSize) return null;
    if (fourcc(head, 4) === 'moov') {
      if (size > 256 * 1024 * 1024) return null;
      return read(at + headLen, at + size);
    }
    at += size;
  }
  return null;
}

/**
 * The chunk layout of a sound track: track `trackId` when given and present, else the first sound track.
 * `frameBytes` = bytes of one PCM frame (bytes per sample x channels). Null when the file has no such table.
 */
export async function readIsoPcmTable(read: ByteReader, fileSize: number, frameBytes: number, trackId?: number): Promise<IsoPcmTable | null> {
  const moov = await readMoov(read, fileSize);
  if (!moov) return null;
  const sound: { id: number; stbl: Box }[] = [];
  for (const trak of boxes(moov, 0, moov.length)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(moov, trak, 'tkhd');
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    const minf = mdia && child(moov, mdia, 'minf');
    const stbl = minf && child(moov, minf, 'stbl');
    if (!tkhd || !hdlr || !stbl || hdlr.end - hdlr.start < 12 || fourcc(moov, hdlr.start + 8) !== 'soun') continue;
    const id = moov[tkhd.start] === 1 ? u32(moov, tkhd.start + 20) : u32(moov, tkhd.start + 12);
    sound.push({ id, stbl });
  }
  const pick = sound.find((s) => s.id === trackId) ?? sound[0];
  if (!pick) return null;
  const stsz = child(moov, pick.stbl, 'stsz');
  const stsc = child(moov, pick.stbl, 'stsc');
  const stco = child(moov, pick.stbl, 'stco');
  const co64 = child(moov, pick.stbl, 'co64');
  const offsetsBox = stco ?? co64;
  if (!stsz || !stsc || !offsetsBox) return null;

  const constSize = u32(moov, stsz.start + 4);
  const sampleCount = u32(moov, stsz.start + 8);
  const chunkCount = u32(moov, offsetsBox.start + 4);
  const runs = u32(moov, stsc.start + 4);
  if (chunkCount === 0 || runs === 0 || sampleCount === 0) return null; // nothing here (a fragmented file keeps its samples in moof boxes)
  if (constSize === 0 && stsz.end - stsz.start < 12 + sampleCount * 4) return null;
  if (stsc.end - stsc.start < 8 + runs * 12 || offsetsBox.end - offsetsBox.start < 8 + chunkCount * (stco ? 4 : 8)) return null;

  // One entry per PCM frame is written as the frame's size, as 1 (old QuickTime), or as the size of one sample. A time table
  // that advances one frame per entry says the same, and then the entry size IS the frame size, whatever the description
  // claims (some writers label packed 24-bit sound as 32-bit).
  const stts = child(moov, pick.stbl, 'stts');
  const oneFramePerEntry = !!stts && stts.end - stts.start >= 16 && u32(moov, stts.start + 4) === 1 && u32(moov, stts.start + 12) === 1;
  const tableFrame = oneFramePerEntry && constSize > 1 && constSize !== frameBytes && !(constSize < frameBytes && frameBytes % constSize === 0) ? constSize : 0;
  const perFrame = tableFrame !== 0 || constSize === frameBytes || constSize === 1 || (constSize > 0 && constSize < frameBytes && frameBytes % constSize === 0);
  const sizeOf = (i: number): number => (constSize !== 0 ? (tableFrame || (perFrame ? frameBytes : constSize)) : u32(moov, stsz.start + 12 + i * 4));

  const ranges: { offset: number; size: number }[] = [];
  let sample = 0;
  let bytes = 0;
  for (let r = 0; r < runs && sample < sampleCount; r++) {
    const first = u32(moov, stsc.start + 8 + r * 12); // 1-based
    const perChunk = u32(moov, stsc.start + 12 + r * 12);
    const next = r + 1 < runs ? u32(moov, stsc.start + 8 + (r + 1) * 12) : chunkCount + 1;
    if (first < 1 || perChunk === 0) return null;
    for (let c = first; c < next && c <= chunkCount && sample < sampleCount; c++) {
      const offset = stco ? u32(moov, stco.start + 8 + (c - 1) * 4) : u64(moov, co64!.start + 8 + (c - 1) * 8);
      const n = Math.min(perChunk, sampleCount - sample);
      let size = 0;
      if (constSize !== 0) size = n * sizeOf(0);
      else for (let i = 0; i < n; i++) size += sizeOf(sample + i);
      sample += n;
      if (offset + size > fileSize) size = Math.max(0, fileSize - offset); // a recording cut short
      if (size === 0) continue;
      const last = ranges[ranges.length - 1];
      if (last && last.offset + last.size === offset) last.size += size;
      else ranges.push({ offset, size });
      bytes += size;
    }
  }
  if (bytes < frameBytes) return null;
  return { ranges, blocks: !perFrame, bytes, frameBytes: tableFrame };
}

export interface PcmLayout {
  /** Bytes per sample: 1, 2, 3, 4 or 8. */
  bytes: number;
  float: boolean;
  bigEndian: boolean;
  /** 8-bit only: unsigned (centre 128). */
  unsigned: boolean;
}

/** `pcm-s16`, `pcm-s24be`, `pcm-f32` ... (the codec names of the demuxer) as a layout. Null for anything else. */
export function pcmLayoutOf(codec: string | null | undefined): PcmLayout | null {
  const m = /^pcm-([suf])(8|16|24|32|64)(be)?$/.exec(codec ?? '');
  if (!m) return null;
  const bits = Number(m[2]);
  const float = m[1] === 'f';
  if (float ? bits !== 32 && bits !== 64 : bits === 64) return null;
  return { bytes: bits / 8, float, bigEndian: !!m[3], unsigned: m[1] === 'u' };
}

/**
 * Convert interleaved PCM bytes into `out` (one Float32Array per channel) starting at frame `at`. Returns the frames written.
 * A trailing partial frame is ignored.
 */
export function pcmBytesToFloat(src: Uint8Array, layout: PcmLayout, out: Float32Array[], at: number): number {
  const nch = out.length;
  const bps = layout.bytes;
  const frames = Math.max(0, Math.min(Math.floor(src.length / (bps * nch)), out[0].length - at));
  const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
  const le = !layout.bigEndian;
  let o = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, o += bps) {
      let v: number;
      if (layout.float) v = bps === 4 ? view.getFloat32(o, le) : view.getFloat64(o, le);
      else if (bps === 1) v = layout.unsigned ? (src[o] - 128) / 128 : view.getInt8(o) / 128;
      else if (bps === 2) v = view.getInt16(o, le) / 32768;
      else if (bps === 3) v = (((le ? src[o] | (src[o + 1] << 8) | (src[o + 2] << 16) : src[o + 2] | (src[o + 1] << 8) | (src[o] << 16)) << 8) >> 8) / 8388608;
      else v = view.getInt32(o, le) / 2147483648;
      out[c][at + i] = v;
    }
  }
  return frames;
}

/**
 * All of a PCM track as float channels (every channel of the file; the caller folds down). `maxFrames` caps very long tracks.
 * Null when the file has no plain chunk table for the track.
 */
export async function readIsoPcm(
  read: ByteReader,
  fileSize: number,
  format: { codec: string | null; channels: number; trackId?: number },
  maxFrames = Infinity,
): Promise<{ channels: Float32Array[]; blocks: boolean } | null> {
  const layout = pcmLayoutOf(format.codec);
  const nch = Math.floor(format.channels);
  if (!layout || !(nch >= 1 && nch <= 64)) return null;
  let frameBytes = layout.bytes * nch;
  const table = await readIsoPcmTable(read, fileSize, frameBytes, format.trackId);
  if (!table) return null;
  if (table.frameBytes) {
    // The table disagrees with the description about the sample width: the table is what the bytes were laid out by.
    const width = table.frameBytes / nch;
    if (layout.float || ![1, 2, 3, 4].includes(width)) return null;
    layout.bytes = width;
    frameBytes = table.frameBytes;
  }
  const total = Math.min(Math.floor(table.bytes / frameBytes), Math.floor(maxFrames));
  if (total < 1) return null;
  const channels = Array.from({ length: nch }, () => new Float32Array(total));
  const STEP = 8 * 1024 * 1024 - ((8 * 1024 * 1024) % frameBytes); // read large ranges in pieces of whole frames
  let at = 0;
  let carry = new Uint8Array(0); // a frame split across two chunks
  for (const r of table.ranges) {
    for (let p = 0; p < r.size && at < total; p += STEP) {
      const part = await read(r.offset + p, r.offset + Math.min(r.size, p + STEP));
      let bytes = part;
      if (carry.length) {
        bytes = new Uint8Array(carry.length + part.length);
        bytes.set(carry);
        bytes.set(part, carry.length);
      }
      const whole = bytes.length - (bytes.length % frameBytes);
      at += pcmBytesToFloat(bytes.subarray(0, whole), layout, channels, at);
      carry = bytes.slice(whole);
    }
    if (at >= total) break;
  }
  return { channels: at < total ? channels.map((c) => c.subarray(0, at)) : channels, blocks: table.blocks };
}
