/**
 * Automatic bitrate for the browser's video encoders.
 *
 * A fixed bitrate fits one kind of picture. Busy pictures (grain, dither, analog noise) need several times more than flat ones, and
 * some encoders react badly when they get too little: Firefox's H.264 encoder spends what the picture needs for about two seconds,
 * notices it is over budget and then starves every later frame, so the video starts fine and turns to mush.
 *
 * So the exporter MEASURES, like it does for frame order: the first frames of the real export go through the real encoder once
 * before the file is opened.
 *
 *  - OVERSHOOT: the frames are encoded at a deliberately low bitrate. An encoder that spends much more than it was given (Firefox)
 *    shows what it wants for this picture; the export then gets that much, so the encoder never has to starve.
 *  - FIXED QUALITY: an encoder that keeps to its budget is asked for a fixed quality instead (quantizer mode) and the bytes it needs
 *    for that quality become the bitrate.
 *
 * When neither works the answer is null and the exporter keeps the bitrate set on the Output.
 */
import type { VideoCodec } from 'mediabunny';
import { avcLevelFor } from './encode-order';

/** Frames the exporter holds back and probes. */
export const AUTO_FRAMES = 8;
/** Seconds between key frames in the built-in pipeline (mediabunny's default). */
export const KEY_INTERVAL = 2;
/** Head room on top of the measurement. */
const MARGIN = 1.15;
/** Bits per pixel of the deliberately low first probe. */
const LOW_BPP = 0.08;
/** Spending this many times the given bitrate counts as "does not keep to its budget". */
const OVERSHOOT = 2;

/** Fixed quality asked from encoders that support it: visually clean, not wasteful (H.264/H.265 scale 0–51, VP9/AV1 scale 0–63). */
const QUANTIZER: Partial<Record<VideoCodec, number>> = { avc: 27, hevc: 27, vp9: 34, av1: 34 };

export interface ProbeSizes {
  /** Bytes of each key frame. */
  key: number[];
  /** Bytes of each other frame. */
  delta: number[];
}

/**
 * Megabits per second for a clip whose frames cost what `sizes` shows: one key frame every `keyInterval` seconds (or every frame),
 * the rest delta frames, plus head room. Rounded up to half a megabit, kept between `min` and `max`. Pure.
 */
export function bitrateFromSizes(sizes: ProbeSizes, fps: number, allKeys: boolean, opt: { keyInterval?: number; min?: number; max?: number } = {}): number | null {
  const avg = (a: readonly number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const key = avg(sizes.key);
  if (!(key > 0) || !(fps > 0)) return null;
  const delta = sizes.delta.length ? avg(sizes.delta) : key;
  const keysPerSecond = allKeys ? fps : Math.min(fps, 1 / (opt.keyInterval ?? KEY_INTERVAL));
  const bits = (key * keysPerSecond + delta * (fps - keysPerSecond)) * 8 * MARGIN;
  const mbps = Math.ceil((bits / 1e6) * 2) / 2;
  return Math.min(opt.max ?? 200, Math.max(opt.min ?? 1, mbps));
}

/**
 * Did an encoder that was given `givenBps` ignore it? Judged on the frames after the first: every encoder may spend extra on the
 * opening key frame, but one that keeps to a budget makes the following frames small enough to fit it. Pure.
 */
export function overshoots(sizes: ProbeSizes, fps: number, allKeys: boolean, givenBps: number): boolean {
  const later = allKeys ? sizes.key.slice(1) : sizes.delta;
  if (later.length === 0) return false;
  const perSecond = (later.reduce((x, y) => x + y, 0) / later.length) * 8 * fps;
  return perSecond > givenBps * OVERSHOOT;
}

/** A codec string the browser's encoder accepts for a codec and picture size (H.264 takes the exact string of the export). Pure. */
export function probeCodecString(codec: VideoCodec, width: number, height: number, fps: number, avcString?: string): string | null {
  if (codec === 'avc') return avcString ?? `avc1.6400${avcLevelFor(width, height, fps).toString(16).toUpperCase().padStart(2, '0')}`;
  if (codec === 'hevc') return 'hev1.1.6.L153.B0';
  if (codec === 'vp9') return 'vp09.00.51.08';
  if (codec === 'av1') return 'av01.0.13M.08';
  return null;
}

export interface AutoBitrate {
  mbps: number;
  /** How it was found (for the export notes). */
  how: 'overshoot' | 'quality';
}

export interface ProbeJob {
  codec: VideoCodec;
  width: number;
  height: number;
  fps: number;
  allKeys: boolean;
  /** The exact H.264 codec string of the export, when one was chosen (e.g. Baseline). */
  avcString?: string;
}

/**
 * Measure the bitrate these frames need (see the file comment). The frames are not closed. Never throws: null = could not tell.
 */
export async function probeBitrate(frames: readonly VideoFrame[], job: ProbeJob): Promise<AutoBitrate | null> {
  if (typeof VideoEncoder === 'undefined' || frames.length === 0) return null;
  const codec = probeCodecString(job.codec, job.width, job.height, job.fps, job.avcString);
  if (!codec) return null;
  const base: VideoEncoderConfig = { codec, width: job.width, height: job.height, framerate: job.fps, latencyMode: 'quality', ...(job.codec === 'avc' ? { avc: { format: 'avc' as const } } : {}) };
  try {
    const low = Math.round(job.width * job.height * job.fps * LOW_BPP);
    const natural = await encodeSizes(frames, { ...base, bitrate: low }, job.allKeys);
    if (natural && overshoots(natural, job.fps, job.allKeys, low)) {
      const mbps = bitrateFromSizes(natural, job.fps, job.allKeys);
      return mbps === null ? null : { mbps, how: 'overshoot' };
    }
    const q = QUANTIZER[job.codec];
    if (q === undefined) return null;
    const fixed = await encodeSizes(frames, { ...base, bitrateMode: 'quantizer' }, job.allKeys, { [job.codec]: { quantizer: q } });
    if (!fixed) return null;
    const mbps = bitrateFromSizes(fixed, job.fps, job.allKeys);
    return mbps === null ? null : { mbps, how: 'quality' };
  } catch {
    return null;
  }
}

/** Encode the frames once with `config` and return the size of every chunk; null when the configuration is not supported or fails. */
async function encodeSizes(frames: readonly VideoFrame[], config: VideoEncoderConfig, allKeys: boolean, perFrame: Record<string, unknown> = {}): Promise<ProbeSizes | null> {
  const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) return null;
  const sizes: ProbeSizes = { key: [], delta: [] };
  let failed = false;
  const encoder = new VideoEncoder({
    output: (chunk) => (chunk.type === 'key' ? sizes.key : sizes.delta).push(chunk.byteLength),
    error: () => {
      failed = true;
    },
  });
  try {
    encoder.configure(config);
    frames.forEach((frame, i) => {
      if (!failed) encoder.encode(frame, { keyFrame: allKeys || i === 0, ...perFrame } as VideoEncoderEncodeOptions);
    });
    await encoder.flush();
  } catch {
    failed = true;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  return failed || sizes.key.length === 0 ? null : sizes;
}
