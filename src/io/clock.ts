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

/**
 * Chooses the playback proxy scale. Cost is assumed to scale with proxy^2, so measured render times are
 * normalised to full resolution. Lowers one step after a few consecutive over-budget frames; raises one step
 * only after a long run of frames that would still fit comfortably at the higher level (hysteresis).
 */
export class ProxyController {
  private idx = 0;
  /** Smoothed render time normalised to proxy 1, ms. */
  private norm = 0;
  private over = 0;
  private under = 0;
  private cooldown = 0;

  constructor(private opts = { lowerAfter: 3, raiseAfter: 40, lowerAbove: 1.0, raiseBelow: 0.65, cooldown: 4 }) {}

  get proxy(): number {
    return PROXY_LEVELS[this.idx];
  }

  reset(): void {
    this.idx = 0;
    this.norm = 0;
    this.over = 0;
    this.under = 0;
    this.cooldown = 0;
  }

  /** Feed the time one rendered frame took. Returns the proxy to use for the next frame. */
  report(renderMs: number, budgetMs: number): number {
    if (this.cooldown > 0) {
      // The first frames after a change include shader compiles and cache misses: ignore them.
      this.cooldown--;
      return this.proxy;
    }
    const p = this.proxy;
    const sample = renderMs / (p * p);
    this.norm = this.norm === 0 ? sample : this.norm * 0.7 + sample * 0.3;
    const atCurrent = this.norm * p * p;
    if (atCurrent > budgetMs * this.opts.lowerAbove) {
      this.over++;
      this.under = 0;
      if (this.over >= this.opts.lowerAfter && this.idx < PROXY_LEVELS.length - 1) {
        this.idx++;
        this.change();
      }
    } else {
      this.over = 0;
      if (this.idx > 0) {
        const up = PROXY_LEVELS[this.idx - 1];
        if (this.norm * up * up < budgetMs * this.opts.raiseBelow) {
          this.under++;
          if (this.under >= this.opts.raiseAfter) {
            this.idx--;
            this.change();
          }
        } else this.under = 0;
      }
    }
    return this.proxy;
  }

  private change(): void {
    this.over = 0;
    this.under = 0;
    this.cooldown = this.opts.cooldown;
  }
}
