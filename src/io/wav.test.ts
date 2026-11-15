import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav } from './wav';

const sine = (n: number) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 5) * 0.8);

describe('wav', () => {
  it('writes a valid 32-bit float header and round-trips exactly', () => {
    const l = sine(100);
    const r = sine(100).map((x) => -x);
    const bytes = encodeWav({ sampleRate: 48000, channels: [l, r] }, 32);
    expect(bytes.length).toBe(44 + 100 * 2 * 4);
    const str = (o: number) => String.fromCharCode(...bytes.slice(o, o + 4));
    expect([str(0), str(8), str(12), str(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data']);
    const v = new DataView(bytes.buffer);
    expect(v.getUint16(20, true)).toBe(3);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(4, true)).toBe(bytes.length - 8);
    const back = decodeWav(bytes);
    expect(back.sampleRate).toBe(48000);
    expect(Array.from(back.channels[0])).toEqual(Array.from(l));
    expect(Array.from(back.channels[1])).toEqual(Array.from(r));
  });
  it('24-bit stays within one step and clamps overload', () => {
    const l = Float32Array.from([0, 0.5, -0.5, 1.5, -2, 1]);
    const back = decodeWav(encodeWav({ sampleRate: 44100, channels: [l] }, 24));
    const want = [0, 0.5, -0.5, 1, -1, 1];
    back.channels[0].forEach((x, i) => expect(Math.abs(x - want[i])).toBeLessThan(2 / 0x800000));
  });
  it('handles mono and empty audio, and rejects junk', () => {
    expect(decodeWav(encodeWav({ sampleRate: 8000, channels: [new Float32Array(0)] })).channels[0].length).toBe(0);
    expect(decodeWav(encodeWav({ sampleRate: 8000, channels: [sine(10)] })).channels.length).toBe(1);
    expect(() => decodeWav(new Uint8Array(64))).toThrow();
  });
});
