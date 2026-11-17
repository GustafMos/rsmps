/**
 * Streams rendered frames to the desktop app's FFmpeg export: start -> audio (once) -> frames, each awaited -> finish (native
 * Save dialog). Pure with respect to the GPU: the exporter hands in `render`, which returns straight-or-premultiplied RGBA bytes.
 */
import type { PcmAudio } from '../engine/audio/api';
import { baseName, type ExportFinishReply, type FfmpegExportClient } from './desktop';
import type { FfmpegCodec } from './export-codecs';

/** Channel-planar float audio to the interleaved little-endian f32 the endpoint expects (at most 2 channels are kept). */
export function interleaveF32(channels: readonly Float32Array[]): { data: Float32Array; channels: 1 | 2; frames: number } {
  const n = channels.length >= 2 ? 2 : 1;
  const frames = channels[0]?.length ?? 0;
  const data = new Float32Array(frames * n);
  if (n === 1) data.set(channels[0] ?? []);
  else for (let i = 0; i < frames; i++) {
    data[i * 2] = channels[0][i];
    data[i * 2 + 1] = channels[1][i] ?? 0;
  }
  return { data, channels: n, frames };
}

/** One request body from several whole frames (all the same size), or the lone frame itself. */
export function packFrames(frames: readonly Uint8ClampedArray[]): Uint8ClampedArray {
  if (frames.length === 1) return frames[0];
  const out = new Uint8ClampedArray(frames.reduce((s, f) => s + f.length, 0));
  let at = 0;
  for (const f of frames) {
    out.set(f, at);
    at += f.length;
  }
  return out;
}

export interface RenderedFrame {
  width: number;
  height: number;
  /** RGBA, width*height*4 bytes. */
  data: Uint8ClampedArray;
}

export interface FfmpegStreamOptions {
  client: FfmpegExportClient;
  codec: FfmpegCodec;
  fps: number;
  frames: number;
  bitrateMbps: number;
  allKeys?: boolean;
  /** File name without extension, from the first frame's size. */
  name: (size: { width: number; height: number }) => string;
  signal?: AbortSignal;
  /** Frame `f` (0-based), already composed to the final size (even-padded when `codec.even`). */
  render(f: number): Promise<RenderedFrame>;
  /** Called once after frame 0 is rendered (so the size is known); null = no sound. */
  audio?: () => Promise<PcmAudio | null>;
  onProgress?(fraction: number, label: string): void;
  yieldNow?(): Promise<void>;
}

export interface FfmpegStreamResult extends ExportFinishReply {
  width: number;
  height: number;
  ext: string;
  /** The audio could not be sent (the video was still written). */
  audioSkipped?: boolean;
}

const abortError = () => new DOMException('Aborted', 'AbortError');

export async function streamToFfmpeg(o: FfmpegStreamOptions): Promise<FfmpegStreamResult> {
  const { client, signal } = o;
  const check = () => {
    if (signal?.aborted) throw abortError();
  };
  check();
  let id: string | null = null;
  try {
    const first = await o.render(0);
    check();
    const pcm = o.audio ? await o.audio() : null;
    const inter = pcm && pcm.channels.length && pcm.channels[0].length ? interleaveF32(pcm.channels) : null;
    check();
    const name = o.name(first);
    const started = await client.start(
      { width: first.width, height: first.height, fps: o.fps, codec: o.codec.id, bitrateMbps: o.bitrateMbps, ...(o.allKeys ? { allKeys: true } : {}), name, ...(inter ? { audio: { sampleRate: pcm!.sampleRate, channels: inter.channels } } : {}) },
      signal,
    );
    id = started.id;
    if (first.data.length !== started.frameBytes && started.frameBytes) throw new Error(`The frame is ${first.data.length} bytes but FFmpeg expected ${started.frameBytes}.`);
    if (inter) await client.audio(id, inter.data, signal);
    for (let f = 0; f < o.frames; f++) {
      check();
      const frame = f === 0 ? first : await o.render(f);
      if (frame.width !== first.width || frame.height !== first.height) throw new Error('Frame size changed during export.');
      await client.frame(id, frame.data, signal);
      o.onProgress?.(((f + 1) / o.frames) * 0.97, `${name} · frame ${f + 1}/${o.frames}`);
      await o.yieldNow?.();
    }
    check();
    o.onProgress?.(0.98, `${name} · finishing`);
    const done = await client.finish(id);
    id = null; // the desktop drops the session when finish returns
    return { ...done, width: first.width, height: first.height, ext: started.ext };
  } catch (err) {
    if (id) await client.cancel(id);
    throw err;
  }
}

/** The file entry for a natively saved video: empty blob, `savedPath` set. */
export function savedEntry(path: string): { name: string; blob: Blob; savedPath: string } {
  return { name: baseName(path), blob: new Blob([]), savedPath: path };
}
