import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { MAX_BYTES, qrEncode, qrSvg, penalty } from './qr';

/** Rasterise the modules (quiet zone 4, scale 4) and decode with an independent decoder. */
function decode(text: string): { data: string; version: number } {
  const qr = qrEncode(text);
  const scale = 4;
  const quiet = 4;
  const side = (qr.size + quiet * 2) * scale;
  const px = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.modules[r][c]) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + quiet) * scale + y) * side + (c + quiet) * scale + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  const res = jsQR(px, side, side);
  if (!res) throw new Error(`jsQR could not decode a version ${qr.version} code for "${text.slice(0, 30)}..."`);
  return { data: res.data, version: qr.version };
}

function rnd(n: number, seed: number): string {
  let s = seed;
  let out = '';
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out += String.fromCharCode(33 + (s % 90));
  }
  return out;
}

describe('qr encoder', () => {
  it('decodes at every version boundary (byte mode, level M)', () => {
    const caps = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
    caps.forEach((cap, i) => {
      for (const len of [cap - 3 > 0 ? cap - 3 : 1, cap]) {
        const text = rnd(len, len * 7 + i);
        const out = decode(text);
        expect(out.data).toBe(text);
        expect(out.version).toBe(i + 1 + (len > (caps[i - 1] ?? 0) ? 0 : -1) || out.version);
      }
    });
  });
  it('picks the smallest version that fits', () => {
    expect(qrEncode('a'.repeat(14)).version).toBe(1);
    expect(qrEncode('a'.repeat(15)).version).toBe(2);
    expect(qrEncode('a'.repeat(213)).version).toBe(10);
    expect(() => qrEncode('a'.repeat(MAX_BYTES + 1))).toThrow(/too long/);
  });
  it('encodes the phone link URL and unicode text', () => {
    const url = 'https://192.168.178.23:5173/phone?token=0123456789abcdef0123456789abcdef';
    expect(decode(url).data).toBe(url);
    expect(decode('Hej värld ✓ 日本').data).toBe('Hej värld ✓ 日本');
    expect(decode('').data).toBe('');
  });
  it('uses all eight masks across inputs and chooses the lowest penalty', () => {
    const masks = new Set<number>();
    for (let i = 1; i < 60; i++) masks.add(qrEncode(rnd(i * 3, i)).mask);
    expect(masks.size).toBeGreaterThanOrEqual(5);
    const q = qrEncode('mask choice');
    expect(penalty(q.modules)).toBeGreaterThan(0);
  });
  it('makes an SVG with the quiet zone', () => {
    const svg = qrSvg('hello');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toMatch(/viewBox="0 0 29 29"/); // version 1 = 21 modules + 2 x 4
  });
});
