/** Shared helpers of the standalone encoders: CRC-32, a growable byte writer and the common session types. */

export type Pixels = Uint8Array | Uint8ClampedArray;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (PNG / zlib polynomial) of bytes[start, end). */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Growable helper for building headers and small files. */
export class ByteWriter {
  buf: Uint8Array;
  view: DataView;
  pos = 0;
  constructor(initial = 256) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }
  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number): this {
    this.ensure(1);
    this.buf[this.pos++] = v;
    return this;
  }
  u16(v: number, le = false): this {
    this.ensure(2);
    this.view.setUint16(this.pos, v, le);
    this.pos += 2;
    return this;
  }
  u32(v: number, le = false): this {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, le);
    this.pos += 4;
    return this;
  }
  /** Unsigned 64-bit (value must be a safe integer). */
  u64(v: number, le = false): this {
    const hi = Math.floor(v / 4294967296);
    const lo = v >>> 0;
    return le ? this.u32(lo, true).u32(hi, true) : this.u32(hi).u32(lo);
  }
  f32(v: number, le = false): this {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, le);
    this.pos += 4;
    return this;
  }
  ascii(s: string): this {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.pos++] = s.charCodeAt(i) & 255;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }
  zeros(n: number): this {
    this.ensure(n);
    this.pos += n;
    return this;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

export function concat(parts: Uint8Array[]): Uint8Array {
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

/** Frame rate as an exact fraction. Accepts 25, 29.97 (snapped to 30000/1001) or {num, den}. */
export interface Fps {
  num: number;
  den: number;
}
export function toFps(fps: number | Fps): Fps {
  if (typeof fps !== 'number') return { num: fps.num, den: fps.den };
  if (Number.isInteger(fps)) return { num: fps, den: 1 };
  for (const [n, d] of [
    [24000, 1001],
    [30000, 1001],
    [48000, 1001],
    [60000, 1001],
    [120000, 1001],
  ] as const) {
    if (Math.abs(fps - n / d) < 0.005) return { num: n, den: d };
  }
  return { num: Math.round(fps * 1000), den: 1000 };
}

export interface EncodeOptions {
  width: number;
  height: number;
  fps?: number | Fps;
  /** Animations: 0 = forever (default), n = n plays. */
  loop?: number;
  /** 0..1 where a codec has a quality knob. */
  quality?: number;
  /** Codec specific extras, documented per encoder. */
  [extra: string]: unknown;
}

export interface EncodeSession {
  /** Straight-alpha RGBA8, width*height*4. The caller may reuse the array once the call (or its promise) has returned. */
  addFrame(rgba: Pixels): void | Promise<void>;
  /** Audio sessions (and video sessions begun with an audio track): per-channel Float32 samples, -1..1. */
  addAudio?(channels: Float32Array[]): void | Promise<void>;
  /** The finished file as blob parts (hand to `new Blob(parts)` or concatenate). */
  finish(): Promise<Uint8Array[]>;
}

export type EncoderKind = 'video' | 'animation' | 'image' | 'audio';

export interface EncoderDescriptor {
  id: string;
  label: string;
  extension: string;
  mime: string;
  kind: EncoderKind;
  alpha: boolean;
  lossless: boolean;
  /** What addFrame takes: straight RGBA8, float RGBA (premultiplied, Float32 or half bits in a Uint16Array), or nothing (audio). */
  input: 'rgba8' | 'float' | 'pcm';
  begin(options: EncodeOptions): EncodeSession;
}

export function checkSize(rgba: Pixels, width: number, height: number, who: string): void {
  if (!(width >= 1 && height >= 1) || !Number.isInteger(width) || !Number.isInteger(height)) throw new Error(`${who}: invalid size ${width}x${height}.`);
  if (rgba.length !== width * height * 4) throw new Error(`${who}: the pixel data does not match the size.`);
}
