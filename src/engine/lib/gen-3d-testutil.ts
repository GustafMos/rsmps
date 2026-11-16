import { tmpdir } from 'node:os';
/** Test helpers for the 3D family: a PNG writer for looking at renders, and a contact-sheet builder. Tests only. */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Where test previews go: RSMPS_PREVIEW_DIR when set, otherwise a folder in the OS temp directory. */
export const PNG_DIR = (process.env.RSMPS_PREVIEW_DIR ?? join(tmpdir(), 'rsmps-previews')).split('\\').join('/');

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

export interface Img {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Write straight RGBA pixels as a PNG over a grey checkerboard (so transparency is visible). */
export function writePng(name: string, px: Img, backdrop = true): string {
  mkdirSync(PNG_DIR, { recursive: true });
  const { width, height, data } = px;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      const bg = backdrop ? (((x >> 3) + (y >> 3)) % 2 ? 150 : 110) : 20;
      for (let c = 0; c < 3; c++) raw[y * (width * 3 + 1) + 1 + x * 3 + c] = Math.round(data[i + c] * a + bg * (1 - a));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const file = join(PNG_DIR, name.endsWith('.png') ? name : `${name}.png`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  return file;
}

/** Lay several same-size renders side by side. */
export function sheet(items: Img[], cols = items.length): Img {
  const w = items[0].width;
  const h = items[0].height;
  const rows = Math.ceil(items.length / cols);
  const out = new Uint8ClampedArray(w * cols * h * rows * 4);
  items.forEach((it, k) => {
    const ox = (k % cols) * w;
    const oy = Math.floor(k / cols) * h;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) out[((oy + y) * w * cols + ox + x) * 4 + c] = it.data[(y * w + x) * 4 + c];
  });
  return { data: out, width: w * cols, height: h * rows };
}
