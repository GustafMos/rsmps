import { biquadTick, makeBiquad, setBiquad } from './dsp';
import type { AudioAsset } from './types';

/** Resample one channel (cubic Hermite; low-passes first when reducing the rate). */
export function resampleChannel(src: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return src;
  let input = src;
  if (dstRate < srcRate) {
    input = new Float32Array(src.length);
    const a = makeBiquad();
    const b = makeBiquad();
    setBiquad(a, 'lowpass', srcRate, dstRate * 0.45, 0.54);
    setBiquad(b, 'lowpass', srcRate, dstRate * 0.45, 1.31);
    for (let i = 0; i < src.length; i++) input[i] = biquadTick(b, biquadTick(a, src[i]));
  }
  const n = Math.max(1, Math.floor((input.length * dstRate) / srcRate));
  const out = new Float32Array(n);
  const step = srcRate / dstRate;
  const last = input.length - 1;
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const i1 = Math.floor(p);
    const t = p - i1;
    const y0 = input[Math.max(i1 - 1, 0)];
    const y1 = input[Math.min(i1, last)];
    const y2 = input[Math.min(i1 + 1, last)];
    const y3 = input[Math.min(i1 + 2, last)];
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    out[i] = ((c3 * t + c2) * t + c1) * t + y1;
  }
  return out;
}

/** Convert decoded PCM (mono or stereo, any rate) into the stereo asset format the kernels read. */
export function toAudioAsset(pcm: { sampleRate: number; channels: Float32Array[] }, sampleRate: number): AudioAsset {
  const l = resampleChannel(pcm.channels[0] ?? new Float32Array(0), pcm.sampleRate, sampleRate);
  const r = pcm.channels[1] ? resampleChannel(pcm.channels[1], pcm.sampleRate, sampleRate) : l;
  return { sampleRate, frames: Math.min(l.length, r.length), left: l, right: r };
}
