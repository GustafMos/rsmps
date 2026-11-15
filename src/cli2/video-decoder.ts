/**
 * Sequential video decoding through ONE long-lived ffmpeg process per (video, size).
 * Raw RGBA frames are piped from stdout with back-pressure (the process is paused whenever two frames
 * are buffered). Monotonically increasing requests are served from the running process; a backward
 * seek (or a very long forward jump) re-spawns ffmpeg with `-ss`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { requireFfmpeg } from './ffmpeg';

/** Forward jumps up to this many frames are decoded and discarded instead of re-spawning. */
const SKIP_LIMIT = 120;

export interface DecodedFrame {
  index: number;
  data: Buffer;
}

export class VideoDecoder {
  /** Number of ffmpeg processes spawned so far (exposed for tests: proves sequential reads do not re-spawn). */
  spawns = 0;

  private proc: ChildProcess | null = null;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = true;
  private wake: (() => void) | null = null;
  private nextIndex = 0;
  private last: DecodedFrame | null = null;
  private gen = 0;
  private stderrTail = '';
  private queue: Promise<unknown> = Promise.resolve();
  private readonly frameBytes: number;

  constructor(
    private file: string,
    /** Output size (after optional down-scaling). */
    readonly width: number,
    readonly height: number,
    /** Source size, to know whether to scale. */
    private srcWidth: number,
    private srcHeight: number,
    private fps: number,
    private frames: number,
  ) {
    this.frameBytes = width * height * 4;
  }

  /** Decode frame `index` (0-based, at the video's fps). Past the end the last frame is held. */
  frame(index: number): Promise<DecodedFrame | null> {
    const run = this.queue.then(() => this.frameNow(Math.max(0, Math.floor(index))));
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    this.gen++;
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* gone */
      }
    }
    this.proc = null;
    this.ended = true;
    this.chunks = [];
    this.buffered = 0;
    this.wake?.();
  }

  private async frameNow(index: number): Promise<DecodedFrame | null> {
    if (this.last && this.last.index === index) return this.last;
    const target = Math.min(index, Math.max(0, this.frames - 1));
    if (this.last && this.last.index === target && index >= this.frames) return this.last;
    const backward = this.last !== null && target < this.last.index;
    const jump = target - this.nextIndex > SKIP_LIMIT;
    if (!this.proc || backward || jump || (this.ended && this.nextIndex > target)) await this.spawnAt(target);
    while (this.nextIndex <= target) {
      const data = await this.readBytes(this.frameBytes);
      if (!data) {
        // The stream ended early (duration estimate was a little long): hold the last decoded frame.
        if (this.last) return this.last;
        throw new Error(`ffmpeg produced no frames for "${this.file}"${this.stderrTail ? `: ${this.stderrTail.trim().split('\n').pop()}` : ''}`);
      }
      this.last = { index: this.nextIndex, data };
      this.nextIndex++;
    }
    return this.last;
  }

  private async spawnAt(index: number): Promise<void> {
    this.close();
    const bin = await requireFfmpeg('decoding video');
    const gen = ++this.gen;
    const filters = [`fps=${this.fps}`];
    if (this.width !== this.srcWidth || this.height !== this.srcHeight) filters.push(`scale=${this.width}:${this.height}:flags=lanczos`);
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
    if (index > 0) args.push('-ss', (index / this.fps).toFixed(6));
    args.push('-i', this.file, '-an', '-sn', '-vf', filters.join(','), '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1');
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.spawns++;
    this.proc = proc;
    this.chunks = [];
    this.buffered = 0;
    this.ended = false;
    this.nextIndex = index;
    this.stderrTail = '';
    proc.stderr!.on('data', (d: Buffer) => {
      if (gen === this.gen) this.stderrTail = (this.stderrTail + d.toString()).slice(-800);
    });
    proc.stdout!.on('data', (d: Buffer) => {
      if (gen !== this.gen) return;
      this.chunks.push(d);
      this.buffered += d.length;
      if (this.buffered >= this.frameBytes * 2) proc.stdout!.pause();
      this.wake?.();
    });
    const done = () => {
      if (gen !== this.gen) return;
      this.ended = true;
      this.wake?.();
    };
    proc.stdout!.on('end', done);
    proc.on('close', done);
    proc.on('error', (e) => {
      this.stderrTail += String(e);
      done();
    });
  }

  private async readBytes(n: number): Promise<Buffer | null> {
    while (this.buffered < n) {
      if (this.ended || !this.proc) return null;
      this.proc.stdout!.resume();
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
      this.wake = null;
    }
    const joined = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = Buffer.from(joined.subarray(0, n));
    const rest = joined.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }
}
