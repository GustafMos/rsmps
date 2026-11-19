import { describe, expect, it } from 'vitest';
import { testGpu } from '../engine/testing';
import { optionalFeatures, requestDeviceWithExtras } from '../engine/gpu/gpu';
import { compressDxt, dxtFrameBytes } from './encoders/dxt';
import { makePicture } from './encoders/test-helpers';
import { hapTextureBytes, hapToRgba, type HapFrame } from './hap';
import { HAP_FFMPEG, ffmpegDecode, makeHapClip, pictureDiff } from './hap-test-helpers';
import { HapPresenter, HapReader, canUploadBc } from './hap-video';

/** Straight RGBA premultiplied the way the engine stores pictures. */
function premultiplied(straight: Uint8Array): Uint8Array {
  const out = new Uint8Array(straight.length);
  for (let i = 0; i < straight.length; i += 4) {
    const a = straight[i + 3];
    for (let c = 0; c < 3; c++) out[i + c] = Math.round((straight[i + c] * a) / 255);
    out[i + 3] = a;
  }
  return out;
}

function frameOf(fmt: 'Hap1' | 'Hap5' | 'HapY', src: Uint8Array, w: number, h: number): HapFrame {
  const data = new Uint8Array(dxtFrameBytes(w, h, fmt));
  compressDxt(src, w, h, fmt, data);
  return { format: fmt === 'Hap1' ? 'bc1' : fmt === 'Hap5' ? 'bc3' : 'ycocg-bc3', data };
}

/** A device stand-in without BC textures: the presenter must then take the CPU path. */
function withoutBc<T extends { device: GPUDevice }>(gpu: T): T {
  const device = new Proxy(gpu.device, {
    get: (d, k) => {
      if (k === 'features') return { has: () => false };
      const v = Reflect.get(d, k, d) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v;
    },
  });
  return new Proxy(gpu, { get: (g, k) => (k === 'device' ? device : (Reflect.get(g, k, g) as unknown)) });
}

describe('optional device features', () => {
  const adapter = (has: string[], fail = false) => {
    const asked: (GPUDeviceDescriptor | undefined)[] = [];
    return {
      asked,
      features: { has: (n: string) => has.includes(n) },
      requestDevice: async (d?: GPUDeviceDescriptor) => {
        asked.push(d);
        if (fail && d?.requiredFeatures) throw new TypeError('unsupported feature');
        return {} as GPUDevice;
      },
    };
  };
  it('asks for BC textures only when the adapter has them', async () => {
    const plain = adapter(['depth-clip-control']);
    expect(optionalFeatures(plain)).toEqual([]);
    await requestDeviceWithExtras(plain);
    expect(plain.asked).toEqual([undefined]); // exactly the request the app made before this feature existed
    const desktop = adapter(['texture-compression-bc', 'float32-filterable']);
    await requestDeviceWithExtras(desktop);
    expect(desktop.asked).toEqual([{ requiredFeatures: ['texture-compression-bc'] }]);
  });
  it('falls back to a plain device when asking for the extras fails', async () => {
    const odd = adapter(['texture-compression-bc'], true);
    await requestDeviceWithExtras(odd);
    expect(odd.asked).toEqual([{ requiredFeatures: ['texture-compression-bc'] }, undefined]);
  });
});

describe('HAP frames on the GPU', () => {
  const W = 46; // not a multiple of 4: the texture is padded, the picture must not show the padding
  const H = 30;

  for (const path of ['bc', 'cpu'] as const) {
    for (const fmt of ['Hap1', 'Hap5', 'HapY'] as const) {
      it(`${fmt} through the ${path === 'bc' ? 'graphics card (BC texture)' : 'CPU decoder'}: same picture as the reference decode, premultiplied, top row first`, async (ctx) => {
        const real = await testGpu();
        if (path === 'bc' && !canUploadBc(real.device)) return ctx.skip(); // this GPU cannot read BC textures
        const gpu = path === 'bc' ? real : withoutBc(real);
        const presenter = new HapPresenter(gpu);
        const src = makePicture(fmt === 'Hap5' ? 'alpha' : 'gradient', W, H, 2);
        // a marker in the top-left corner: catches a picture that comes out upside down
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) src.set([255, 255, 255, 255], (y * W + x) * 4);
        const frame = frameOf(fmt, src, W, H);
        const want = premultiplied(hapToRgba(frame, W, H));
        const got = await gpu.scopedAsync(async () => {
          const tex = presenter.present(frame, W, H, W, H);
          expect([tex.width, tex.height, tex.format]).toEqual([W, H, 'rgba8unorm']);
          return new Uint8Array(await real.readRaw({ texture: tex, width: W, height: H }));
        });
        const d = pictureDiff(got, want);
        // graphics cards round the in-between colours of a block a little differently from the CPU decoder
        expect(d.max).toBeLessThanOrEqual(path === 'bc' ? 6 : 0);
        expect(d.mean).toBeLessThan(1);
        expect(got[0]).toBeGreaterThan(240); // the marker is at the top
        expect(got[(H - 1) * W * 4 + 2]).toBeLessThan(200);
        presenter.dispose();
      });
    }

    it(`${path}: a smaller output is the picture scaled down, without the padding leaking in`, async (ctx) => {
      const real = await testGpu();
      if (path === 'bc' && !canUploadBc(real.device)) return ctx.skip();
      const gpu = path === 'bc' ? real : withoutBc(real);
      const presenter = new HapPresenter(gpu);
      const w = 62;
      const h = 30;
      const src = new Uint8Array(w * h * 4);
      for (let i = 0; i < src.length; i += 4) src.set([200, 100, 50, 255], i); // one flat colour: any padding (black) would darken the edge
      const frame = frameOf('Hap1', src, w, h);
      const got = await gpu.scopedAsync(async () => {
        const tex = presenter.present(frame, w, h, 31, 15);
        expect([tex.width, tex.height]).toEqual([31, 15]);
        return new Uint8Array(await real.readRaw({ texture: tex, width: 31, height: 15 }));
      });
      for (let i = 0; i < got.length; i += 4) {
        expect(Math.abs(got[i] - 200)).toBeLessThanOrEqual(6);
        expect(Math.abs(got[i + 1] - 100)).toBeLessThanOrEqual(6);
        expect(Math.abs(got[i + 2] - 50)).toBeLessThanOrEqual(6);
        expect(got[i + 3]).toBe(255);
      }
      presenter.dispose();
    });
  }

  it('HAP Q Alpha: the separate alpha texture is used, on both paths', async () => {
    const real = await testGpu();
    const src = makePicture('alpha', W, H);
    const colour = frameOf('HapY', src, W, H);
    const dxt5 = frameOf('Hap5', src, W, H).data;
    const alpha = new Uint8Array(hapTextureBytes('bc4', W, H));
    for (let b = 0; b < alpha.length / 8; b++) alpha.set(dxt5.subarray(b * 16, b * 16 + 8), b * 8);
    const frame: HapFrame = { ...colour, alpha };
    const want = premultiplied(hapToRgba(frame, W, H));
    expect(want[3]).toBe(0);
    for (const gpu of [...(canUploadBc(real.device) ? [real] : []), withoutBc(real)]) {
      const presenter = new HapPresenter(gpu);
      const got = await gpu.scopedAsync(async () => new Uint8Array(await real.readRaw({ texture: presenter.present(frame, W, H, W, H), width: W, height: H })));
      const d = pictureDiff(got, want);
      expect(d.max).toBeLessThanOrEqual(6);
      expect(d.mean).toBeLessThan(1);
      presenter.dispose();
    }
  });

  it('BC7 without a card that reads it is refused in plain words', async () => {
    const gpu = withoutBc(await testGpu());
    const presenter = new HapPresenter(gpu);
    expect(() => presenter.present({ format: 'bc7', data: new Uint8Array(hapTextureBytes('bc7', 8, 8)) }, 8, 8, 8, 8)).toThrow(/graphics card/);
  });
});

describe.skipIf(!HAP_FFMPEG)('HAP files written by FFmpeg, read and shown', () => {
  it('finds each frame by time, any order, and shows what FFmpeg decodes', async () => {
    const w = 128;
    const h = 72;
    const file = makeHapClip({ format: 'hap_q', width: w, height: h, frames: 5, chunks: 4, sound: true });
    const theirs = ffmpegDecode(file);
    const reader = new HapReader(new Blob([file as BlobPart]));
    await reader.init();
    expect([reader.fourcc, reader.width, reader.height]).toEqual(['HapY', w, h]);
    const gpu = await testGpu();
    const presenter = new HapPresenter(gpu);
    // 25 frames a second: frame n covers [n/25, (n+1)/25); asked out of order on purpose (every frame stands alone)
    for (const [t, n] of [[0.17, 4], [0, 0], [0.09, 2], [0.0401, 1], [99, 4], [-1, 0]] as const) {
      const place = await reader.locate(t);
      expect(place, `t=${t}`).not.toBeNull();
      expect(Math.round(place!.packet.timestamp * 25)).toBe(n);
      if (n === 4) expect(place!.end).toBe(Infinity);
      else expect(place!.end).toBeCloseTo((n + 1) / 25, 6);
      const frame = await reader.read(place!);
      const got = await gpu.scopedAsync(async () => new Uint8Array(await gpu.readRaw({ texture: presenter.present(frame, w, h, w, h), width: w, height: h })));
      const d = pictureDiff(got, theirs.subarray(n * w * h * 4, (n + 1) * w * h * 4));
      expect(d.max, `frame ${n}`).toBeLessThanOrEqual(8);
      expect(d.mean, `frame ${n}`).toBeLessThan(1.5);
    }
    presenter.dispose();
    reader.dispose();
  });

  it('a file that is not HAP is refused, so the caller can use the ordinary video path', async () => {
    const reader = new HapReader(new Blob([new Uint8Array(64)]));
    await expect(reader.init()).rejects.toThrow();
    reader.dispose();
  });
});
