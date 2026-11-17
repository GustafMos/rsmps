import { describe, expect, it } from 'vitest';
import { crc16, crc8, encodeFlac } from './flac';
import { join, rng } from './test-helpers';

/** Independent decoder for what the encoder writes (CONSTANT / VERBATIM / FIXED + Rice), checking both CRCs. */
function decodeFlac(file: Uint8Array) {
  expect(String.fromCharCode(...file.subarray(0, 4))).toBe('fLaC');
  expect(file[4]).toBe(0x80);
  const rate = (file[18] << 12) | (file[19] << 4) | (file[20] >> 4);
  const channels = ((file[20] >> 1) & 7) + 1;
  const bps = (((file[20] & 1) << 4) | (file[21] >> 4)) + 1;
  const total = (file[21] & 15) * 2 ** 32 + new DataView(file.buffer, file.byteOffset).getUint32(22);
  let p = 42;
  const out: Int32Array[] = Array.from({ length: channels }, () => new Int32Array(total));
  let at = 0;
  let frameNo = 0;
  while (p < file.length) {
    const start = p;
    expect([file[p], file[p + 1]]).toEqual([0xff, 0xf8]);
    const bsCode = file[p + 2] >> 4;
    expect(file[p + 3] >> 4).toBe(channels - 1);
    p += 4;
    // utf8 frame number
    const lead = file[p];
    let nb = 1;
    while (lead & (0x80 >> nb)) nb++;
    const num = nb === 1 ? lead : ((lead & (0xff >> (nb + 1))) * 2 ** (6 * (nb - 1))) + file.subarray(p + 1, p + nb).reduce((s, b, i) => s + (b & 63) * 2 ** (6 * (nb - 2 - i)), 0);
    expect(num).toBe(frameNo++);
    p += nb === 1 ? 1 : nb;
    let n = 4096;
    if (bsCode === 6) n = file[p++] + 1;
    else if (bsCode === 7) {
      n = ((file[p] << 8) | file[p + 1]) + 1;
      p += 2;
    } else expect(bsCode).toBe(12);
    expect(file[p]).toBe(crc8(file, start, p));
    p++;
    let bitPos = p * 8;
    const bit = () => (file[bitPos >> 3] >> (7 - (bitPos++ & 7))) & 1;
    const read = (k: number) => {
      let v = 0;
      for (let i = 0; i < k; i++) v = v * 2 + bit();
      return v;
    };
    const signed = (k: number) => {
      const v = read(k);
      return v >= 2 ** (k - 1) ? v - 2 ** k : v;
    };
    for (let c = 0; c < channels; c++) {
      expect(read(1)).toBe(0);
      const type = read(6);
      expect(read(1)).toBe(0);
      const x = out[c];
      if (type === 0) {
        const v = signed(bps);
        for (let i = 0; i < n; i++) x[at + i] = v;
      } else if (type === 1) for (let i = 0; i < n; i++) x[at + i] = signed(bps);
      else {
        expect(type >> 3).toBe(1);
        const order = type & 7;
        for (let i = 0; i < order; i++) x[at + i] = signed(bps);
        expect(read(2)).toBe(0);
        const po = read(4);
        const size = n >> po;
        for (let part = 0; part < 1 << po; part++) {
          const k = read(4);
          for (let i = Math.max(part * size, order); i < (part + 1) * size; i++) {
            let q = 0;
            while (!bit()) q++;
            const u = q * 2 ** k + read(k);
            const r = u % 2 ? -(u + 1) / 2 : u / 2;
            const s = (d: number) => x[at + i - d];
            const pred = order === 0 ? 0 : order === 1 ? s(1) : order === 2 ? 2 * s(1) - s(2) : order === 3 ? 3 * s(1) - 3 * s(2) + s(3) : 4 * s(1) - 6 * s(2) + 4 * s(3) - s(4);
            x[at + i] = pred + r;
          }
        }
      }
    }
    p = Math.ceil(bitPos / 8);
    const crc = crc16(file, start, p);
    expect([file[p], file[p + 1]]).toEqual([crc >> 8, crc & 255]);
    p += 2;
    at += n;
  }
  expect(at).toBe(total);
  return { rate, channels, bps, total, samples: out };
}

const quant = (f: Float32Array, bits: number) => Int32Array.from(f, (x) => Math.round(Math.max(-1, Math.min(1, x)) * (x < 0 ? 2 ** (bits - 1) : 2 ** (bits - 1) - 1)));

describe('FLAC', () => {
  const r = rng(11);
  const n = 4096 * 2 + 1234;
  const tone = Float32Array.from({ length: n }, (_, i) => 0.6 * Math.sin(i / 17) + 0.1 * Math.sin(i / 3));
  const noise = Float32Array.from({ length: n }, () => (r() - 0.5) * 1.6);
  const silence = new Float32Array(n);

  for (const bits of [16, 24] as const) {
    it(`${bits}-bit stereo: lossless round trip, CRCs valid, short last frame`, () => {
      const file = join(encodeFlac([tone, noise], { sampleRate: 44100, bits }));
      const d = decodeFlac(file);
      expect([d.rate, d.channels, d.bps, d.total]).toEqual([44100, 2, bits, n]);
      expect(d.samples[0]).toEqual(quant(tone, bits));
      expect(d.samples[1]).toEqual(quant(noise, bits));
    });
  }

  it('silence is CONSTANT and tiny; a tone compresses well; noise stays near PCM size', () => {
    const sil = join(encodeFlac([silence], { sampleRate: 48000 }));
    expect(sil.length).toBeLessThan(200);
    expect(decodeFlac(sil).samples[0].every((v) => v === 0)).toBe(true);
    expect(join(encodeFlac([tone], { sampleRate: 48000 })).length).toBeLessThan(n * 2 * 0.5);
    const nz = join(encodeFlac([noise], { sampleRate: 48000 }));
    expect(nz.length).toBeLessThan(n * 2 * 1.02 + 200);
  });

  it('full-scale square waves and clipping survive (verbatim / large residual paths)', () => {
    const sq = Float32Array.from({ length: 5000 }, (_, i) => (Math.floor(i / 50) % 2 ? 1 : -1));
    const loud = Float32Array.from({ length: 5000 }, (_, i) => (i % 2 ? 2 : -2));
    for (const sig of [sq, loud]) expect(decodeFlac(join(encodeFlac([sig], { sampleRate: 8000, bits: 16 }))).samples[0]).toEqual(quant(sig, 16));
  });

  it('tiny inputs: one sample, empty, 8 channels', () => {
    expect(decodeFlac(join(encodeFlac([Float32Array.of(0.5)], { sampleRate: 44100 }))).samples[0][0]).toBe(16384);
    expect(decodeFlac(join(encodeFlac([new Float32Array(0)], { sampleRate: 44100 }))).total).toBe(0);
    const eight = decodeFlac(join(encodeFlac(Array.from({ length: 8 }, (_, c) => tone.map((v) => v * (c + 1) * 0.1)), { sampleRate: 96000 })));
    expect(eight.channels).toBe(8);
  });

  it('known CRC values', () => {
    expect(crc8(new TextEncoder().encode('123456789'))).toBe(0xf4); // CRC-8/SMBUS
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0xfee8); // CRC-16/UMTS (poly 0x8005, init 0, no reflection)
  });
});
