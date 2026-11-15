import { createStore, type Store } from './createStore';
import type { Io, PlayerState } from '../../io/api';

/**
 * The slow-moving part of player state, exposed to React. Per-frame values (time, frame, cache)
 * are NOT here: transport components read them imperatively from `io.player`.
 */
export interface PlayerSlice {
  playing: boolean;
  errors: ReadonlyMap<string, string>;
  timings: ReadonlyMap<string, number>;
  fps: number;
  proxyPct: number;
  imageSize: { width: number; height: number } | null;
  totalFrames: number;
  audio: { needed: boolean; running: boolean; micNodes: number };
}

const EMPTY: ReadonlyMap<string, never> = new Map<string, never>();

function sameMap<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

export function createPlayerStore(io: Io): Store<PlayerSlice> {
  const store = createStore<PlayerSlice>({
    playing: false,
    errors: EMPTY,
    timings: EMPTY,
    fps: 0,
    proxyPct: 100,
    imageSize: null,
    totalFrames: 1,
    audio: { needed: false, running: false, micNodes: 0 },
  });
  const apply = (s: PlayerState) => {
    const cur = store.get();
    const timings = new Map<string, number>();
    for (const [k, v] of s.timings) timings.set(k, Math.round(v * 10) / 10);
    const next: PlayerSlice = {
      playing: s.playing,
      errors: sameMap(cur.errors, s.errors) ? cur.errors : new Map(s.errors),
      timings: sameMap(cur.timings, timings) ? cur.timings : timings,
      fps: Math.round(s.measuredFps),
      proxyPct: Math.round(s.proxy * 100),
      imageSize:
        cur.imageSize && s.imageSize && cur.imageSize.width === s.imageSize.width && cur.imageSize.height === s.imageSize.height
          ? cur.imageSize
          : s.imageSize,
      totalFrames: s.totalFrames,
      audio:
        cur.audio.needed === s.audio.needed && cur.audio.running === s.audio.running && cur.audio.micNodes === s.audio.micNodes
          ? cur.audio
          : { needed: s.audio.needed, running: s.audio.running, micNodes: s.audio.micNodes },
    };
    if (
      next.playing !== cur.playing ||
      next.errors !== cur.errors ||
      next.timings !== cur.timings ||
      next.fps !== cur.fps ||
      next.proxyPct !== cur.proxyPct ||
      next.imageSize !== cur.imageSize ||
      next.totalFrames !== cur.totalFrames ||
      next.audio !== cur.audio
    ) {
      store.set(next);
    }
  };
  apply(io.player.getState());
  io.player.subscribe(apply);
  return store;
}
