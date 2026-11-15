import type { PcmAudio } from '../engine/audio/api';

/**
 * Cut `duration` seconds out of `pcm` starting at `start`, repeating the source when `loop` is set and
 * padding with silence otherwise. Used to carry a video's own sound into the exported video.
 */
export function fitAudio(pcm: PcmAudio, start: number, duration: number, loop: boolean): PcmAudio {
  const rate = pcm.sampleRate;
  const n = Math.max(1, Math.round(duration * rate));
  const len = pcm.channels[0]?.length ?? 0;
  const first = Math.round(start * rate);
  const channels = pcm.channels.slice(0, 2).map((src) => {
    const out = new Float32Array(n);
    if (len === 0) return out;
    for (let i = 0; i < n; i++) {
      let j = first + i;
      if (loop) j = ((j % len) + len) % len;
      else if (j < 0 || j >= len) continue;
      out[i] = src[j];
    }
    return out;
  });
  return { sampleRate: rate, channels };
}
