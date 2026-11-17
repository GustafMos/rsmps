/**
 * HAP video (Vidvox, BSD-2-Clause specification) in a QuickTime MOV: Hap1 (DXT1), Hap5 (DXT5 with alpha), HapY (scaled YCoCg DXT5).
 * Frame container per the public HAP spec: a section header of 4 bytes (24-bit little-endian size + type byte) or 8 bytes (three zero
 * bytes, type byte, 32-bit little-endian size). Type byte = second-stage compressor (0xA0 none, 0xB0 snappy) | texture format
 * (0x0B DXT1, 0x0E DXT5, 0x0F scaled YCoCg DXT5). Chunked ("complex") frames are not produced.
 */
import { compressDxt, dxtFrameBytes, type DxtFormat } from './dxt';
import { createMovMuxer, type MovAudioConfig, type MovMuxer } from './mov';
import type { ByteSink } from './sink';
import { snappyEncode } from './snappy';
import { checkSize, type EncodeOptions, type EncodeSession, type Pixels } from './util';

export const HAP_TEXTURE_CODE: Record<DxtFormat, number> = { Hap1: 0x0b, Hap5: 0x0e, HapY: 0x0f };
const COMPRESSOR_NAME: Record<DxtFormat, string> = { Hap1: 'Hap', Hap5: 'Hap Alpha', HapY: 'Hap Q' };

/** Wrap a texture (compressed blocks) into a HAP frame. Snappy is used only when it makes the frame smaller. */
export function hapFrame(texture: Uint8Array, fmt: DxtFormat, snappy: boolean): Uint8Array {
  let body = texture;
  let comp = 0xa0;
  if (snappy) {
    const s = snappyEncode(texture);
    if (s.length < texture.length) {
      body = s;
      comp = 0xb0;
    }
  }
  const type = comp | HAP_TEXTURE_CODE[fmt];
  const small = body.length < 0x1000000;
  const out = new Uint8Array((small ? 4 : 8) + body.length);
  if (small) {
    out[0] = body.length & 255;
    out[1] = (body.length >> 8) & 255;
    out[2] = (body.length >> 16) & 255;
    out[3] = type;
    out.set(body, 4);
  } else {
    out[3] = type;
    out[4] = body.length & 255;
    out[5] = (body.length >> 8) & 255;
    out[6] = (body.length >> 16) & 255;
    out[7] = (body.length >>> 24) & 255;
    out.set(body, 8);
  }
  return out;
}

export interface HapOptions extends EncodeOptions {
  /** Default Hap1 (Hap5 when `alpha` is true). */
  format?: DxtFormat;
  alpha?: boolean;
  /** Second-stage Snappy compression. Default false. */
  snappy?: boolean;
  /** CPU least-squares refinements per block (default 2). Ignored for addTexture. */
  refine?: number;
  audio?: MovAudioConfig;
  /** Write the file through this sink (nothing is kept in memory; `finish()` then resolves with no parts). */
  sink?: ByteSink;
  /** Number of frames that will be added; lets a sink that cannot seek be used when frames have a fixed size (no Snappy, no audio). */
  frames?: number;
}

/** Bytes of a HAP frame without Snappy (section header + texture). */
export function hapFixedFrameBytes(textureBytes: number): number {
  return (textureBytes < 0x1000000 ? 4 : 8) + textureBytes;
}

export class HapSession implements EncodeSession {
  readonly format: DxtFormat;
  private readonly mux: MovMuxer;
  private readonly tex: Uint8Array;
  private readonly snappy: boolean;
  private readonly refine: number | undefined;
  /** Texture size per frame in bytes (blocks of the padded size). */
  readonly textureBytes: number;
  constructor(private readonly o: HapOptions) {
    this.format = o.format ?? (o.alpha ? 'Hap5' : 'Hap1');
    this.snappy = !!o.snappy;
    this.refine = o.refine;
    this.textureBytes = dxtFrameBytes(o.width, o.height, this.format);
    this.tex = new Uint8Array(this.textureBytes);
    const fixed = o.sink && !o.sink.seekable && o.frames !== undefined && !o.snappy && !o.audio ? o.frames * hapFixedFrameBytes(this.textureBytes) : undefined;
    this.mux = createMovMuxer({
      sink: o.sink,
      declaredPayload: fixed,
      width: o.width,
      height: o.height,
      fps: o.fps ?? 25,
      video: { fourcc: this.format, compressorName: COMPRESSOR_NAME[this.format], depth: this.format === 'Hap1' ? 24 : 32 },
      audio: o.audio,
    });
  }
  /** Compress on the CPU and append. */
  addFrame(rgba: Pixels): void | Promise<void> {
    checkSize(rgba, this.o.width, this.o.height, 'HAP');
    compressDxt(rgba, this.o.width, this.o.height, this.format, this.tex, { refine: this.refine });
    return this.mux.addVideo(hapFrame(this.tex, this.format, this.snappy));
  }
  /** Append blocks that were compressed elsewhere (the GPU path). Must be `textureBytes` long. */
  addTexture(blocks: Uint8Array): void | Promise<void> {
    if (blocks.length !== this.textureBytes) throw new Error('HAP: the texture size does not match the frame size.');
    return this.mux.addVideo(hapFrame(blocks, this.format, this.snappy));
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

export function beginHap(o: HapOptions): HapSession {
  return new HapSession(o);
}
