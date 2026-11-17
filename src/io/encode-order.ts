/**
 * Frame order and timing of the browser's video encoding pipeline.
 *
 * Two things can go wrong between "frame i at time i / fps goes in" and the file that comes out, and both show up as a stutter,
 * a freeze or a missing frame exactly at a loop point:
 *
 *  - REORDERING. Some encoders (Firefox's H.264 on Windows, for one) use B-frames: frames come back out of presentation order
 *    (0, 2, 1, 4, 3 …). Written into an MP4 as they come, B-frames get a presentation time BEFORE their decode time, which strict
 *    players and VJ software cannot honor.
 *  - OFFSET. An encoder (or a workaround for one inside the muxing library) can shift every timestamp by a frame, so the file starts
 *    one frame early (and the player trims the first frame) or one frame late.
 *
 * Neither can be known from the browser name, so the exporter MEASURES: before a video export it pushes a few tiny frames through the
 * very same pipeline (same codec, same options, same muxer), reads the little file back and looks at the timestamps. The answer is
 * remembered per configuration for the session. With it the exporter picks a configuration that keeps frames in order (H.264
 * Constrained Baseline has no B-frames; every frame a key frame is the fallback) and compensates a whole-frame offset.
 */
import { ALL_FORMATS, BufferSource, BufferTarget, EncodedPacketSink, Input, Mp4OutputFormat, Output, Quality, VideoSample, VideoSampleSource, WebMOutputFormat, type VideoCodec } from 'mediabunny';

/** True when `order` (timestamps in the order the encoder emitted them) is not strictly increasing. Pure. */
export function isReordered(order: readonly number[]): boolean {
  for (let i = 1; i < order.length; i++) if (order[i] <= order[i - 1]) return true;
  return false;
}

/** H.264 levels: [level_idc, max frame size in macroblocks, max macroblocks per second]. */
const AVC_LEVELS: readonly (readonly [number, number, number])[] = [
  [30, 1620, 40500],
  [31, 3600, 108000],
  [32, 5120, 216000],
  [40, 8192, 245760],
  [42, 8704, 522240],
  [50, 22080, 589824],
  [51, 36864, 983040],
  [52, 36864, 2073600],
  [60, 139264, 4177920],
  [61, 139264, 8355840],
  [62, 139264, 16711680],
];

/** The lowest H.264 level that fits a picture size and frame rate (level_idc, e.g. 51 for 4K at 25 fps). Pure. */
export function avcLevelFor(width: number, height: number, fps: number): number {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = mbs * Math.max(1, fps);
  for (const [idc, maxFs, maxMbps] of AVC_LEVELS) if (mbs <= maxFs && rate <= maxMbps) return idc;
  return AVC_LEVELS[AVC_LEVELS.length - 1][0];
}

/** Codec string for H.264 Constrained Baseline (no B-frames) at the level a picture needs, e.g. "avc1.42E033". Pure. */
export function avcBaselineCodec(width: number, height: number, fps: number): string {
  return `avc1.42E0${avcLevelFor(width, height, fps).toString(16).toUpperCase().padStart(2, '0')}`;
}

export interface PipelineOptions {
  codec: VideoCodec;
  webm: boolean;
  /** Override of the full codec string (e.g. H.264 Constrained Baseline). */
  fullCodecString?: string;
  /** Every frame a key frame. */
  allKeys?: boolean;
}

export interface PipelineReport {
  /** The measurement ran and produced a readable file. False = unknown: treat the pipeline as fine and rely on the final file check. */
  ok: boolean;
  /** Frames are stored out of presentation order. */
  reordered: boolean;
  /** Whole frames by which the file's first frame is off (file time minus intended time; -1 = one frame early). */
  offsetFrames: number;
  /** Frames found in the file (FRAMES were sent). */
  count: number;
}

/** Frames sent through the pipeline by `measurePipeline`. */
export const PROBE_FRAMES = 10;

/**
 * What a list of file timestamps (seconds, in stored order) says about the pipeline, for frames sent at 0, 1/fps, 2/fps … Pure.
 */
export function readTimestamps(stamps: readonly number[], fps: number, sent: number): PipelineReport {
  if (stamps.length === 0) return { ok: false, reordered: false, offsetFrames: 0, count: 0 };
  const first = Math.min(...stamps);
  return { ok: true, reordered: isReordered(stamps), offsetFrames: Math.round(first * fps), count: stamps.length === sent ? sent : stamps.length };
}

/** Options that the exporter passes to the encoder for a pipeline choice. Pure. */
export function sourceOptions(o: PipelineOptions, fps: number): { fullCodecString?: string; keyFrameInterval?: number } {
  return {
    ...(o.fullCodecString ? { fullCodecString: o.fullCodecString } : {}),
    // keyFrameInterval is in seconds: half a frame makes every frame a key frame.
    ...(o.allKeys ? { keyFrameInterval: 0.5 / fps } : {}),
  };
}

const cache = new Map<string, Promise<PipelineReport>>();

/** Test hook. */
export function forgetPipelines(): void {
  cache.clear();
}

/**
 * Measure the real pipeline for these options: encode a few small frames, mux them, read the file back. Remembered per session.
 * Never throws: when anything is missing or fails the report has `ok: false`.
 */
export function measurePipeline(o: PipelineOptions, fps: number): Promise<PipelineReport> {
  const key = `${o.codec}|${o.webm}|${o.fullCodecString ?? ''}|${o.allKeys ? 1 : 0}|${fps}`;
  let p = cache.get(key);
  if (!p) {
    p = run(o, fps).catch(() => ({ ok: false, reordered: false, offsetFrames: 0, count: 0 }));
    cache.set(key, p);
  }
  return p;
}

async function run(o: PipelineOptions, fps: number): Promise<PipelineReport> {
  if (typeof VideoFrame === 'undefined' || typeof OffscreenCanvas === 'undefined') return { ok: false, reordered: false, offsetFrames: 0, count: 0 };
  const W = 640;
  const H = 360;
  const output = new Output({ format: o.webm ? new WebMOutputFormat() : new Mp4OutputFormat(), target: new BufferTarget() });
  const source = new VideoSampleSource({ codec: o.codec, quality: new Quality({ bitrate: 4_000_000 }), ...sourceOptions(o, fps) });
  output.addVideoTrack(source, { frameRate: fps });
  let done = false;
  try {
    await output.start();
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { ok: false, reordered: false, offsetFrames: 0, count: 0 };
    for (let i = 0; i < PROBE_FRAMES; i++) {
      // moving content, so the encoder has a reason to use every frame type it likes
      ctx.fillStyle = `hsl(${i * 31} 70% 45%)`;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.fillRect((i * 67) % (W - 160), 90, 160, 160);
      const sample = new VideoSample(new VideoFrame(canvas, { timestamp: Math.round((i / fps) * 1e6), duration: Math.round(1e6 / fps) }));
      try {
        await source.add(sample);
      } finally {
        sample.close();
      }
    }
    await output.finalize();
    done = true;
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) return { ok: false, reordered: false, offsetFrames: 0, count: 0 };
    return readTimestamps(await fileTimestamps(buffer), fps, PROBE_FRAMES);
  } finally {
    if (!done) await output.cancel().catch(() => undefined);
  }
}

/** Presentation timestamps (seconds) of the video packets in a finished file, in stored order. */
export async function fileTimestamps(buffer: ArrayBuffer): Promise<number[]> {
  const input = new Input({ source: new BufferSource(buffer), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) return [];
  const stamps: number[] = [];
  for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) stamps.push(packet.timestamp);
  return stamps;
}

export interface PipelineChoice {
  options: PipelineOptions;
  /** Add this many frames to every input timestamp so the file starts at 0 (compensates a negative offset). */
  shiftFrames: number;
  /** Something the user should know (goes into the export notes). */
  note?: string;
}

/**
 * Choose how to encode so that frames end up in order and start at time 0.
 * `measure` is injectable for tests; `requestedAllKeys` is the Output's "All key frames" switch.
 */
export async function choosePipeline(
  base: { codec: VideoCodec; webm: boolean },
  size: { width: number; height: number; fps: number },
  requestedAllKeys: boolean,
  measure: (o: PipelineOptions, fps: number) => Promise<PipelineReport> = measurePipeline,
  baselineUsable: (codec: string) => Promise<boolean> = async () => true,
): Promise<PipelineChoice> {
  const fps = size.fps;
  const shiftFor = (r: PipelineReport) => (r.ok && r.offsetFrames < 0 ? -r.offsetFrames : 0);
  const lateNote = (r: PipelineReport) => (r.ok && r.offsetFrames > 0 ? `the video starts ${r.offsetFrames} frame${r.offsetFrames === 1 ? '' : 's'} late in this browser; players may hold the first frame` : undefined);
  const first: PipelineOptions = { ...base, allKeys: requestedAllKeys };
  const r1 = await measure(first, fps);
  if (!r1.ok || !r1.reordered) return { options: first, shiftFrames: shiftFor(r1), note: lateNote(r1) };

  const why = "this browser's encoder stores frames out of order, which makes loops stutter in some players";
  if (base.codec === 'avc') {
    const baseline = avcBaselineCodec(size.width, size.height, fps);
    if (await baselineUsable(baseline)) {
      const opt: PipelineOptions = { ...base, fullCodecString: baseline, allKeys: requestedAllKeys };
      const r2 = await measure(opt, fps);
      if (r2.ok && !r2.reordered) return { options: opt, shiftFrames: shiftFor(r2), note: `${why}. The video was written with the H.264 Baseline profile, which keeps every frame in order (raise the bitrate a little if you see blocks).` };
    }
  }
  if (!requestedAllKeys) {
    const opt: PipelineOptions = { ...base, allKeys: true };
    const r3 = await measure(opt, fps);
    if (r3.ok && !r3.reordered) return { options: opt, shiftFrames: shiftFor(r3), note: `${why}. Every frame was written as a key frame instead, which keeps them in order (raise the bitrate if the picture looks soft).` };
  }
  return { options: first, shiftFrames: shiftFor(r1), note: `${why}, and no setting of this browser avoids it. Choose VP9 or AV1 on the Output, or export an image sequence.` };
}
