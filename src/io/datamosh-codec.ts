/**
 * The codec half of Codec Datamosh: the browser's own video encoder and decoder (WebCodecs).
 *
 * Pictures go into a `VideoEncoder` one by one; key frames are made ONLY where the node asks for one (every other frame is sent with
 * `keyFrame: false`, and the encoder runs in 'realtime' mode, which makes neither B-frames nor key frames of its own in the browsers
 * we know). The chunks are kept in memory (they are small: this is compressed video). Then the node says which chunks to give the
 * decoder, in which order, and a `VideoDecoder` configured from the encoder's own `decoderConfig` turns them back into pictures.
 *
 * WHICH CODEC. H.264 first: nothing in an H.264 delta frame depends on how earlier frames were PARSED, only on the earlier picture,
 * so a stream with frames missing or repeated still decodes cleanly once its frame counters are renumbered (h264-renumber.ts).
 * VP9 and VP8 as they come do depend on it (their delta frames lean on statistics gathered from the frames before), and their
 * decoders stop or produce noise when a frame is missing. Asked for two "temporal layers" the browser's encoder switches that
 * dependence off (it is how video calls survive lost packets), and the damaged stream decodes. The price: every other frame is then
 * a `leaf` that nothing is predicted from, which the plan has to know for the bloom.
 * Every candidate is TRIED on a tiny damaged stream before it is chosen (`probeCandidate`), so a browser whose decoder refuses damage
 * is found out in milliseconds, not after the whole project was rendered.
 *
 * The decoder is asked to run in software where the browser lets us choose: a software decoder repeats what the stream says, while
 * hardware decoders are the ones that reject or silently repair streams they do not like.
 */
import { DATAMOSH_MESSAGES, DatamoshRefused, setDatamoshService, type DatamoshCodec, type DatamoshOpenOptions, type DatamoshService } from '../engine/lib/datamosh-bridge';
import { moshBitrate, moshSize } from '../engine/lib/datamosh-plan';
import { findSps, newH264Counter, renumberChunk, type H264Sps } from './h264-renumber';

interface Candidate {
  name: string;
  /** WebCodecs codec string for a picture size. */
  codec(width: number, height: number): string;
  h264?: boolean;
  /** Ask for temporal layers (see the top of the file). */
  layers?: boolean;
  note?: string;
}

/** The smallest H.264 level that allows the picture size (by macroblocks per frame), as the two hex digits of the codec string. */
export function h264Level(width: number, height: number): string {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  if (mbs <= 1620) return '1f'; // 3.1: up to 1280x720
  if (mbs <= 8192) return '28'; // 4.0: up to 1920x1080
  if (mbs <= 22080) return '32'; // 5.0
  return '33'; // 5.1: up to 4096x2304
}

export const DATAMOSH_CANDIDATES: readonly Candidate[] = [
  { name: 'H.264', h264: true, codec: (w, h) => `avc1.4200${h264Level(w, h)}` },
  { name: 'VP9', layers: true, codec: () => 'vp09.00.10.08', note: 'VP9, this browser has no H.264 encoder' },
  // VP8 is deliberately not here: its delta frames keep leaning on the statistics of earlier frames even with layers, so after a
  // removed key frame it decodes to coloured noise instead of the old picture, and every browser that encodes VP8 encodes VP9 too.
];

interface Chunk {
  key: boolean;
  /** Temporal layer above 0: nothing is predicted from this frame. */
  leaf: boolean;
  data: Uint8Array;
}

const abortError = () => new DOMException('Cancelled', 'AbortError');
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Encoder settings for a candidate, or null when this browser cannot encode it. Software first: its output is the most predictable. */
async function encoderConfig(c: Candidate, width: number, height: number, fps: number, compression: number): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return null;
  const base: VideoEncoderConfig = {
    codec: c.codec(width, height),
    width,
    height,
    bitrate: moshBitrate(width, height, fps, compression),
    framerate: fps,
    // 'realtime': no frame reordering (no B-frames), so the order chunks come out is the order they are shown in.
    latencyMode: 'realtime',
    ...(c.h264 ? { avc: { format: 'annexb' as const } } : {}),
    ...(c.layers ? { scalabilityMode: 'L1T2' } : {}),
  };
  for (const hardwareAcceleration of ['prefer-software', 'no-preference'] as const) {
    const cfg = { ...base, hardwareAcceleration };
    try {
      if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
    } catch {
      // an unknown codec string throws in some browsers: same as "not supported"
    }
  }
  return null;
}

class Session implements DatamoshCodec {
  readonly name: string;
  readonly note?: string;
  readonly width: number;
  readonly height: number;
  private encoder: VideoEncoder;
  private chunks = new Map<number, Chunk>();
  private decoderConfig: VideoDecoderConfig | null = null;
  private steps = 0;
  private failure: string | null = null;
  private dt: number;
  private canvas: OffscreenCanvas | null = null;
  private closed = false;

  constructor(
    private c: Candidate,
    cfg: VideoEncoderConfig,
    private srcWidth: number,
    private srcHeight: number,
    private fps: number,
  ) {
    this.name = c.name;
    this.note = c.note;
    this.width = cfg.width;
    this.height = cfg.height;
    this.dt = Math.round(1e6 / Math.max(1, fps));
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig) this.decoderConfig ??= meta.decoderConfig;
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        // The timestamp is the step number times `dt`: that is how a chunk finds its step again, also when the encoder skipped one.
        const layer = (meta as { svc?: { temporalLayerId?: number } } | undefined)?.svc?.temporalLayerId ?? 0;
        this.chunks.set(Math.round(chunk.timestamp / this.dt), { key: chunk.type === 'key', leaf: layer > 0, data });
      },
      error: (e) => {
        this.failure = message(e);
      },
    });
    this.encoder.configure(cfg);
  }

  async encode(rgba: Uint8ClampedArray, key: boolean): Promise<void> {
    if (this.failure) throw new Error(`The ${this.name} encoder stopped: ${this.failure}`);
    const timestamp = this.steps++ * this.dt;
    const { srcWidth: sw, srcHeight: sh, width, height } = this;
    let frame: VideoFrame;
    if (width <= sw && height <= sh && sw - width < 2 && sh - height < 2) {
      // Same size (but for an odd last row or column, which is cut off): hand the pixels over as they are. 'RGBX' = alpha ignored.
      frame = new VideoFrame(rgba, { format: 'RGBX', codedWidth: sw, codedHeight: sh, timestamp, visibleRect: { x: 0, y: 0, width, height } });
    } else {
      // Another size: scale through a 2D canvas. The picture is opaque for a video, so alpha is forced to 1 first.
      const opaque = new Uint8ClampedArray(rgba);
      for (let i = 3; i < opaque.length; i += 4) opaque[i] = 255;
      const bitmap = await createImageBitmap(new ImageData(opaque, sw, sh));
      this.canvas ??= new OffscreenCanvas(width, height);
      const g = this.canvas.getContext('2d')!;
      g.imageSmoothingQuality = 'high';
      g.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      frame = new VideoFrame(this.canvas, { timestamp });
    }
    try {
      this.encoder.encode(frame, { keyFrame: key });
    } finally {
      frame.close();
    }
    // Do not let pictures pile up in front of a slow encoder.
    while (this.encoder.state === 'configured' && this.encoder.encodeQueueSize > 2 && !this.failure) await tick();
  }

  async finish(): Promise<({ key: boolean; leaf?: boolean } | null)[]> {
    if (this.encoder.state === 'configured') await this.encoder.flush().catch((e) => (this.failure ??= message(e)));
    if (this.encoder.state !== 'closed') this.encoder.close();
    if (this.failure) throw new Error(`The ${this.name} encoder stopped: ${this.failure}`);
    return Array.from({ length: this.steps }, (_, i) => {
      const c = this.chunks.get(i);
      return c ? { key: c.key, leaf: c.leaf } : null;
    });
  }

  async decode(feed: readonly number[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<(Blob | null)[]> {
    const total = feed.length;
    const out: (Blob | null)[] = new Array(total).fill(null);
    if (!total) return out;
    if (!this.decoderConfig) throw new Error(`The ${this.name} encoder did not say how to decode its stream.`);
    const first = this.chunks.get(feed[0]);
    if (!first?.key) throw new Error('The stream does not start with a key frame.');
    let sps: H264Sps | null = null;
    if (this.c.h264) {
      sps = findSps(first.data);
      if (!sps) throw new DatamoshRefused(this.name, 'The H.264 stream of this browser has a form that cannot be renumbered.');
    }

    const { width, height } = this;
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d')!;
    let failure: string | null = null;
    let done = 0;
    // Decoded pictures are turned into stored images one after the other (the canvas is shared), in the order they arrive.
    let chain: Promise<void> = Promise.resolve();
    let waiting = 0;
    const decoder = new VideoDecoder({
      output: (frame) => {
        const at = Math.round(frame.timestamp / this.dt);
        waiting++;
        chain = chain.then(async () => {
          try {
            g.drawImage(frame, 0, 0, width, height);
            frame.close();
            // Same form as a compressed bake: the codec's damage is far coarser than what WebP at this quality adds.
            const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.92 });
            if (at >= 0 && at < total) out[at] = blob;
          } catch (e) {
            frame.close();
            failure ??= message(e);
          } finally {
            waiting--;
            onProgress?.(++done, total);
          }
        });
      },
      error: (e) => {
        failure ??= message(e);
      },
    });
    const cfg: VideoDecoderConfig = { ...this.decoderConfig };
    try {
      // A software decoder does what the stream says; ask for it where the browser offers the choice.
      const soft = { ...cfg, hardwareAcceleration: 'prefer-software' as const };
      decoder.configure((await VideoDecoder.isConfigSupported(soft)).supported ? soft : cfg);
      const counter = newH264Counter();
      for (let n = 0; n < total; n++) {
        if (signal?.aborted) throw abortError();
        if (failure) break;
        const chunk = this.chunks.get(feed[n]);
        if (!chunk) continue;
        const data = sps ? renumberChunk(chunk.data, chunk.key, sps, counter) : chunk.data;
        // Timestamps count up in the order fed, whatever the chunk said when it was encoded: a chunk fed twice needs two times.
        decoder.decode(new EncodedVideoChunk({ type: chunk.key ? 'key' : 'delta', timestamp: n * this.dt, duration: this.dt, data }));
        while (decoder.state === 'configured' && (decoder.decodeQueueSize > 4 || waiting > 4) && !failure) await tick();
      }
      if (!failure && decoder.state === 'configured') await decoder.flush().catch((e) => (failure ??= message(e)));
      await chain;
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') throw e;
      failure ??= message(e);
    } finally {
      if (decoder.state !== 'closed') decoder.close();
    }
    await chain.catch(() => undefined);
    if (signal?.aborted) throw abortError();
    if (failure) throw new DatamoshRefused(this.name, `The ${this.name} decoder stopped on the damaged stream after ${out.filter(Boolean).length} of ${total} frames (${failure}).`);
    return out;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.encoder.state !== 'closed') this.encoder.close();
    this.chunks.clear();
  }
}

/** A small moving test picture: two different "shots" of drifting stripes, so there is motion for a delta frame to carry. */
function probePicture(w: number, h: number, frame: number, shot: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const band = shot === 0 ? ((x + frame * 3) >> 3) & 1 : ((y + frame * 3) >> 3) & 1;
      px[i] = shot === 0 ? 40 + band * 180 : 30;
      px[i + 1] = shot === 0 ? 60 : 50 + band * 170;
      px[i + 2] = band ? 200 : 90;
      px[i + 3] = 255;
    }
  }
  return px;
}

const probed = new Map<string, Promise<boolean>>();

/**
 * Does this codec survive the two kinds of damage here? Encodes eight tiny frames with a removed key frame and a repeated delta
 * frame and checks that the decoder gives a picture for every chunk. Remembered per codec for the session.
 */
export function probeCandidate(c: Candidate): Promise<boolean> {
  let p = probed.get(c.name);
  if (!p) {
    p = (async () => {
      const w = 128;
      const h = 96;
      const cfg = await encoderConfig(c, w, h, 30, 0.3);
      if (!cfg) return false;
      const s = new Session(c, cfg, w, h, 30);
      try {
        // key, 3 deltas, [key (left out), "nothing moved"], 3 deltas
        const plan: { shot: number; frame: number; key: boolean; drop?: boolean }[] = [];
        for (let f = 0; f < 4; f++) plan.push({ shot: 0, frame: f, key: f === 0 });
        plan.push({ shot: 1, frame: 4, key: true, drop: true }, { shot: 1, frame: 4, key: false });
        for (let f = 5; f < 8; f++) plan.push({ shot: 1, frame: f, key: false });
        for (const st of plan) await s.encode(probePicture(w, h, st.frame, st.shot), st.key);
        const made = await s.finish();
        if (made.some((m) => !m) || !made[0]?.key || made.some((m, i) => i > 0 && !!m?.key !== plan[i].key)) return false;
        const feed: number[] = [];
        let bloomed = false;
        plan.forEach((st, i) => {
          if (st.drop) return;
          feed.push(i);
          if (i >= 6 && !bloomed && !made[i]?.leaf) {
            feed.push(i, i, i); // a repeated delta frame
            bloomed = true;
          }
        });
        const got = await s.decode(feed);
        return got.every(Boolean);
      } catch {
        return false;
      } finally {
        s.close();
      }
    })();
    probed.set(c.name, p);
  }
  return p;
}

/** Forget what the probes found (tests). */
export function resetDatamoshProbes(): void {
  probed.clear();
}

export const datamoshService: DatamoshService = {
  async open(opts: DatamoshOpenOptions, signal?: AbortSignal): Promise<DatamoshCodec> {
    if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') throw new Error(DATAMOSH_MESSAGES.noEncoder);
    const size = moshSize(opts.width, opts.height, opts.maxSide);
    let couldEncode = false;
    for (const c of DATAMOSH_CANDIDATES) {
      if (signal?.aborted) throw abortError();
      if (opts.exclude?.includes(c.name)) {
        couldEncode = true;
        continue;
      }
      const cfg = await encoderConfig(c, size.width, size.height, opts.fps, opts.compression);
      if (!cfg) continue;
      couldEncode = true;
      if (!(await probeCandidate(c))) continue;
      return new Session(c, cfg, opts.width, opts.height, opts.fps);
    }
    throw new Error(couldEncode ? DATAMOSH_MESSAGES.refused : DATAMOSH_MESSAGES.noEncoder);
  },
};

/** Give Codec Datamosh jobs their codec. Nothing is created until a job asks. */
export function installDatamosh(): void {
  setDatamoshService(datamoshService);
}
