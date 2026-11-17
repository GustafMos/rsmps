/**
 * QOI ("Quite OK Image") encoder, written from the public QOI specification (qoiformat.org, MIT licensed reference; the format is
 * free to implement). Lossless, 8-bit, straight alpha. channels 4 keeps alpha, 3 drops it (composited over black).
 */
import { checkSize, type Pixels } from './util';

export function encodeQoi(rgba: Pixels, width: number, height: number, opts: { alpha?: boolean; linear?: boolean } = {}): Uint8Array {
  checkSize(rgba, width, height, 'QOI');
  const alpha = opts.alpha ?? true;
  const out = new Uint8Array(14 + width * height * (alpha ? 5 : 4) + 8);
  const v = new DataView(out.buffer);
  out.set([0x71, 0x6f, 0x69, 0x66]);
  v.setUint32(4, width);
  v.setUint32(8, height);
  out[12] = alpha ? 4 : 3;
  out[13] = opts.linear ? 1 : 0;
  let o = 14;
  const index = new Uint32Array(64); // packed 0xAABBGGRR; zero = (0,0,0,0)
  let pr = 0, pg = 0, pb = 0, pa = 255;
  let run = 0;
  const n = width * height;
  for (let i = 0; i < n; i++) {
    let r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], a = rgba[i * 4 + 3];
    if (!alpha) {
      r = Math.round((r * a) / 255);
      g = Math.round((g * a) / 255);
      b = Math.round((b * a) / 255);
      a = 255;
    }
    if (r === pr && g === pg && b === pb && a === pa) {
      if (++run === 62 || i === n - 1) {
        out[o++] = 0xc0 | (run - 1);
        run = 0;
      }
      continue;
    }
    if (run > 0) {
      out[o++] = 0xc0 | (run - 1);
      run = 0;
    }
    const h = (r * 3 + g * 5 + b * 7 + a * 11) & 63;
    const packed = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
    if (index[h] === packed) out[o++] = h;
    else {
      index[h] = packed;
      if (a === pa) {
        const dr = r - pr, dg = g - pg, db = b - pb;
        // wrap to a signed byte like the reference encoder
        const wr = ((dr + 128) & 255) - 128, wg = ((dg + 128) & 255) - 128, wb = ((db + 128) & 255) - 128;
        if (wr >= -2 && wr <= 1 && wg >= -2 && wg <= 1 && wb >= -2 && wb <= 1) {
          out[o++] = 0x40 | ((wr + 2) << 4) | ((wg + 2) << 2) | (wb + 2);
        } else {
          const drg = wr - wg, dbg = wb - wg;
          if (wg >= -32 && wg <= 31 && drg >= -8 && drg <= 7 && dbg >= -8 && dbg <= 7) {
            out[o++] = 0x80 | (wg + 32);
            out[o++] = ((drg + 8) << 4) | (dbg + 8);
          } else {
            out[o++] = 0xfe;
            out[o++] = r;
            out[o++] = g;
            out[o++] = b;
          }
        }
      } else {
        out[o++] = 0xff;
        out[o++] = r;
        out[o++] = g;
        out[o++] = b;
        out[o++] = a;
      }
    }
    pr = r; pg = g; pb = b; pa = a;
  }
  out.set([0, 0, 0, 0, 0, 0, 0, 1], o);
  o += 8;
  return out.slice(0, o);
}
