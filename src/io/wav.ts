/** Dependency-free WAV writer / reader for recordings and audio export. */

export interface WavPcm {
  sampleRate: number;
  /** One Float32Array per channel, equal lengths (1 or 2 are typical). */
  channels: Float32Array[];
}

export type WavBits = 24 | 32;

/** RIFF/WAVE bytes. 32 = IEEE float (lossless for our float32 audio), 24 = integer PCM. Samples are clamped to -1..1 for 24-bit. */
export function encodeWav(pcm: WavPcm, bits: WavBits = 32): Uint8Array {
  const nch = Math.max(1, pcm.channels.length);
  const frames = pcm.channels[0]?.length ?? 0;
  const bytesPer = bits / 8;
  const dataBytes = frames * nch * bytesPer;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, bits === 32 ? 3 : 1, true); // 3 = IEEE float, 1 = PCM
  v.setUint16(22, nch, true);
  v.setUint32(24, pcm.sampleRate, true);
  v.setUint32(28, pcm.sampleRate * nch * bytesPer, true);
  v.setUint16(32, nch * bytesPer, true);
  v.setUint16(34, bits, true);
  str(36, 'data');
  v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++) {
      const x = pcm.channels[Math.min(c, pcm.channels.length - 1)][i] ?? 0;
      if (bits === 32) {
        v.setFloat32(o, x, true);
      } else {
        const s = Math.max(-1, Math.min(1, x));
        const n = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        v.setUint8(o, n & 0xff);
        v.setUint8(o + 1, (n >> 8) & 0xff);
        v.setUint8(o + 2, (n >> 16) & 0xff);
      }
      o += bytesPer;
    }
  }
  return out;
}

/** Read back what `encodeWav` wrote (16/24-bit PCM and 32-bit float). Throws on anything else. */
export function decodeWav(bytes: Uint8Array): WavPcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.');
  let o = 12;
  let fmt: { format: number; nch: number; rate: number; bits: number } | null = null;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(o + 8, true), nch: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    else if (id === 'data' && fmt) {
      const per = fmt.bits / 8;
      const frames = Math.floor(size / (per * fmt.nch));
      const channels = Array.from({ length: fmt.nch }, () => new Float32Array(frames));
      let p = o + 8;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.nch; c++) {
          if (fmt.format === 3 && fmt.bits === 32) channels[c][i] = v.getFloat32(p, true);
          else if (fmt.format === 1 && fmt.bits === 24) {
            let n = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
            if (n & 0x800000) n -= 0x1000000;
            channels[c][i] = n < 0 ? n / 0x800000 : n / 0x7fffff;
          } else if (fmt.format === 1 && fmt.bits === 16) channels[c][i] = v.getInt16(p, true) / 32768;
          else throw new Error('Unsupported WAV format.');
          p += per;
        }
      }
      return { sampleRate: fmt.rate, channels };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('The WAV file has no audio data.');
}
