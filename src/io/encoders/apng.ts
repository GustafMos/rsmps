/**
 * Animated PNG (APNG) encoder. Chunks acTL / fcTL / fdAT per the public APNG specification (a PNG extension; PNG itself is an open
 * W3C / ISO standard). Frame 0 is stored in IDAT so every PNG reader shows it. Zlib via fflate. Lossless; straight alpha.
 *
 * Frame differencing: only the changed rectangle is stored (dispose NONE). For each frame both blend modes are tried when valid
 * (SOURCE = replace, OVER with unchanged pixels made transparent, valid when every changed pixel is opaque) and the smaller wins.
 * Identical consecutive frames are merged into one longer delay. Delays are exact fractions (frame duration = den/num seconds).
 * Modes: 'rgba' (default, streams) | 'palette' (8-bit indexed with tRNS, needs <= 256 distinct RGBA values) | 'auto' (palette when it
 * fits, else rgba). 'palette' and 'auto' keep a copy of every frame until finish().
 */
import { zlibSync } from 'fflate';
import { ByteWriter, checkSize, crc32, toFps, type EncodeOptions, type EncodeSession, type Fps, type Pixels } from './util';

export interface ApngOptions extends EncodeOptions {
  mode?: 'rgba' | 'palette' | 'auto';
  /** Frame differencing (default true). */
  diff?: boolean;
  /** zlib level 0..9 (default 6). */
  level?: number;
  /** Number of plays, 0 = forever (default). */
  loop?: number;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Adaptive-filtered scanlines (per row the filter with the smallest sum of absolute values wins). bpp = bytes per pixel. */
export function filterRows(src: Uint8Array, w: number, h: number, bpp: number, adaptive: boolean): Uint8Array {
  const stride = w * bpp;
  const out = new Uint8Array((stride + 1) * h);
  if (!adaptive) {
    for (let y = 0; y < h; y++) out.set(src.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
    return out;
  }
  const cand = new Uint8Array(stride);
  const zero = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = src.subarray(y * stride, (y + 1) * stride);
    const up = y ? src.subarray((y - 1) * stride, y * stride) : zero;
    let bestF = 0;
    let bestS = 0;
    for (let i = 0; i < stride; i++) bestS += row[i] < 128 ? row[i] : 256 - row[i];
    for (let f = 1; f <= 4; f++) {
      let s = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = up[i];
        const c = i >= bpp ? up[i - bpp] : 0;
        let p: number;
        if (f === 1) p = a;
        else if (f === 2) p = b;
        else if (f === 3) p = (a + b) >> 1;
        else {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const d = (row[i] - p) & 255;
        cand[i] = d;
        s += d < 128 ? d : 256 - d;
        if (s >= bestS) break;
      }
      if (s < bestS) {
        bestS = s;
        bestF = f;
        out.set(cand, y * (stride + 1) + 1);
        out[y * (stride + 1)] = f;
      }
    }
    if (bestF === 0) {
      out[y * (stride + 1)] = 0;
      out.set(row, y * (stride + 1) + 1);
    }
  }
  return out;
}

interface FrameRec {
  x: number;
  y: number;
  w: number;
  h: number;
  blend: 0 | 1;
  /** Frame durations in units of fps.den / fps.num seconds. */
  ticks: number;
  zdata: Uint8Array;
}

export class ApngSession implements EncodeSession {
  private readonly w: number;
  private readonly h: number;
  private readonly fps: Fps;
  private readonly diff: boolean;
  private readonly level: number;
  private readonly mode: 'rgba' | 'palette' | 'auto';
  private readonly raw: Pixels[] = [];
  private frames: FrameRec[] = [];
  private prev: Uint8Array | null = null;
  constructor(private readonly o: ApngOptions) {
    this.w = o.width;
    this.h = o.height;
    this.fps = toFps(o.fps ?? 10);
    this.diff = o.diff ?? true;
    this.level = o.level ?? 6;
    this.mode = o.mode ?? 'rgba';
  }

  addFrame(rgba: Pixels): void {
    checkSize(rgba, this.w, this.h, 'APNG');
    if (this.mode === 'rgba') this.encodeRgba(rgba);
    else this.raw.push(rgba.slice());
  }

  private encodeRgba(rgba: Pixels): void {
    const { w, h } = this;
    let x0 = 0, y0 = 0, x1 = w, y1 = h;
    let changed: boolean[] | null = null;
    if (this.diff && this.prev) {
      const p = this.prev;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (rgba[i] !== p[i] || rgba[i + 1] !== p[i + 1] || rgba[i + 2] !== p[i + 2] || rgba[i + 3] !== p[i + 3]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            maxY = y;
          }
        }
      }
      if (maxX < 0) {
        this.frames[this.frames.length - 1].ticks++;
        return;
      }
      x0 = minX;
      y0 = minY;
      x1 = maxX + 1;
      y1 = maxY + 1;
      changed = [];
    }
    const rw = x1 - x0;
    const rh = y1 - y0;
    const src = new Uint8Array(rw * rh * 4);
    for (let y = 0; y < rh; y++) src.set(rgba.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + rw) * 4), y * rw * 4);
    let best: FrameRec = { x: x0, y: y0, w: rw, h: rh, blend: 0, ticks: 1, zdata: zlibSync(filterRows(src, rw, rh, 4, true), { level: this.level as 6 }) };
    if (changed && this.prev) {
      // OVER candidate: unchanged pixels become fully transparent; valid when each changed pixel is opaque.
      const over = src.slice();
      let ok = true;
      const p = this.prev;
      for (let y = 0; y < rh && ok; y++) {
        for (let x = 0; x < rw; x++) {
          const i = ((y0 + y) * w + x0 + x) * 4;
          const same = rgba[i] === p[i] && rgba[i + 1] === p[i + 1] && rgba[i + 2] === p[i + 2] && rgba[i + 3] === p[i + 3];
          const j = (y * rw + x) * 4;
          if (same) over.fill(0, j, j + 4);
          else if (rgba[i + 3] !== 255) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        const z = zlibSync(filterRows(over, rw, rh, 4, true), { level: this.level as 6 });
        if (z.length < best.zdata.length) best = { ...best, blend: 1, zdata: z };
      }
    }
    this.frames.push(best);
    if (!this.prev) this.prev = new Uint8Array(w * h * 4);
    this.prev.set(rgba);
  }

  async finish(): Promise<Uint8Array[]> {
    const { w, h } = this;
    let palette: { rgba: Uint32Array; map: Map<number, number> } | null = null;
    if (this.mode !== 'rgba') {
      if (!this.raw.length) throw new Error('APNG: no frames.');
      const map = new Map<number, number>();
      for (const f of this.raw) {
        const u = new Uint32Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.length));
        for (let i = 0; i < u.length && map.size <= 256; i++) if (!map.has(u[i])) map.set(u[i], map.size);
        if (map.size > 256) break;
      }
      if (map.size <= 256) palette = { rgba: new Uint32Array(map.keys()), map };
      else if (this.mode === 'palette') throw new Error('APNG: more than 256 distinct colours, palette mode is not possible.');
      if (palette) this.encodePalette(palette.map);
      else for (const f of this.raw) this.encodeRgba(f);
      this.raw.length = 0;
    }
    if (!this.frames.length) throw new Error('APNG: no frames.');
    const ihdr = new ByteWriter(13).u32(w).u32(h).u8(8).u8(palette ? 3 : 6).u8(0).u8(0).u8(0).result();
    const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
    if (palette) {
      const n = palette.rgba.length;
      const plte = new Uint8Array(n * 3);
      const trns = new Uint8Array(n);
      palette.rgba.forEach((c, i) => {
        // Uint32 view of little-endian RGBA bytes: low byte = R.
        plte[i * 3] = c & 255;
        plte[i * 3 + 1] = (c >>> 8) & 255;
        plte[i * 3 + 2] = (c >>> 16) & 255;
        trns[i] = c >>> 24;
      });
      parts.push(chunk('PLTE', plte));
      let last = n;
      while (last > 0 && trns[last - 1] === 255) last--;
      if (last > 0) parts.push(chunk('tRNS', trns.subarray(0, last)));
    }
    parts.push(chunk('acTL', new ByteWriter(8).u32(this.frames.length).u32(this.o.loop ?? 0).result()));
    let seq = 0;
    this.frames.forEach((f, i) => {
      let num = f.ticks * this.fps.den;
      let den = this.fps.num;
      const g = gcd(num, den);
      num /= g;
      den /= g;
      while (num > 65535 || den > 65535) {
        num = Math.round(num / 2);
        den = Math.round(den / 2);
      }
      const fctl = new ByteWriter(26).u32(seq++).u32(f.w).u32(f.h).u32(f.x).u32(f.y).u16(num).u16(den).u8(0).u8(f.blend).result();
      parts.push(chunk('fcTL', fctl));
      if (i === 0) parts.push(chunk('IDAT', f.zdata));
      else {
        const d = new Uint8Array(4 + f.zdata.length);
        new DataView(d.buffer).setUint32(0, seq++);
        d.set(f.zdata, 4);
        parts.push(chunk('fdAT', d));
      }
    });
    parts.push(chunk('IEND', new Uint8Array(0)));
    return parts;
  }

  private encodePalette(map: Map<number, number>): void {
    const { w, h } = this;
    let prev: Uint8Array | null = null;
    for (const f of this.raw) {
      const u = new Uint32Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.length));
      const idx = new Uint8Array(w * h);
      for (let i = 0; i < idx.length; i++) idx[i] = map.get(u[i])!;
      let x0 = 0, y0 = 0, x1 = w, y1 = h;
      if (this.diff && prev) {
        let minX = w, minY = h, maxX = -1, maxY = -1;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            if (idx[y * w + x] !== prev[y * w + x]) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              maxY = y;
            }
          }
        }
        if (maxX < 0) {
          this.frames[this.frames.length - 1].ticks++;
          continue;
        }
        x0 = minX;
        y0 = minY;
        x1 = maxX + 1;
        y1 = maxY + 1;
      }
      const rw = x1 - x0;
      const rh = y1 - y0;
      const src = new Uint8Array(rw * rh);
      for (let y = 0; y < rh; y++) src.set(idx.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + rw), y * rw);
      this.frames.push({ x: x0, y: y0, w: rw, h: rh, blend: 0, ticks: 1, zdata: zlibSync(filterRows(src, rw, rh, 1, false), { level: this.level as 6 }) });
      prev = idx;
    }
  }
}

export function beginApng(o: ApngOptions): ApngSession {
  return new ApngSession(o);
}
