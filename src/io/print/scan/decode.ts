/**
 * Photo decoding shared by the main thread and the scan worker (createImageBitmap + OffscreenCanvas exist in both), plus a
 * header reader that tells the pixel size of an encoded photo without decoding it (used to plan memory before queueing jobs).
 */
import type { RasterImage } from '../raster';

/** Can this realm decode a photo (a worker in an old browser may not have these)? */
export function canDecodeHere(): boolean {
  return typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined';
}

/** Decode to straight RGBA, EXIF orientation applied, longest side limited to `maxSide` (0 = unlimited). */
export async function decodeToRaster(blob: Blob, maxSide = 0): Promise<RasterImage> {
  // EXIF orientation is applied ('from-image' is the default; stated so the pipeline never sees a sideways photo).
  let bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    const long = Math.max(bmp.width, bmp.height);
    if (maxSide > 0 && long > maxSide) {
      const k = maxSide / long;
      const resized = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
      bmp.close();
      bmp = resized;
    }
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
    return { width: d.width, height: d.height, data: d.data };
  } finally {
    bmp.close();
  }
}

/** Pixel size stored in the header of a JPEG, PNG or WebP file, or null (other formats, damaged or truncated header). */
export function imageSizeFromHeader(b: Uint8Array): { width: number; height: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { width: u32(16), height: u32(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
        i += 2;
        continue;
      }
      // SOFn (not DHT, JPG, DAC): height then width
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: u16(i + 5), width: u16(i + 7) };
      i += 2 + u16(i + 2);
    }
    return null;
  }
  const tag = (i: number) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
  if (b.length > 30 && tag(0) === 'RIFF' && tag(8) === 'WEBP') {
    const kind = tag(12);
    if (kind === 'VP8X') return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === 'VP8L') {
      const v = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return { width: 1 + (v & 0x3fff), height: 1 + ((v >>> 14) & 0x3fff) };
    }
    if (kind === 'VP8 ') return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  return null;
}

/**
 * Pixels the scanner will hold for this photo after decoding (the longest side is limited to `maxSide`), or null when the
 * size cannot be read from the header. Reads only the first 256 KB of the file.
 */
export async function estimateDecodedPixels(blob: Blob, maxSide: number): Promise<number | null> {
  try {
    const head = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
    const s = imageSizeFromHeader(head);
    if (!s || s.width <= 0 || s.height <= 0) return null;
    const k = maxSide > 0 ? Math.min(1, maxSide / Math.max(s.width, s.height)) : 1;
    return Math.round(s.width * k) * Math.round(s.height * k);
  } catch {
    return null;
  }
}
