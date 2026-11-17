import { describe, expect, it } from 'vitest';
import { halfToFloat } from '../../io/encoders/float';
import { testGpu } from '../testing';

describe('Gpu.readFloat', () => {
  it('returns half-float bits of an rgba16float image, values above 1.0 included, rows unpadded (width not a multiple of 32)', async () => {
    const gpu = await testGpu();
    const W = 37; // 37 * 8 bytes = 296: padded to 512 in the copy
    const H = 5;
    const img = gpu.scoped(() => {
      const o = gpu.pass({
        label: 'rf-test',
        size: { width: W, height: H },
        format: 'rgba16float',
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(2.5 + floor(px.x), 0.25, -0.5, floor(px.y) / 4.0); }',
      });
      gpu.retain(o.texture);
      return o;
    });
    const half = await gpu.readFloat(img);
    expect(half.length).toBe(W * H * 4);
    for (const [x, y] of [[0, 0], [36, 4], [17, 2]]) {
      const i = (y * W + x) * 4;
      expect(halfToFloat(half[i])).toBeCloseTo(2.5 + x, 1);
      expect(halfToFloat(half[i + 1])).toBeCloseTo(0.25, 3);
      expect(halfToFloat(half[i + 2])).toBeCloseTo(-0.5, 3);
      expect(halfToFloat(half[i + 3])).toBeCloseTo(y / 4, 3);
    }
    gpu.release(img.texture);
  });

  it('converts an 8-bit image up (value / 255, premultiplied like the engine holds it)', async () => {
    const gpu = await testGpu();
    const data = new Uint8Array([255, 0, 0, 255, 0, 128, 255, 128, 10, 20, 30, 0, 200, 100, 50, 255]);
    const img = gpu.upload(data, 2, 2, 1, true);
    const half = await gpu.readFloat(img);
    const raw = await gpu.readRaw(img);
    expect(half.length).toBe(16);
    for (let i = 0; i < 16; i++) expect(halfToFloat(half[i])).toBeCloseTo(raw[i] / 255, 2);
    expect(halfToFloat(half[0])).toBe(1);
    expect(halfToFloat(half[3])).toBe(1);
  });
});
