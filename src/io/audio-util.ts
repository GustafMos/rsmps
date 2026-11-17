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

/**
 * How much of each source channel goes to the left and to the right of a stereo fold-down, for the usual channel orders
 * (3: L R C · 4: L R Ls Rs · 5: L R C Ls Rs · 6: L R C LFE Ls Rs · 7/8: the same plus more surrounds). The centre (speech in
 * most films and camera surround) and the surrounds are kept at -3 dB, the LFE is left out, and the sum is scaled so it
 * cannot clip. Mono and stereo pass unchanged. Taking only the first two channels would drop the speech of a 5.1 track.
 */
export function stereoWeights(channels: number): { left: number[]; right: number[] } {
  const n = Math.max(1, Math.floor(channels));
  if (n === 1) return { left: [1], right: [1] };
  const left = new Array<number>(n).fill(0);
  const right = new Array<number>(n).fill(0);
  left[0] = 1;
  right[1] = 1;
  if (n === 2) return { left, right };
  const k = Math.SQRT1_2;
  const hasCentre = n !== 4;
  if (hasCentre) left[2] = right[2] = k;
  // Surrounds: everything after the centre and the LFE, alternating left / right.
  for (let c = n === 4 ? 2 : n >= 6 ? 4 : 3, side = 0; c < n; c++, side ^= 1) (side === 0 ? left : right)[c] = k;
  const norm = 1 / Math.max(left.reduce((a, b) => a + b, 0), right.reduce((a, b) => a + b, 0));
  return { left: left.map((w) => w * norm), right: right.map((w) => w * norm) };
}

/** Add `src` (one array per source channel) into the stereo pair `dst` at sample `at`, folded down with `stereoWeights`. */
export function mixToStereo(dst: Float32Array[], at: number, src: Float32Array[]): void {
  const w = stereoWeights(src.length);
  const sides = dst.length > 1 ? [w.left, w.right] : [w.left.map((l, c) => (l + w.right[c]) / 2)];
  for (let d = 0; d < sides.length; d++) {
    const out = dst[d];
    for (let c = 0; c < src.length; c++) {
      const g = sides[d][c];
      if (g === 0) continue;
      const x = src[c];
      const n = Math.max(0, Math.min(x.length, out.length - at));
      if (g === 1 && src.length <= 2) out.set(n === x.length ? x : x.subarray(0, n), at);
      else for (let i = 0; i < n; i++) out[at + i] += x[i] * g;
    }
  }
}
