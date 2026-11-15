/**
 * Video through the browser's own media pipeline (an HTMLVideoElement), for files WebCodecs cannot decode (phone HEVC,
 * 10-bit...). Many browsers play those through the OS / hardware decoder. HDR sources come out tone-mapped to SDR by the
 * browser: accepted.
 *
 * Two access modes, both frame-exact where it matters:
 *  - SEEK (paused scrubbing and ALL exports): set currentTime, wait for `seeked`, then wait until the element has really
 *    presented a frame (requestVideoFrameCallback) and check its `mediaTime` against the requested frame time; retry when it
 *    is off by more than half a frame. This is how an export frame is guaranteed to match the requested time.
 *  - PLAY (real-time forward playback only): let the element play at the measured rate and keep it in step with the clock the
 *    node asks for (nudge playbackRate for small drift, seek for large drift or a backwards jump). Never used while exporting.
 */

/* ------------------------------------------- pure parts ------------------------------------------ */

/** Start time of the frame that contains `t` on a grid of `fps` frames per second. */
export function snapTime(t: number, fps: number): number {
  const rate = fps > 0 ? fps : 24;
  return Math.max(0, Math.floor(t * rate + 1e-6) / rate);
}

/** Where to seek so the presented frame is the one starting at `snapped`: a quarter frame into it (never on the edge). */
export function seekTarget(snapped: number, fps: number, duration: number): number {
  const rate = fps > 0 ? fps : 24;
  const t = snapped + 0.25 / rate;
  return duration > 0 ? Math.min(t, Math.max(0, duration - 0.5 / rate)) : t;
}

export interface PlaybackInput {
  /** The element is playing right now. */
  playing: boolean;
  /** video.currentTime. */
  currentTime: number;
  /** Requested clip time (what the node asks for). */
  t: number;
  /** Wall clock, ms. */
  now: number;
  lastReqT: number | null;
  lastReqWall: number | null;
  /** Exporting: always seek. */
  exact: boolean;
}

export interface PlaybackDecision {
  seek: boolean;
  play: boolean;
  rate: number;
}

export const DRIFT_KEEP = 0.06; // seconds: close enough, leave the element alone
export const DRIFT_SEEK = 0.5; // seconds: too far, seek
const FORWARD_GAP_MS = 250; // requests further apart than this are not "real-time playback"
const MAX_FORWARD_STEP = 0.5; // a request further ahead than this is a jump

/**
 * Decide how to serve a request: keep playing, nudge the rate, or seek. A request looks like forward playback when it is
 * recent and a little further along than the previous one; the playback rate is the ratio of clip time to wall time, so
 * Media In's frame-rate reinterpretation works unchanged.
 */
export function decidePlayback(i: PlaybackInput): PlaybackDecision {
  if (i.exact) return { seek: true, play: false, rate: 1 };
  const havePrev = i.lastReqT !== null && i.lastReqWall !== null;
  const wallMs = havePrev ? i.now - i.lastReqWall! : Infinity;
  const dt = havePrev ? i.t - i.lastReqT! : 0;
  const forward = havePrev && wallMs <= FORWARD_GAP_MS && wallMs > 0 && dt > 0 && dt <= MAX_FORWARD_STEP;
  if (!forward) return { seek: true, play: false, rate: 1 }; // scrubbing, paused view, a jump, a loop wrap or the first request
  const base = Math.min(4, Math.max(0.25, dt / (wallMs / 1000)));
  if (!i.playing) {
    return { seek: Math.abs(i.t - i.currentTime) > DRIFT_KEEP, play: true, rate: base };
  }
  const drift = i.t - i.currentTime; // positive: the element is behind the clock
  if (Math.abs(drift) > DRIFT_SEEK) return { seek: true, play: true, rate: base };
  if (Math.abs(drift) <= DRIFT_KEEP) return { seek: false, play: true, rate: base };
  const nudge = Math.max(-0.25, Math.min(0.25, drift / DRIFT_SEEK)); // catch up / slow down by at most 25 %
  return { seek: false, play: true, rate: Math.min(4, Math.max(0.1, base * (1 + nudge))) };
}

/** Human name of a codec from the container's codec id and parameter string. */
export function codecLabel(codec: string | null | undefined, params?: string | null): string {
  const p = (params ?? '').toLowerCase();
  const num = (s: string | undefined) => (s === undefined ? NaN : parseInt(s, 10));
  switch (codec) {
    case 'hevc': {
      // hvc1.<profile>.<flags>.L<level>...: profile 2 = Main 10
      const profile = num(p.split('.')[1]);
      return profile === 2 ? 'HEVC (H.265) 10-bit' : 'HEVC (H.265)';
    }
    case 'avc':
      return 'H.264 (AVC)';
    case 'vp9': {
      const profile = num(p.split('.')[1]);
      return profile === 2 || profile === 3 ? 'VP9 10-bit' : 'VP9';
    }
    case 'vp8':
      return 'VP8';
    case 'av1': {
      const bits = num(p.split('.')[3]);
      return bits === 10 ? 'AV1 10-bit' : 'AV1';
    }
    case 'prores':
      return 'Apple ProRes';
    default:
      return codec ? codec.toUpperCase() : 'an unknown video codec';
  }
}

export function ffmpegCommand(fileName: string): string {
  const stem = fileName.replace(/\.[^.]+$/, '');
  return `ffmpeg -i "${fileName}" -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac "${stem}-h264.mp4"`;
}

export function unsupportedHint(fileName: string): string {
  return `Chrome or Edge on this computer can usually open this file, or convert it to H.264: ${ffmpegCommand(fileName)}`;
}

export function unsupportedMessage(fileName: string, label: string): string {
  return `"${fileName}" uses ${label} video, which this browser cannot play. ${unsupportedHint(fileName)}`;
}

/* ------------------------------------------ the element ----------------------------------------- */

const OPEN_TIMEOUT_MS = 10_000;

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

export class ElementVideo {
  readonly video: VideoWithRvfc;
  private url: string;
  private ready: Promise<void>;
  private chain: Promise<unknown> = Promise.resolve();
  lastUsed = performance.now();
  lastReqT: number | null = null;
  lastReqWall: number | null = null;
  seeks = 0;
  disposed = false;

  constructor(
    blob: Blob,
    private fps: number,
    private duration: number,
  ) {
    const v = document.createElement('video') as VideoWithRvfc;
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    this.video = v;
    this.url = URL.createObjectURL(blob);
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The browser did not load this video in time.')), OPEN_TIMEOUT_MS);
      v.onloadeddata = () => {
        clearTimeout(timer);
        if (!v.videoWidth || !v.videoHeight) reject(new Error('The browser opened this file but found no picture it can play.'));
        else resolve();
      };
      v.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`The browser cannot play this video${v.error?.message ? ` (${v.error.message})` : ''}.`));
      };
    });
    this.ready.catch(() => undefined);
    v.src = this.url;
    v.load();
  }

  /** Resolves when the element can show pictures; rejects when the browser cannot play the file. */
  open(): Promise<void> {
    return this.ready;
  }

  get size(): { width: number; height: number } {
    return { width: this.video.videoWidth, height: this.video.videoHeight };
  }

  /**
   * Make the element show the frame for clip time `t`. Resolves to true when the frame is exact (seek path), false when it
   * comes from real-time playback. Calls are serialised.
   */
  present(t: number, exact: boolean, after?: () => Promise<void>): Promise<boolean> {
    // `after` (the texture upload) runs inside the same serialised step, so no other request can move the element meanwhile.
    const run = this.chain.then(async () => {
      const wasExact = await this.presentNow(t, exact);
      if (after) await after();
      return wasExact;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async presentNow(t: number, exact: boolean): Promise<boolean> {
    await this.ready;
    const v = this.video;
    const now = performance.now();
    this.lastUsed = now;
    const d = decidePlayback({ playing: !v.paused, currentTime: v.currentTime, t, now, lastReqT: this.lastReqT, lastReqWall: this.lastReqWall, exact });
    this.lastReqT = t;
    this.lastReqWall = now;
    if (d.seek) {
      if (!v.paused) v.pause();
      await this.seekExact(t);
      if (d.play) {
        v.playbackRate = d.rate;
        void v.play().catch(() => undefined);
        return false;
      }
      return true;
    }
    if (d.play) {
      v.playbackRate = d.rate;
      if (v.paused) await v.play().catch(() => undefined);
      return false;
    }
    if (!v.paused) v.pause();
    return true;
  }

  /** Seek and wait until the presented frame is the one at `t` (within half a frame), retrying twice. */
  private async seekExact(t: number): Promise<void> {
    const v = this.video;
    const snapped = snapTime(t, this.fps);
    const target = seekTarget(snapped, this.fps, this.duration);
    const half = 0.5 / (this.fps > 0 ? this.fps : 24);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Math.abs(v.currentTime - target) > 1e-4 || v.seeking) {
        this.seeks++;
        await new Promise<void>((resolve) => {
          const done = () => {
            v.removeEventListener('seeked', done);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, 4000);
          v.addEventListener('seeked', done);
          v.currentTime = attempt === 0 ? target : target + (attempt % 2 ? 0.1 : -0.1) / (this.fps > 0 ? this.fps : 24);
        });
      }
      if (typeof v.requestVideoFrameCallback !== 'function') return; // no way to inspect the frame: trust `seeked`
      const mediaTime = await this.nextPresentedMediaTime(250);
      if (mediaTime === null || Math.abs(mediaTime - snapped) <= half + 1e-3) return;
      // The element showed a neighbouring frame: seek again, from the other side.
      v.currentTime = Math.max(0, target + (mediaTime > snapped ? -1 : 1) * half);
    }
  }

  /** `mediaTime` of the next frame the element presents, or null if none arrives in `ms` (nothing new to present). */
  private nextPresentedMediaTime(ms: number): Promise<number | null> {
    const v = this.video;
    return new Promise((resolve) => {
      let id = 0;
      const timer = setTimeout(() => {
        v.cancelVideoFrameCallback?.(id);
        resolve(null);
      }, ms);
      id = v.requestVideoFrameCallback!((_now, meta) => {
        clearTimeout(timer);
        resolve(meta.mediaTime);
      });
    });
  }

  pause(): void {
    if (!this.video.paused) this.video.pause();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    URL.revokeObjectURL(this.url);
  }
}

/** Elements of one asset. Several Media In nodes asking for different times each keep their own element (capped). */
export class ElementPool {
  private items: ElementVideo[] = [];

  constructor(
    private make: () => ElementVideo,
    private cap = 3,
  ) {}

  /** The element whose last request is nearest to `t`; a new one when every element is far away and the pool has room. */
  pick(t: number): ElementVideo {
    let best: ElementVideo | null = null;
    let bestDist = Infinity;
    for (const e of this.items) {
      const d = e.lastReqT === null ? 0.25 : Math.abs(t - e.lastReqT);
      if (d < bestDist) {
        best = e;
        bestDist = d;
      }
    }
    if (best && bestDist <= 2) return best;
    if (this.items.length < this.cap) {
      const e = this.make();
      this.items.push(e);
      return e;
    }
    // Full: reuse the one used longest ago.
    return this.items.reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b));
  }

  /** Pause idle elements (~0.5 s unused) and free ones unused for long. */
  sweep(now: number): void {
    for (const e of [...this.items]) {
      if (now - e.lastUsed > 500) e.pause();
      if (now - e.lastUsed > 20_000) {
        e.dispose();
        this.items.splice(this.items.indexOf(e), 1);
      }
    }
  }

  get count(): number {
    return this.items.length;
  }

  totalSeeks(): number {
    return this.items.reduce((s, e) => s + e.seeks, 0);
  }

  dispose(): void {
    for (const e of this.items) e.dispose();
    this.items = [];
  }
}
