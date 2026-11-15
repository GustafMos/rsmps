/** Dependency-free PNG encoder (fflate for deflate). Pure. */
import { zlibSync } from 'fflate';
import type { RasterImage } from './raster';

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

export interface PngOptions {
  /** Written as the pixel density (pHYs). */
  dpi?: number;
  /** Drop the alpha channel (smaller files for opaque pages). */
  opaque?: boolean;
  level?: number;
}

export function encodePng(img: RasterImage, opts: PngOptions = {}): Uint8Array {
  const { width: w, height: h, data } = img;
  const channels = opts.opaque ? 3 : 4;
  const stride = w * channels;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    raw[o] = 0;
    if (channels === 4) raw.set(data.subarray(y * w * 4, (y + 1) * w * 4), o + 1);
    else for (let x = 0, s = y * w * 4, d = o + 1; x < w; x++, s += 4, d += 3) {
      raw[d] = data[s];
      raw[d + 1] = data[s + 1];
      raw[d + 2] = data[s + 2];
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (opts.dpi) {
    const phys = new Uint8Array(9);
    const pv = new DataView(phys.buffer);
    const ppm = Math.round(opts.dpi / 0.0254);
    pv.setUint32(0, ppm);
    pv.setUint32(4, ppm);
    phys[8] = 1;
    parts.push(chunk('pHYs', phys));
  }
  parts.push(chunk('IDAT', zlibSync(raw, { level: (opts.level ?? 6) as 6 })), chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
