/**
 * Sound-to-picture bridge plumbing (pure). `Host.signal` is answered from one of two places:
 *  - live: the running audio engine's latest value;
 *  - export: per-frame tracks analysed offline, which make exports deterministic.
 */

export interface TrackLookup {
  fps: number;
  value(nodeId: string, name: string, frameIndex: number): number;
}

export class SignalRouter {
  /** Live value source (the audio engine). */
  live: (nodeId: string, name: string) => number = () => 0;
  /** Called when an export that used offline tracks has finished (lets the player re-render live). */
  onExportEnd: (() => void) | null = null;
  private tracks: TrackLookup | null = null;

  get exporting(): boolean {
    return this.tracks !== null;
  }

  beginExport(tracks: TrackLookup): void {
    this.tracks = tracks;
  }

  endExport(): void {
    if (!this.tracks) return;
    this.tracks = null;
    this.onExportEnd?.();
  }

  signal(nodeId: string, name: string, seconds: number): number {
    const t = this.tracks;
    if (t) return t.value(nodeId, name, Math.max(0, Math.round(seconds * t.fps)));
    return this.live(nodeId, name);
  }
}

/** Tracks that answer 0 for everything (analysis failed or unavailable): keeps an export free of live values. */
export const SILENT_TRACKS = (fps: number): TrackLookup => ({ fps, value: () => 0 });

export type FrameEvent = 'play' | 'seek' | 'step' | 'wrap' | 'tick';

/**
 * Bridge nodes read the clock, so the engine caches them per frame. A live value would stay frozen in that
 * cache when a frame is visited again. Every non-sequential visit (start of playback, seek, step, loop wrap)
 * therefore flushes the engine cache and the player's frame cache while live signals are active.
 * Plain forward ticks only ever reach frames not rendered since the last flush.
 */
export function needsInvalidate(liveSignalsActive: boolean, event: FrameEvent): boolean {
  return liveSignalsActive && event !== 'tick';
}
