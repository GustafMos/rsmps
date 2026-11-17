/**
 * Standalone encoders (no FFmpeg, no extra dependency) as a table of descriptors. Each `begin(options)` returns a session with
 * `addFrame(...)` and `finish() -> Uint8Array[]` (blob parts). Image kinds accept exactly one frame. See README.md in this folder.
 */
import { encodeAiff } from './aiff';
import { FlacEncoder } from './flac';
import { beginApng, type ApngOptions } from './apng';
import { beginGif, type GifOptions } from './gif';
import { beginHap, type HapOptions } from './hap';
import { encodeExr, encodeHdr, type FloatPixels } from './float';
import { beginMjpegMov, beginPngMov, beginRawMov, type MjpegOptions, type MovCodecOptions } from './mov-codecs';
import { encodeQoi } from './qoi';
import { encodeBmp, encodeIco, encodePnm, encodeTga } from './stills';
import { encodeTiff } from './tiff';
import { checkSize, type EncodeOptions, type EncoderDescriptor, type EncodeSession, type Pixels } from './util';

export * from './util';
export { beginGif, gifDelays, type GifOptions } from './gif';
export { beginApng, type ApngOptions } from './apng';
export { beginHap, hapFrame, HapSession, type HapOptions } from './hap';
export { createHapGpuCompressor, type HapGpu, type HapGpuCompressor } from './hap-gpu';
export { compressDxt, decompressDxt, dxtFrameBytes, psnr, type DxtFormat } from './dxt';
export { snappyEncode, snappyDecode } from './snappy';
export { createMovMuxer, MovMuxer, type MovOptions } from './mov';
export { MemorySink, type ByteSink } from './sink';
export { beginMjpegMov, beginPngMov, beginRawMov, canvasJpeg, type JpegEncoder } from './mov-codecs';
export { pngFile } from './png';
export { encodeQoi } from './qoi';
export { encodeBmp, encodeTga, encodePnm, encodeIco, resizeRgba } from './stills';
export { encodeTiff, encodeTiffPages, type TiffPage, type TiffOptions } from './tiff';
export { encodeHdr, encodeExr, floatToHalf, halfToFloat, type FloatPixels } from './float';
export { encodeAiff, extended80 } from './aiff';
export { encodeFlac, FlacEncoder } from './flac';

/** One picture in, one file out. */
function still(o: EncodeOptions, encode: (rgba: Pixels, w: number, h: number) => Uint8Array): EncodeSession {
  let file: Uint8Array | null = null;
  return {
    addFrame(rgba) {
      if (file) throw new Error('This format holds one picture; write one file per frame.');
      checkSize(rgba, o.width, o.height, 'image');
      file = encode(rgba, o.width, o.height);
    },
    async finish() {
      if (!file) throw new Error('No frame was added.');
      return [file];
    },
  };
}

function floatStill(o: EncodeOptions, encode: (px: FloatPixels, w: number, h: number) => Uint8Array): EncodeSession {
  let file: Uint8Array | null = null;
  return {
    addFrame(px) {
      if (file) throw new Error('This format holds one picture; write one file per frame.');
      let data: FloatPixels;
      if (px instanceof Float32Array || px instanceof Uint16Array) data = px;
      else {
        // 8-bit input: straight alpha RGBA -> premultiplied float, value / 255 (no colour-space conversion).
        const f = new Float32Array(px.length);
        for (let i = 0; i < px.length; i += 4) {
          const a = px[i + 3] / 255;
          f[i] = (px[i] / 255) * a;
          f[i + 1] = (px[i + 1] / 255) * a;
          f[i + 2] = (px[i + 2] / 255) * a;
          f[i + 3] = a;
        }
        data = f;
      }
      if (data.length !== o.width * o.height * 4) throw new Error('The pixel data does not match the size.');
      file = encode(data, o.width, o.height);
    },
    async finish() {
      if (!file) throw new Error('No frame was added.');
      return [file];
    },
  };
}

export interface AudioOptions extends EncodeOptions {
  sampleRate: number;
  bits?: 16 | 24;
}

function aiffSession(o: AudioOptions): EncodeSession {
  const chunks: Float32Array[][] = [];
  return {
    addFrame() {
      throw new Error('Audio encoders take addAudio().');
    },
    addAudio(channels) {
      chunks.push(channels.map((c) => c.slice()));
    },
    async finish() {
      const n = chunks[0]?.length ?? 0;
      const channels = Array.from({ length: n }, (_, c) => {
        const total = chunks.reduce((s, ch) => s + ch[c].length, 0);
        const out = new Float32Array(total);
        let at = 0;
        for (const ch of chunks) {
          out.set(ch[c], at);
          at += ch[c].length;
        }
        return out;
      });
      return [encodeAiff({ sampleRate: o.sampleRate, channels }, o.bits ?? 24)];
    },
  };
}

function flacSession(o: AudioOptions): EncodeSession {
  const enc = new FlacEncoder({ sampleRate: o.sampleRate, bits: o.bits });
  return {
    addFrame() {
      throw new Error('Audio encoders take addAudio().');
    },
    addAudio: (channels) => enc.addAudio(channels),
    async finish() {
      return enc.finish();
    },
  };
}

const mov = (id: string, label: string, alpha: boolean, lossless: boolean, begin: EncoderDescriptor['begin']): EncoderDescriptor => ({
  id,
  label,
  extension: 'mov',
  mime: 'video/quicktime',
  kind: 'video',
  alpha,
  lossless,
  input: 'rgba8',
  begin,
});

export const ENCODERS: EncoderDescriptor[] = [
  mov('hap', 'HAP', false, false, (o) => beginHap({ ...(o as HapOptions), format: 'Hap1' })),
  mov('hap-alpha', 'HAP with alpha', true, false, (o) => beginHap({ ...(o as HapOptions), format: 'Hap5' })),
  mov('hap-q', 'HAP Q', false, false, (o) => beginHap({ ...(o as HapOptions), format: 'HapY' })),
  mov('mov-mjpeg', 'Motion JPEG MOV', false, false, (o) => beginMjpegMov(o as MjpegOptions)),
  mov('mov-png', 'PNG MOV', true, true, (o) => beginPngMov(o as MovCodecOptions)),
  mov('mov-raw', 'Uncompressed MOV', true, true, (o) => beginRawMov(o as MovCodecOptions)),
  { id: 'gif', label: 'Animated GIF', extension: 'gif', mime: 'image/gif', kind: 'animation', alpha: true, lossless: false, input: 'rgba8', begin: (o) => beginGif(o as GifOptions) },
  { id: 'apng', label: 'Animated PNG', extension: 'png', mime: 'image/apng', kind: 'animation', alpha: true, lossless: true, input: 'rgba8', begin: (o) => beginApng(o as ApngOptions) },
  { id: 'bmp', label: 'BMP', extension: 'bmp', mime: 'image/bmp', kind: 'image', alpha: true, lossless: true, input: 'rgba8', begin: (o) => still(o, (p, w, h) => encodeBmp(p, w, h, { alpha: o.alpha !== false, background: o.background as [number, number, number] | undefined })) },
  { id: 'tga', label: 'TGA', extension: 'tga', mime: 'image/x-tga', kind: 'image', alpha: true, lossless: true, input: 'rgba8', begin: (o) => still(o, (p, w, h) => encodeTga(p, w, h, { rle: o.rle !== false })) },
  { id: 'tiff', label: 'TIFF', extension: 'tif', mime: 'image/tiff', kind: 'image', alpha: true, lossless: true, input: 'rgba8', begin: (o) => still(o, (p, w, h) => encodeTiff(p, w, h, { compression: o.compression === 'none' ? 'none' : 'deflate' })) },
  { id: 'qoi', label: 'QOI', extension: 'qoi', mime: 'image/qoi', kind: 'image', alpha: true, lossless: true, input: 'rgba8', begin: (o) => still(o, (p, w, h) => encodeQoi(p, w, h)) },
  { id: 'pam', label: 'PAM with alpha', extension: 'pam', mime: 'image/x-portable-arbitrarymap', kind: 'image', alpha: true, lossless: true, input: 'rgba8', begin: (o) => still(o, (p, w, h) => encodePnm(p, w, h, { alpha: true })) },
  { id: 'ppm', label: 'PPM', extension: 'ppm', mime: 'image/x-portable-pixmap', kind: 'image', alpha: false, lossless: true, input: 'rgba8', begin: (o) => still(o, (p, w, h) => encodePnm(p, w, h)) },
  { id: 'ico', label: 'ICO icon', extension: 'ico', mime: 'image/vnd.microsoft.icon', kind: 'image', alpha: true, lossless: true, input: 'rgba8', begin: (o) => still(o, (p, w, h) => encodeIco(p, w, h, { sizes: o.sizes as number[] | undefined, scale: o.scale as 'nearest' | 'box' | undefined })) },
  { id: 'hdr', label: 'Radiance HDR', extension: 'hdr', mime: 'image/vnd.radiance', kind: 'image', alpha: false, lossless: false, input: 'float', begin: (o) => floatStill(o, encodeHdr) },
  { id: 'exr', label: 'OpenEXR half float', extension: 'exr', mime: 'image/x-exr', kind: 'image', alpha: true, lossless: true, input: 'float', begin: (o) => floatStill(o, (p, w, h) => encodeExr(p, w, h, { compression: o.compression === 'none' ? 'none' : 'zip' })) },
  { id: 'aiff', label: 'AIFF audio', extension: 'aiff', mime: 'audio/aiff', kind: 'audio', alpha: false, lossless: true, input: 'pcm', begin: (o) => aiffSession(o as AudioOptions) },
  { id: 'flac', label: 'FLAC audio', extension: 'flac', mime: 'audio/flac', kind: 'audio', alpha: false, lossless: true, input: 'pcm', begin: (o) => flacSession({ ...(o as AudioOptions), bits: (o as AudioOptions).bits ?? 16 }) },
];

export function getEncoder(id: string): EncoderDescriptor | undefined {
  return ENCODERS.find((e) => e.id === id);
}
