/** The CLI's own-encoder routes (no FFmpeg), the `formats` listing and the unchanged existing still formats. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Gpu } from '../../engine/gpu/gpu';
import { testGpu } from '../../engine/testing';
import { decompressDxt } from '../../io/encoders/dxt';
import { snappyDecode } from '../../io/encoders/snappy';
import { parseBoxes, readMov, videoSamples } from '../../io/encoders/test-helpers';
import { WIRED_ROWS } from '../../io/export-codecs';
import { CODECS, parseCodec } from '../encode';
import { formatText, listFormats } from '../formats';
import { renderGraphBatch } from '../render';
import { builtinRegistry, chain, readRaw, tempDir } from './testkit';

const registry = builtinRegistry();
let gpu: Gpu;
beforeAll(async () => {
  gpu = await testGpu();
}, 60_000);

function shapeGraph(outParams: Record<string, unknown>, project: Record<string, unknown> = {}) {
  return chain(registry, [{ type: 'shape', params: { kind: 'rect', width: 0.6, height: 0.6, fill: [1, 0, 0, 0.5] } }], { width: 64, height: 48, fps: 10, duration: 0.3, ...project }, outParams).graph;
}

async function render(outParams: Record<string, unknown>, overrides: Parameters<typeof renderGraphBatch>[0]['overrides'] = {}) {
  const dir = tempDir('rsmps-fmt-');
  const summary = await renderGraphBatch({ graph: shapeGraph(outParams), registry, outDir: dir, overrides, sequenceFps: 10, gpu });
  expect(summary.errors).toEqual([]);
  return { dir, files: summary.files };
}

describe('existing still formats are unchanged', () => {
  it('PNG, JPEG and WebP files are byte-identical to what sharp makes of the same pixels (the pre-registry behavior)', async () => {
    const px = await (async () => {
      const r = await render({ kind: 'image', imageFormat: 'png', name: 'ref' });
      return readRaw(join(r.dir, 'ref.png'));
    })();
    for (const [fmt, ext] of [['png', 'png'], ['webp', 'webp'], ['jpeg', 'jpg']] as const) {
      const r = await render({ kind: 'image', imageFormat: fmt, name: 'g' });
      const got = readFileSync(join(r.dir, `g.${ext}`));
      const rgba = Buffer.from(px.data);
      let img = sharp(rgba, { raw: { width: px.width, height: px.height, channels: 4 } });
      if (fmt === 'png') img = img.png({ compressionLevel: 6 });
      else if (fmt === 'webp') img = img.webp({ quality: 92, alphaQuality: 100 });
      else {
        // JPEG is written from premultiplied (over black) pixels
        const over = Buffer.from(px.data);
        for (let i = 0; i < over.length; i += 4) for (let c = 0; c < 3; c++) over[i + c] = Math.round((over[i + c] * over[i + 3]) / 255);
        img = sharp(over, { raw: { width: px.width, height: px.height, channels: 4 } }).removeAlpha().jpeg({ quality: 92, mozjpeg: true });
      }
      const want = await img.toBuffer();
      expect(Buffer.compare(got, want), fmt).toBe(0);
    }
  });
});

describe('formats the app writes itself, through the CLI render path', () => {
  it('HAP through the GPU compressor: a streamed MOV (moov at the end) with 3 frames, premultiplied over black', async () => {
    const r = await render({ kind: 'video', codec: 'hap', name: 'clip' });
    expect(r.files).toEqual(['clip.mov']);
    const file = new Uint8Array(readFileSync(join(r.dir, 'clip.mov')));
    expect(parseBoxes(file).map((b) => b.type)).toEqual(['ftyp', 'mdat', 'moov']);
    const mov = readMov(file);
    expect(mov.tracks[0]).toMatchObject({ fourcc: 'Hap1', width: 64, height: 48 });
    expect(mov.tracks[0].sizes).toHaveLength(3);
    const s = videoSamples(file, mov.tracks[0])[0];
    const type = s[3];
    const body = (type & 0xf0) === 0xb0 ? snappyDecode(s.subarray(4)) : s.subarray(4);
    const px = decompressDxt(body, 64, 48, 'Hap1');
    const mid = (24 * 64 + 32) * 4;
    expect(px[mid]).toBeGreaterThan(110);
    expect(px[mid]).toBeLessThan(150);
  });

  it('--codec hap-alpha / hap-q / png / raw-mov / mjpeg (sharp) / gif / apng need no FFmpeg and parse by id', async () => {
    for (const id of ['hap-alpha', 'hap-q', 'png', 'raw-mov', 'mjpeg', 'gif', 'apng']) {
      expect(CODECS[parseCodec(id)!].route, id).toBe('own');
      const r = await render({ kind: 'video', name: 'c' }, { codec: CODECS[id] });
      expect(statSync(join(r.dir, r.files[0])).size, id).toBeGreaterThan(100);
    }
    const mj = await render({ kind: 'video', name: 'm' }, { codec: CODECS.mjpeg });
    const m = readMov(new Uint8Array(readFileSync(join(mj.dir, 'm.mov'))));
    expect(m.tracks[0].fourcc).toBe('jpeg');
    expect(m.tracks[0].sizes).toHaveLength(3);
  });

  it('still formats: signature, extension and a frame sequence with the name tokens; float formats written linear', async () => {
    for (const [fmt, ext] of [['qoi', 'qoi'], ['tiff', 'tif'], ['tga', 'tga'], ['bmp', 'bmp'], ['ppm', 'ppm'], ['ico', 'ico'], ['exr', 'exr'], ['hdr', 'hdr'], ['tiff16', 'tif']] as const) {
      const r = await render({ kind: 'image', imageFormat: fmt, name: 's' });
      expect(r.files, fmt).toEqual([`s.${ext}`]);
    }
    const seq = await render({ kind: 'sequence', imageFormat: 'exr', name: 'f_{frame}' });
    expect(seq.files.map((f) => f.split('/').pop())).toEqual(['f_0000.exr', 'f_0001.exr', 'f_0002.exr']);
    expect(readdirSync(join(seq.dir, seq.files[0].split('/')[0]))).toHaveLength(3);
  });
});

describe('the formats listing', () => {
  it('lists every registry row with its route and availability here; own rows are always available', async () => {
    const { formats, ffmpeg } = await listFormats();
    expect(formats).toHaveLength(WIRED_ROWS.length);
    for (const f of formats) if (f.route === 'own') expect(f.available, f.id).toBe(true);
    for (const id of ['hap', 'hap-alpha', 'hap-q', 'mjpeg', 'png', 'raw-mov', 'gif', 'apng', 'qoi', 'exr', 'wav', 'flac']) expect(formats.find((f) => f.id === id)!.via, id).toBe('own');
    expect(formats.find((f) => f.id === 'png-image')!.via).toBe('sharp');
    const text = formatText(formats, ffmpeg);
    expect(text).toMatch(/hap-alpha\s+HAP Alpha\s+mov\s+own\s+yes \(own\)/);
    expect(text).toMatch(/written by the app itself/);
  });
});
