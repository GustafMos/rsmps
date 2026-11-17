import { defineNode } from '../../define';
import { srgbToOklab, type Rgb } from '../../lib/pixel-color';
import { extractPalette, samplesFromRgba } from '../../lib/pixel-extract';
import type { ImageValue, PaletteValue } from '../../types';

/** Longest side of the pictures the job reads (sprites are small; a bigger picture is only sampled). */
const SIDE = 128;
/** Most colour samples that go into one extraction (a fixed stride keeps it deterministic). */
const MAX_SAMPLES = 60_000;

interface PalJson {
  colors: Rgb[];
  pictures: number;
}

/** Most pictures one job reads when it walks every batch item of the wired chain (items x sampled moments). */
const MAX_ITEM_PULLS = 1200;

/**
 * One shared palette for a whole set of sprites. A render never sees other batch items, so the set is named here (or walked by the job):
 * the image files listed in `Sprites`, the frames of the wired clip, and / or the wired chain evaluated for EVERY batch item
 * (`ProcessCtx.pull` with `item`), which gives "one palette for the whole character set after my effect chain". A process job reads them once, pools their colors and
 * extracts ONE palette that is stored with the project; the node then serves it for every batch item and every frame.
 * Until the job has run, the stand-in is the palette of the current item alone (the wired picture at frame 0, or the current Sprites file).
 */
export default defineNode({
  id: 'batch-palette',
  title: 'Batch Palette',
  category: 'pixel',
  description:
    'One palette for a whole set of sprites, so a character set shares its colors. Pressing Process reads every image in Sprites and/or sampled frames of the wired clip once, pools their colors and extracts a single palette that is saved with the project. ' +
    'Until then it shows the palette of the current picture alone. Wire it into Palette Lock, Dither, Quantize or Palette Swap.',
  keywords: ['palette', 'shared palette', 'batch', 'character set', 'all sprites', 'extract', 'common palette', 'colors'],
  cpu: true,
  inputs: { image: { type: 'image', label: 'Image', lazy: true } },
  outputs: { palette: { type: 'palette', label: 'Palette' } },
  params: {
    source: {
      type: 'enum',
      default: 'files',
      label: 'Read from',
      options: [
        { value: 'files', label: 'Sprites files' },
        { value: 'clip', label: 'Wired clip frames' },
        { value: 'both', label: 'Both' },
        { value: 'items', label: 'Every batch item' },
      ],
    },
    sprites: { type: 'assets', default: [], accept: 'image-video', label: 'Sprites', hint: 'The pictures that share the palette (every one is read once).', visibleIf: (p) => p.source === 'files' || p.source === 'both' },
    samples: { type: 'number', default: 12, min: 1, max: 240, softMax: 48, step: 1, integer: true, label: 'Clip samples', hint: 'How many moments of the wired clip are read, evenly spread over the project length. With Every batch item: moments per item (fewer when there are very many items; at most 1200 pictures in all).', visibleIf: (p) => p.source !== 'files' },
    count: { type: 'number', default: 16, min: 2, max: 256, softMax: 64, step: 1, integer: true, label: 'Color count' },
    method: {
      type: 'enum',
      default: 'kmeans',
      label: 'Method',
      options: [
        { value: 'kmeans', label: 'K-means' },
        { value: 'median-cut', label: 'Median cut' },
      ],
    },
    sort: {
      type: 'enum',
      default: 'lightness',
      label: 'Order',
      options: [
        { value: 'none', label: 'As found' },
        { value: 'lightness', label: 'By lightness' },
      ],
    },
  },
  process: {
    title: 'Extract shared palette',
    description: 'Read every sprite and sampled clip frame once and extract one palette.',
    standIn: 'preview',
    required: 'always',
    signature: (p, sigs) => `${p.source}|${p.count}|${p.method}|${p.samples}|${p.source === 'files' || p.source === 'both' ? (p.sprites as string[]).join(',') : ''}|${p.source === 'files' ? '' : (sigs.image ?? '')}`,
    estimate: (p) => ({ frames: (p.source === 'files' || p.source === 'both' ? (p.sprites as string[]).length : 0) + (p.source === 'files' ? 0 : p.samples), note: 'small reads, a few seconds' }),
    async run(job) {
      const p = job.params;
      const pool: Rgb[] = [];
      let pictures = 0;
      const add = async (img: ImageValue) => {
        pool.push(...samplesFromRgba(await job.gpu.read(img, true)));
        pictures++;
      };
      if (p.source === 'files' || p.source === 'both') {
        const files = p.sprites as string[];
        for (let i = 0; i < files.length; i++) {
          await job.yield();
          const f = await job.host.assetFrame(files[i], 0, SIDE);
          if (!f) throw new Error('A sprite file is missing. Remove it or add it again.');
          await add({ kind: 'image', texture: f.texture, width: f.width, height: f.height, unit: 1 });
          job.progress((i + 1) / (files.length + (p.source === 'both' ? p.samples : 0)), `sprite ${i + 1}/${files.length}`);
        }
      }
      if (p.source === 'items') {
        // The wired chain for every batch item, a few moments of each: the same picture each item would export, effects included.
        const items = Math.max(1, job.item.count);
        const per = Math.max(1, Math.min(Math.round(p.samples), Math.floor(MAX_ITEM_PULLS / items)));
        const proxy = Math.min(1, SIDE / Math.max(job.canvas.width, job.canvas.height));
        for (let it = 0; it < items; it++) {
          for (let i = 0; i < per; i++) {
            await job.yield();
            const frame = Math.min(job.frames - 1, Math.floor(((i + 0.5) / per) * job.frames));
            const pulled = await job.pull('image', { frame, proxy, item: it });
            try {
              if (pulled.value && typeof pulled.value === 'object' && 'texture' in pulled.value) await add(pulled.value as ImageValue);
            } finally {
              pulled.release();
            }
            job.progress((it * per + i + 1) / (items * per), `item ${it + 1}/${items}`);
          }
        }
      } else if (p.source !== 'files') {
        const n = Math.max(1, Math.round(p.samples));
        const proxy = Math.min(1, SIDE / Math.max(job.canvas.width, job.canvas.height));
        for (let i = 0; i < n; i++) {
          await job.yield();
          const frame = Math.min(job.frames - 1, Math.floor(((i + 0.5) / n) * job.frames));
          const pulled = await job.pull('image', { frame, proxy });
          try {
            if (pulled.value && typeof pulled.value === 'object' && 'texture' in pulled.value) await add(pulled.value as ImageValue);
          } finally {
            pulled.release();
          }
          job.progress((i + 1) / n, `frame ${i + 1}/${n}`);
        }
      }
      if (!pool.length) throw new Error('There was nothing to read: add Sprites files or wire a picture.');
      const stride = Math.max(1, Math.ceil(pool.length / MAX_SAMPLES));
      const used = stride === 1 ? pool : pool.filter((_, i) => i % stride === 0);
      const colors = extractPalette(used, p.count, p.method);
      const out: PalJson = { colors, pictures };
      job.store.json('palette', out);
      return { meta: { colors: colors.length, pictures } };
    },
  },
  summary: (p) => `${p.count} colors · ${p.source === 'files' ? `${(p.sprites as string[]).length} files` : p.source === 'clip' ? `${p.samples} frames` : p.source === 'items' ? 'every item' : 'files + clip'}`,
  async render(ctx) {
    const p = ctx.params;
    const sorted = (colors: Rgb[]): PaletteValue => ({
      kind: 'palette',
      colors: p.sort === 'lightness' ? colors.map((c, i) => ({ c, i, l: srgbToOklab(c)[0] })).sort((a, b) => a.l - b.l || a.i - b.i).map((k) => k.c) : colors,
    });
    const ps = ctx.process!;
    if (ps.servable) {
      const stored = await ps.json<PalJson>('palette');
      if (stored && stored.colors.length) return { palette: sorted(stored.colors) };
    }
    // Stand-in: the palette of the current item alone.
    let image: ImageValue | null = null;
    if (p.source !== 'files') image = await ctx.pull('image', { seconds: 0 });
    if (!image && p.source !== 'clip' && p.sprites.length) {
      const id = p.sprites[ctx.item.index % p.sprites.length];
      const f = await ctx.host.assetFrame(id, 0, SIDE);
      if (f) image = { kind: 'image', texture: f.texture, width: f.width, height: f.height, unit: 1 };
    }
    if (!image) return { palette: { kind: 'palette', colors: [[0, 0, 0], [1, 1, 1]] } };
    const k = SIDE / Math.max(image.width, image.height);
    const small = k >= 1 ? image : ctx.gpu.pass({ label: 'batch-palette-downscale', size: { width: Math.max(1, Math.round(image.width * k)), height: Math.max(1, Math.round(image.height * k)) }, textures: { src: image }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }' });
    const colors = extractPalette(samplesFromRgba(await ctx.gpu.read(small, true)), p.count, p.method);
    return { palette: sorted(colors.length ? colors : [[0, 0, 0]]) };
  },
});
