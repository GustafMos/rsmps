/**
 * "Fast copy" of a clip: the same clip in the form this app plays quickest.
 *
 * Phone and camera clips store a full picture (key frame) only once every second or two; every other frame is "what
 * changed since the last one". Playing forwards that is fine. Anything else (scrubbing, the loop wrapping round, playing
 * backwards, effects that read several moments at once such as Datamosh, Echo or Time Displace) makes the decoder go
 * back to a key frame and decode every frame up to the one wanted: dozens of frames for one picture.
 *
 * The fast copy is H.264 (decoded by the graphics chip on every phone and computer) with EVERY frame a key frame, so any
 * frame costs one decode, and no larger than needed. The price is a larger file than the original at the same size.
 */
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, WebMOutputFormat, canEncodeVideo, type VideoCodec } from 'mediabunny';

export interface FastCopyPlan {
  width: number;
  height: number;
  /** Bits per second. */
  bitrate: number;
}

/**
 * Size and bitrate of the fast copy: the clip scaled down (never up) so its longer side is at most `maxSide`, even
 * numbers (encoders need them), and enough bits for a picture made of key frames only to stay clean.
 */
export function fastCopyPlan(info: { width: number; height: number; fps: number }, maxSide: number): FastCopyPlan {
  const long = Math.max(info.width, info.height, 2);
  const k = Math.min(1, maxSide / long);
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
  const width = even(info.width);
  const height = even(info.height);
  const fps = Math.min(60, Math.max(1, info.fps || 30));
  // key frames only: about 0.35 bits per pixel per frame, between 4 and 60 megabits a second
  const bitrate = Math.round(Math.min(60e6, Math.max(4e6, width * height * fps * 0.35)));
  return { width, height, bitrate };
}

/** "clip.mov" -> "clip fast.mp4". */
export function fastCopyName(name: string, ext: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem.replace(/ fast$/i, '')} fast.${ext}`;
}

export interface FastCopyOptions {
  maxSide: number;
  onProgress?: (fraction: number) => void;
  /** Called with something the user should know about the result (the sound was lost). */
  onNote?: (text: string) => void;
  signal?: AbortSignal;
}

/** Encode the fast copy. Throws a readable error when this browser cannot do it. */
export async function makeFastCopy(blob: Blob, name: string, info: { width: number; height: number; fps: number }, opts: FastCopyOptions): Promise<File> {
  const plan = fastCopyPlan(info, opts.maxSide);
  // H.264 first (hardware decoding everywhere); VP9, then VP8, where the browser has no H.264 encoder
  let codec: VideoCodec | null = null;
  for (const c of ['avc', 'vp9', 'vp8'] as VideoCodec[]) {
    if (await canEncodeVideo(c, { width: plan.width, height: plan.height, bitrate: plan.bitrate }).catch(() => false)) {
      codec = c;
      break;
    }
  }
  if (!codec) throw new Error('This browser cannot encode video, so it cannot make a fast copy.');
  const mp4 = codec === 'avc';
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  const output = new Output({ format: mp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target: new BufferTarget() });
  const conversion = await Conversion.init({
    input,
    output,
    video: { codec, width: plan.width, height: plan.height, fit: 'contain', bitrate: plan.bitrate, keyFrameInterval: 0.001, forceTranscode: true },
    // the sound: copied as it is when the new file can hold it, otherwise re-encoded to whatever this browser can encode
    showWarnings: false,
  });
  // A clip that loses its sound here is still worth having: the picture is what needs to be fast. Say so, though.
  const lostSound = conversion.discardedTracks.some((t) => t.track.type === 'audio');
  if (lostSound) opts.onNote?.('The sound of this clip could not be carried over, so the fast copy is silent. Keep the original for its sound (wire its Audio output).');
  if (!conversion.isValid) {
    const why = conversion.discardedTracks.map((t) => t.reason).join(', ');
    throw new Error(`This clip cannot be converted here${why ? ` (${why})` : ''}.`);
  }
  conversion.onProgress = (p) => opts.onProgress?.(p);
  const onAbort = () => void conversion.cancel();
  opts.signal?.addEventListener('abort', onAbort);
  try {
    await conversion.execute();
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
  if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('The fast copy came out empty.');
  return new File([buffer], fastCopyName(name, mp4 ? 'mp4' : 'webm'), { type: mp4 ? 'video/mp4' : 'video/webm' });
}
