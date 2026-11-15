import type { Io } from '../../io/api';

/** Min/max per bucket of an audio asset, `bps` buckets per second. */
export interface Peaks {
  bps: number;
  min: Float32Array;
  max: Float32Array;
  duration: number;
}

const BPS = 100;
const cache = new Map<string, Promise<Peaks | null>>();
const idle = () => new Promise<void>((r) => setTimeout(r, 0));

/** Computed once per asset id (chunked so the UI stays responsive) and cached. */
export function getPeaks(io: Io, assetId: string): Promise<Peaks | null> {
  let p = cache.get(assetId);
  if (!p) {
    p = compute(io, assetId).catch(() => null);
    cache.set(assetId, p);
    // a failed or missing decode is retried next time
    void p.then((r) => { if (!r && cache.get(assetId) === p) cache.delete(assetId); });
  }
  return p;
}

async function compute(io: Io, assetId: string): Promise<Peaks | null> {
  const pcm = await io.library.assetAudio?.(assetId);
  if (!pcm || !pcm.channels.length) return null;
  const frames = pcm.channels[0].length;
  const duration = frames / pcm.sampleRate;
  const n = Math.max(1, Math.ceil(duration * BPS));
  const min = new Float32Array(n).fill(0);
  const max = new Float32Array(n).fill(0);
  const per = pcm.sampleRate / BPS;
  const CHUNK = 1 << 18;
  for (let from = 0; from < frames; from += CHUNK) {
    const to = Math.min(frames, from + CHUNK);
    for (const ch of pcm.channels) {
      for (let i = from; i < to; i++) {
        const b = Math.min(n - 1, Math.floor(i / per));
        const v = ch[i];
        if (v < min[b]) min[b] = v;
        if (v > max[b]) max[b] = v;
      }
    }
    await idle();
  }
  return { bps: BPS, min, max, duration };
}
