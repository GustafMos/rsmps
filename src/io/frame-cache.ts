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

  constructor(
    maxBytes: number,
    onEvict: (image: I) => void,
  ) {
    this.lru = new ByteLru<number, CachedFrame<I>>(maxBytes, (frame, entry) => {
      this.frames.delete(frame);
      onEvict(entry.image);
    });
  }

  get bytes(): number {
    return this.lru.bytes;
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
    this.frames.add(frame);
    return true;
  }

  clear(): void {
    this.lru.clear();
    this.frames.clear();
  }
}
