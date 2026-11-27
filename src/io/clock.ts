/** Playback clock and the adaptive resolution controller. Pure. */

export interface ClockResult {
  frame: number;
  /** How many times the clip has wrapped since the clock started (loop mode). */
  cycle: number;
  /** True when playback should stop (end reached, not looping). */
  ended: boolean;
}

/**
 * Frame index = startFrame + floor(elapsed * fps). Frames are dropped, never stretched:
 * the clock always follows wall time.
 */
export function frameAtTime(startFrame: number, elapsedMs: number, fps: number, totalFrames: number, loop: boolean): ClockResult {
  const raw = startFrame + Math.floor((Math.max(0, elapsedMs) * fps) / 1000);
  if (loop) return { frame: raw % totalFrames, cycle: Math.floor(raw / totalFrames), ended: false };
  if (raw >= totalFrames) return { frame: totalFrames - 1, cycle: 0, ended: true };
  return { frame: raw, cycle: 0, ended: false };
}

export const PROXY_LEVELS = [1, 0.75, 0.5, 0.35, 0.25] as const;

export interface ProxyTuning {
  /** Frames ignored after warmup() (shader compiles, cold caches). */
  warmupFrames: number;
  /** Size of the median window. */
  window: number;
  /** Consecutive over-budget medians before stepping down (levels above the floor). */
  lowerAfter: number;
  /** Median above budget * this counts as over. */
  overFactor: number;
  /** Median below budget * this counts as comfortable. */
  underFactor: number;
  /** Comfortable for this long before stepping up (ms). */
  raiseAfterMs: number;
  /** A level abandoned for being too slow is not retried for this long (ms). */
  retryAfterMs: number;
  /** Index of the lowest level used without sustained proof (0.5). */
  floorIndex: number;
  /** Over budget at the floor for this long before going below it (ms). */
  belowFloorAfterMs: number;
}

export const DEFAULT_TUNING: ProxyTuning = {
  warmupFrames: 8,
  window: 5,
  lowerAfter: 6,
  overFactor: 1.0,
  underFactor: 0.55,
  raiseAfterMs: 1500,
  retryAfterMs: 10_000,
  floorIndex: 2,
  belowFloorAfterMs: 2000,
};

/**
 * Chooses the playback proxy scale, calmly. It looks at the median of the last few render times (one
 * spike never matters), changes one level at a time, ignores frames right after play / graph / proxy
 * changes, will not go below 0.5 unless 0.5 is itself too slow for a sustained time, climbs only after a
 * sustained comfortable period, and does not retry a level it abandoned for ~10 s. The level survives pause/play and loop
 * wraps (only `reset()` returns to 1).
 */
export class ProxyController {
  private idx = 0;
  /** Index of the finest level allowed (the viewer is small: finer than this would only be thrown away). */
  private ceilIdx = 0;
  private times: number[] = [];
  private warm = 0;
  private over = 0;
  private overSince = -1;
  private underSince = -1;
  private abandonedUntil: number[] = PROXY_LEVELS.map(() => 0);

  constructor(private t: ProxyTuning = DEFAULT_TUNING) {
    this.warm = t.warmupFrames;
  }

  get proxy(): number {
    return PROXY_LEVELS[this.idx];
  }

  /**
   * The finest level worth rendering (see `playbackProxyCap`). Playback starts there instead of at full size, and the controller never
   * climbs above it. Changing it restarts the measuring only when the current level has to change.
   */
  setCeiling(cap: number): void {
    let i = PROXY_LEVELS.findIndex((l) => l <= cap + 1e-6);
    if (i < 0) i = PROXY_LEVELS.length - 1;
    if (i === this.ceilIdx) return;
    this.ceilIdx = i;
    if (this.idx < i) {
      this.idx = i;
      this.settle();
    }
  }

  /** Back to the finest allowed level (the user changed the proxy mode). */
  reset(): void {
    this.idx = this.ceilIdx;
    this.abandonedUntil = PROXY_LEVELS.map(() => 0);
    this.warmup();
  }

  /** Out of memory: drop one resolution level now. */
  forceLower(): void {
    if (this.idx < PROXY_LEVELS.length - 1) {
      this.abandonedUntil[this.idx] = performance.now() + this.t.retryAfterMs * 3;
      this.idx++;
      this.settle();
    }
  }

  /** Playback started, or the graph changed: keep the level, but ignore the next frames and restart timers. */
  warmup(): void {
    this.warm = this.t.warmupFrames;
    this.times = [];
    this.over = 0;
    this.overSince = -1;
    this.underSince = -1;
  }

  /** Feed the time one rendered frame took (ms) at wall-clock `now` (ms). Returns the proxy for the next frame. */
  report(renderMs: number, budgetMs: number, now: number = performance.now()): number {
    if (this.warm > 0) {
      this.warm--;
      return this.proxy;
    }
    this.times.push(renderMs);
    if (this.times.length > this.t.window) this.times.shift();
    if (this.times.length < this.t.window) return this.proxy;
    const median = [...this.times].sort((a, b) => a - b)[this.times.length >> 1];

    if (median > budgetMs * this.t.overFactor) {
      this.underSince = -1;
      this.over++;
      if (this.overSince < 0) this.overSince = now;
      const atFloor = this.idx >= this.t.floorIndex;
      const ready = atFloor ? now - this.overSince >= this.t.belowFloorAfterMs : this.over >= this.t.lowerAfter;
      if (ready && this.idx < PROXY_LEVELS.length - 1) {
        this.abandonedUntil[this.idx] = now + this.t.retryAfterMs;
        this.idx++;
        this.settle();
      }
      return this.proxy;
    }

    this.over = 0;
    this.overSince = -1;
    if (this.idx > this.ceilIdx && median < budgetMs * this.t.underFactor) {
      if (this.underSince < 0) this.underSince = now;
      const up = PROXY_LEVELS[this.idx - 1];
      const p = this.proxy;
      const predicted = median * ((up * up) / (p * p));
      if (now - this.underSince >= this.t.raiseAfterMs && now >= this.abandonedUntil[this.idx - 1] && predicted < budgetMs * 0.9) {
        this.idx--;
        this.settle();
      }
    } else this.underSince = -1;
    return this.proxy;
  }

  private settle(): void {
    this.warm = this.t.warmupFrames;
    this.times = [];
    this.over = 0;
    this.overSince = -1;
    this.underSince = -1;
  }
}
