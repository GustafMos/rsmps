/**
 * Small still-picture writers: TGA, BMP, PPM / PAM and ICO. Each takes straight-alpha RGBA8 and returns the file bytes.
 * Formats without alpha composite over `background` (default black).
 */
import { pngFile } from './png';
import { ByteWriter, checkSize, concat, type Pixels } from './util';

export interface BackgroundOption {
  background?: [number, number, number];
}

function over(rgba: Pixels, i: number, bg: [number, number, number]): [number, number, number] {
  const a = rgba[i + 3];
  if (a === 255) return [rgba[i], rgba[i + 1], rgba[i + 2]];
  const k = a / 255;
  return [Math.round(rgba[i] * k + bg[0] * (1 - k)), Math.round(rgba[i + 1] * k + bg[1] * (1 - k)), Math.round(rgba[i + 2] * k + bg[2] * (1 - k))];
}

// ---------------------------------------------------------------- TGA

/** Truevision TGA 2.0, 32-bit BGRA, top-left origin, optional RLE (packets never cross a row). */
export function encodeTga(rgba: Pixels, width: number, height: number, opts: { rle?: boolean } = {}): Uint8Array {
  checkSize(rgba, width, height, 'TGA');
  if (width > 65535 || height > 65535) throw new Error('TGA: picture too large.');
  const head = new ByteWriter(18).u8(0).u8(0).u8(opts.rle ? 10 : 2).zeros(5).u16(0, true).u16(0, true).u16(width, true).u16(height, true).u8(32).u8(0x28).result();
  const footer = new ByteWriter(26).u32(0).u32(0).ascii('TRUEVISION-XFILE.').u8(0).result();
  const px = (i: number, o: Uint8Array, at: number) => {
    o[at] = rgba[i * 4 + 2];
    o[at + 1] = rgba[i * 4 + 1];
    o[at + 2] = rgba[i * 4];
    o[at + 3] = rgba[i * 4 + 3];
  };
  if (!opts.rle) {
    const body = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) px(i, body, i * 4);
    return concat([head, body, footer]);
  }
  const body = new Uint8Array(width * height * 5 + height * 2);
  let o = 0;
  const same = (a: number, b: number) => rgba[a * 4] === rgba[b * 4] && rgba[a * 4 + 1] === rgba[b * 4 + 1] && rgba[a * 4 + 2] === rgba[b * 4 + 2] && rgba[a * 4 + 3] === rgba[b * 4 + 3];
  for (let y = 0; y < height; y++) {
    let x = 0;
    const row = y * width;
    while (x < width) {
      let run = 1;
      while (x + run < width && run < 128 && same(row + x, row + x + run)) run++;
      if (run >= 2) {
        body[o++] = 0x80 | (run - 1);
        px(row + x, body, o);
        o += 4;
        x += run;
      } else {
        let n = 1;
        while (x + n < width && n < 128 && !(x + n + 1 < width && same(row + x + n, row + x + n + 1))) n++;
        body[o++] = n - 1;
        for (let k = 0; k < n; k++, o += 4) px(row + x + k, body, o);
        x += n;
      }
    }
  }
  return concat([head, body.subarray(0, o), footer]);
}

// ---------------------------------------------------------------- BMP

/** Windows BMP, bottom-up. alpha true: 32-bit BITMAPV5HEADER with masks and sRGB; false: 24-bit BITMAPINFOHEADER over `background`. */
export function encodeBmp(rgba: Pixels, width: number, height: number, opts: { alpha?: boolean } & BackgroundOption = {}): Uint8Array {
  checkSize(rgba, width, height, 'BMP');
  const alpha = opts.alpha ?? true;
  const bg = opts.background ?? [0, 0, 0];
  const bpp = alpha ? 4 : 3;
  const stride = Math.ceil((width * bpp) / 4) * 4;
  const headerSize = alpha ? 124 : 40;
  const dataOffset = 14 + headerSize;
  const dataSize = stride * height;
  const w = new ByteWriter(dataOffset + dataSize);
  w.ascii('BM').u32(dataOffset + dataSize, true).u32(0).u32(dataOffset, true);
  w.u32(headerSize, true).u32(width, true).u32(height, true).u16(1, true).u16(bpp * 8, true).u32(alpha ? 3 : 0, true).u32(dataSize, true).u32(2835, true).u32(2835, true).u32(0).u32(0);
  if (alpha) {
    w.u32(0x00ff0000, true).u32(0x0000ff00, true).u32(0x000000ff, true).u32(0xff000000, true);
    w.u32(0x73524742, true); // 'sRGB' colour space type (stored as the LE value 'BGRs')
    w.zeros(36); // endpoints
    w.zeros(12); // gamma
    w.u32(4, true); // intent: LCS_GM_IMAGES
    w.u32(0).u32(0).u32(0);
  }
  const body = new Uint8Array(dataSize);
  for (let y = 0; y < height; y++) {
    const row = (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (alpha) {
        body[row + x * 4] = rgba[i + 2];
        body[row + x * 4 + 1] = rgba[i + 1];
        body[row + x * 4 + 2] = rgba[i];
        body[row + x * 4 + 3] = rgba[i + 3];
      } else {
        const [r, g, b] = over(rgba, i, bg);
        body[row + x * 3] = b;
        body[row + x * 3 + 1] = g;
        body[row + x * 3 + 2] = r;
      }
    }
  }
  w.bytes(body);
  return w.result();
}

// ---------------------------------------------------------------- PNM

/** Netpbm: PPM (P6, RGB over `background`) or PAM (P7, RGB_ALPHA). */
export function encodePnm(rgba: Pixels, width: number, height: number, opts: { alpha?: boolean } & BackgroundOption = {}): Uint8Array {
  checkSize(rgba, width, height, 'PNM');
  const alpha = opts.alpha ?? false;
  const bg = opts.background ?? [0, 0, 0];
  const head = new TextEncoder().encode(alpha ? `P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n` : `P6\n${width} ${height}\n255\n`);
  const body = new Uint8Array(width * height * (alpha ? 4 : 3));
  for (let i = 0; i < width * height; i++) {
    if (alpha) body.set(rgba.subarray(i * 4, i * 4 + 4), i * 4);
    else body.set(over(rgba, i * 4, bg), i * 3);
  }
  return concat([head, body]);
}

// ---------------------------------------------------------------- ICO

/** Resample for icon sizes: 'nearest' keeps pixel art crisp, 'box' averages (premultiplied) for photos and smooth art. */
export function resizeRgba(rgba: Pixels, sw: number, sh: number, dw: number, dh: number, mode: 'nearest' | 'box'): Uint8Array {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const o = (y * dw + x) * 4;
      if (mode === 'nearest') {
        const i = (Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh)) * sw + Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw))) * 4;
        out.set(rgba.subarray(i, i + 4), o);
        continue;
      }
      const x0 = (x * sw) / dw, x1 = ((x + 1) * sw) / dw, y0 = (y * sh) / dh, y1 = ((y + 1) * sh) / dh;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wgt = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          const i = (Math.min(sh - 1, sy) * sw + Math.min(sw - 1, sx)) * 4;
          const pa = rgba[i + 3] * wgt;
          r += rgba[i] * pa;
          g += rgba[i + 1] * pa;
          b += rgba[i + 2] * pa;
          a += pa;
          wsum += wgt;
        }
      }
      if (a > 0) out.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / wsum)], o);
    }
  }
  return out;
}

/** ICO with PNG-compressed 32-bit entries (Windows Vista and later, browsers, macOS). Sizes 1..256, square or not. */
export function encodeIco(rgba: Pixels, width: number, height: number, opts: { sizes?: number[]; scale?: 'nearest' | 'box' } = {}): Uint8Array {
  checkSize(rgba, width, height, 'ICO');
  const sizes = [...new Set(opts.sizes ?? [16, 32, 48, 64, 128, 256])].sort((a, b) => a - b);
  if (!sizes.length || sizes.some((s) => !Number.isInteger(s) || s < 1 || s > 256)) throw new Error('ICO: sizes must be integers from 1 to 256.');
  const side = Math.max(width, height);
  const images = sizes.map((s) => {
    // Fit the whole picture into the s x s square, centred, transparent padding.
    const dw = Math.max(1, Math.round((width * s) / side));
    const dh = Math.max(1, Math.round((height * s) / side));
    const scaled = dw === width && dh === height ? new Uint8Array(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.length)) : resizeRgba(rgba, width, height, dw, dh, opts.scale ?? 'nearest');
    let sq = scaled;
    if (dw !== s || dh !== s) {
      sq = new Uint8Array(s * s * 4);
      const ox = (s - dw) >> 1;
      const oy = (s - dh) >> 1;
      for (let y = 0; y < dh; y++) sq.set(scaled.subarray(y * dw * 4, (y + 1) * dw * 4), ((oy + y) * s + ox) * 4);
    }
    return pngFile(sq, s, s, 6);
  });
  const w = new ByteWriter(22 + images.length * 16);
  w.u16(0, true).u16(1, true).u16(images.length, true);
  let offset = 6 + images.length * 16;
  images.forEach((img, i) => {
    const s = sizes[i];
    w.u8(s === 256 ? 0 : s).u8(s === 256 ? 0 : s).u8(0).u8(0).u16(1, true).u16(32, true).u32(img.length, true).u32(offset, true);
    offset += img.length;
  });
  return concat([w.result(), ...images]);
}
