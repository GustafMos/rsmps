/** Test-only helpers: synthetic pictures and a small ISO/QuickTime box reader. Not part of the shipped encoders. */

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export type Picture = 'gradient' | 'noise' | 'edges' | 'alpha' | 'pixelart';

export function makePicture(kind: Picture, w: number, h: number, seed = 1): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const r = rng(seed);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c: [number, number, number, number];
      if (kind === 'gradient') c = [(x / w) * 255, (y / h) * 255, ((x + y) / (w + h)) * 255, 255];
      else if (kind === 'noise') c = [r() * 255, r() * 255, r() * 255, 255];
      else if (kind === 'edges') {
        const on = ((x >> 3) + (y >> 3)) & 1;
        c = on ? [255, 40, 20, 255] : [10, 30, 240, 255];
      } else if (kind === 'alpha') c = [200, 120 + (x / w) * 100, 40, (x / w) * 255];
      else {
        const pal = [[20, 20, 40], [200, 60, 60], [240, 220, 120], [60, 160, 90], [250, 250, 250]];
        const p = pal[(((x >> 2) * 7 + (y >> 2) * 13) >> 1) % 5];
        c = [p[0], p[1], p[2], 255];
      }
      out[i] = Math.round(c[0]);
      out[i + 1] = Math.round(c[1]);
      out[i + 2] = Math.round(c[2]);
      out[i + 3] = Math.round(c[3]);
    }
  }
  return out;
}

export interface Box {
  type: string;
  start: number;
  size: number;
  headSize: number;
  children: Box[];
}
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf']);

export function parseBoxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = v.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    let head = 8;
    if (size === 1) {
      size = v.getUint32(at + 8) * 4294967296 + v.getUint32(at + 12);
      head = 16;
    } else if (size === 0) size = end - at;
    if (size < head || at + size > end) throw new Error(`bad box ${type} at ${at}: size ${size}`);
    out.push({ type, start: at, size, headSize: head, children: CONTAINERS.has(type) ? parseBoxes(bytes, at + head, at + size) : [] });
    at += size;
  }
  return out;
}

export function find(boxes: Box[], path: string): Box | undefined {
  const [first, ...rest] = path.split('/');
  const b = boxes.find((x) => x.type === first);
  if (!b || !rest.length) return b;
  return find(b.children, rest.join('/'));
}
export function findAll(boxes: Box[], type: string): Box[] {
  return boxes.filter((b) => b.type === type);
}

export interface MovTrackInfo {
  handler: string;
  fourcc: string;
  timescale: number;
  duration: number;
  sizes: number[];
  offsets: number[];
  samplesPerChunk: number[];
  deltas: number[];
  sampleSize: number;
  entry: Uint8Array;
  width: number;
  height: number;
}

/** Read the sample tables of every track. Sample order is the file order of the chunks of that track. */
export function readMov(file: Uint8Array): { tracks: MovTrackInfo[]; movieDuration: number; movieTimescale: number; boxes: Box[] } {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const boxes = parseBoxes(file);
  const moov = find(boxes, 'moov')!;
  const mvhd = find(moov.children, 'mvhd')!;
  const tracks: MovTrackInfo[] = [];
  for (const trak of findAll(moov.children, 'trak')) {
    const mdhd = find(trak.children, 'mdia/mdhd')!;
    const hdlr = find(trak.children, 'mdia/hdlr')!;
    const tkhd = find(trak.children, 'tkhd')!;
    const stbl = find(trak.children, 'mdia/minf/stbl')!;
    const s = (t: string) => find(stbl.children, t);
    const stsd = s('stsd')!;
    const eStart = stsd.start + 16;
    const eSize = v.getUint32(eStart);
    const fourcc = String.fromCharCode(...file.subarray(eStart + 4, eStart + 8));
    const stsz = s('stsz')!;
    const sampleSize = v.getUint32(stsz.start + 12);
    const n = v.getUint32(stsz.start + 16);
    const sizes: number[] = [];
    if (sampleSize === 0) for (let i = 0; i < n; i++) sizes.push(v.getUint32(stsz.start + 20 + i * 4));
    const co = s('stco') ?? s('co64')!;
    const nc = v.getUint32(co.start + 12);
    const offsets: number[] = [];
    for (let i = 0; i < nc; i++) offsets.push(co.type === 'stco' ? v.getUint32(co.start + 16 + i * 4) : v.getUint32(co.start + 16 + i * 8) * 4294967296 + v.getUint32(co.start + 20 + i * 8));
    const stsc = s('stsc')!;
    const ne = v.getUint32(stsc.start + 12);
    const runs: [number, number][] = [];
    for (let i = 0; i < ne; i++) runs.push([v.getUint32(stsc.start + 16 + i * 12), v.getUint32(stsc.start + 20 + i * 12)]);
    const samplesPerChunk: number[] = [];
    for (let c = 1; c <= nc; c++) {
      let cur = runs[0][1];
      for (const [first, cnt] of runs) if (first <= c) cur = cnt;
      samplesPerChunk.push(cur);
    }
    const stts = s('stts')!;
    const nt = v.getUint32(stts.start + 12);
    const deltas: number[] = [];
    for (let i = 0; i < nt; i++) {
      const cnt = v.getUint32(stts.start + 16 + i * 8);
      const d = v.getUint32(stts.start + 20 + i * 8);
      for (let k = 0; k < cnt; k++) deltas.push(d);
    }
    tracks.push({
      handler: String.fromCharCode(...file.subarray(hdlr.start + 16, hdlr.start + 20)),
      fourcc,
      timescale: v.getUint32(mdhd.start + 20),
      duration: v.getUint32(mdhd.start + 24),
      sizes,
      offsets,
      samplesPerChunk,
      deltas,
      sampleSize,
      entry: file.subarray(eStart + 8, eStart + eSize),
      width: v.getUint32(tkhd.start + 8 + 76) / 65536,
      height: v.getUint32(tkhd.start + 8 + 80) / 65536,
    });
  }
  return { tracks, movieDuration: v.getUint32(mvhd.start + 24), movieTimescale: v.getUint32(mvhd.start + 20), boxes };
}

/** Video samples of the first track as byte slices of the file. */
export function videoSamples(file: Uint8Array, t: MovTrackInfo): Uint8Array[] {
  return t.sizes.map((s, i) => file.subarray(t.offsets[i], t.offsets[i] + s));
}

export function join(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
