import { ByteLru } from './lru';

export interface CachedFrame<I> {
  image: I;
  /** Proxy scale the frame was rendered at. */
  proxy: number;
}

/**
 * RAM cache of final rendered frames for the current view (graph hash + node + item). Keyed by frame
 * index. `frames` is a live Set (mutated in place) that mirrors the keys, so the UI can draw a
 * "cached" bar without per-notification allocation.
 */
export class RenderedFrameCache<I> {
  readonly frames = new Set<number>();
  private lru: ByteLru<number, CachedFrame<I>>;
  private head = 0;
  private length = 0;
  private forward = false;

  constructor(
    maxBytes: number,
    onEvict: (image: I) => void,
  ) {
    this.lru = new ByteLru<number, CachedFrame<I>>(maxBytes, (frame, entry) => {
      this.frames.delete(frame);
      onEvict(entry.image);
    });
    this.lru.pickVictim = (keys) => this.victim(keys);
  }

  /**
   * Where the playhead is, so a full cache gives up the frames it needs LAST. Playing forward in a loop, the frame needed furthest in the
   * future is the one just played (it comes round again after the whole clip): evicting oldest-first would drop frame 0 just before the loop
   * wraps and every pass would render the whole clip again; this keeps the frames that come next. Paused (scrubbing): the frame
   * farthest from the playhead in either direction goes first. `total` 0 = unknown (oldest first).
   */
  setPlayhead(frame: number, total: number, playing: boolean): void {
    this.head = frame;
    this.length = total;
    this.forward = playing;
  }

  /** How many frames until `frame` is needed again. A frame at the playhead has just been shown: it is needed after a whole pass. */
  private wait(frame: number): number {
    const n = this.length;
    if (this.forward) return ((((frame - this.head - 1) % n) + n) % n) + 1;
    const d = Math.abs(frame - this.head);
    return Math.min(d, n - d);
  }

  private victim(keys: number[]): number | undefined {
    if (this.length <= 0 || keys.length === 0) return keys[0]; // oldest first
    let best = keys[0];
    let bestWait = -1;
    for (const k of keys) {
      const w = this.wait(k);
      if (w > bestWait) {
        bestWait = w;
        best = k;
      }
    }
    return best;
  }

  setMaxBytes(bytes: number): void {
    this.lru.resize(bytes);
  }

  get bytes(): number {
    return this.lru.bytes;
  }

  get maxBytes(): number {
    return this.lru.maxBytes;
  }

  /** The cached frame if it is at least as sharp as `minProxy`. */
  get(frame: number, minProxy: number): CachedFrame<I> | undefined {
    const e = this.lru.peek(frame);
    if (!e || e.proxy < minProxy - 1e-6) return undefined;
    this.lru.get(frame);
    return e;
  }

  /** Returns false (and does not keep `image`) when a sharper frame is already cached. */
  put(frame: number, image: I, proxy: number, bytes: number): boolean {
    const old = this.lru.peek(frame);
    // Never replace a sharper frame with a blurrier one.
    if (old && old.proxy > proxy + 1e-6) return false;
    this.lru.set(frame, { image, proxy }, bytes);
    if (!this.lru.has(frame)) return false; // the new frame is the one needed last: it gave way to frames that come sooner
    this.frames.add(frame);
    return true;
  }

  clear(): void {
    this.lru.clear();
    this.frames.clear();
  }
}
