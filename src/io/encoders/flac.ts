/**
 * FLAC encoder (lossless audio), written from the public FLAC format specification (xiph.org/flac/format.html; the format is
 * royalty-free and the specification is published under CC BY). Fixed blocks of 4096 samples, per channel the best of
 * CONSTANT / VERBATIM / FIXED predictor (orders 0-4) with partitioned Rice coding, independent channel assignment, CRC-8 / CRC-16.
 * 16 or 24 bit, 1-8 channels, any sample rate up to 655350 Hz. The STREAMINFO MD5 is left zero ("unknown"), which the spec allows.
 * Ratio is typically 50-70 % of PCM (a real LPC encoder would add 5-10 points; not attempted).
 */
import { ByteWriter } from './util';

const BLOCK = 4096;

const CRC8 = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 255 : (c << 1) & 255;
    t[i] = c;
  }
  return t;
})();
const CRC16 = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
    t[i] = c;
  }
  return t;
})();
export function crc8(b: Uint8Array, s = 0, e = b.length): number {
  let c = 0;
  for (let i = s; i < e; i++) c = CRC8[c ^ b[i]];
  return c;
}
export function crc16(b: Uint8Array, s = 0, e = b.length): number {
  let c = 0;
  for (let i = s; i < e; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]];
  return c;
}

class Bits {
  buf = new Uint8Array(1 << 14);
  n = 0; // bytes complete
  acc = 0;
  have = 0;
  private grow(): void {
    if (this.n + 8 > this.buf.length) {
      const b = new Uint8Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
  }
  /** up to 24 bits */
  put(v: number, bits: number): void {
    if (bits > 24) {
      this.put(Math.floor(v / 2 ** (bits - 24)) & ((1 << (bits - 24)) - 1), bits - 24);
      this.put(v & 0xffffff, 24);
      return;
    }
    this.acc = (this.acc << bits) | (v & ((1 << bits) - 1));
    this.have += bits;
    while (this.have >= 8) {
      this.grow();
      this.buf[this.n++] = (this.acc >>> (this.have - 8)) & 255;
      this.have -= 8;
    }
    this.acc &= (1 << this.have) - 1;
  }
  unary(q: number): void {
    while (q >= 16) {
      this.put(0, 16);
      q -= 16;
    }
    this.put(1, q + 1);
  }
  align(): void {
    if (this.have) this.put(0, 8 - this.have);
  }
  bytes(): Uint8Array {
    return this.buf.subarray(0, this.n);
  }
}

const zig = (v: number) => (v >= 0 ? v * 2 : -v * 2 - 1);

/** Bits needed for residuals r[from..to) with Rice parameter k. */
function riceBits(u: Float64Array, from: number, to: number, k: number): number {
  let bits = (to - from) * (1 + k);
  for (let i = from; i < to; i++) bits += Math.floor(u[i] / 2 ** k);
  return bits;
}

function bestK(u: Float64Array, from: number, to: number): { k: number; bits: number } {
  let sum = 0;
  for (let i = from; i < to; i++) sum += u[i];
  const mean = sum / Math.max(1, to - from);
  const est = mean < 1 ? 0 : Math.min(14, Math.floor(Math.log2(mean)));
  let best = { k: est, bits: Infinity };
  for (let k = Math.max(0, est - 1); k <= Math.min(14, est + 1); k++) {
    const b = riceBits(u, from, to, k);
    if (b < best.bits) best = { k, bits: b };
  }
  return best;
}

function writeSubframe(w: Bits, x: Int32Array, bps: number): void {
  const n = x.length;
  let constant = true;
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) {
    w.put(0, 8); // CONSTANT, no wasted bits
    w.put(x[0], bps);
    return;
  }
  // choose fixed order by smallest sum of absolute residuals
  let bestOrder = 0;
  let bestSum = Infinity;
  const res = new Float64Array(n);
  let bestRes = res;
  for (let order = 0; order <= Math.min(4, n - 1); order++) {
    const r = new Float64Array(n);
    let s = 0;
    for (let i = order; i < n; i++) {
      let p = 0;
      if (order === 1) p = x[i - 1];
      else if (order === 2) p = 2 * x[i - 1] - x[i - 2];
      else if (order === 3) p = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3];
      else if (order === 4) p = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
      r[i] = x[i] - p;
      s += Math.abs(r[i]);
    }
    if (s < bestSum) {
      bestSum = s;
      bestOrder = order;
      bestRes = r;
    }
  }
  const u = new Float64Array(n);
  for (let i = bestOrder; i < n; i++) u[i] = zig(bestRes[i]);
  // best partition order
  let bestBits = Infinity;
  let bestPo = 0;
  let bestKs: number[] = [];
  for (let po = 0; po <= 8; po++) {
    const parts = 1 << po;
    if (n % parts !== 0 || n / parts <= bestOrder) break;
    const size = n / parts;
    let bits = 4 + 4 * parts + 2;
    const ks: number[] = [];
    for (let p = 0; p < parts; p++) {
      const from = Math.max(p * size, bestOrder);
      const { k, bits: b } = bestK(u, from, (p + 1) * size);
      ks.push(k);
      bits += b;
    }
    if (bits < bestBits) {
      bestBits = bits;
      bestPo = po;
      bestKs = ks;
    }
  }
  const fixedBits = 8 + bestOrder * bps + bestBits;
  const verbatimBits = 8 + n * bps;
  if (!(fixedBits < verbatimBits)) {
    w.put(2, 8); // VERBATIM
    for (let i = 0; i < n; i++) w.put(x[i], bps);
    return;
  }
  w.put(0x10 | (bestOrder << 1), 8); // FIXED: 001ooo0 -> bits 0 01ooo 0
  for (let i = 0; i < bestOrder; i++) w.put(x[i], bps);
  w.put(0, 2); // Rice, 4-bit parameters
  w.put(bestPo, 4);
  const size = n >> bestPo;
  for (let p = 0; p < 1 << bestPo; p++) {
    const k = bestKs[p];
    w.put(k, 4);
    for (let i = Math.max(p * size, bestOrder); i < (p + 1) * size; i++) {
      const v = u[i];
      w.unary(Math.floor(v / 2 ** k));
      if (k) w.put(v % 2 ** k, k);
    }
  }
}

function utf8Number(n: number, out: number[]): void {
  if (n < 0x80) return void out.push(n);
  let bytes = 2;
  while (n >= 2 ** (bytes * 5 + 1)) bytes++;
  out.push(((0xff00 >> bytes) & 0xff) | Math.floor(n / 2 ** (6 * (bytes - 1))));
  for (let i = bytes - 2; i >= 0; i--) out.push(0x80 | (Math.floor(n / 2 ** (6 * i)) & 0x3f));
}

export interface FlacOptions {
  sampleRate: number;
  bits?: 16 | 24;
}

export class FlacEncoder {
  private readonly bits: 16 | 24;
  private frames: Uint8Array[] = [];
  private queue: Int32Array[] = [];
  private queued = 0;
  private channels = 0;
  private total = 0;
  private minFrame = Infinity;
  private maxFrame = 0;
  private frameNo = 0;
  constructor(private readonly o: FlacOptions) {
    this.bits = o.bits ?? 16;
    if (!(o.sampleRate >= 1 && o.sampleRate <= 655350)) throw new Error('FLAC: unsupported sample rate.');
  }

  addAudio(chunk: Float32Array[]): void {
    if (!chunk.length) return;
    if (!this.channels) {
      if (chunk.length > 8) throw new Error('FLAC: at most 8 channels.');
      this.channels = chunk.length;
      this.queue = chunk.map(() => new Int32Array(BLOCK));
    }
    if (chunk.length !== this.channels) throw new Error('FLAC: the channel count changed.');
    const scale = this.bits === 16 ? 0x8000 : 0x800000;
    const pos = this.bits === 16 ? 0x7fff : 0x7fffff;
    const n = chunk[0].length;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.channels; c++) {
        const x = Math.max(-1, Math.min(1, chunk[c][i]));
        this.queue[c][this.queued] = Math.round(x < 0 ? x * scale : x * pos);
      }
      if (++this.queued === BLOCK) this.flush(BLOCK);
    }
  }

  private flush(n: number): void {
    const w = new Bits();
    const head: number[] = [0xff, 0xf8];
    const bsCode = n === BLOCK ? 12 : n <= 256 ? 6 : 7;
    const ssCode = this.bits === 16 ? 4 : 6;
    head.push((bsCode << 4) | 0, ((this.channels - 1) << 4) | (ssCode << 1));
    utf8Number(this.frameNo++, head);
    if (bsCode === 6) head.push(n - 1);
    if (bsCode === 7) head.push((n - 1) >> 8, (n - 1) & 255);
    head.push(crc8(Uint8Array.from(head)));
    for (const b of head) w.put(b, 8);
    for (let c = 0; c < this.channels; c++) writeSubframe(w, this.queue[c].subarray(0, n), this.bits);
    w.align();
    const body = w.bytes();
    const out = new Uint8Array(body.length + 2);
    out.set(body);
    const crc = crc16(body);
    out[body.length] = crc >> 8;
    out[body.length + 1] = crc & 255;
    this.frames.push(out);
    this.total += n;
    this.minFrame = Math.min(this.minFrame, out.length);
    this.maxFrame = Math.max(this.maxFrame, out.length);
    this.queued = 0;
  }

  finish(): Uint8Array[] {
    if (this.queued) this.flush(this.queued);
    const ch = Math.max(1, this.channels);
    const info = new ByteWriter(42);
    info.ascii('fLaC').u8(0x80).u8(0).u8(0).u8(34);
    const bs = Math.min(BLOCK, Math.max(16, this.total));
    info.u16(bs).u16(bs);
    const mf = this.frames.length ? this.minFrame : 0;
    info.u8(mf >> 16).u8((mf >> 8) & 255).u8(mf & 255);
    info.u8(this.maxFrame >> 16).u8((this.maxFrame >> 8) & 255).u8(this.maxFrame & 255);
    // 20 bits rate, 3 bits channels-1, 5 bits bps-1, 36 bits total samples
    const rate = this.o.sampleRate;
    info.u8(rate >> 12).u8((rate >> 4) & 255);
    info.u8(((rate & 15) << 4) | ((ch - 1) << 1) | ((this.bits - 1) >> 4));
    const totalHi = Math.floor(this.total / 2 ** 32);
    info.u8((((this.bits - 1) & 15) << 4) | (totalHi & 15));
    info.u32(this.total >>> 0);
    info.zeros(16);
    return [info.result(), ...this.frames];
  }
}

export function encodeFlac(channels: Float32Array[], o: FlacOptions): Uint8Array[] {
  const e = new FlacEncoder(o);
  e.addAudio(channels);
  return e.finish();
}
