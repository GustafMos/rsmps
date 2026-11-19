/**
 * Test-only helpers for HAP reading: real HAP files made by an FFmpeg found on this machine, and FFmpeg's own decode of
 * them to compare against. Not part of the shipped app. CI may have no FFmpeg (or one without the `hap` encoder, which
 * needs libsnappy): `HAP_FFMPEG` is then null and the tests that need it are skipped.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny';

function findFfmpeg(): string | null {
  const candidates = ['ffmpeg'];
  try {
    const p = (createRequire(import.meta.url)('@ffmpeg-installer/ffmpeg') as { path: string }).path;
    if (existsSync(p)) candidates.push(p);
  } catch {
    /* not installed */
  }
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
      if (r.status === 0 && /^\s*V\S*\s+hap\s/m.test(r.stdout)) return bin;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** An FFmpeg that can write and read HAP, or null. */
export const HAP_FFMPEG = findFfmpeg();

let dir = '';
const workDir = (): string => (dir ||= mkdtempSync(join(tmpdir(), 'rsmps-hap-')));

export interface HapClipOptions {
  format: 'hap' | 'hap_alpha' | 'hap_q';
  width?: number;
  height?: number;
  frames?: number;
  /** FFmpeg's `-chunks` (1 = one block per frame, more = a chunked frame). */
  chunks?: number;
  compressor?: 'none' | 'snappy';
  /** Add a sine tone as PCM sound. */
  sound?: boolean;
}

/**
 * A short HAP clip written by FFmpeg: a moving test pattern (with a transparent gradient for HAP Alpha, so the alpha
 * channel is really exercised). 25 frames a second.
 */
export function makeHapClip(o: HapClipOptions): Uint8Array {
  const w = o.width ?? 64;
  const h = o.height ?? 48;
  const n = o.frames ?? 3;
  const file = join(workDir(), `clip-${o.format}-${w}x${h}-${n}-${o.chunks ?? 1}-${o.compressor ?? 'snappy'}-${o.sound ? 's' : 'q'}.mov`);
  const alpha = o.format === 'hap_alpha' ? ",format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*X/W'" : '';
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=25${alpha}`];
  if (o.sound) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
  args.push('-frames:v', String(n), '-c:v', 'hap', '-format', o.format, '-chunks', String(o.chunks ?? 1), '-compressor', o.compressor ?? 'snappy');
  if (o.sound) args.push('-c:a', 'pcm_s16le', '-shortest');
  args.push(file);
  const r = spawnSync(HAP_FFMPEG!, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg could not make the HAP test clip: ${r.stderr}`);
  return new Uint8Array(readFileSync(file));
}

/** Every frame of a video file as FFmpeg decodes it: straight RGBA, frames one after another. */
export function ffmpegDecode(file: Uint8Array, name = 'in.mov'): Uint8Array {
  const path = join(workDir(), name);
  writeFileSync(path, file);
  const r = spawnSync(HAP_FFMPEG!, ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`ffmpeg could not decode ${name}: ${r.stderr.toString()}`);
  return new Uint8Array(r.stdout);
}

/** The video samples of a file, read the way the app reads them (the demuxer hands out packets of codecs it cannot decode). */
export async function hapSamples(file: Uint8Array): Promise<{ fourcc: unknown; width: number; height: number; samples: Uint8Array[] }> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([file as BlobPart])) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    const sink = new EncodedPacketSink(track);
    const samples: Uint8Array[] = [];
    for await (const p of sink.packets()) samples.push(p.data.slice());
    return { fourcc: await track.getInternalCodecId(), width: await track.getCodedWidth(), height: await track.getCodedHeight(), samples };
  } finally {
    input.dispose();
  }
}

/** Largest and mean absolute difference between two byte pictures (all four channels, or only RGB). */
export function pictureDiff(a: Uint8Array | Uint8ClampedArray, b: Uint8Array | Uint8ClampedArray, rgbOnly = false): { max: number; mean: number } {
  if (a.length !== b.length) return { max: 255, mean: 255 };
  let max = 0;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (rgbOnly && i % 4 === 3) continue;
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
    sum += d;
    n++;
  }
  return { max, mean: n ? sum / n : 0 };
}
