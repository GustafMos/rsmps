import { beforeAll, describe, expect, it, vi } from 'vitest';
import { harness, type Harness } from '../../testing';
import type { Host, ImageValue, TextSpec } from '../../types';
import { subtitleDebug, clearAtlases } from '../../lib/subtitle-gpu';
import { addNode, createGraph } from '../../graph';

/**
 * A fake rasteriser with the same contract as the app's (padding ceil(size*0.15)+2, 1.2 line box): every character is a solid block
 * 0.8 advance wide and 0.6 em tall, advance = 0.5 em. Layout, atlas and drawing are real; only the glyph shapes are blocks.
 */
const calls: TextSpec[] = [];
const ADV = 0.5;
function rasterize(spec: TextSpec) {
  calls.push(spec);
  const pad = Math.ceil(spec.sizePx * 0.15) + 2;
  const adv = spec.sizePx * ADV;
  const textW = Math.ceil(spec.text.length * adv);
  const width = textW + pad * 2;
  const lineH = Math.ceil(spec.sizePx * 1.2);
  const height = lineH + pad * 2;
  const data = new Uint8ClampedArray(width * height * 4);
  const gh = Math.round(spec.sizePx * 0.6);
  const top = pad + Math.round((lineH - gh) / 2);
  for (let c = 0; c < spec.text.length; c++) {
    if (spec.text[c] === ' ') continue;
    const x0 = pad + Math.round(c * adv + adv * 0.1);
    const x1 = pad + Math.round(c * adv + adv * 0.9);
    for (let y = top; y < top + gh; y++) for (let x = x0; x < x1; x++) data.set([255, 255, 255, 255], (y * width + x) * 4);
  }
  return { data, width, height };
}
const host: Host = { assetInfo: () => null, assetFrame: async () => null, rasterizeText: rasterize };
const proj = { width: 360, height: 640, lengthMode: 'absolute' as const, duration: 6, fps: 24 };
const base = { preset: 'custom', fontSize: 40, stroke: 0, shadowColor: [0, 0, 0, 0], animIn: 'none', animOut: 'none', position: 'center', maxLines: 3 };

let t: Harness;
let headless: Harness;
beforeAll(async () => {
  t = await harness([], host);
  headless = await harness();
});

type Px = Awaited<ReturnType<Harness['pixels']>>;
function bounds(px: Px, pred: (p: [number, number, number, number]) => boolean = (p) => p[3] > 128) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < px.height; y++)
    for (let x = 0; x < px.width; x++)
      if (pred(px.at(x, y))) {
        n++;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
  return { n, x0, y0, x1, y1 };
}
const run = async (params: Record<string, unknown>, seconds: number, inputs: Record<string, never> = {}) => t.run('subtitles', { ...base, ...params }, inputs, { seconds, project: proj });
const img = async (params: Record<string, unknown>, seconds: number) => t.pixels((await run(params, seconds)).image as ImageValue);

describe('subtitles node', () => {
  it('headless (no rasteriser): a transparent canvas-sized image and sane numbers', async () => {
    const out = await headless.run('subtitles', {}, {}, { project: proj });
    const im = out.image as ImageValue;
    expect([im.width, im.height]).toEqual([360, 640]);
    expect((await headless.pixels(im)).data.every((v) => v === 0)).toBe(true);
    expect(out.active).toBe(0);
  });

  it('shows the right cue at the right time and nothing outside cues', async () => {
    const text = '[0-2] AAAA\n[3-5] BBBBBBBB';
    const a = await img({ text }, 1);
    const ba = bounds(a);
    expect(ba.n).toBeGreaterThan(100);
    // centred, one 4-letter word: 4 * 20 = 80 px wide
    expect(Math.abs((ba.x0 + ba.x1) / 2 - 180)).toBeLessThan(3);
    expect(ba.x1 - ba.x0 + 1).toBeGreaterThan(60);
    expect(ba.x1 - ba.x0 + 1).toBeLessThan(90);
    const gap = await img({ text }, 2.5);
    expect(bounds(gap).n).toBe(0);
    const b = bounds(await img({ text }, 4));
    expect(b.x1 - b.x0).toBeGreaterThan((ba.x1 - ba.x0) * 1.7); // 8 letters vs 4
    expect(bounds(await img({ text }, 5.5)).n).toBe(0);
    const o = await run({ text }, 1);
    expect([o.active, o.cueProgress, o.wordIndex]).toEqual([1, 0.5, 0]);
    expect((await run({ text }, 2.5)).active).toBe(0);
  });

  it('reads a .srt file through host.assetBytes', async () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\nFROM FILE\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n{\\an8}TOP\r\n';
    const bytes = new TextEncoder().encode(srt).buffer as ArrayBuffer;
    const fileHost: Host = { ...host, assetBytes: async () => bytes };
    const tf = await harness([], fileHost);
    const at = async (s: number) => tf.pixels((await tf.run('subtitles', { ...base, file: ['x'], position: 'bottom' }, {}, { seconds: s, project: proj })).image as ImageValue);
    const mid = bounds(await at(1.5));
    expect(mid.n).toBeGreaterThan(100);
    expect(mid.y0).toBeGreaterThan(400); // bottom
    const top = bounds(await at(3.5));
    expect(top.n).toBeGreaterThan(50);
    expect(top.y1).toBeLessThan(200); // {\an8} moved it to the top
    expect(bounds(await at(2.5)).n).toBe(0);
  });

  it('fade: invisible at the cue start, full in the middle, gone at the end', async () => {
    const p = { text: '[0-4] FADE', animIn: 'fade', animOut: 'fade', duration: 0.5 };
    expect(bounds(await img(p, 0)).n).toBe(0);
    const mid = await img(p, 2);
    expect(bounds(mid).n).toBeGreaterThan(100);
    const half = await img(p, 0.25);
    let peak = 0;
    for (let i = 3; i < half.data.length; i += 4) peak = Math.max(peak, half.data[i]);
    expect(peak).toBeGreaterThan(80);
    expect(peak).toBeLessThan(200);
    expect(bounds(await img(p, 3.999)).n).toBe(0);
  });

  it('every animation is invisible at its start and complete at its end', async () => {
    for (const kind of ['fade', 'pop', 'slide', 'bounce', 'blur', 'wipe', 'shake', 'wave', 'jitter', 'flicker']) {
      const p = { text: '[0-4] ANIM', animIn: kind, duration: 0.4 };
      const start = bounds(await img(p, 0)).n;
      const end = await img(p, 2);
      const full = bounds(end);
      expect(start, `${kind} at its start`).toBe(0);
      expect(full.n, `${kind} when done`).toBeGreaterThan(150);
      expect(Math.abs((full.x0 + full.x1) / 2 - 180)).toBeLessThan(3);
    }
  });

  it('karaoke lights the word being spoken, others keep the base color', async () => {
    const p = { text: '[0-3] one two three', mode: 'karaoke', color: [1, 0, 0, 1], highlightColor: [0, 1, 0, 1], maxLines: 1, fontSize: 24 };
    const px = await img(p, 1.2); // "two": 0.82 .. 1.64
    const green = bounds(px, (c) => c[3] > 128 && c[1] > 200 && c[0] < 60);
    const red = bounds(px, (c) => c[3] > 128 && c[0] > 200 && c[1] < 60);
    expect(green.n).toBeGreaterThan(20);
    expect(red.n).toBeGreaterThan(20);
    const all = bounds(px);
    // the green word is the middle one: red on both sides of it
    expect(green.x0).toBeGreaterThan(all.x0 + 10);
    expect(green.x1).toBeLessThan(all.x1 - 10);
    expect((await run(p, 1.2)).wordIndex).toBe(1);
    const first = bounds(await img(p, 0.3), (c) => c[3] > 128 && c[1] > 200 && c[0] < 60);
    expect(first.x1).toBeLessThan(180);
    const last = bounds(await img(p, 2.5), (c) => c[3] > 128 && c[1] > 200 && c[0] < 60);
    expect(last.x0).toBeGreaterThan(170);
  });

  it('chunks show a few words at a time; word mode one', async () => {
    const text = '[0-6] a1 b2 c3 d4 e5 f6';
    const w = (b: ReturnType<typeof bounds>) => b.x1 - b.x0 + 1;
    const one = w(bounds(await img({ text, mode: 'word' }, 0.2)));
    const chunk = w(bounds(await img({ text, mode: 'chunks', wordsPerChunk: 3, maxLines: 1 }, 0.2)));
    expect(one).toBeLessThan(60);
    expect(chunk).toBeGreaterThan(one * 2.5);
    const later = w(bounds(await img({ text, mode: 'chunks', wordsPerChunk: 3, maxLines: 1 }, 5)));
    expect(Math.abs(later - chunk)).toBeLessThan(4);
  });

  it('typewriter reveals letters over time and build keeps words', async () => {
    const text = '[0-4] AAAAAA BBBBBB';
    const w = async (mode: string, s: number) => bounds(await img({ text, mode, maxLines: 1 }, s)).n;
    const early = await w('typewriter', 0.2);
    const mid = await w('typewriter', 1.5);
    const end = await w('typewriter', 3.8);
    expect(early).toBeLessThan(mid);
    expect(mid).toBeLessThan(end);
    expect(await w('build', 0.1)).toBeGreaterThan(0); // the first word is there at once
    const b1 = await w('build', 0.1);
    const b2 = await w('build', 3.8);
    expect(b2).toBeGreaterThan(b1 * 1.5);
  });

  it('stroke is drawn outside the letters, shadow offset and blur move away from them', async () => {
    const plain = bounds(await img({ text: '[0-4] OOO', color: [1, 0, 0, 1] }, 2));
    const px = await img({ text: '[0-4] OOO', color: [1, 0, 0, 1], stroke: 6, strokeColor: [0, 0, 1, 1] }, 2);
    const blue = bounds(px, (c) => c[3] > 128 && c[2] > 200 && c[0] < 80);
    expect(blue.n).toBeGreaterThan(50);
    expect(blue.x0).toBeLessThan(plain.x0 - 4);
    expect(blue.x0).toBeGreaterThan(plain.x0 - 8);
    expect(px.at(Math.round((plain.x0 + plain.x1) / 2), Math.round((plain.y0 + plain.y1) / 2))).toEqual([255, 0, 0, 255]); // fill stays on top
    const sh = await img({ text: '[0-4] OOO', color: [1, 0, 0, 1], shadowColor: [0, 0, 0, 1], shadowX: 0, shadowY: 12, shadowBlur: 0 }, 2);
    const dark = bounds(sh, (c) => c[3] > 128 && c[0] < 40);
    expect(dark.y1).toBeGreaterThan(plain.y1 + 8);
  });

  it('box behind the text', async () => {
    const px = await img({ text: '[0-4] BOX', boxMode: 'block', boxColor: [0, 0, 1, 1], boxPadding: 10, boxRadius: 0 }, 2);
    const ink = bounds(px, (c) => c[3] > 128 && c[0] > 200);
    const box = bounds(px, (c) => c[3] > 128 && c[2] > 200 && c[0] < 40);
    expect(box.x0).toBeLessThan(ink.x0 - 6);
    expect(box.x1).toBeGreaterThan(ink.x1 + 6);
    expect(box.y0).toBeLessThan(ink.y0 - 6);
  });

  it('picture in the letters (Fill input) and the mask output match the text', async () => {
    const fill = t.solid(360, 640, [0, 255, 0, 255]);
    const out = await t.run('subtitles', { ...base, text: '[0-4] FILL', color: [1, 0, 0, 1] }, { image: fill }, { seconds: 2, project: proj });
    const px = await t.pixels(out.image as ImageValue);
    const g = bounds(px, (c) => c[3] > 128 && c[1] > 200 && c[0] < 40);
    expect(g.n).toBeGreaterThan(100);
    expect(bounds(px, (c) => c[3] > 128 && c[0] > 200).n).toBe(0);
    const m = await t.pixels(out.mask as ImageValue);
    expect(m.at(g.x0 + 3, Math.round((g.y0 + g.y1) / 2))[0]).toBe(255);
    expect(m.at(5, 5)[0]).toBe(0);
    expect(bounds(m, (c) => c[0] > 128).n).toBe(bounds(px).n);
  });

  it('gradient fill runs from one color to the other', async () => {
    const px = await img({ text: '[0-4] WWWWWWWW', fillStyle: 'gradient', color: [1, 0, 0, 1], gradientColor: [0, 0, 1, 1], gradientAngle: 0 }, 2);
    const b = bounds(px);
    const left = px.at(b.x0 + 3, Math.round((b.y0 + b.y1) / 2));
    const right = px.at(b.x1 - 3, Math.round((b.y0 + b.y1) / 2));
    expect(left[0]).toBeGreaterThan(right[0] + 100);
    expect(right[2]).toBeGreaterThan(left[2] + 100);
  });

  it('pixelSize draws on an art grid, stamps cell and gives blocky 1-bit edges', async () => {
    const out = await run({ text: '[0-4] PIXEL', pixelSize: 4, oneBit: true, fontSize: 48, stroke: 4, pixelOutline: true, strokeColor: [0, 0, 0, 1] }, 2);
    const image = out.image as ImageValue;
    expect(image.cell).toBe(4);
    expect([image.width, image.height]).toEqual([360, 640]);
    const px = await t.pixels(image);
    // every 4x4 cell is uniform
    let nonUniform = 0;
    let inked = 0;
    for (let cy = 0; cy < 160; cy++)
      for (let cx = 0; cx < 90; cx++) {
        const c0 = px.at(cx * 4, cy * 4);
        if (c0[3] > 0) inked++;
        for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) {
          const c = px.at(cx * 4 + dx, cy * 4 + dy);
          if (c[0] !== c0[0] || c[1] !== c0[1] || c[2] !== c0[2] || c[3] !== c0[3]) nonUniform++;
        }
      }
    expect(inked).toBeGreaterThan(30);
    expect(nonUniform).toBe(0);
    // 1-bit: alpha is 0 or 255 only
    expect(Array.from({ length: px.width * px.height }, (_, i) => px.data[i * 4 + 3]).every((a) => a === 0 || a === 255)).toBe(true);
    // the outline is one art pixel: a black ring exactly 4 texels wide around the white glyphs
    const white = bounds(px, (c) => c[3] > 128 && c[0] > 200);
    const black = bounds(px, (c) => c[3] > 128 && c[0] < 40);
    expect(white.x0 - black.x0).toBe(4);
    // an empty frame keeps the grid too
    expect(((await run({ text: '[0-1] x', pixelSize: 4 }, 3)).image as ImageValue).cell).toBe(4);
  });

  it('pixel dithered fill uses two colors on the grid', async () => {
    const px = await img({ text: '[0-4] DITHER', pixelSize: 4, oneBit: true, fontSize: 64, fillStyle: 'dither', color: [1, 1, 0, 1], gradientColor: [1, 0, 0, 1], gradientAngle: 90 }, 2);
    const y = bounds(px, (c) => c[3] > 128 && c[1] > 200);
    const r = bounds(px, (c) => c[3] > 128 && c[1] < 40 && c[0] > 200);
    expect(y.n).toBeGreaterThan(50);
    expect(r.n).toBeGreaterThan(50);
  });

  it('cue position tags and safe areas move the block', async () => {
    const bottom = bounds(await img({ text: '[0-4] LOW', position: 'bottom' }, 2));
    const safe = bounds(await img({ text: '[0-4] LOW', position: 'bottom', safeArea: 'tiktok' }, 2));
    expect(safe.y1).toBeLessThan(bottom.y1 - 50);
    expect(safe.y1).toBeLessThanOrEqual(640 * (1 - 0.22) - 14);
    const free = bounds(await img({ text: '[0-4] LOW', position: 'free', x: 0.25, y: 0.25 }, 2));
    expect(Math.abs((free.x0 + free.x1) / 2 - 90)).toBeLessThan(3);
    expect(Math.abs((free.y0 + free.y1) / 2 - 160)).toBeLessThan(26);
  });

  it('a long caption breaks into lines and shrinks to fit', async () => {
    const text = '[0-4] this is a very long caption that cannot fit on one single line of the frame';
    const px = await img({ text, maxLines: 2, fontSize: 40 }, 2);
    const b = bounds(px);
    expect(b.x0).toBeGreaterThanOrEqual(0);
    expect(b.x1).toBeLessThanOrEqual(359);
    expect(b.x1 - b.x0).toBeLessThan(0.9 * 360 + 2);
    expect(b.y1 - b.y0).toBeGreaterThan(30);
  });

  it('presets render something for every look and survive emoji and empty words', async () => {
    for (const preset of ['classic', 'bold', 'karaoke', 'typewriter', 'pixel8', 'pixelDither', 'boxed', 'bigword', 'wave']) {
      const px = await t.pixels((await t.run('subtitles', { preset, text: '[0-4] hello brave new world \u{1F600}' }, {}, { seconds: 2.5, project: proj })).image as ImageValue);
      expect(bounds(px).n, preset).toBeGreaterThan(50);
    }
  });

  it('loops: with Wrap on, the frame after the last equals the first', async () => {
    const project = { width: 64, height: 96, lengthMode: 'absolute' as const, duration: 2, fps: 10 };
    const p = { ...base, fontSize: 12, text: 'AAA\nBBB', animIn: 'fade', animOut: 'fade', duration: 0.3, loopWithProject: true };
    const a = await t.pixels((await t.run('subtitles', p, {}, { seconds: 0, project })).image as ImageValue);
    const z = await t.pixels((await t.run('subtitles', p, {}, { seconds: 2, project })).image as ImageValue);
    expect(Buffer.from(a.data).equals(Buffer.from(z.data))).toBe(true);
    const mid = await t.pixels((await t.run('subtitles', p, {}, { seconds: 0.5, project })).image as ImageValue);
    expect(bounds(mid).n).toBeGreaterThan(0);
    const q = { ...p, loopWithProject: false };
    const z2 = await t.pixels((await t.run('subtitles', q, {}, { seconds: 2, project })).image as ImageValue);
    expect(Buffer.from(a.data).equals(Buffer.from(z2.data))).toBe(true); // nothing is showing at the end either
  });

  it('offset and speed retime the captions', async () => {
    const p = { text: '[1-2] AAA' };
    expect(bounds(await img({ ...p, offset: 2 }, 1.5)).n).toBe(0);
    expect(bounds(await img({ ...p, offset: 2 }, 3.5)).n).toBeGreaterThan(50);
    expect(bounds(await img({ ...p, speed: 2 }, 0.75)).n).toBeGreaterThan(50); // subtitle time 1.5
    expect(bounds(await img({ ...p, speed: 2 }, 1.5)).n).toBe(0);
  });
});

describe('subtitles performance contract', () => {
  const gpuOf = () => t.gpu as unknown as { pass: (o: unknown) => unknown; counters: { pipelinesCreated: number; shaderModulesCreated: number; texturesCreated: number; buffersCreated: number; bindGroupsCreated: number } };

  it('rasterises each word once and builds the atlas once across 48 frames; a playing frame costs zero shader passes', async () => {
    clearAtlases(t.gpu.device);
    const text = Array.from({ length: 12 }, (_, i) => `[${i * 0.5}-${i * 0.5 + 0.5}] word${i} and more${i}`).join('\n');
    const params = { ...base, text, mode: 'chunks', wordsPerChunk: 2, animIn: 'pop', animOut: 'none', stroke: 4, shadowColor: [0, 0, 0, 0.5], shadowBlur: 4, fontSize: 36 };
    const project = { ...proj, fps: 8, duration: 6 };
    let graph = createGraph('subs');
    graph.project = { ...graph.project, ...project };
    const added = addNode(graph, t.registry, 'subtitles', { x: 0, y: 0 }, params);
    graph = added.graph;
    const frame = async (f: number, port = 'image') => {
      const r = await t.engine.evaluate({ graph, node: added.node.id, port, seconds: f / 8 });
      expect(r.errors.size).toBe(0);
      return r;
    };
    const g = gpuOf();
    const spy = vi.spyOn(g, 'pass');
    const rasterBefore = subtitleDebug.rasterCalls;
    await frame(0); // warm-up: builds the atlas and the pipelines
    const buildPasses = spy.mock.calls.length;
    const buildRasters = subtitleDebug.rasterCalls - rasterBefore;
    const builds0 = subtitleDebug.atlasBuilds;
    const raster0 = subtitleDebug.rasterCalls;
    const before = { ...g.counters };
    let maxPasses = 0;
    const t0 = performance.now();
    for (let f = 0; f < 48; f++) {
      spy.mockClear();
      await frame(f);
      maxPasses = Math.max(maxPasses, spy.mock.calls.length);
    }
    const msPerFrame = (performance.now() - t0) / 48;
    console.info(`[subtitles] atlas build: ${buildRasters} rasterisations, ${buildPasses} GPU passes; playing: ${maxPasses} passes and 0 rasterisations per frame, ${msPerFrame.toFixed(2)} ms per frame (JS + submit, headless)`);
    spy.mockClear();
    await frame(10, 'mask'); // asking for the text mask costs exactly one pass
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();
    expect(subtitleDebug.atlasBuilds - builds0).toBe(0);
    expect(subtitleDebug.rasterCalls - raster0).toBe(0);
    expect(maxPasses).toBe(0);
    expect(g.counters.pipelinesCreated - before.pipelinesCreated).toBe(0);
    expect(g.counters.shaderModulesCreated - before.shaderModulesCreated).toBe(0);
  });

  it('sliders compile nothing', async () => {
    const g = gpuOf();
    const params = { ...base, text: '[0-4] sliders', animIn: 'fade' };
    await t.run('subtitles', { ...params, stroke: 2 }, {}, { seconds: 2, project: proj });
    await t.run('subtitles', { ...params, stroke: 2, oneBit: true, fillStyle: 'gradient', boxMode: 'block', mode: 'karaoke', highlightActive: true }, {}, { seconds: 2, project: proj });
    const before = { ...g.counters };
    for (let i = 1; i <= 12; i++) {
      await t.run(
        'subtitles',
        { ...params, stroke: i, shadowColor: [0, 0, 0, i / 12], shadowBlur: i, shadowX: i, color: [i / 12, 0, 1, 1], boxMode: 'block', boxPadding: i * 3, maxWidth: 0.5 + i / 30, gradientAngle: i * 10, pulse: i / 30, duration: i / 20, motionAmount: i / 30 },
        {},
        { seconds: 1 + i / 20, project: proj },
      );
    }
    expect(g.counters.pipelinesCreated - before.pipelinesCreated).toBe(0);
    expect(g.counters.shaderModulesCreated - before.shaderModulesCreated).toBe(0);
  });

  it('a long file (3,000 cues) keeps memory bounded and looks cues up fast', async () => {
    clearAtlases(t.gpu.device);
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const a = i * 2;
      lines.push(`${i + 1}\n00:${String(Math.floor(a / 60) % 60).padStart(2, '0')}:${String(a % 60).padStart(2, '0')},000 --> 00:${String(Math.floor((a + 1) / 60) % 60).padStart(2, '0')}:${String((a + 1) % 60).padStart(2, '0')},500\nline number ${i} has words${i % 40}\n`);
    }
    // times above 1 h wrap in this synthetic file; use hours so the cues stay ordered
    const srt = Array.from({ length: 3000 }, (_, i) => {
      const s = i * 2;
      const f = (v: number) => `${String(Math.floor(v / 3600)).padStart(2, '0')}:${String(Math.floor(v / 60) % 60).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
      return `${i + 1}\n${f(s)},000 --> ${f(s + 1)},500\nline number ${i} has words${i % 40}\n`;
    }).join('\n');
    void lines;
    const bytes = new TextEncoder().encode(srt).buffer as ArrayBuffer;
    const th = await harness([], { ...host, assetBytes: async () => bytes });
    const g = gpuOf();
    void g;
    const before = subtitleDebug.atlasBuilds;
    const t0 = performance.now();
    for (let i = 0; i < 3000; i += 97) await th.run('subtitles', { ...base, file: ['f'], fontSize: 20 }, {}, { seconds: i * 2 + 0.5, project: { ...proj, duration: 6000 } });
    const ms = performance.now() - t0;
    const stats = (await import('../../lib/subtitle-gpu')).atlasStats(t.gpu.device);
    expect(stats.count).toBeLessThanOrEqual(8);
    expect(stats.bytes).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(subtitleDebug.atlasBuilds - before).toBeGreaterThan(8); // pages were built and evicted
    expect(ms).toBeLessThan(60000);
  });
});
