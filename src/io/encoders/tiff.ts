/**
 * Baseline TIFF 6.0 writer (little-endian, chunky RGB or RGBA, 8 or 16 bit, strips, optional Adobe deflate with horizontal predictor,
 * ExtraSamples = unassociated alpha, SampleFormat = unsigned integer). Several pages make a multi-page file. The format is an open
 * specification (Adobe, 1992); "TIFF" is a trademark of its owner and is used here only as a format name.
 */
import { zlibSync } from 'fflate';
import { ByteWriter, concat, type Pixels } from './util';

export interface TiffPage {
  width: number;
  height: number;
  /** RGBA8 (Uint8Array / Uint8ClampedArray) or RGBA16 (Uint16Array), straight alpha, 4 samples per pixel. */
  data: Pixels | Uint16Array;
}

export interface TiffOptions {
  compression?: 'none' | 'deflate';
  /** Horizontal differencing before deflate (default true). */
  predictor?: boolean;
  /** false writes RGB only (alpha dropped, composited over nothing: the stored colour is used as is). Default true. */
  alpha?: boolean;
  /** Pixels per inch written as the resolution (default none). */
  dpi?: number;
}

const BYTE_TARGET = 131072;

function pageBytes(p: TiffPage, alpha: boolean, bits: 8 | 16): Uint8Array {
  const n = p.width * p.height;
  const ch = alpha ? 4 : 3;
  const bps = bits / 8;
  const out = new Uint8Array(n * ch * bps);
  if (bits === 8) {
    const s = p.data as Pixels;
    if (alpha) out.set(s);
    else for (let i = 0; i < n; i++) out.set(s.subarray(i * 4, i * 4 + 3), i * 3);
  } else {
    const s = p.data as Uint16Array;
    const v = new DataView(out.buffer);
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) v.setUint16((i * ch + c) * 2, s[i * 4 + c], true);
  }
  return out;
}

export function encodeTiffPages(pages: TiffPage[], opts: TiffOptions = {}): Uint8Array {
  if (!pages.length) throw new Error('TIFF: no pages.');
  const alpha = opts.alpha ?? true;
  const deflate = opts.compression === 'deflate';
  const predictor = deflate && (opts.predictor ?? true);
  const ch = alpha ? 4 : 3;
  const parts: Uint8Array[] = [new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0])];
  let cur = 8;
  const push = (b: Uint8Array) => {
    parts.push(b);
    cur += b.length;
    if (cur & 1) {
      parts.push(new Uint8Array(1));
      cur++;
    }
  };
  let prevNextPtr: { part: Uint8Array; at: number } | null = null;
  for (const p of pages) {
    const bits: 8 | 16 = p.data instanceof Uint16Array ? 16 : 8;
    if (p.data.length !== p.width * p.height * 4) throw new Error('TIFF: the pixel data does not match the size.');
    const bps = bits / 8;
    const stride = p.width * ch * bps;
    const raw = pageBytes(p, alpha, bits);
    const rows = Math.max(1, Math.min(p.height, Math.floor(BYTE_TARGET / stride)));
    const strips: Uint8Array[] = [];
    for (let y = 0; y < p.height; y += rows) {
      const n = Math.min(rows, p.height - y);
      let strip = raw.slice(y * stride, (y + n) * stride);
      if (predictor) {
        for (let r = 0; r < n; r++) {
          const base = r * stride;
          if (bits === 8) for (let i = stride - 1; i >= ch; i--) strip[base + i] = (strip[base + i] - strip[base + i - ch]) & 255;
          else {
            const v = new DataView(strip.buffer, strip.byteOffset + base, stride);
            for (let i = p.width * ch - 1; i >= ch; i--) v.setUint16(i * 2, (v.getUint16(i * 2, true) - v.getUint16((i - ch) * 2, true)) & 0xffff, true);
          }
        }
      }
      strips.push(deflate ? zlibSync(strip, { level: 6 }) : strip);
    }
    const offsets: number[] = [];
    for (const s of strips) {
      offsets.push(cur);
      push(s);
    }
    // Out-of-line values
    const bpsOff = cur;
    const bw = new ByteWriter(16);
    for (let c = 0; c < ch; c++) bw.u16(bits, true);
    push(bw.result());
    const sfOff = cur;
    if (bits === 16) {
      const sf = new ByteWriter(8);
      for (let c = 0; c < ch; c++) sf.u16(1, true);
      push(sf.result());
    }
    let offTable = 0;
    let cntTable = 0;
    if (strips.length > 1) {
      const ow = new ByteWriter(strips.length * 4);
      offsets.forEach((o) => ow.u32(o, true));
      offTable = cur;
      push(ow.result());
      const cw = new ByteWriter(strips.length * 4);
      strips.forEach((s) => cw.u32(s.length, true));
      cntTable = cur;
      push(cw.result());
    }
    let resOff = 0;
    if (opts.dpi) {
      const rw = new ByteWriter(16).u32(Math.round(opts.dpi), true).u32(1, true).u32(Math.round(opts.dpi), true).u32(1, true);
      resOff = cur;
      push(rw.result());
    }
    type Entry = [number, number, number, number];
    const entries: Entry[] = [
      [256, 4, 1, p.width],
      [257, 4, 1, p.height],
      [258, 3, ch, ch <= 2 ? bits : bpsOff],
      [259, 3, 1, deflate ? 8 : 1],
      [262, 3, 1, 2],
      [273, 4, strips.length, strips.length === 1 ? offsets[0] : offTable],
      [277, 3, 1, ch],
      [278, 4, 1, rows],
      [279, 4, strips.length, strips.length === 1 ? strips[0].length : cntTable],
    ];
    if (opts.dpi) entries.push([282, 5, 1, resOff], [283, 5, 1, resOff + 8], [296, 3, 1, 2]);
    entries.push([284, 3, 1, 1]);
    if (predictor) entries.push([317, 3, 1, 2]);
    if (alpha) entries.push([338, 3, 1, 2]);
    if (bits === 16) entries.push([339, 3, ch, sfOff]);
    entries.sort((a, b) => a[0] - b[0]);
    const ifd = new ByteWriter(2 + entries.length * 12 + 4).u16(entries.length, true);
    for (const [tag, type, count, value] of entries) {
      ifd.u16(tag, true).u16(type, true).u32(count, true);
      if (type === 3 && count === 1) ifd.u16(value, true).u16(0);
      else ifd.u32(value, true);
    }
    const ifdStart = cur;
    ifd.u32(0, true);
    const ifdBytes = ifd.result();
    if (prevNextPtr) new DataView(prevNextPtr.part.buffer, prevNextPtr.part.byteOffset).setUint32(prevNextPtr.at, ifdStart, true);
    else new DataView(parts[0].buffer).setUint32(4, ifdStart, true);
    push(ifdBytes);
    prevNextPtr = { part: ifdBytes, at: ifdBytes.length - 4 };
  }
  return concat(parts);
}

export function encodeTiff(data: Pixels | Uint16Array, width: number, height: number, opts: TiffOptions = {}): Uint8Array {
  return encodeTiffPages([{ width, height, data }], opts);
}
