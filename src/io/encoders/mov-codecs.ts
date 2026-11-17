/**
 * Other all-intra codecs in MOV through the generic muxer:
 *  - Photo-JPEG ('jpeg' sample entry): one baseline JFIF JPEG per frame, produced by a callback (browser: canvas.convertToBlob).
 *  - PNG ('png ' sample entry, depth 32): one complete PNG file per frame, RGBA straight alpha, lossless.
 *  - Uncompressed ('raw ' sample entry, depth 32): 8-bit ARGB, the QuickTime "None" 32-bit layout, lossless with alpha.
 */
import { createMovMuxer, type MovAudioConfig, type MovMuxer } from './mov';
import type { ByteSink } from './sink';
import { pngFile } from './png';
import { checkSize, type EncodeOptions, type EncodeSession, type Pixels } from './util';

export interface MovCodecOptions extends EncodeOptions {
  audio?: MovAudioConfig;
  /** Write the file through this sink instead of collecting it (see sink.ts). */
  sink?: ByteSink;
  /** Total bytes of all samples when known (raw MOV: frames * w * h * 4); lets a sink that cannot seek be used. */
  declaredPayload?: number;
}

class MovSession implements EncodeSession {
  protected readonly mux: MovMuxer;
  constructor(protected readonly o: MovCodecOptions, fourcc: string, name: string, depth: 24 | 32, private readonly make: (rgba: Pixels) => Uint8Array | Promise<Uint8Array>) {
    this.mux = createMovMuxer({ width: o.width, height: o.height, fps: o.fps ?? 25, video: { fourcc, compressorName: name, depth }, audio: o.audio, sink: o.sink, declaredPayload: o.declaredPayload });
  }
  async addFrame(rgba: Pixels): Promise<void> {
    checkSize(rgba, this.o.width, this.o.height, 'MOV');
    await this.mux.addVideo(await this.make(rgba));
  }
  addAudio(channels: Float32Array[]): void | Promise<void> {
    return this.mux.addAudio(channels);
  }
  async finish(): Promise<Uint8Array[]> {
    if (this.mux.streaming) {
      await this.mux.close();
      return [];
    }
    return this.mux.finish();
  }
}

/** Callback that returns a baseline JPEG for an RGBA frame. */
export type JpegEncoder = (rgba: Pixels, width: number, height: number, quality: number) => Promise<Uint8Array>;

/** JPEG through OffscreenCanvas / canvas.convertToBlob. Browser and worker only. */
export const canvasJpeg: JpegEncoder = async (rgba, width, height, quality) => {
  const g = globalThis as unknown as { OffscreenCanvas?: new (w: number, h: number) => { getContext(t: string): { putImageData(d: unknown, x: number, y: number): void } | null; convertToBlob(o: { type: string; quality: number }): Promise<Blob> } };
  if (!g.OffscreenCanvas) throw new Error('Motion JPEG needs a canvas (browser or worker); pass a `jpeg` encoder callback elsewhere.');
  const c = new g.OffscreenCanvas(width, height);
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('Motion JPEG: no 2D context.');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length) as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
};

export interface MjpegOptions extends MovCodecOptions {
  /** 0..1, default 0.92. */
  quality?: number;
  jpeg?: JpegEncoder;
}

export function beginMjpegMov(o: MjpegOptions): MovSession {
  const enc = o.jpeg ?? canvasJpeg;
  return new MovSession(o, 'jpeg', 'Photo - JPEG', 24, (rgba) => enc(rgba, o.width, o.height, o.quality ?? 0.92));
}

export function beginPngMov(o: MovCodecOptions): MovSession {
  return new MovSession(o, 'png ', 'PNG', 32, (rgba) => pngFile(rgba, o.width, o.height));
}

export function beginRawMov(o: MovCodecOptions): MovSession {
  return new MovSession(o, 'raw ', 'None', 32, (rgba) => {
    const out = new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) {
      out[i] = rgba[i + 3];
      out[i + 1] = rgba[i];
      out[i + 2] = rgba[i + 1];
      out[i + 3] = rgba[i + 2];
    }
    return out;
  });
}
