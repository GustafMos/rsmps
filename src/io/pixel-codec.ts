/**
 * Packing of finished frames into system RAM (player frame cache, engine RAM tier, baked sequences).
 *
 * Measured on a 1920x1080 frame in Chromium (dithered test graph), see the memory pass notes:
 *   deflate (CompressionStream, off the main thread)   19 ms   38 KB   inflate 9 ms   exact
 *   PNG                                                56 ms   78 KB   decode 7 ms    exact
 *   WebP quality 1 (lossless in Chromium)              50 ms   41 KB   decode 13 ms   exact
 *   WebP 0.92 (lossy)                                 129 ms   47 KB   decode 10 ms   max error 74
 *   JPEG 0.92 (lossy, no alpha)                        51 ms  120 KB   decode 7 ms    max error 70
 * Deflate is the fastest exact scheme and tiny for graphics, dithering and pixel art (the tool's material); photographic frames
 * deflate badly, and only for those a lossy codec is used (preview quality "compressed"). "lossless" never uses a lossy codec.
 */

export type Codec = 'raw' | 'deflate' | 'jpeg' | 'webp';
export type CacheQuality = 'compressed' | 'lossless';

export interface Packed {
  codec: Codec;
  /** Bytes for raw/deflate (premultiplied RGBA8), an encoded image for jpeg/webp (straight alpha). */
  data: Uint8Array | Blob;
  /** Size held in memory. */
  bytes: number;
  width: number;
  height: number;
}

/** A frame that deflates to less than this share of raw RGBA stays lossless even in "compressed" mode. */
const LOSSLESS_KEEP_RATIO = 0.12;

export const canDeflate = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

/** CompressionStream runs zlib on the main thread, one chunk per task: a whole 8 MB frame of noise blocks it for 150 ms. Feed it slices. */
const SLICE = 256 * 1024;
const yieldToEventLoop = () => new Promise<void>((r) => setTimeout(r, 0));

async function pump(stream: { writable: WritableStream<BufferSource>; readable: ReadableStream<Uint8Array> }, data: Uint8Array): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.readable.getReader();
  const reading = (async () => {
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      parts.push(r.value);
      total += r.value.byteLength;
    }
  })();
  const w = stream.writable.getWriter();
  try {
    for (let at = 0; at < data.byteLength; at += SLICE) {
      await w.write(data.subarray(at, Math.min(data.byteLength, at + SLICE)) as never);
      if ((at / SLICE) % 4 === 3) await yieldToEventLoop(); // let input, rendering and timers run between slices
    }
    await w.close();
  } catch (err) {
    void reader.cancel().catch(() => undefined);
    throw err;
  }
  await reading;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export function deflate(data: Uint8Array): Promise<Uint8Array> {
  return pump(new CompressionStream('deflate-raw') as never, data);
}

export async function inflate(data: Uint8Array, length: number): Promise<Uint8Array> {
  const out = await pump(new DecompressionStream('deflate-raw') as never, data);
  if (out.length !== length) throw new Error(`inflate: expected ${length} bytes, got ${out.length}`);
  return out;
}

/**
 * Cheap estimate of how well a frame deflates: compresses three thin slabs (top, middle, bottom) and returns packed/raw.
 * About 1 ms. Used to skip a full deflate of a photographic frame that a lossy codec will take anyway.
 */
export async function deflateRatioEstimate(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Promise<number> {
  if (!canDeflate) return 1;
  const rows = Math.min(height, 16);
  const rowBytes = width * 4;
  const slab = new Uint8Array(rows * rowBytes * 3);
  const at = [0, Math.max(0, Math.floor(height / 2) - rows / 2), Math.max(0, height - rows)];
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  at.forEach((y, i) => slab.set(bytes.subarray(y * rowBytes, (y + rows) * rowBytes), i * rows * rowBytes));
  const z = await deflate(slab);
  return z.byteLength / slab.byteLength;
}

/** Exact packing of premultiplied RGBA8. Falls back to the raw bytes where CompressionStream does not exist. */
export async function packLossless(data: Uint8Array | Uint8ClampedArray, width: number, height: number): Promise<Packed> {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (!canDeflate) return { codec: 'raw', data: bytes, bytes: bytes.byteLength, width, height };
  const z = await deflate(bytes);
  if (z.byteLength >= bytes.byteLength) return { codec: 'raw', data: bytes, bytes: bytes.byteLength, width, height };
  return { codec: 'deflate', data: z, bytes: z.byteLength, width, height };
}

function hasAlpha(px: Uint8Array | Uint8ClampedArray): boolean {
  for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) return true;
  return false;
}

/** Encodes the frame a lossy way without touching pixels in JS (the player draws the texture into an OffscreenCanvas and calls convertToBlob). */
export type LossyEncoder = (alpha: boolean) => Promise<Blob>;

/**
 * Pack a finished (premultiplied) frame. 'lossless' is exact; 'compressed' is exact too unless the picture does not deflate well
 * (photographic content), in which case JPEG (opaque) or WebP (alpha) is used. `lossy` is the preferred way to encode (no pixel loops
 * on the main thread); without it the pixels are un-premultiplied in JS and drawn through a 2D canvas.
 */
export async function packFrame(data: Uint8Array | Uint8ClampedArray, width: number, height: number, quality: CacheQuality, lossy?: LossyEncoder): Promise<Packed> {
  const canLossy = !!lossy || typeof OffscreenCanvas !== 'undefined';
  if (quality === 'compressed' && canLossy && (await deflateRatioEstimate(data, width, height)) > LOSSLESS_KEEP_RATIO * 3) {
    // clearly not graphics: skip the full deflate and go straight to the lossy codec
    const p = await packLossy(data, width, height, lossy);
    if (p) return p;
  }
  const exact = await packLossless(data, width, height);
  if (quality === 'lossless' || exact.bytes <= data.byteLength * LOSSLESS_KEEP_RATIO || !canLossy) return exact;
  const p = await packLossy(data, width, height, lossy);
  return p && p.bytes < exact.bytes ? p : exact;
}

async function packLossy(data: Uint8Array | Uint8ClampedArray, width: number, height: number, lossy?: LossyEncoder): Promise<Packed | null> {
  const alpha = hasAlpha(data);
  try {
    if (lossy) {
      const blob = await lossy(alpha);
      return blob.size > 0 ? { codec: alpha ? 'webp' : 'jpeg', data: blob, bytes: blob.size, width, height } : null;
    }
    return await packLossyViaCanvas(data, width, height, alpha);
  } catch {
    return null;
  }
}

async function packLossyViaCanvas(data: Uint8Array | Uint8ClampedArray, width: number, height: number, alpha: boolean): Promise<Packed | null> {
  // un-premultiply into straight RGBA for the image encoder
  const straight = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 255 || a === 0) {
      straight[i] = data[i];
      straight[i + 1] = data[i + 1];
      straight[i + 2] = data[i + 2];
    } else {
      straight[i] = Math.min(255, Math.round((data[i] * 255) / a));
      straight[i + 1] = Math.min(255, Math.round((data[i + 1] * 255) / a));
      straight[i + 2] = Math.min(255, Math.round((data[i + 2] * 255) / a));
    }
    straight[i + 3] = a;
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d')!.putImageData(new ImageData(straight, width, height), 0, 0);
  const blob = await canvas.convertToBlob(alpha ? { type: 'image/webp', quality: 0.9 } : { type: 'image/jpeg', quality: 0.92 });
  return blob.size > 0 ? { codec: alpha ? 'webp' : 'jpeg', data: blob, bytes: blob.size, width, height } : null;
}

/** Premultiplied RGBA8 of a raw/deflate pack. Lossy packs go through `unpackToBitmap`. */
export async function unpackBytes(p: Packed): Promise<Uint8Array> {
  const data = p.data as Uint8Array;
  if (p.codec === 'raw') return data;
  if (p.codec === 'deflate') return inflate(data, p.width * p.height * 4);
  throw new Error(`unpackBytes: ${p.codec} is an image codec`);
}

/** Decode a lossy pack to an ImageBitmap (straight alpha: upload with premultipliedAlpha). */
export function unpackToBitmap(p: Packed): Promise<ImageBitmap> {
  return createImageBitmap(p.data as Blob, { premultiplyAlpha: 'none' });
}

export function isLossy(p: Packed): boolean {
  return p.codec === 'jpeg' || p.codec === 'webp';
}
