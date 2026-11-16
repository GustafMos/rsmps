/**
 * Looks at the node with REAL fonts: renders every preset on a 1080x1920 canvas over a dark gradient and writes PNGs into the scratch
 * folder. `sharp` (SVG text through the system fonts) stands in for the browser's canvas; it is asynchronous, so each preset is rendered
 * twice: a dry run collects which words are needed, they are rasterised, then the real run happens.
 *
 *   SUBS_GALLERY=1 npx vitest run src/engine/nodes/generate/subtitles-gallery.test.ts
 *
 * Skipped otherwise (it needs sharp and installed fonts).
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { harness } from '../../testing';
import { addNode, connect, createGraph } from '../../graph';
import { clearAtlases } from '../../lib/subtitle-gpu';
import { PNG_DIR, writePng } from '../../lib/gen-3d-testutil';
import type { Host, ImageValue, TextSpec } from '../../types';

const ON = !!process.env.SUBS_GALLERY;
const OUT = join(PNG_DIR, 'subs');

const FONT_MAP: Record<string, string> = { 'sans-serif': 'Arial', monospace: 'Consolas' };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type Bmp = { data: Uint8ClampedArray; width: number; height: number };
const store = new Map<string, Bmp>();
const key = (s: TextSpec) => `${s.text}|${s.font}|${s.sizePx}|${s.weight}|${s.italic}`;
const needed = new Map<string, TextSpec>();

const host: Host = {
  assetInfo: () => null,
  assetFrame: async () => null,
  rasterizeText: (spec) => {
    const k = key(spec);
    const hit = store.get(k);
    if (hit) return hit;
    needed.set(k, spec);
    return { data: new Uint8ClampedArray(4 * 8 * 8).fill(255), width: 8, height: 8 }; // placeholder for the dry run
  },
};

async function fill(sharp: (b: Buffer) => { ensureAlpha(): { raw(): { toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }> } } }) {
  for (const [k, spec] of needed) {
    if (store.has(k)) continue;
    const pad = Math.ceil(spec.sizePx * 0.15) + 2;
    const lineH = Math.ceil(spec.sizePx * 1.2);
    const H = lineH + pad * 2;
    const W = Math.ceil(spec.text.length * spec.sizePx * 1.1 + pad * 2 + 40);
    const family = FONT_MAP[spec.font] ?? spec.font;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><text x="${pad}" y="${pad + lineH / 2 + spec.sizePx * 0.34}" font-family="${family}" font-size="${spec.sizePx}" font-weight="${spec.weight}" font-style="${spec.italic ? 'italic' : 'normal'}" fill="white">${esc(spec.text)}</text></svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let x0 = info.width;
    let x1 = -1;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) if (data[(y * info.width + x) * 4 + 3] > 8) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    if (x1 < 0) { store.set(k, { data: new Uint8ClampedArray(4 * (pad * 2 + 2) * H), width: pad * 2 + 2, height: H }); continue; }
    const inkW = x1 - x0 + 1;
    const slack = Math.round(spec.sizePx * 0.04); // side bearings, which an ink-trimmed bitmap lacks
    const w = inkW + pad * 2 + slack * 2;
    const out = new Uint8ClampedArray(w * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < inkW; x++) {
        const si = (y * info.width + x0 + x) * 4;
        const di = (y * w + pad + slack + x) * 4;
        out[di] = 255; out[di + 1] = 255; out[di + 2] = 255; out[di + 3] = data[si + 3];
      }
    store.set(k, { data: out, width: w, height: H });
  }
  needed.clear();
}

const SRT = `1
00:00:00,000 --> 00:00:04,000
This is how fast captions can look on a phone

2
00:00:04,000 --> 00:00:08,000
{\\an8}Top caption with a second line
that keeps the rhythm
`;

describe.skipIf(!ON)('subtitles gallery (real fonts)', () => {
  it('renders every preset and the pixel presets through Dither', async () => {
    const sharpMod = await import(pathToFileURL(join(process.cwd(), 'node_modules/sharp/dist/index.mjs')).href);
    const sharp = sharpMod.default;
    const bytes = new TextEncoder().encode(SRT).buffer as ArrayBuffer;
    const fileHost: Host = { ...host, assetBytes: async () => bytes };
    const project = { width: 1080, height: 1920, lengthMode: 'relative' as const, referenceSide: 1080, duration: 8, fps: 24 };

    const bg = (t: Awaited<ReturnType<typeof harness>>) =>
      t.fromFn(1080, 1920, (x, y) => {
        const v = y / 1920;
        const checker = ((x >> 7) + (y >> 7)) % 2 ? 6 : 0;
        return [Math.round(24 + 40 * v + checker), Math.round(18 + 22 * (1 - v) + checker), Math.round(52 + 60 * v + checker), 255];
      });

    const presets: [string, number][] = [['classic', 1.5], ['bold', 1.2], ['karaoke', 1.9], ['typewriter', 2.3], ['pixel8', 1.2], ['pixelDither', 1.2], ['boxed', 1.9], ['bigword', 1.3], ['wave', 2.4]];
    const sheet = new Uint8ClampedArray(1080 * 1920 * 4);
    for (let i = 3; i < sheet.length; i += 4) sheet[i] = 255;

    for (const [n, [preset, time]] of presets.entries()) {
      let t = await harness([], fileHost);
      const params = { preset, file: ['x'], safeArea: 'tiktok' };
      for (let pass = 0; pass < 2; pass++) {
        clearAtlases(t.gpu.device);
        t = await harness([], fileHost);
        await t.run('subtitles', params, {}, { seconds: time, project });
        if (pass === 0) await fill(sharp);
      }
      clearAtlases(t.gpu.device);
      const out = await t.run('subtitles', params, {}, { seconds: time, project });
      const px = await t.pixels(out.image as ImageValue);
      const back = await t.pixels(bg(t));
      const comp = new Uint8ClampedArray(px.data.length);
      for (let i = 0; i < px.data.length; i += 4) {
        const a = px.data[i + 3] / 255;
        for (let c = 0; c < 3; c++) comp[i + c] = Math.round(px.data[i + c] * a + back.data[i + c] * (1 - a));
        comp[i + 3] = 255;
      }
      writePng(`subs/${preset}`, { data: comp, width: 1080, height: 1920 }, false);
      // one third scale tile in the contact sheet
      const tx = (n % 3) * 360;
      const ty = Math.floor(n / 3) * 640;
      for (let y = 0; y < 640; y++)
        for (let x = 0; x < 360; x++) {
          for (let c = 0; c < 3; c++) {
            let s = 0;
            for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) s += comp[((y * 3 + dy) * 1080 + x * 3 + dx) * 4 + c];
            sheet[((ty + y) * 1080 + tx + x) * 4 + c] = Math.round(s / 9);
          }
        }
      let ink = 0;
      for (let i = 3; i < px.data.length; i += 4) if (px.data[i] > 128) ink++;
      expect(ink, preset).toBeGreaterThan(500);
    }
    writePng('subs/contact-sheet', { data: sheet, width: 1080, height: 1920 }, false);

    // pixel presets through Dither: background + captions merged, then dithered on the art grid
    for (const preset of ['pixel8', 'pixelDither']) {
      let t = await harness([], fileHost);
      for (let pass = 0; pass < 2; pass++) {
        clearAtlases(t.gpu.device);
        t = await harness([], fileHost);
        const build = () => {
          let g = createGraph('d');
          g.project = { ...g.project, ...project };
          const src = t.source(bg(t));
          const a = addNode(g, t.registry, src);
          g = a.graph;
          const s = addNode(g, t.registry, 'subtitles', { x: 0, y: 0 }, { preset, file: ['x'], safeArea: 'tiktok' });
          g = s.graph;
          const m = addNode(g, t.registry, 'merge', { x: 0, y: 0 }, { fit: 'stretch' });
          g = connect(m.graph, t.registry, { node: a.node.id, port: 'out' }, { node: m.node.id, port: 'background' });
          g = connect(g, t.registry, { node: s.node.id, port: 'image' }, { node: m.node.id, port: 'foreground' });
          const d = addNode(g, t.registry, 'dither', { x: 0, y: 0 }, { algorithm: 'bayer-4' });
          g = connect(d.graph, t.registry, { node: m.node.id, port: 'image' }, { node: d.node.id, port: 'image' });
          return { g, node: d.node.id };
        };
        const { g, node } = build();
        await t.evalGraph(g, node, { seconds: 1.2 });
        if (pass === 0) await fill(sharp);
      }
      clearAtlases(t.gpu.device);
      let g = createGraph('d');
      g.project = { ...g.project, ...project };
      const a = addNode(g, t.registry, t.source(bg(t)));
      g = a.graph;
      const s = addNode(g, t.registry, 'subtitles', { x: 0, y: 0 }, { preset, file: ['x'], safeArea: 'tiktok' });
      g = s.graph;
      const m = addNode(g, t.registry, 'merge', { x: 0, y: 0 }, { fit: 'stretch' });
      g = connect(m.graph, t.registry, { node: a.node.id, port: 'out' }, { node: m.node.id, port: 'background' });
      g = connect(g, t.registry, { node: s.node.id, port: 'image' }, { node: m.node.id, port: 'foreground' });
      const d = addNode(g, t.registry, 'dither', { x: 0, y: 0 }, { algorithm: 'bayer-4' });
      g = connect(d.graph, t.registry, { node: m.node.id, port: 'image' }, { node: d.node.id, port: 'image' });
      const img = (await t.evalGraph(g, d.node.id, { seconds: 1.2 })) as ImageValue;
      const px = await t.pixels(img);
      writePng(`subs/${preset}-dither`, { data: px.data, width: px.width, height: px.height }, false);
    }
  }, 600000);
});
