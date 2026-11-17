import { defineNode } from '../../define';
import { crispResize, gridCell, withArtGrid } from '../../lib/art-grid';
import { countAgainstPalette, pack8 } from '../../lib/palette-lock';
import { hexToRgb, type Rgb } from '../../lib/pixel-color';
import { BUILTIN_PALETTES, builtinPalette } from '../../lib/pixel-palettes';
import { PALETTE_WGSL, SPACE_INDEX, clampPalette, paletteTexture } from '../../lib/pixel-gpu';
import type { ImageValue, NodeGpu } from '../../types';

/** Longest side of the picture a count reads back (a point-sampled copy of the art grid). Pictures up to this size are counted exactly. */
const COUNT_SIDE = 128;

/** Memo of counts: a pure function of (node, upstream structure, frame, palette, mode). */
const COUNTS = new Map<string, { off: number; colors: number }>();

async function count(gpu: NodeGpu, image: ImageValue, palette: Rgb[], exact: boolean): Promise<{ off: number; colors: number }> {
  const cell = gridCell(image);
  const aw = Math.max(1, Math.round(image.width / cell));
  const ah = Math.max(1, Math.round(image.height / cell));
  const k = exact ? 1 : Math.min(1, COUNT_SIDE / Math.max(aw, ah));
  const w = Math.max(1, Math.round(aw * k));
  const h = Math.max(1, Math.round(ah * k));
  const small = w === image.width && h === image.height ? image : crispResize(gpu, image, { width: w, height: h, unit: 1 });
  const px = await gpu.read(small, true);
  const c = countAgainstPalette(px, palette);
  return { off: c.opaque ? c.off / c.opaque : 0, colors: c.colors };
}

export default defineNode({
  id: 'palette-lock',
  title: 'Palette Lock',
  category: 'pixel',
  description:
    'Keeps a picture on a palette: every pixel snaps to the nearest palette color (measured in OKLab), or the pixels that are off the palette are painted magenta so you can find them, or nothing changes and the node only reports. The numbers say how much of the picture was off the palette and how many colors it uses. ' +
    'No dithering here: use Dither or Quantize for that. With a Palette node wired to several nodes (or Batch Palette) a whole set of sprites shares one palette.',
  keywords: ['palette', 'restrict', 'snap', 'shared palette', 'off palette', 'validate', 'lock', 'check', 'colors', 'limit', 'game'],
  cpu: true,
  optionalOutputs: ['offPalette', 'colors'],
  inputs: { image: { type: 'image', required: true, label: 'Image' }, palette: { type: 'palette', label: 'Palette' } },
  outputs: {
    image: { type: 'image', label: 'Image' },
    offPalette: { type: 'number', label: 'Off palette' },
    colors: { type: 'number', label: 'Colors' },
  },
  maskable: true,
  params: {
    mode: {
      type: 'enum',
      default: 'snap',
      label: 'Mode',
      options: [
        { value: 'snap', label: 'Snap to palette' },
        { value: 'highlight', label: 'Highlight off-palette' },
        { value: 'report', label: 'Report only' },
      ],
      hint: 'Report only passes the picture through unchanged and counts exactly (a full read of the picture, cached). The other modes count a picture of at most 128 pixels on its longest side, which is exact for sprites up to that size and only read when a number output is used.',
    },
    builtin: { type: 'enum', default: 'pico-8', label: 'Palette', options: BUILTIN_PALETTES.map((b) => ({ value: b.id, label: b.name })), hint: 'Used when no palette is wired.' },
    marker: { type: 'color', default: [1, 0, 1, 1], label: 'Marker color', visibleIf: (p) => p.mode === 'highlight' },
  },
  summary: (p) => p.mode,
  async render(ctx) {
    const p = ctx.params;
    const input = ctx.in.image;
    const wired = ctx.in.palette?.colors as Rgb[] | undefined;
    const palette = clampPalette(wired && wired.length ? wired : (builtinPalette(p.builtin) ?? BUILTIN_PALETTES[0]).colors.map(hexToRgb));
    const gpu = ctx.gpu;

    let image: ImageValue = input;
    if (p.mode !== 'report') {
      image = withArtGrid(gpu, input, 0, (art) =>
        gpu.pass({
          label: 'palette-lock',
          size: art,
          textures: { src: art, pal: paletteTexture(gpu, palette, 'oklab') },
          uniforms: { palCount: palette.length, colorSpace: SPACE_INDEX.oklab, highlight: p.mode === 'highlight', marker: p.marker },
          wgsl: /* wgsl */ `
${PALETTE_WGSL}
fn onPalette(c: vec3f, a: f32) -> bool {
  let tol = select(2.0, 0.5, a > 0.999) / 255.0;
  let n = i32(u.palCount);
  for (var i = 0; i < n; i++) {
    let d = abs(palSrgb(i) - c);
    if (max(d.x, max(d.y, d.z)) <= tol) { return true; }
  }
  return false;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  if (s.a <= 0.0001) { return s; }
  let c = s.rgb / s.a;
  if (u.highlight > 0.5) {
    if (onPalette(c, s.a)) { return s; }
    return premul(vec4f(u.marker.rgb, s.a));
  }
  return premul(vec4f(palSrgb(nearestIdx(toSpace(c))), s.a));
}`,
        }),
      );
    }

    const out: Record<string, unknown> = { image };
    if (ctx.wants('offPalette') || ctx.wants('colors')) {
      const key = `${ctx.nodeId}|${ctx.inputSignature('image')}|${ctx.inputVaries('image') ? ctx.time.frame : 0}|${p.mode}|${palette.map(pack8).join(',')}|${ctx.item.index}`;
      let c = COUNTS.get(key);
      if (!c) {
        const exact = p.mode === 'report';
        const off = await count(gpu, input, palette, exact);
        // Snap mode: the colors that leave the node are the snapped ones.
        const colors = p.mode === 'snap' ? (await count(gpu, image, palette, false)).colors : off.colors;
        c = { off: off.off, colors };
        COUNTS.set(key, c);
        if (COUNTS.size > 256) COUNTS.delete(COUNTS.keys().next().value as string);
      }
      out.offPalette = c.off;
      out.colors = c.colors;
    } else {
      out.offPalette = 0;
      out.colors = 0;
    }
    return out as { image: ImageValue; offPalette: number; colors: number };
  },
});
