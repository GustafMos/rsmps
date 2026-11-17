/**
 * Animated GIF89a encoder. Own code: median-cut quantiser, ordered (Bayer 8x8) and Floyd-Steinberg dithering, LZW, Netscape loop
 * extension, 1-bit transparency, frame differencing (changed rectangle, the unchanged pixels inside it become the transparent index so
 * LZW sees long runs) and centisecond delays whose rounding error is carried forward so the average rate is exact.
 * Frames with <= 256 colours (255 + the reserved transparent slot when needed) are written EXACTLY, never dithered.
 * The LZW patents have expired (worldwide, 2004).
 *
 * palette 'local' (default) quantises every frame on its own and streams; 'global' builds one table from all frames and therefore keeps
 * a copy of every frame until finish().
 */
import { ByteWriter, checkSize, toFps, type EncodeOptions, type EncodeSession, type Fps, type Pixels } from './util';

export interface GifOptions extends EncodeOptions {
  /** Maximum colours per palette, 2..256 (default 256). */
  colors?: number;
  dither?: 'none' | 'ordered' | 'floyd';
  palette?: 'local' | 'global';
  /** Alpha below this becomes the transparent colour (default 128). 0 turns transparency off. */
  alphaThreshold?: number;
  /** Frame differencing (default true). */
  diff?: boolean;
  /** Netscape loop count: 0 = forever (default), n = repeat n more times, -1 = no extension (play once). */
  loop?: number;
}

/** Delays in centiseconds for n frames at an exact rate: cumulative rounding, so the sum is round(n*100*den/num) and the average exact. */
export function gifDelays(fps: number | Fps, n: number, start = 0): number[] {
  const f = toFps(fps);
  const out: number[] = [];
  const t = (i: number) => Math.floor((i * 100 * f.den * 2 + f.num) / (2 * f.num));
  for (let i = start; i < start + n; i++) out.push(t(i + 1) - t(i));
  return out;
}

// ---------------------------------------------------------------- quantiser

interface Palette {
  /** RGB triples. */
  rgb: Uint8Array;
  n: number;
  exact: boolean;
  lookup: Map<number, number> | null;
}

const key24 = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

/** Unique opaque colours of the frames, or null when there are more than `cap`. */
function exactColors(frames: Pixels[], thr: number, cap: number): Map<number, number> | null {
  const m = new Map<number, number>();
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 4) {
      if (f[i + 3] < thr) continue;
      const k = key24(f[i], f[i + 1], f[i + 2]);
      if (!m.has(k)) {
        if (m.size >= cap) return null;
        m.set(k, m.size);
      }
    }
  }
  return m;
}

function medianCut(frames: Pixels[], thr: number, count: number): Uint8Array {
  const BINS = 32768;
  const cnt = new Float64Array(BINS);
  const sr = new Float64Array(BINS);
  const sg = new Float64Array(BINS);
  const sb = new Float64Array(BINS);
  for (const f of frames) {
    for (let i = 0; i < f.length; i += 4) {
      if (f[i + 3] < thr) continue;
      const b = ((f[i] >> 3) << 10) | ((f[i + 1] >> 3) << 5) | (f[i + 2] >> 3);
      cnt[b]++;
      sr[b] += f[i];
      sg[b] += f[i + 1];
      sb[b] += f[i + 2];
    }
  }
  const all: number[] = [];
  for (let b = 0; b < BINS; b++) if (cnt[b]) all.push(b);
  type Box = { bins: number[]; pop: number };
  const mk = (bins: number[]): Box => ({ bins, pop: bins.reduce((s, b) => s + cnt[b], 0) });
  const boxes: Box[] = [mk(all)];
  const chan = (b: number, c: number) => (c === 0 ? b >> 10 : c === 1 ? (b >> 5) & 31 : b & 31);
  while (boxes.length < count) {
    let bi = -1;
    let bp = -1;
    boxes.forEach((bx, i) => {
      if (bx.bins.length > 1 && bx.pop > bp) {
        bp = bx.pop;
        bi = i;
      }
    });
    if (bi < 0) break;
    const box = boxes[bi];
    let axis = 0;
    let best = -1;
    for (let c = 0; c < 3; c++) {
      let lo = 31;
      let hi = 0;
      for (const b of box.bins) {
        const v = chan(b, c);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      // Green is perceptually heavier.
      const range = (hi - lo) * (c === 1 ? 1.4 : c === 0 ? 1.1 : 0.8);
      if (range > best) {
        best = range;
        axis = c;
      }
    }
    box.bins.sort((a, b) => chan(a, axis) - chan(b, axis) || a - b);
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.bins.length - 1; i++) {
      acc += cnt[box.bins[i]];
      cut = i + 1;
      if (acc >= box.pop / 2) break;
    }
    boxes.splice(bi, 1, mk(box.bins.slice(0, cut)), mk(box.bins.slice(cut)));
  }
  const rgb = new Uint8Array(boxes.length * 3);
  boxes.forEach((bx, i) => {
    let r = 0, g = 0, b = 0;
    for (const bin of bx.bins) {
      r += sr[bin];
      g += sg[bin];
      b += sb[bin];
    }
    rgb[i * 3] = Math.round(r / bx.pop);
    rgb[i * 3 + 1] = Math.round(g / bx.pop);
    rgb[i * 3 + 2] = Math.round(b / bx.pop);
  });
  return rgb;
}

function hasTransparency(frames: Pixels[], thr: number): boolean {
  if (thr <= 0) return false;
  for (const f of frames) for (let i = 3; i < f.length; i += 4) if (f[i] < thr) return true;
  return false;
}

function buildPalette(frames: Pixels[], thr: number, maxColors: number, slot: boolean): { pal: Palette; slot: boolean } {
  let useSlot = slot;
  let ex = exactColors(frames, thr, maxColors - (useSlot ? 1 : 0));
  if (!ex && useSlot && !hasTransparency(frames, thr)) {
    // The slot was only for differencing: give it up when the picture needs all 256 colours.
    ex = exactColors(frames, thr, maxColors);
    if (ex) useSlot = false;
  }
  if (ex) {
    const rgb = new Uint8Array(Math.max(1, ex.size) * 3);
    for (const [k, i] of ex) {
      rgb[i * 3] = k >> 16;
      rgb[i * 3 + 1] = (k >> 8) & 255;
      rgb[i * 3 + 2] = k & 255;
    }
    return { pal: { rgb, n: Math.max(1, ex.size), exact: true, lookup: ex }, slot: useSlot };
  }
  const rgb = medianCut(frames, thr, maxColors - (useSlot ? 1 : 0));
  return { pal: { rgb, n: rgb.length / 3, exact: false, lookup: null }, slot: useSlot };
}

const BAYER8 = (() => {
  const m = new Float32Array(64);
  const b2 = [0, 2, 3, 1];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let v = 0;
      for (let l = 0; l < 3; l++) v = v * 4 + b2[(((y >> (2 - l)) & 1) << 1) | ((x >> (2 - l)) & 1)];
      m[y * 8 + x] = (v + 0.5) / 64 - 0.5;
    }
  }
  return m;
})();

/** Map a frame to palette indices. `trans` = transparent index or -1. Fills `target` with what a decoder will show. */
function mapFrame(rgba: Pixels, w: number, h: number, pal: Palette, trans: number, thr: number, dither: 'none' | 'ordered' | 'floyd', idx: Uint8Array, target: Uint32Array): void {
  const cache = new Int16Array(1 << 18).fill(-1);
  const near = (r: number, g: number, b: number): number => {
    const k = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    const c = cache[k];
    if (c >= 0) return c;
    let best = 1e9;
    let bi = 0;
    for (let i = 0; i < pal.n; i++) {
      const dr = r - pal.rgb[i * 3];
      const dg = g - pal.rgb[i * 3 + 1];
      const db = b - pal.rgb[i * 3 + 2];
      const d = dr * dr * 2 + dg * dg * 4 + db * db * 3;
      if (d < best) {
        best = d;
        bi = i;
      }
    }
    cache[k] = bi;
    return bi;
  };
  const put = (p: number, i: number) => {
    idx[p] = i;
    target[p] = (0xff000000 | (pal.rgb[i * 3] << 16) | (pal.rgb[i * 3 + 1] << 8) | pal.rgb[i * 3 + 2]) >>> 0;
  };
  if (pal.exact) {
    for (let p = 0; p < w * h; p++) {
      const o = p * 4;
      if (rgba[o + 3] < thr) {
        idx[p] = trans;
        target[p] = 0;
      } else put(p, pal.lookup!.get(key24(rgba[o], rgba[o + 1], rgba[o + 2]))!);
    }
    return;
  }
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  if (dither === 'floyd') {
    let cur = new Float32Array((w + 2) * 3);
    let nxt = new Float32Array((w + 2) * 3);
    for (let y = 0; y < h; y++) {
      nxt.fill(0);
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        const o = p * 4;
        if (rgba[o + 3] < thr) {
          idx[p] = trans;
          target[p] = 0;
          continue;
        }
        const e = (x + 1) * 3;
        const r = clamp(rgba[o] + cur[e]);
        const g = clamp(rgba[o + 1] + cur[e + 1]);
        const b = clamp(rgba[o + 2] + cur[e + 2]);
        const i = near(r, g, b);
        put(p, i);
        const er = r - pal.rgb[i * 3];
        const eg = g - pal.rgb[i * 3 + 1];
        const eb = b - pal.rgb[i * 3 + 2];
        const spread = (arr: Float32Array, at: number, f: number) => {
          arr[at] += er * f;
          arr[at + 1] += eg * f;
          arr[at + 2] += eb * f;
        };
        spread(cur, e + 3, 7 / 16);
        spread(nxt, e - 3, 3 / 16);
        spread(nxt, e, 5 / 16);
        spread(nxt, e + 3, 1 / 16);
      }
      const t = cur;
      cur = nxt;
      nxt = t;
    }
    return;
  }
  const spread = dither === 'ordered' ? 56 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const o = p * 4;
      if (rgba[o + 3] < thr) {
        idx[p] = trans;
        target[p] = 0;
        continue;
      }
      if (spread) {
        const t = BAYER8[(y & 7) * 8 + (x & 7)] * spread;
        put(p, near(clamp(rgba[o] + t), clamp(rgba[o + 1] + t), clamp(rgba[o + 2] + t)));
      } else put(p, near(rgba[o], rgba[o + 1], rgba[o + 2]));
    }
  }
}

// ---------------------------------------------------------------- LZW

const DICT_KEY = new Int32Array(1 << 20);
const DICT_VAL = new Int16Array(1 << 20);
let dictGen = 0;

/** GIF LZW. Returns the code stream (not yet split into sub-blocks). */
export function lzwEncode(idx: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let out = new Uint8Array(Math.max(64, idx.length >> 1));
  let o = 0;
  let acc = 0;
  let nbits = 0;
  const write = (code: number, size: number) => {
    acc |= code << nbits;
    nbits += size;
    while (nbits >= 8) {
      if (o >= out.length) {
        const n = new Uint8Array(out.length * 2);
        n.set(out);
        out = n;
      }
      out[o++] = acc & 255;
      acc >>>= 8;
      nbits -= 8;
    }
  };
  let next = eoi + 1;
  let size = minCodeSize + 1;
  dictGen++;
  write(clear, size);
  if (idx.length) {
    let prefix = idx[0];
    for (let i = 1; i < idx.length; i++) {
      const c = idx[i];
      const k = (prefix << 8) | c;
      if (DICT_KEY[k] === dictGen) {
        prefix = DICT_VAL[k];
        continue;
      }
      write(prefix, size);
      DICT_KEY[k] = dictGen;
      DICT_VAL[k] = next++;
      if (next > 4095) {
        write(clear, size);
        dictGen++;
        next = eoi + 1;
        size = minCodeSize + 1;
      } else if (next > 1 << size) size++;
      prefix = c;
    }
    write(prefix, size);
  }
  write(eoi, size);
  if (nbits > 0) write(0, 8 - nbits);
  return out.subarray(0, o);
}

// ---------------------------------------------------------------- file

interface Rec {
  idx: Uint8Array;
  target: Uint32Array;
  pal: Palette;
  trans: number;
  delay: number;
  local: boolean;
}

function bitsFor(n: number): number {
  let b = 1;
  while (1 << b < n) b++;
  return b;
}

export class GifSession implements EncodeSession {
  private readonly w: number;
  private readonly h: number;
  private readonly thr: number;
  private readonly maxColors: number;
  private readonly dither: 'none' | 'ordered' | 'floyd';
  private readonly diff: boolean;
  private readonly global: boolean;
  private readonly fps: Fps;
  private frameNo = 0;
  private readonly parts: Uint8Array[] = [];
  private readonly buffered: Pixels[] = [];
  private canvas: Uint32Array;
  private pending: Rec | null = null;
  private held: { bytes: Uint8Array; delayPos: number; delay: number } | null = null;
  private globalPal: { pal: Palette; slot: boolean } | null = null;
  private headerWritten = false;
  private any = false;

  constructor(private readonly o: GifOptions) {
    this.w = o.width;
    this.h = o.height;
    if (this.w > 65535 || this.h > 65535) throw new Error('GIF: the picture is larger than 65535 pixels.');
    this.thr = o.alphaThreshold ?? 128;
    this.maxColors = Math.max(2, Math.min(256, Math.round(o.colors ?? 256)));
    this.dither = o.dither ?? 'none';
    this.diff = o.diff ?? true;
    this.global = o.palette === 'global';
    this.fps = toFps(o.fps ?? 10);
    this.canvas = new Uint32Array(this.w * this.h);
  }

  addFrame(rgba: Pixels): void {
    checkSize(rgba, this.w, this.h, 'GIF');
    if (this.global) {
      this.buffered.push(rgba.slice());
      return;
    }
    this.push(rgba, null);
  }

  private push(rgba: Pixels, shared: { pal: Palette; slot: boolean } | null): void {
    const { w, h } = this;
    let pal: Palette;
    let slot: boolean;
    if (shared) ({ pal, slot } = shared);
    else {
      const needSlot = this.diff || hasTransparency([rgba], this.thr);
      ({ pal, slot } = buildPalette([rgba], this.thr, this.maxColors, needSlot));
    }
    // A transparent pixel needs a slot even when the caller asked for none.
    const trans = slot ? pal.n : -1;
    const idx = new Uint8Array(w * h);
    const target = new Uint32Array(w * h);
    mapFrame(rgba, w, h, pal, trans < 0 ? 0 : trans, this.thr, this.dither, idx, target);
    this.advance({ idx, target, pal, trans, delay: gifDelays(this.fps, 1, this.frameNo++)[0], local: !shared });
  }

  /** A new frame arrived: settle the pending one (it now knows whether the canvas must be cleared after it), then queue this one. */
  private advance(next: Rec): void {
    if (this.pending) {
      let clear = false;
      const t = next.target;
      const p = this.pending.target;
      for (let i = 0; i < t.length; i++) {
        if (t[i] === 0 && p[i] !== 0) {
          clear = true;
          break;
        }
      }
      this.emit(this.pending, clear);
    }
    this.pending = next;
  }

  private emit(r: Rec, clearAfter: boolean): void {
    const { w, h, canvas } = this;
    let x0 = 0, y0 = 0, x1 = w, y1 = h;
    const first = !this.any;
    const useDiff = this.diff && !first && !clearAfter && r.trans >= 0;
    if (this.diff && !first && !clearAfter) {
      let minX = w, minY = h, maxX = -1, maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (r.target[y * w + x] !== canvas[y * w + x]) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            maxY = y;
          }
        }
      }
      if (maxX < 0) {
        if (this.held) {
          this.held.delay += r.delay;
          this.patchDelay();
          return;
        }
      } else {
        x0 = minX;
        y0 = minY;
        x1 = maxX + 1;
        y1 = maxY + 1;
      }
    }
    const rw = x1 - x0;
    const rh = y1 - y0;
    const data = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const p = (y0 + y) * w + x0 + x;
        data[y * rw + x] = useDiff && r.target[p] === canvas[p] ? r.trans : r.idx[p];
      }
    }
    const total = r.pal.n + (r.trans >= 0 ? 1 : 0);
    if (!this.headerWritten) this.writeHeader(r);
    const bw = new ByteWriter(data.length + 64);
    // Graphic control extension
    bw.u8(0x21).u8(0xf9).u8(4);
    const hasT = r.trans >= 0 && data.includes(r.trans);
    bw.u8(((clearAfter ? 2 : 1) << 2) | (hasT ? 1 : 0));
    const delayPos = bw.pos;
    bw.u16(0, true).u8(hasT ? r.trans : 0).u8(0);
    // Image descriptor
    bw.u8(0x2c).u16(x0, true).u16(y0, true).u16(rw, true).u16(rh, true);
    const bits = Math.max(1, bitsFor(total));
    const useLocal = r.local;
    bw.u8(useLocal ? 0x80 | (bits - 1) : 0);
    if (useLocal) {
      const table = new Uint8Array((1 << bits) * 3);
      table.set(r.pal.rgb.subarray(0, r.pal.n * 3));
      bw.bytes(table);
    }
    const minCode = Math.max(2, useLocal ? bits : this.globalBits);
    bw.u8(minCode);
    const lzw = lzwEncode(data, minCode);
    for (let i = 0; i < lzw.length; i += 255) {
      const n = Math.min(255, lzw.length - i);
      bw.u8(n).bytes(lzw.subarray(i, i + n));
    }
    bw.u8(0);
    this.flushHeld();
    this.held = { bytes: bw.result(), delayPos, delay: r.delay };
    this.patchDelay();
    canvas.set(r.target);
    if (clearAfter) canvas.fill(0);
    this.any = true;
  }

  private globalBits = 8;

  private writeHeader(r: Rec): void {
    const w = new ByteWriter(800);
    w.ascii('GIF89a').u16(this.w, true).u16(this.h, true);
    if (this.globalPal) {
      const total = this.globalPal.pal.n + (this.globalPal.slot ? 1 : 0);
      const bits = Math.max(1, bitsFor(total));
      this.globalBits = bits;
      w.u8(0x80 | ((bits - 1) << 4) | (bits - 1)).u8(0).u8(0);
      const table = new Uint8Array((1 << bits) * 3);
      table.set(this.globalPal.pal.rgb.subarray(0, this.globalPal.pal.n * 3));
      w.bytes(table);
    } else w.u8(0x70).u8(0).u8(0);
    const loop = this.o.loop ?? 0;
    if (loop >= 0) w.u8(0x21).u8(0xff).u8(11).ascii('NETSCAPE2.0').u8(3).u8(1).u16(loop, true).u8(0);
    this.parts.push(w.result());
    this.headerWritten = true;
    void r;
  }

  private patchDelay(): void {
    const h = this.held!;
    const d = Math.min(65535, h.delay);
    h.bytes[h.delayPos] = d & 255;
    h.bytes[h.delayPos + 1] = d >> 8;
  }

  private flushHeld(): void {
    if (this.held) this.parts.push(this.held.bytes);
    this.held = null;
  }

  async finish(): Promise<Uint8Array[]> {
    if (this.global) {
      const frames = this.buffered.splice(0);
      if (!frames.length) throw new Error('GIF: no frames.');
      const need = this.diff || hasTransparency(frames, this.thr);
      this.globalPal = buildPalette(frames, this.thr, this.maxColors, need);
      for (const f of frames) this.push(f, this.globalPal);
    }
    if (!this.pending && !this.held) throw new Error('GIF: no frames.');
    if (this.pending) this.emit(this.pending, false);
    this.pending = null;
    this.flushHeld();
    this.parts.push(new Uint8Array([0x3b]));
    return this.parts;
  }
}

export function beginGif(o: GifOptions): GifSession {
  return new GifSession(o);
}
