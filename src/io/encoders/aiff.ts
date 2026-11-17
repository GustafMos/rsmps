/**
 * AIFF writer (uncompressed big-endian PCM, 16 or 24 bit) from per-channel Float32 audio, as WavPcm in src/io/wav.ts.
 * Layout per the Apple "Audio Interchange File Format" 1.3 specification: FORM / COMM (with an 80-bit extended sample rate) / SSND.
 */
import { ByteWriter } from './util';

export interface AiffPcm {
  sampleRate: number;
  channels: Float32Array[];
}

/** IEEE 754 80-bit extended, big-endian, for positive finite numbers. */
export function extended80(x: number): Uint8Array {
  const out = new Uint8Array(10);
  if (!(x > 0)) return out;
  const exp = Math.floor(Math.log2(x));
  const e = exp + 16383;
  // mantissa: x / 2^exp in [1,2) scaled to 63 fractional bits (exact for the sample rates in use).
  const mant = BigInt(Math.round((x / 2 ** exp) * 2 ** 30)) << 33n;
  out[0] = (e >> 8) & 0x7f;
  out[1] = e & 255;
  for (let i = 0; i < 8; i++) out[2 + i] = Number((mant >> BigInt(8 * (7 - i))) & 255n);
  return out;
}

export function encodeAiff(pcm: AiffPcm, bits: 16 | 24 = 24): Uint8Array {
  const nch = Math.max(1, pcm.channels.length);
  const frames = pcm.channels[0]?.length ?? 0;
  const bps = bits / 8;
  const dataBytes = frames * nch * bps;
  const ssnd = 8 + dataBytes;
  const pad = ssnd & 1;
  const w = new ByteWriter(12 + 26 + 8 + ssnd + 2);
  w.ascii('FORM').u32(4 + 26 + 8 + ssnd + pad).ascii('AIFF');
  w.ascii('COMM').u32(18).u16(nch).u32(frames).u16(bits).bytes(extended80(pcm.sampleRate));
  w.ascii('SSND').u32(ssnd).u32(0).u32(0);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const x = Math.max(-1, Math.min(1, pcm.channels[Math.min(c, pcm.channels.length - 1)][i] ?? 0));
      if (bits === 16) w.u16(Math.round(x < 0 ? x * 0x8000 : x * 0x7fff) & 0xffff);
      else {
        const n = Math.round(x < 0 ? x * 0x800000 : x * 0x7fffff);
        w.u8((n >> 16) & 255).u8((n >> 8) & 255).u8(n & 255);
      }
    }
  }
  if (pad) w.u8(0);
  return w.result();
}
