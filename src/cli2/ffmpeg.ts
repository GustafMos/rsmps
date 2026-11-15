/** Locating and running ffmpeg, plus a small prober (there is no ffprobe in @ffmpeg-installer). */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

let resolved: string | null | undefined;

/** Path of an ffmpeg binary, or null. Order: $FFMPEG_PATH, @ffmpeg-installer/ffmpeg, `ffmpeg` on PATH. */
export async function findFfmpeg(): Promise<string | null> {
  if (resolved !== undefined) return resolved;
  const candidates: string[] = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try {
    const name = '@ffmpeg-installer/ffmpeg';
    const mod = (await import(/* @vite-ignore */ name)) as { path?: string; default?: { path?: string } };
    const p = mod.path ?? mod.default?.path;
    if (p) candidates.push(p);
  } catch {
    /* optional dependency not installed */
  }
  candidates.push('ffmpeg');
  for (const c of candidates) {
    if (c !== 'ffmpeg' && !existsSync(c)) continue;
    const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
    if (r.status === 0) {
      resolved = c;
      return c;
    }
  }
  resolved = null;
  return null;
}

export async function requireFfmpeg(why: string): Promise<string> {
  const p = await findFfmpeg();
  if (!p) throw new Error(`ffmpeg is required for ${why} but was not found. Install @ffmpeg-installer/ffmpeg, put ffmpeg on PATH or set FFMPEG_PATH.`);
  return p;
}

/** Run ffmpeg to completion, collecting stderr. Rejects with the stderr tail on a non-zero exit. */
export async function runFfmpeg(args: string[]): Promise<{ stdout: Buffer; stderr: string }> {
  const bin = await requireFfmpeg('this operation');
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ stdout: Buffer.concat(out), stderr: err }) : reject(new Error(`ffmpeg exited with ${code}\n${err.slice(-1500)}`))));
  });
}

export interface ProbeResult {
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
  duration: number;
  /** Frame count estimate (duration * fps). */
  frames: number;
}

/** Probe a media file by parsing `ffmpeg -i` output. */
export async function probe(file: string): Promise<ProbeResult> {
  const bin = await requireFfmpeg('reading video and audio files');
  const stderr = await new Promise<string>((resolve, reject) => {
    const p = spawn(bin, ['-hide_banner', '-nostdin', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', () => resolve(err)); // exit code is 1 without an output file: expected
  });
  if (/No such file|Invalid data found|does not contain any stream/i.test(stderr) && !/Stream #/.test(stderr)) {
    throw new Error(`Cannot read "${file}" (${stderr.trim().split('\n').pop()})`);
  }
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0;
  const vLine = stderr.split('\n').find((l) => /Stream #\d+:\d+.*: Video:/.test(l) && !/attached pic/.test(l));
  const hasAudio = /Stream #\d+:\d+.*: Audio:/.test(stderr);
  let width = 0;
  let height = 0;
  let fps = 0;
  if (vLine) {
    const body = vLine.replace(/0x[0-9a-f]+/gi, '').replace(/\[[^\]]*\]/g, '');
    const size = /,\s*(\d{2,5})x(\d{2,5})/.exec(body);
    if (size) {
      width = Number(size[1]);
      height = Number(size[2]);
    }
    const f = /(\d+(?:\.\d+)?)\s*fps/.exec(body) ?? /(\d+(?:\.\d+)?)\s*tbr/.exec(body);
    if (f) fps = Number(f[1]);
    const rot = /rotate\s*:\s*(-?\d+)/.exec(stderr);
    if (rot && Math.abs(Number(rot[1])) % 180 === 90) [width, height] = [height, width];
  }
  if (!fps || !Number.isFinite(fps)) fps = 24;
  return { hasVideo: !!vLine, hasAudio, width, height, fps, duration, frames: Math.max(1, Math.round(duration * fps)) };
}

/** Kill a child process quietly. */
export function kill(p: ChildProcess | null): void {
  try {
    p?.kill();
  } catch {
    /* already gone */
  }
}
