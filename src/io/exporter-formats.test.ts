/**
 * The app exporter's own-encoder routes (HAP, PNG / uncompressed MOV, GIF, APNG, QOI, TIFF, OpenEXR ..., AIFF / FLAC sound) on the real
 * headless GPU. None of these needs a canvas: pixels are read back from the GPU and encoded by src/io/encoders.
 */
import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../engine/graph';
import { harness } from '../engine/testing';
import type { GraphDoc } from '../engine/types';
import type { ExportRequest } from './api';
import { decompressDxt } from './encoders/dxt';
import { snappyDecode } from './encoders/snappy';
import { parseBoxes, readMov, videoSamples } from './encoders/test-helpers';
import { ExporterImpl } from './exporter';
import { EvalGate } from './gate';

type Out = { name: string; blob: Blob; savedPath?: string };

/** One half transparent red ellipse on a transparent canvas: the case where straight and premultiplied colors differ. */
async function setup(outParams: Record<string, unknown>, o: { w?: number; h?: number; frames?: number; audio?: boolean } = {}) {
  const t = await harness();
  const w = o.w ?? 64;
  const h = o.h ?? 48;
  const fps = 10;
  let g: GraphDoc = createGraph('hero');
  g = { ...g, project: { ...g.project, width: w, height: h, fps, duration: (o.frames ?? 3) / fps, loop: true, lengthMode: 'absolute' } };
  const shape = addNode(g, t.registry, 'shape', { x: 0, y: 0 }, { kind: 'rect', width: 0.6, height: 0.6, fill: [1, 0, 0, 0.5] });
  const out = addNode(shape.graph, t.registry, 'image-out', { x: 0, y: 0 }, { name: 'clip', kind: 'video', ...outParams });
  g = connect(out.graph, t.registry, { node: shape.node.id, port: 'image' }, { node: out.node.id, port: 'image' });
  const library = { exact: false, setFrameBudget: () => 0, assetInfo: () => null };
  const pcm = o.audio ? { sampleRate: 48000, channels: [Float32Array.from({ length: 48000 * ((o.frames ?? 3) / fps) }, (_, i) => Math.sin(i / 30) * 0.3)] } : null;
  const audio = { hasSignals: () => false, hasExportAudio: () => !!pcm, renderOffline: async () => pcm };
  const exporter = new ExporterImpl({ gpu: t.gpu, gate: new EvalGate(t.engine), registry: t.registry, library, audio } as never);
  const req: ExportRequest = { graph: g, outputs: [out.node.id], items: 'current', item: 0, zip: false };
  const run = async (): Promise<Out[]> => (exporter as unknown as { run(r: ExportRequest): Promise<Out[]> }).run(req);
  return { run, req, w, h };
}

const bytesOf = async (f: Out) => new Uint8Array(await f.blob.arrayBuffer());

/** The texture of one HAP sample: [format code, blocks]. */
function unhap(frame: Uint8Array): { code: number; tex: Uint8Array } {
  let size = frame[0] | (frame[1] << 8) | (frame[2] << 16);
  let at = 4;
  if (size === 0) {
    size = frame[4] | (frame[5] << 8) | (frame[6] << 16) | (frame[7] << 24);
    at = 8;
  }
  const type = frame[3];
  const body = frame.subarray(at, at + size);
  return { code: type & 0x0f, tex: (type & 0xf0) === 0xb0 ? snappyDecode(body) : body };
}

describe('app exporter: HAP', () => {
  it('HAP (no alpha) puts the half transparent picture over black; HAP Alpha keeps straight color and alpha; GPU path', async () => {
    const opaque = await setup({ codec: 'hap', hapSnappy: true });
    const a = await opaque.run();
    expect(a.map((f) => f.name)).toEqual(['clip.mov']); // no errors.txt: nothing to report
    const file = await bytesOf(a[0]);
    expect(parseBoxes(file).map((b) => b.type)).toEqual(['ftyp', 'mdat', 'moov']); // streamed: index at the end
    const mov = readMov(file);
    expect(mov.tracks[0]).toMatchObject({ fourcc: 'Hap1', width: 64, height: 48 });
    expect(mov.tracks[0].sizes).toHaveLength(3);
    const first = unhap(videoSamples(file, mov.tracks[0])[0]);
    expect(first.code).toBe(0x0b);
    const px = decompressDxt(first.tex, 64, 48, 'Hap1');
    const mid = (24 * 64 + 32) * 4;
    // red at alpha 0.5 composited over black is about 128, never 255 (that would be the straight color)
    expect(px[mid]).toBeGreaterThan(110);
    expect(px[mid]).toBeLessThan(150);
    expect(px[mid + 1]).toBeLessThan(10);
    expect(px[0]).toBeLessThan(10); // the transparent corner is black

    const alpha = await setup({ codec: 'hap_alpha', hapSnappy: false });
    const b = await alpha.run();
    const file5 = await bytesOf(b[0]);
    const m5 = readMov(file5);
    expect(m5.tracks[0].fourcc).toBe('Hap5');
    const f5 = unhap(videoSamples(file5, m5.tracks[0])[0]);
    expect(f5.code).toBe(0x0e);
    const p5 = decompressDxt(f5.tex, 64, 48, 'Hap5');
    expect(p5[mid]).toBeGreaterThan(240); // straight red
    expect(Math.abs(p5[mid + 3] - 128)).toBeLessThan(12); // alpha 0.5
    expect(p5[3]).toBeLessThan(8); // transparent corner
  });

  it('HapQ works and the "Better" quality (CPU refinement) is selectable; 4K-style odd sizes need no padding', async () => {
    const q = await setup({ codec: 'hap_q', hapQuality: 'better' }, { w: 45, h: 27, frames: 2 });
    const f = await q.run();
    const file = await bytesOf(f[0]);
    const mov = readMov(file);
    expect(mov.tracks[0]).toMatchObject({ fourcc: 'HapY', width: 45, height: 27 });
    expect(mov.tracks[0].sizes).toHaveLength(2);
  });

  it('muxes PCM sound into the MOV and writes a plain size for the audio samples', async () => {
    const s = await setup({ codec: 'hap' }, { frames: 5, audio: true });
    const f = await s.run();
    const mov = readMov(await bytesOf(f[0]));
    expect(mov.tracks.map((t) => t.handler)).toEqual(['vide', 'soun']);
    expect(mov.tracks[1].fourcc).toBe('sowt');
    expect(mov.tracks[1].duration).toBe(24000); // 0.5 s at 48 kHz
  });
});

describe('app exporter: lossless MOV, GIF, APNG', () => {
  it('PNG MOV keeps straight alpha, uncompressed MOV is ARGB, both with the right frame count', async () => {
    const p = await setup({ codec: 'png-mov' });
    const mp = readMov(await bytesOf((await p.run())[0]));
    expect(mp.tracks[0]).toMatchObject({ fourcc: 'png ', width: 64, height: 48 });
    expect(mp.tracks[0].sizes).toHaveLength(3);
    const r = await setup({ codec: 'raw-mov' });
    const file = await bytesOf((await r.run())[0]);
    const mr = readMov(file);
    expect(mr.tracks[0].fourcc).toBe('raw ');
    const px = videoSamples(file, mr.tracks[0])[0];
    const mid = (24 * 64 + 32) * 4;
    // QuickTime 32-bit order is A R G B: straight red at alpha 0.5
    expect(Math.abs(px[mid] - 128)).toBeLessThan(3);
    expect([px[mid + 1], px[mid + 2], px[mid + 3]]).toEqual([255, 0, 0]);
    expect(px[0]).toBe(0); // transparent corner
  });

  it('GIF and APNG are written without FFmpeg or a canvas', async () => {
    const g = await setup({ codec: 'gif', gifDither: 'none', gifColors: 16, gifLoop: 2 });
    const gif = await bytesOf((await g.run())[0]);
    expect(String.fromCharCode(...gif.subarray(0, 6))).toBe('GIF89a');
    const a = await setup({ codec: 'apng' });
    const files = await a.run();
    expect(files[0].name).toBe('clip.png');
    const png = await bytesOf(files[0]);
    expect(Array.from(png.subarray(1, 4))).toEqual([0x50, 0x4e, 0x47]);
    expect(new TextDecoder('latin1').decode(png).includes('acTL')).toBe(true);
  });
});

describe('app exporter: still formats written by the app', () => {
  const magic: Record<string, (b: Uint8Array) => boolean> = {
    qoi: (b) => String.fromCharCode(...b.subarray(0, 4)) === 'qoif',
    tiff: (b) => b[0] === 0x49 && b[1] === 0x49 && b[2] === 42,
    tiff16: (b) => b[0] === 0x49 && b[1] === 0x49 && b[2] === 42,
    bmp: (b) => b[0] === 0x42 && b[1] === 0x4d,
    ppm: (b) => String.fromCharCode(...b.subarray(0, 2)) === 'P6',
    ico: (b) => b[0] === 0 && b[2] === 1,
    exr: (b) => b[0] === 0x76 && b[1] === 0x2f && b[2] === 0x31 && b[3] === 0x01,
    hdr: (b) => String.fromCharCode(...b.subarray(0, 10)) === '#?RADIANCE',
  };
  for (const fmt of Object.keys(magic)) {
    it(`${fmt}: one still file with the right name and signature`, async () => {
      const s = await setup({ kind: 'image', imageFormat: fmt, name: 'still_{width}x{height}' });
      const files = await s.run();
      expect(files).toHaveLength(1);
      expect(files[0].name).toMatch(/^still_64x48\.(qoi|tif|bmp|ppm|ico|exr|hdr)$/);
      expect(magic[fmt](await bytesOf(files[0]))).toBe(true);
    });
  }

  it('an image sequence in an own format writes one file per frame with the name tokens', async () => {
    const s = await setup({ kind: 'sequence', imageFormat: 'qoi', name: 'f_{frame}' });
    const files = await s.run();
    expect(files.map((f) => f.name)).toEqual(['f_0000.qoi', 'f_0001.qoi', 'f_0002.qoi']);
  });
});

describe('app exporter: sound files', () => {
  it('writes AIFF and FLAC from the Audio Output, default 32-bit float WAV', async () => {
    const t = await harness();
    let g: GraphDoc = createGraph('snd');
    g = { ...g, project: { ...g.project, width: 8, height: 8, fps: 10, duration: 0.5, loop: true, lengthMode: 'absolute' } };
    const ao = addNode(g, t.registry, 'audio-out', { x: 0, y: 0 }, {});
    const pcm = { sampleRate: 48000, channels: [Float32Array.from({ length: 24000 }, (_, i) => Math.sin(i / 20) * 0.5)] };
    const audio = { hasSignals: () => false, hasExportAudio: () => true, renderOffline: async () => pcm };
    const library = { exact: false, setFrameBudget: () => 0, assetInfo: () => null };
    const exporter = new ExporterImpl({ gpu: t.gpu, gate: new EvalGate(t.engine), registry: t.registry, library, audio } as never);
    const run = (patch: Record<string, unknown>) => {
      const graph = { ...ao.graph, nodes: ao.graph.nodes.map((n) => (n.id === ao.node.id ? { ...n, params: { ...n.params, ...patch } } : n)) };
      return (exporter as unknown as { run(r: ExportRequest): Promise<Out[]> }).run({ graph, outputs: [ao.node.id], items: 'current', item: 0, zip: false });
    };
    const wav = await run({});
    expect(wav.map((f) => f.name)).toEqual(['snd.wav']);
    const wb = await bytesOf(wav[0]);
    expect(String.fromCharCode(...wb.subarray(0, 4))).toBe('RIFF');
    expect(new DataView(wb.buffer, wb.byteOffset).getUint16(34, true)).toBe(32);
    const w16 = await run({ soundFormat: 'wav' });
    expect(new DataView((await bytesOf(w16[0])).buffer).getUint16(34, true)).toBe(16);
    const aiff = await run({ soundFormat: 'aiff24' });
    expect(aiff[0].name).toBe('snd.aiff');
    expect(String.fromCharCode(...(await bytesOf(aiff[0])).subarray(0, 4))).toBe('FORM');
    const flac = await run({ soundFormat: 'flac' });
    expect(flac[0].name).toBe('snd.flac');
    expect(String.fromCharCode(...(await bytesOf(flac[0])).subarray(0, 4))).toBe('fLaC');
    // a format that needs FFmpeg and has none: WAV, with a note
    const mp3 = await run({ soundFormat: 'mp3' });
    expect(mp3.map((f) => f.name).sort()).toEqual(['errors.txt', 'snd.wav']);
    expect(await mp3.find((f) => f.name === 'errors.txt')!.blob.text()).toMatch(/MP3/);
  });
});
