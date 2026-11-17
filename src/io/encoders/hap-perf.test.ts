import { expect, it } from 'vitest';
import { testGpu } from '../../engine/testing';
import { compressDxt, dxtFrameBytes, type DxtFormat } from './dxt';
import { hapFrame } from './hap';
import { createHapGpuCompressor } from './hap-gpu';
import { makePicture, rng } from './test-helpers';

/** Measurement, not a gate: prints ms per 1920x1080 frame and bytes per frame. Loose upper bounds only. */
it('HAP speed and size at 1920x1080', async () => {
  const W = 1920;
  const H = 1080;
  // A photo-like picture: smooth gradient plus mild noise and some hard edges.
  const g = makePicture('gradient', W, H);
  const e = makePicture('edges', W, H);
  const r = rng(9);
  const src = new Uint8Array(W * H * 4);
  for (let i = 0; i < src.length; i++) src[i] = i % 4 === 3 ? 255 : Math.max(0, Math.min(255, ((i >> 2) % 7 === 0 ? e[i] : g[i]) + (r() - 0.5) * 12));
  const gpu = await testGpu();
  const img = gpu.upload(src, W, H, 1, true);
  const lines: string[] = [];
  for (const fmt of ['Hap1', 'Hap5', 'HapY'] as DxtFormat[]) {
    const out = new Uint8Array(dxtFrameBytes(W, H, fmt));
    for (const refine of [0, 2]) {
      compressDxt(src, W, H, fmt, out, { refine });
      const t0 = performance.now();
      const n = 3;
      for (let i = 0; i < n; i++) compressDxt(src, W, H, fmt, out, { refine });
      lines.push(`${fmt} CPU refine ${refine}: ${((performance.now() - t0) / n).toFixed(1)} ms/frame`);
    }
    const comp = createHapGpuCompressor(gpu, W, H, fmt);
    await comp.compress(img);
    const t0 = performance.now();
    const n = 10;
    for (let i = 0; i < n; i++) await comp.compress(img);
    lines.push(`${fmt} GPU (incl. readback): ${((performance.now() - t0) / n).toFixed(1)} ms/frame`);
    const tex = comp.bytes;
    comp.dispose();
    compressDxt(src, W, H, fmt, out, { refine: 2 });
    const t1 = performance.now();
    const snap = hapFrame(out, fmt, true).length;
    lines.push(`${fmt} bytes/frame: none ${hapFrame(out, fmt, false).length} (texture ${tex}), snappy ${snap} (snappy took ${(performance.now() - t1).toFixed(1)} ms)`);
    expect(snap).toBeLessThanOrEqual(tex + 4);
  }
  console.log('\n' + lines.join('\n'));
}, 120000);

it('other encoders: ms per 1920x1080 frame and size', async () => {
  const { beginGif } = await import('./gif');
  const { beginApng } = await import('./apng');
  const { encodeQoi } = await import('./qoi');
  const { encodeTga, encodeBmp } = await import('./stills');
  const { encodeTiff } = await import('./tiff');
  const { encodeExr } = await import('./float');
  const { beginPngMov } = await import('./mov-codecs');
  const W = 1920;
  const H = 1080;
  const art = makePicture('pixelart', W, H);
  const photo = makePicture('gradient', W, H);
  const r = rng(4);
  for (let i = 0; i < photo.length; i += 4) for (let c = 0; c < 3; c++) photo[i + c] = Math.max(0, Math.min(255, photo[i + c] + (r() - 0.5) * 10));
  const lines: string[] = [];
  const time = async (name: string, fn: () => unknown | Promise<unknown>, size: (x: unknown) => number) => {
    const t0 = performance.now();
    const out = await fn();
    lines.push(`${name}: ${(performance.now() - t0).toFixed(0)} ms, ${(size(out) / 1024).toFixed(0)} KiB`);
  };
  const len = (x: unknown) => (x as Uint8Array).length;
  await time('QOI pixel art', () => encodeQoi(art, W, H), len);
  await time('QOI photo', () => encodeQoi(photo, W, H), len);
  await time('TGA RLE photo', () => encodeTga(photo, W, H, { rle: true }), len);
  await time('BMP photo', () => encodeBmp(photo, W, H), len);
  await time('TIFF deflate photo', () => encodeTiff(photo, W, H, { compression: 'deflate' }), len);
  await time('EXR zip photo', () => encodeExr(Float32Array.from(photo, (v) => v / 255), W, H), len);
  await time('PNG-in-MOV frame', async () => { const s = beginPngMov({ width: W, height: H }); await s.addFrame(photo); return (await s.finish()).reduce((n, p) => n + p.length, 0); }, (x) => x as number);
  await time('GIF pixel art frame (exact)', async () => { const s = beginGif({ width: W, height: H }); s.addFrame(art); return (await s.finish()).reduce((n, p) => n + p.length, 0); }, (x) => x as number);
  await time('GIF photo frame (median cut, floyd)', async () => { const s = beginGif({ width: W, height: H, dither: 'floyd' }); s.addFrame(photo); return (await s.finish()).reduce((n, p) => n + p.length, 0); }, (x) => x as number);
  await time('APNG photo frame', async () => { const s = beginApng({ width: W, height: H }); s.addFrame(photo); return (await s.finish()).reduce((n, p) => n + p.length, 0); }, (x) => x as number);
  console.log('\n' + lines.join('\n'));
}, 240000);
