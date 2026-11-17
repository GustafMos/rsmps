/** Minimal synchronous PNG file writer (RGBA8, straight alpha) on fflate. Used by PNG-in-MOV and ICO. */
import { zlibSync } from 'fflate';
import { ByteWriter, crc32, type Pixels } from './util';

function pngChunk(w: ByteWriter, type: string, data: Uint8Array): void {
  const start = w.pos + 4;
  w.u32(data.length).ascii(type).bytes(data);
  w.u32(crc32(w.buf, start, w.pos));
}

/** A complete PNG file of an RGBA frame (filter 0, zlib via fflate; synchronous). */
export function pngFile(rgba: Pixels, width: number, height: number, level: 0 | 1 | 3 | 6 = 1): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const z = zlibSync(raw, { level });
  const w = new ByteWriter(z.length + 128);
  w.bytes(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  const ihdr = new ByteWriter(13).u32(width).u32(height).u8(8).u8(6).u8(0).u8(0).u8(0).result();
  pngChunk(w, 'IHDR', ihdr);
  pngChunk(w, 'IDAT', z);
  pngChunk(w, 'IEND', new Uint8Array(0));
  return w.result();
}

