import { defineNode } from '../../define';
import type { ImageValue, PaletteValue } from '../../types';
import { srgbToOklab, hexToRgb, type Rgb } from '../../lib/pixel-color';
import { extractPalette, samplesFromRgba } from '../../lib/pixel-extract';
import { BUILTIN_PALETTES, builtinPalette } from '../../lib/pixel-palettes';

const EXTRACT_SIDE = 128;

type Sort = 'none' | 'lightness' | 'hue';

function sortColors(colors: Rgb[], mode: Sort): Rgb[] {
  if (mode === 'none') return colors;
  const keyed = colors.map((c, i) => {
    const [l, a, b] = srgbToOklab(c);
    const hue = Math.atan2(b, a);
    const chroma = Math.hypot(a, b);
    // Greys have no hue: keep them first, ordered by lightness.
    return { c, i, key: mode === 'lightness' ? l : chroma < 0.03 ? -10 + l : hue };
  });
  keyed.sort((p, q) => p.key - q.key || p.i - q.i);
  return keyed.map((k) => k.c);
}

/**
 * Palette source. Three ways to get colours:
 *  - built-in: a named palette.
 *  - custom: the colours of the `custom` param (also wireable from another palette node).
 *  - extract: derive `count` colours from the image input (median-cut or k-means in OKLab).
 *
 * Extraction is CPU analysis of a <=128 px downscaled readback and is fully deterministic. For video,
 * "Lock to first frame" pulls the input at second 0, so the palette never flickers.
 */
export default defineNode({
  id: 'palette',
  title: 'Palette',
  category: 'pixel',
  description: 'Provides a colour palette: a built-in one, your own, or colours extracted from an image.',
  keywords: ['colors', 'swatch', 'extract', 'median cut', 'kmeans', 'pico-8', 'gameboy'],
  cpu: true,
  inputs: { image: { type: 'image', label: 'Image (for extract)', lazy: true } },
  outputs: { palette: { type: 'palette', label: 'Palette' } },
  params: {
    source: {
      type: 'enum',
      default: 'builtin',
      label: 'Source',
      options: [
        { value: 'builtin', label: 'Built-in' },
        { value: 'custom', label: 'Custom' },
        { value: 'extract', label: 'Extract from image' },
      ],
    },
    builtin: {
      type: 'enum',
      default: 'pico-8',
      label: 'Palette',
      options: BUILTIN_PALETTES.map((p) => ({ value: p.id, label: `${p.name} (${p.colors.length})` })),
      visibleIf: (p) => p.source === 'builtin',
    },
    custom: {
      type: 'palette',
      default: [
        [0.05, 0.05, 0.1],
        [0.35, 0.3, 0.5],
        [0.8, 0.45, 0.35],
        [0.98, 0.93, 0.8],
      ],
      label: 'Colours',
      visibleIf: (p) => p.source === 'custom',
    },
    count: { type: 'number', default: 16, min: 2, max: 64, step: 1, integer: true, label: 'Colours', visibleIf: (p) => p.source === 'extract' },
    method: {
      type: 'enum',
      default: 'kmeans',
      label: 'Method',
      options: [
        { value: 'kmeans', label: 'K-means (OKLab)' },
        { value: 'median-cut', label: 'Median cut (OKLab)' },
      ],
      visibleIf: (p) => p.source === 'extract',
    },
    frame: {
      type: 'number',
      default: 0,
      min: 0,
      max: 3600,
      step: 0.01,
      unit: 's',
      label: 'Sample at',
      hint: 'The palette is extracted once from the input at this time and stays fixed for the whole clip.',
      visibleIf: (p) => p.source === 'extract' && p.follow !== true,
    },
    follow: {
      type: 'bool',
      default: false,
      label: 'Re-extract every frame',
      hint: 'Uses the CPU on every frame and the palette may flicker. Leave off for a stable, cached palette.',
      visibleIf: (p) => p.source === 'extract',
    },
    sort: {
      type: 'enum',
      default: 'none',
      label: 'Order',
      options: [
        { value: 'none', label: 'As defined' },
        { value: 'lightness', label: 'By lightness' },
        { value: 'hue', label: 'By hue' },
      ],
    },
  },
  summary: (p) => (p.source === 'builtin' ? (builtinPalette(p.builtin)?.name ?? p.builtin) : p.source === 'custom' ? `${p.custom.length} custom` : `extract ${p.count}`),
  async render(ctx) {
    const p = ctx.params;
    let colors: Rgb[];
    if (p.source === 'builtin') {
      colors = (builtinPalette(p.builtin) ?? BUILTIN_PALETTES[0]).colors.map(hexToRgb);
    } else if (p.source === 'custom') {
      colors = p.custom.map((c) => [c[0], c[1], c[2]] as Rgb);
    } else {
      const image: ImageValue | null = p.follow ? await ctx.pull('image', { seconds: ctx.time.seconds }) : await ctx.pull('image', { seconds: p.frame });
      if (!image) colors = [[0, 0, 0], [1, 1, 1]];
      else {
        const k = EXTRACT_SIDE / Math.max(image.width, image.height);
        const small = k >= 1 ? image : ctx.gpu.pass({
          label: 'palette-downscale',
          size: { width: Math.max(1, Math.round(image.width * k)), height: Math.max(1, Math.round(image.height * k)) },
          textures: { src: image },
          wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }',
        });
        const rgba = await ctx.gpu.read(small, true);
        colors = extractPalette(samplesFromRgba(rgba), p.count, p.method);
      }
    }
    if (colors.length === 0) colors = [[0, 0, 0]];
    const value: PaletteValue = { kind: 'palette', colors: sortColors(colors, p.sort) };
    return { palette: value };
  },
});
