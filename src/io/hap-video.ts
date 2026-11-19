/**
 * Playing HAP clips: finding a frame in the file and putting it on a GPU texture. The frame container itself is in hap.ts.
 *
 * Why HAP does not go through the video decoder like every other clip: no browser decodes it, and it does not need
 * decoding. A frame is already a texture in the form desktop graphics cards read (BC blocks). So a frame costs one read
 * from the file, an optional Snappy unpack, one upload and one small draw. Every frame stands alone: any frame of any clip
 * costs the same, which is what makes many clips at once, scrubbing and playing backwards cheap.
 *
 * Two ways to the texture:
 *   - the graphics card reads BC textures (`texture-compression-bc`, asked for when the device is made, see gpu.ts): the
 *     blocks are uploaded as they are and one draw turns them into the engine's premultiplied RGBA (HAP Q is converted
 *     from its brightness / colour-difference form in that draw).
 *   - it does not (most phones, some software renderers): the blocks are decoded on the CPU (hap.ts) and uploaded as
 *     plain RGBA. Slower, same picture.
 */
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, type EncodedPacket } from 'mediabunny';
import type { Gpu } from '../engine/gpu/gpu';
import { hapBlockBytes, hapName, hapTextureBytes, hapToRgba, parseHapFrame, type HapFormat, type HapFrame } from './hap';

/** True when this device can be handed BC blocks directly. */
export function canUploadBc(device: { features: { has(name: string): boolean } }): boolean {
  return device.features.has('texture-compression-bc');
}

/* ---------------------------------------------------------------------------------------------- */
/* Reader: frames of one file                                                                      */
/* ---------------------------------------------------------------------------------------------- */

export interface HapFramePlace {
  /** Handle for `read`. */
  packet: EncodedPacket;
  /** The time range (seconds) this frame is shown for; `end` is Infinity for the last frame. */
  start: number;
  end: number;
}

/**
 * The HAP frames of one file. The app's demuxer cannot decode HAP but it does hand out the raw samples of a track it does
 * not know, which is all that is needed here. Nothing is kept between calls: every frame is its own read.
 */
export class HapReader {
  private input: Input;
  private sink: EncodedPacketSink | null = null;
  private ready: Promise<void> | null = null;
  /** Sample entry name: Hap1, Hap5, HapY, HapM, HapA or Hap7. Set by `init`. */
  fourcc = '';
  /** Size of the picture as stored (the blocks cover it rounded up to multiples of 4). Set by `init`. */
  width = 0;
  height = 0;

  constructor(blob: Blob) {
    this.input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  }

  /** Opens the file. Rejects when its video track is not HAP. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      const track = await this.input.getPrimaryVideoTrack();
      const id = track ? await track.getInternalCodecId() : null;
      if (!track || !hapName(id)) throw new Error('Not a HAP video.');
      this.fourcc = id as string;
      this.width = await track.getCodedWidth();
      this.height = await track.getCodedHeight();
      this.sink = new EncodedPacketSink(track);
    })();
    return this.ready;
  }

  /** Which frame is shown at `t` (the first one for a time before the clip starts). Reads only the file's index, not the frame. */
  async locate(t: number): Promise<HapFramePlace | null> {
    await this.init();
    const sink = this.sink!;
    const packet = (await sink.getPacket(Math.max(0, t), { metadataOnly: true })) ?? (await sink.getFirstPacket({ metadataOnly: true }));
    if (!packet) return null;
    const next = await sink.getNextPacket(packet, { metadataOnly: true });
    return { packet, start: Math.min(packet.timestamp, Math.max(0, t)), end: next ? next.timestamp : Infinity };
  }

  /** Read and unwrap the frame `locate` found. */
  async read(place: HapFramePlace): Promise<HapFrame> {
    await this.init();
    const full = await this.sink!.getPacket(place.packet.timestamp);
    if (!full) throw new Error('HAP: the frame could not be read from the file.');
    return parseHapFrame(full.data, { width: this.width, height: this.height });
  }

  dispose(): void {
    try {
      this.input.dispose();
    } catch {
      /* already disposed */
    }
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Presenter: a frame onto an engine texture                                                       */
/* ---------------------------------------------------------------------------------------------- */

const GPU_FORMAT: Record<HapFormat, GPUTextureFormat> = {
  bc1: 'bc1-rgba-unorm',
  bc3: 'bc3-rgba-unorm',
  'ycocg-bc3': 'bc3-rgba-unorm',
  bc4: 'bc4-r-unorm',
  bc7: 'bc7-rgba-unorm',
};

/** What one texel of the compressed texture means, as WGSL giving `rgb` and `a` (straight) from the sample `c`. */
const MEANING: Record<HapFormat, string> = {
  // HAP is opaque; DXT1's "transparent" palette entry is just black there
  bc1: 'let rgb = c.rgb; var a = 1.0;',
  bc3: 'let rgb = c.rgb; var a = c.a;',
  bc7: 'let rgb = c.rgb; var a = c.a;',
  // HAP Q: alpha holds the brightness, red and green the two colour differences (centred on 128/255), blue how much they were stretched
  'ycocg-bc3': `let s = c.b * (255.0 / 8.0) + 1.0;
  let co = (c.r - 0.50196078431373) / s;
  let cg = (c.g - 0.50196078431373) / s;
  let rgb = clamp(vec3f(c.a + co - cg, c.a + cg, c.a - co - cg), vec3f(0.0), vec3f(1.0));
  var a = 1.0;`,
  bc4: 'let rgb = vec3f(c.r); var a = 1.0;',
};

/**
 * The draw that turns the uploaded texture into engine pixels. Four samples per output pixel, each read as one exact texel
 * (never blended by the sampler: blending HAP Q texels before converting them gives wrong colours at block edges). At the
 * clip's own size the four land on the same texel, so the picture is exact; at half size they are the four texels a pixel
 * covers. `u.scale` maps the output onto the part of the texture the picture occupies (the texture is padded to multiples
 * of 4); `u.edge` keeps samples out of the padding.
 */
function presentWgsl(meaning: string, withAlpha: boolean, premultiplied = false): string {
  return /* wgsl */ `
fn hapTexel(st: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smpNearest, st, 0.0);
  ${meaning}
  ${withAlpha ? 'a = textureSampleLevel(alphaTex, smpNearest, st, 0.0).r;' : ''}
  return ${premultiplied ? 'vec4f(rgb, a)' : 'vec4f(rgb * a, a)'};
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let q = 0.25 / u.size;
  var acc = vec4f(0.0);
  acc += hapTexel(min((uv + vec2f(-q.x, -q.y)) * u.scale, u.edge));
  acc += hapTexel(min((uv + vec2f(q.x, -q.y)) * u.scale, u.edge));
  acc += hapTexel(min((uv + vec2f(-q.x, q.y)) * u.scale, u.edge));
  acc += hapTexel(min((uv + vec2f(q.x, q.y)) * u.scale, u.edge));
  return acc * 0.25;
}`;
}

/** Already premultiplied RGBA, only resized (the CPU path at a smaller size than the clip). */
const PLAIN = 'let rgb = c.rgb; var a = c.a;';

/** How many upload textures are kept: one per clip size and format in use. More than this and the oldest is freed. */
const MAX_SOURCES = 12;

/**
 * Puts HAP frames on engine textures. One instance serves every HAP clip: clips of the same size and format share the
 * texture the blocks are uploaded into (an upload and the draw that reads it are queued together, so sharing is safe).
 */
export class HapPresenter {
  private sources = new Map<string, GPUTexture>();

  constructor(private gpu: Gpu) {}

  /** The texture blocks of this size and format are uploaded into. */
  private source(format: GPUTextureFormat, bw: number, bh: number): GPUTexture {
    const key = `${format}:${bw}x${bh}`;
    let tex = this.sources.get(key);
    if (tex) {
      this.sources.delete(key); // move to the newest position
    } else {
      // BC textures are stored in whole 4x4 blocks: the size is the picture rounded up to multiples of 4
      tex = this.gpu.createTexture({ label: `hap-${key}`, size: [bw * 4, bh * 4], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }, 'hap-source');
    }
    this.sources.set(key, tex);
    while (this.sources.size > MAX_SOURCES) {
      const oldest = this.sources.keys().next().value as string;
      this.gpu.destroyTexture(this.sources.get(oldest)!);
      this.sources.delete(oldest);
    }
    return tex;
  }

  /**
   * Draw `frame` (a picture of srcWidth x srcHeight) into a pooled rgba8unorm texture of outWidth x outHeight, premultiplied,
   * top row first, like every other texture the library hands to the engine. The texture comes from `gpu.acquire`
   * and is NOT retained: the caller retains it. Throws a readable Error for a frame that cannot be shown here.
   */
  present(frame: HapFrame, srcWidth: number, srcHeight: number, outWidth: number, outHeight: number): GPUTexture {
    const gpu = this.gpu;
    if (!canUploadBc(gpu.device)) return this.presentCpu(frame, srcWidth, srcHeight, outWidth, outHeight);
    const bw = Math.ceil(srcWidth / 4);
    const bh = Math.ceil(srcHeight / 4);
    if (frame.data.length < hapTextureBytes(frame.format, srcWidth, srcHeight)) throw new Error('HAP: the frame is smaller than the picture it should hold.');
    const upload = (format: HapFormat, data: Uint8Array): GPUTexture => {
      const tex = this.source(GPU_FORMAT[format], bw, bh);
      const rowBytes = bw * hapBlockBytes(format);
      gpu.device.queue.writeTexture({ texture: tex }, data as BufferSource, { bytesPerRow: rowBytes, rowsPerImage: bh }, [bw * 4, bh * 4]);
      return tex;
    };
    const src = upload(frame.format, frame.data.subarray(0, hapTextureBytes(frame.format, srcWidth, srcHeight)));
    const alpha = frame.alpha && frame.format !== 'bc4' ? upload('bc4', frame.alpha.subarray(0, hapTextureBytes('bc4', srcWidth, srcHeight))) : null;
    const out = gpu.pass({
      label: `hap-${frame.format}${alpha ? '-alpha' : ''}`,
      size: { width: outWidth, height: outHeight },
      textures: alpha ? { src: { texture: src }, alphaTex: { texture: alpha } } : { src: { texture: src } },
      uniforms: { scale: [srcWidth / (bw * 4), srcHeight / (bh * 4)], edge: [(srcWidth - 0.5) / (bw * 4), (srcHeight - 0.5) / (bh * 4)] },
      wgsl: presentWgsl(MEANING[frame.format], !!alpha),
    });
    return out.texture;
  }

  /** Without BC textures: decode the blocks here and upload plain pixels. */
  private presentCpu(frame: HapFrame, srcWidth: number, srcHeight: number, outWidth: number, outHeight: number): GPUTexture {
    const gpu = this.gpu;
    const pixels = hapToRgba(frame, srcWidth, srcHeight, { premultiply: true });
    const full = gpu.upload(pixels, srcWidth, srcHeight, 1, false);
    if (outWidth === srcWidth && outHeight === srcHeight) return full.texture;
    const out = gpu.pass({
      label: 'hap-cpu-resize',
      size: { width: outWidth, height: outHeight },
      textures: { src: full },
      uniforms: { scale: [1, 1], edge: [1, 1] },
      wgsl: presentWgsl(PLAIN, false, true),
    });
    gpu.recycleNow(full.texture); // the draw that reads it is already queued
    return out.texture;
  }

  /** After the GPU device was lost and replaced: the upload textures died with the old device, forget them. */
  reset(): void {
    this.sources.clear();
  }

  dispose(): void {
    for (const tex of this.sources.values()) this.gpu.destroyTexture(tex);
    this.sources.clear();
  }
}
