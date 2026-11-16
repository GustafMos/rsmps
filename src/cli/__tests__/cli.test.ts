import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { testGpu } from '../../engine/testing';
import type { Gpu } from '../../engine/gpu/gpu';
import { CODECS, parseCodec } from '../encode';
import { NodeHost } from '../host';
import { expandInputs } from '../media';
import { assignInputs, applyOverrides, parseItemRange, parseSize } from '../prepare';
import { parseArgs } from '../args';
import { renderGraphBatch } from '../render';
import { builtinRegistry, chain, ffmpegBin, ffmpegSync, readRaw, setParam, tempDir, writeSprite } from './testkit';

const registry = builtinRegistry();
let gpu: Gpu;
let ffmpeg: string | null = null;

beforeAll(async () => {
  gpu = await testGpu();
  ffmpeg = await ffmpegBin();
  if (!ffmpeg) console.warn('[cli2 tests] ffmpeg not found: video tests are skipped');
}, 60_000);

async function withAnimate(extraOut: Record<string, unknown> = {}) {
  const { addNode, connect } = await import('./testkit');
  const c = chain(registry, [{ type: 'shape', params: { kind: 'ellipse', width: 0.4, height: 0.5, fill: [1, 0, 0, 1] } }], { width: 64, height: 48, fps: 12, duration: 1 }, extraOut);
  const graph = c.graph;
  const shapeId = c.ids[0];
  const added = addNode(graph, registry, 'animate', { x: 0, y: 0 }, { from: 0.3, to: 0.7, wave: 'sine' });
  return connect(added.graph, registry, { node: added.node.id, port: 'value' }, { node: shapeId, port: 'x' });
}

describe('pure helpers', () => {
  it('parses item ranges (1-based, open ended)', () => {
    expect(parseItemRange('1-3,7', 10)).toEqual([0, 1, 2, 6]);
    expect(parseItemRange('8-', 10)).toEqual([7, 8, 9]);
    expect(() => parseItemRange('0', 10)).toThrow();
  });
  it('parses sizes, codecs and args', () => {
    expect(parseSize('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(() => parseSize('big')).toThrow();
    expect(parseCodec('prores4444')).toBe('prores4444');
    expect(parseCodec('AVC')).toBe('h264');
    expect(CODECS.prores4444.args(0).join(' ')).toContain('yuva444p10le');
    const p = parseArgs(['g.json', 'a.png', '--input', 'x=a', 'b', '--set', 'a.b=1', '--set=c.d=2', '-q'], {
      input: { value: true, repeat: true, greedy: true },
      set: { value: true, repeat: true },
      quiet: { alias: 'q' },
    });
    expect(p.positionals).toEqual(['g.json', 'a.png']);
    expect(p.values.get('input')).toEqual(['x=a', 'b']);
    expect(p.values.get('set')).toEqual(['a.b=1', 'c.d=2']);
    expect(p.flags.has('quiet')).toBe(true);
  });
  it('expands files, folders and globs', async () => {
    const dir = tempDir();
    await writeSprite(join(dir, 'a1.png'), 8, 8, '#f00');
    await writeSprite(join(dir, 'a10.png'), 8, 8, '#f00');
    await writeSprite(join(dir, 'a2.png'), 8, 8, '#f00');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    expect(expandInputs([dir]).map((f) => f.split(/[\\/]/).pop())).toEqual(['a1.png', 'a2.png', 'a10.png']);
    expect(expandInputs([join(dir, 'a?.png')]).length).toBe(2);
    expect(expandInputs([join(dir, '*.{png,txt}')]).length).toBe(3); // the .txt is not media
    expect(() => expandInputs([join(dir, 'zzz*.png')])).toThrow(/matched nothing/);
  });
  it('--set and inputs modify the graph', () => {
    const c = chain(registry, [{ type: 'media-in', label: 'Sprites' }, { type: 'outline', label: 'Edge' }]);
    const g = applyOverrides(c.graph, registry, { size: '10x20', fps: 6, sets: ['Edge.thickness=7', 'Out.name="{name}_x"'] });
    expect(g.project).toMatchObject({ width: 10, height: 20, fps: 6 });
    expect(g.nodes.find((n) => n.label === 'Edge')!.params.thickness).toBe(7);
    expect(() => applyOverrides(c.graph, registry, { sets: ['Edge.nope=1'] })).toThrow(/no param/);
    const dir = tempDir();
    writeFileSync(join(dir, 'x.png'), '');
    const a = assignInputs(c.graph, registry, { positional: [join(dir, 'x.png')], targeted: [] });
    expect(a.graph.nodes.find((n) => n.label === 'Sprites')!.params.assets).toHaveLength(1);
  });
});

describe('stills and batches', () => {
  it('renders a folder of sprites to PNG with correct sizes and straight alpha; one bad file does not stop the batch', async () => {
    const dir = tempDir();
    const sprites = join(dir, 'sprites');
    mkdirSync(sprites);
    await writeSprite(join(sprites, 'a.png'), 32, 32, '#ff0000');
    await writeSprite(join(sprites, 'b.png'), 48, 24, '#00ff00');
    writeFileSync(join(sprites, 'bad.png'), 'not an image');
    await writeSprite(join(sprites, 'c.png'), 16, 16, '#0000ff');
    const c = chain(registry, [{ type: 'media-in', label: 'Sprites' }, { type: 'color-adjust', params: { saturation: 1 } }], {}, { name: '{name}_out', kind: 'image' });
    const { graph } = assignInputs(c.graph, registry, { positional: [sprites], targeted: [] });
    const out = join(dir, 'out');
    mkdirSync(out);
    const sum = await renderGraphBatch({ graph, registry, outDir: out, sequenceFps: 12, gpu });
    expect(sum.errors).toHaveLength(1);
    expect(sum.errors[0].item).toBe(3);
    expect(readdirSync(out).sort()).toEqual(['a_out.png', 'b_out.png', 'c_out.png']);
    const a = await readRaw(join(out, 'a_out.png'));
    expect([a.width, a.height]).toEqual([32, 32]);
    const mid = a.at(16, 16);
    expect(mid[3]).toBeGreaterThan(120);
    expect(mid[3]).toBeLessThan(136);
    expect(mid[0]).toBeGreaterThan(245); // un-premultiplied: still full red, not darkened by alpha
    expect(a.at(0, 0)[3]).toBe(0);
    const b = await readRaw(join(out, 'b_out.png'));
    expect([b.width, b.height]).toEqual([48, 24]);
  });

  it('honours --items, format override and file name pattern', async () => {
    const dir = tempDir();
    for (const n of ['a', 'b', 'c']) await writeSprite(join(dir, `${n}.png`), 8, 8, '#ffffff');
    const c = chain(registry, [{ type: 'media-in' }], {}, { name: '{name}-{width}x{height}', kind: 'image' });
    const { graph } = assignInputs(c.graph, registry, { positional: [dir], targeted: [] });
    const out = join(dir, 'o');
    mkdirSync(out);
    const sum = await renderGraphBatch({ graph, registry, outDir: out, items: [1], overrides: { imageFormat: 'webp' }, sequenceFps: 12, gpu });
    expect(sum.errors).toEqual([]);
    expect(readdirSync(out)).toEqual(['b-8x8.webp']);
    expect((await sharp(join(out, 'b-8x8.webp')).metadata()).format).toBe('webp');
  });
});

describe('animation exports without ffmpeg', () => {
  it('writes a PNG sequence with alpha and zero-padded names', async () => {
    const graph = await withAnimate({ kind: 'sequence', name: 'ball' });
    const out = tempDir();
    const sum = await renderGraphBatch({ graph, registry, outDir: out, sequenceFps: 12, gpu });
    expect(sum.errors).toEqual([]);
    const files = readdirSync(join(out, 'ball')).sort();
    expect(files).toHaveLength(12);
    expect(files[0]).toBe('ball_0000.png');
    expect(files[11]).toBe('ball_0011.png');
    const f0 = await readRaw(join(out, 'ball', files[0]));
    expect([f0.width, f0.height]).toEqual([64, 48]);
    expect(f0.at(0, 0)[3]).toBe(0);
    const f3 = await readRaw(join(out, 'ball', files[3]));
    expect(Buffer.compare(f0.data, f3.data)).not.toBe(0); // it really animates
    const opaque = [...Array(64 * 48).keys()].some((i) => f0.data[i * 4 + 3] === 255);
    expect(opaque).toBe(true);
  });

  it('writes a spritesheet PNG plus JSON metadata', async () => {
    const graph = await withAnimate({ kind: 'spritesheet', name: 'sheet', columns: 4, padding: 2 });
    const out = tempDir();
    const sum = await renderGraphBatch({ graph, registry, outDir: out, sequenceFps: 12, gpu });
    expect(sum.errors).toEqual([]);
    const meta = JSON.parse(readFileSync(join(out, 'sheet.json'), 'utf8'));
    expect(meta).toMatchObject({ frameCount: 12, columns: 4, rows: 3, frameWidth: 64, frameHeight: 48, padding: 2, width: 4 * 64 + 3 * 2, height: 3 * 48 + 2 * 2 });
    const m = await sharp(join(out, 'sheet.png')).metadata();
    expect([m.width, m.height, m.hasAlpha]).toEqual([meta.width, meta.height, true]);
  });

  it('dry run lists files and renders nothing', async () => {
    const graph = await withAnimate({ kind: 'sequence', name: 'ball' });
    const out = join(tempDir(), 'never');
    const sum = await renderGraphBatch({ graph, registry, outDir: out, sequenceFps: 12, dryRun: true });
    expect(sum.plan).toHaveLength(1);
    expect(sum.plan[0].path).toBe('ball/ball_0000.png');
    expect(() => readdirSync(out)).toThrow();
  });

  it('writes print sheets (PDF) for outputs of kind print, and plans them in a dry run', async () => {
    const graph = await withAnimate({ kind: 'print', name: 'sheet', printOutput: 'both', printDpi: 72, printColumns: 3, printRows: 4, step: 3 });
    const plan = await renderGraphBatch({ graph, registry, outDir: join(tempDir(), 'never'), sequenceFps: 12, dryRun: true });
    expect(plan.plan[0]).toMatchObject({ kind: 'print', path: 'sheet.pdf' });
    const out = tempDir();
    const sum = await renderGraphBatch({ graph, registry, outDir: out, sequenceFps: 12, gpu });
    expect(sum.errors).toEqual([]);
    expect(sum.skipped).toEqual([]);
    const pdf = readFileSync(join(out, 'sheet.pdf'));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const png = readFileSync(join(out, 'sheet_page_01.png'));
    expect([...png.subarray(1, 4)]).toEqual([80, 78, 71]); // PNG signature
    expect(sum.files).toEqual(expect.arrayContaining(['sheet.pdf', 'sheet_page_01.png']));
  });

  it('rotoscope style, paper layers, flipbook, zine, plates and plotter SVG all come out of the Output print kind', async () => {
    const run = async (params: Record<string, unknown>) => {
      const graph = await withAnimate({ kind: 'print', name: 'x', printDpi: 72, printOutput: 'pdf', step: 3, ...params });
      const out = tempDir();
      const sum = await renderGraphBatch({ graph, registry, outDir: out, sequenceFps: 12, gpu });
      expect(sum.errors).toEqual([]);
      return sum.files;
    };
    expect(await run({ printStyle: 'blue', printLayers: 2 })).toEqual(['x_layer1.pdf', 'x_layer2.pdf']);
    expect(await run({ printStyle: 'outline', printFrameNumbers: true })).toEqual(['x.pdf']);
    expect(await run({ printLayout: 'flipbook', printDuplex: true, printThumbIndex: true })).toEqual(['x_flipbook.pdf']);
    expect(await run({ printLayout: 'zine' })).toEqual(['x_zine.pdf']);
    const plates = await run({ printKind: 'separations', printInks: 2 });
    expect(plates.length).toBe(2);
    expect(plates.every((f) => f.startsWith('x_ink') && f.endsWith('.pdf'))).toBe(true);
    const svgs = await run({ printKind: 'svg-plot', printInks: 1 });
    expect(svgs.length).toBeGreaterThan(0);
    expect(svgs.every((f) => f.endsWith('.svg'))).toBe(true);
  });
});

describe('ffmpeg exports', () => {
  it('ProRes 4444 keeps alpha: pixel format, transparent pixel, opaque colour', async (ctx) => {
    if (!ffmpeg) return ctx.skip();
    const graph = await withAnimate({ kind: 'video', name: 'p4444' });
    const out = tempDir();
    const sum = await renderGraphBatch({ graph, registry, outDir: out, overrides: { codec: CODECS.prores4444 }, sequenceFps: 12, gpu });
    expect(sum.errors).toEqual([]);
    const file = join(out, 'p4444.mov');
    const info = ffmpegSync(ffmpeg, ['-i', file]).stderr;
    expect(info).toMatch(/Video: prores \(4444\)/);
    expect(info).toMatch(/yuva444p\d*[a-z]*/); // alpha pixel format
    expect(info).toMatch(/64x48/);
    const png = join(out, 'frame0.png');
    expect(ffmpegSync(ffmpeg, ['-y', '-v', 'error', '-i', file, '-frames:v', '1', '-pix_fmt', 'rgba', png]).status).toBe(0);
    const f = await readRaw(png);
    expect(f.at(0, 0)[3]).toBe(0); // transparent corner survived
    const p = f.at(19, 24); // inside the red ellipse (x animates around 0.3 at frame 0)
    expect(p[3]).toBeGreaterThan(250);
    expect(Math.abs(p[0] - 255)).toBeLessThan(6);
    expect(p[1]).toBeLessThan(6);
    expect(p[2]).toBeLessThan(6);
  }, 60_000);

  it('qtrle, png-in-mov and webm-alpha also keep alpha; h264 pads to even size', async (ctx) => {
    if (!ffmpeg) return ctx.skip();
    const graph = await withAnimate({ kind: 'video', name: 'v' });
    const out = tempDir();
    for (const c of ['qtrle', 'png', 'webm-alpha', 'h264'] as const) {
      const g = { ...graph, project: { ...graph.project, width: 65, height: 49 }, nodes: graph.nodes.map((n) => (n.type === 'image-out' ? { ...n, params: { ...n.params, name: `v_${c}` } } : n)) };
      const sum = await renderGraphBatch({ graph: g, registry, outDir: out, overrides: { codec: CODECS[c] }, sequenceFps: 12, gpu });
      expect(sum.errors, c).toEqual([]);
    }
    const q = ffmpegSync(ffmpeg, ['-i', join(out, 'v_qtrle.mov')]).stderr;
    expect(q).toMatch(/Video: qtrle.*bgra|Video: qtrle.*argb/);
    expect(ffmpegSync(ffmpeg, ['-i', join(out, 'v_png.mov')]).stderr).toMatch(/Video: png.*rgba/);
    expect(ffmpegSync(ffmpeg, ['-i', join(out, 'v_h264.mp4')]).stderr).toMatch(/66x50/);
    expect(ffmpegSync(ffmpeg, ['-i', join(out, 'v_webm-alpha.webm')]).stderr).toMatch(/Video: vp9/);
  }, 120_000);

  it('decodes a video input sequentially with ONE ffmpeg process; backward seeks re-spawn and stay correct', async (ctx) => {
    if (!ffmpeg) return ctx.skip();
    const dir = tempDir();
    const src = join(dir, 'src.mp4');
    expect(ffmpegSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=12:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]).status).toBe(0);
    const host = new NodeHost(gpu, { sequenceFps: 12 });
    const info = await host.register(src);
    expect(info).toMatchObject({ kind: 'video', width: 64, height: 48 });
    expect(Math.round(info.fps)).toBe(12);
    const snap = async (i: number) => {
      const f = await host.assetFrame(src, i / 12, 0);
      gpu.retain(f!.texture);
      const px = await gpu.read(f!);
      gpu.release(f!.texture);
      return Buffer.from(px.buffer).toString('base64');
    };
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) seen.push(await snap(i));
    expect(host.decoderSpawns).toBe(1);
    expect(new Set(seen).size).toBeGreaterThan(15);
    expect(await snap(5)).toBe(seen[5]); // backward seek
    expect(host.decoderSpawns).toBe(2);
    expect(await snap(6)).toBe(seen[6]); // continues sequentially after the seek
    expect(host.decoderSpawns).toBe(2);
    host.close();
  }, 60_000);

  it('muxes the graph audio into the video', async (ctx) => {
    if (!ffmpeg) return ctx.skip();
    let graph = await withAnimate({ kind: 'video', name: 'withaudio' });
    const { addNode, connect } = await import('./testkit');
    const osc = addNode(graph, registry, 'oscillator', { x: 0, y: 0 }, {});
    const ao = addNode(osc.graph, registry, 'audio-out', { x: 0, y: 0 }, {});
    graph = connect(ao.graph, registry, { node: osc.node.id, port: 'audio' }, { node: ao.node.id, port: 'audio' });
    const out = tempDir();
    const sum = await renderGraphBatch({ graph, registry, outDir: out, overrides: { codec: CODECS.prores4444 }, sequenceFps: 12, gpu });
    expect(sum.errors).toEqual([]);
    expect(ffmpegSync(ffmpeg, ['-i', join(out, 'withaudio.mov')]).stderr).toMatch(/Audio: pcm_s16le/);
  }, 60_000);
});

describe('command line', () => {
  it('builds the bundle, lists nodes, checks and renders a graph end to end', async () => {
    const root = resolve(__dirname, '../../..');
    const build = spawnSync(process.execPath, [join(root, 'scripts/build-cli.mjs')], { cwd: root, encoding: 'utf8' });
    expect(build.status, build.stderr).toBe(0);
    const cli = join(root, 'dist-cli/rsmps.mjs');
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });

    const nodes = run('nodes', '--json');
    expect(nodes.status, nodes.stderr).toBe(0);
    expect((JSON.parse(nodes.stdout) as { id: string }[]).some((n) => n.id === 'image-out')).toBe(true);

    const c = chain(registry, [{ type: 'media-in', label: 'Sprites' }, { type: 'color-adjust', params: { hue: 90 } }], {}, { kind: 'image' });
    const dir = tempDir();
    const gfile = join(dir, 'g.rsmps.json');
    writeFileSync(gfile, JSON.stringify(c.graph));
    await writeSprite(join(dir, 's.png'), 16, 16, '#ff0000');
    const check = run('check', gfile);
    expect(check.status, check.stdout + check.stderr).toBe(0);

    const out = join(dir, 'out');
    const r = run('render', gfile, join(dir, 's.png'), '--out', out, '--json');
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('"event":"done"');
    expect((await readRaw(join(out, 's.png'))).at(8, 8)[3]).toBeGreaterThan(120);

    const bad = run('render', gfile, join(dir, 'nope.png'), '--out', out);
    expect(bad.status).toBe(2);
    const usage = run('render');
    expect(usage.status).toBe(2);
    void setParam;
  }, 120_000);
});
