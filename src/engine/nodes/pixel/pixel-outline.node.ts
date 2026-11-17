import { defineNode } from '../../define';
import { withArtGrid } from '../../lib/art-grid';
import { BUILTIN_PALETTES, builtinPalette } from '../../lib/pixel-palettes';
import { hexToRgb, type Rgb } from '../../lib/pixel-color';
import { PALETTE_WGSL, SPACE_INDEX, clampPalette, paletteTexture } from '../../lib/pixel-gpu';
import type { ImageValue, NodeGpu } from '../../types';

interface OutlinePass {
  width: number;
  eight: boolean;
  outer: boolean;
  inner: boolean;
  sides: [number, number, number, number];
  colorMode: 0 | 1 | 2;
  color: [number, number, number, number];
  darken: number;
  palette: Rgb[] | null;
}

/** One outline pass on an art-size image. Integer pixel maths only: the alpha silhouette is the half-covered threshold of the picture. */
export function outlinePass(gpu: NodeGpu, src: ImageValue, o: OutlinePass): ImageValue {
  const pal = o.palette && o.palette.length ? paletteTexture(gpu, o.palette, 'oklab') : null;
  return gpu.pass({
    label: 'pixel-outline',
    size: src,
    textures: { src, pal },
    uniforms: {
      wd: o.width,
      eight: o.eight,
      outer: o.outer,
      inner: o.inner,
      sides: o.sides,
      colorMode: o.colorMode,
      color: o.color,
      darken: o.darken,
      palCount: o.palette?.length ?? 0,
      colorSpace: SPACE_INDEX.oklab,
    },
    wgsl: /* wgsl */ `
${pal ? PALETTE_WGSL : ''}
// alpha of an integer pixel; -1 outside the picture
fn A(x: i32, y: i32) -> f32 {
  let d = vec2i(textureDimensions(src));
  if (x < 0 || y < 0 || x >= d.x || y >= d.y) { return -1.0; }
  return textureLoad(src, vec2i(x, y), 0).a;
}
fn C(x: i32, y: i32) -> vec3f { return unpremul(textureLoad(src, vec2i(x, y), 0)).rgb; }
// Is the neighbour at offset (dx, dy) on a side the user switched on? sides = top, bottom, left, right (where the OUTLINE sits).
fn sideOn(dx: i32, dy: i32) -> bool {
  return (dy > 0 && u.sides.x > 0.5) || (dy < 0 && u.sides.y > 0.5) || (dx > 0 && u.sides.z > 0.5) || (dx < 0 && u.sides.w > 0.5);
}
fn dist(dx: i32, dy: i32) -> i32 {
  if (u.eight > 0.5) { return max(abs(dx), abs(dy)); }
  return abs(dx) + abs(dy);
}
fn tint(base: vec3f) -> vec3f {
  var c = u.color.rgb;
  if (u.colorMode > 0.5) { c = base * (1.0 - u.darken); }
  ${pal ? `if (u.colorMode > 1.5) { c = palSrgb(nearestIdx(toSpace(base * (1.0 - u.darken)))); }` : ''}
  return c;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let x = i32(floor(px.x));
  let y = i32(floor(px.y));
  let s = textureLoad(src, vec2i(x, y), 0);
  let n = i32(u.wd);
  if (s.a < 0.5) {
    if (u.outer < 0.5) { return s; }
    // nearest opaque neighbour (scan order breaks ties, so the result never depends on anything else)
    var best = 1000;
    var bc = vec3f(0.0);
    for (var dy = -n; dy <= n; dy++) {
      for (var dx = -n; dx <= n; dx++) {
        let d = dist(dx, dy);
        if (d == 0 || d > n || d >= best) { continue; }
        if (A(x + dx, y + dy) >= 0.5 && sideOn(dx, dy)) { best = d; bc = C(x + dx, y + dy); }
      }
    }
    if (best == 1000) { return s; }
    return premul(vec4f(tint(bc), u.color.a));
  }
  if (u.inner < 0.5) { return s; }
  // inside: an opaque pixel with an empty pixel within reach (the picture's border does not count as empty)
  var hit = false;
  for (var dy = -n; dy <= n; dy++) {
    for (var dx = -n; dx <= n; dx++) {
      let d = dist(dx, dy);
      if (d == 0 || d > n) { continue; }
      let a = A(x + dx, y + dy);
      if (a >= 0.0 && a < 0.5 && sideOn(-dx, -dy)) { hit = true; }
    }
  }
  if (!hit) { return s; }
  return premul(vec4f(tint(C(x, y)), u.color.a));
}`,
  });
}

export default defineNode({
  id: 'pixel-outline',
  title: 'Pixel Outline',
  category: 'pixel',
  description:
    'A hard pixel outline around the alpha silhouette of a sprite: outside, inside or both, 4- or 8-connected (corners), a fixed color, a darkened copy of the neighboring color (selective outline) or the nearest palette color, only on chosen sides (a drop-shadow style edge), with an optional second outline. ' +
    'Works on the art grid, one art pixel at a time. For a smooth, anti-aliased stroke use Sprite Outline.',
  keywords: ['outline', 'stroke', 'border', 'selout', 'selective outline', 'sprite', 'silhouette', 'edge', 'pixel art', 'contour'],
  inputs: { image: { type: 'image', required: true, label: 'Image' }, palette: { type: 'palette', label: 'Palette' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    position: {
      type: 'enum',
      default: 'outside',
      label: 'Position',
      options: [
        { value: 'outside', label: 'Outside' },
        { value: 'inside', label: 'Inside' },
        { value: 'both', label: 'Both' },
      ],
    },
    width: { type: 'number', default: 1, min: 1, max: 16, softMax: 6, step: 1, integer: true, unit: 'px', label: 'Width', hint: 'In art pixels.' },
    connect: {
      type: 'enum',
      default: 'eight',
      label: 'Corners',
      options: [
        { value: 'four', label: '4-connected' },
        { value: 'eight', label: '8-connected' },
      ],
      hint: '8-connected also outlines diagonal neighbors, so corners are filled. 4-connected leaves the corner pixel out (a rounder, thinner look).',
    },
    colorMode: {
      type: 'enum',
      default: 'fixed',
      label: 'Color from',
      options: [
        { value: 'fixed', label: 'One color' },
        { value: 'selective', label: 'Darker neighbor' },
        { value: 'palette', label: 'Palette' },
      ],
      hint: 'Darker neighbor: each outline pixel takes the color of the sprite pixel it touches, darkened (selective outline). Palette: that darkened color, snapped to the wired palette (or the built-in one below).',
    },
    color: { type: 'color', default: [0.05, 0.03, 0.1, 1], label: 'Color', visibleIf: (p) => p.colorMode === 'fixed' },
    darken: { type: 'number', default: 0.55, min: 0, max: 1, step: 0.01, label: 'Darken', visibleIf: (p) => p.colorMode !== 'fixed' },
    builtin: {
      type: 'enum',
      default: 'pico-8',
      label: 'Palette',
      options: BUILTIN_PALETTES.map((b) => ({ value: b.id, label: b.name })),
      hint: 'Used when no palette is wired.',
      visibleIf: (p) => p.colorMode === 'palette',
    },
    opacity: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Opacity', visibleIf: (p) => p.colorMode !== 'fixed' },
    top: { type: 'bool', default: true, label: 'Top', group: 'Sides', hint: 'Outline pixels above the sprite.' },
    bottom: { type: 'bool', default: true, label: 'Bottom', group: 'Sides' },
    left: { type: 'bool', default: true, label: 'Left', group: 'Sides' },
    right: { type: 'bool', default: true, label: 'Right', group: 'Sides', hint: 'Only Bottom and Right on gives a drop-shadow style edge.' },
    second: { type: 'bool', default: false, label: 'Second outline', group: 'Second' },
    color2: { type: 'color', default: [1, 1, 1, 1], label: 'Second color', group: 'Second', visibleIf: (p) => p.second === true },
    width2: { type: 'number', default: 1, min: 1, max: 16, softMax: 6, step: 1, integer: true, unit: 'px', label: 'Second width', group: 'Second', visibleIf: (p) => p.second === true },
  },
  summary: (p) => `${p.position} ${p.width} px · ${p.connect === 'eight' ? '8' : '4'}-way${p.second ? ' + second' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const wired = ctx.in.palette?.colors as Rgb[] | undefined;
    const palette = p.colorMode === 'palette' ? clampPalette(wired && wired.length ? wired : (builtinPalette(p.builtin) ?? BUILTIN_PALETTES[0]).colors.map(hexToRgb)) : null;
    const image = withArtGrid(ctx.gpu, ctx.in.image, 0, (art, { toArt }) => {
      const sides: [number, number, number, number] = [p.top ? 1 : 0, p.bottom ? 1 : 0, p.left ? 1 : 0, p.right ? 1 : 0];
      const first = outlinePass(ctx.gpu, art, {
        width: Math.max(1, Math.round(toArt(p.width))),
        eight: p.connect === 'eight',
        outer: p.position !== 'inside',
        inner: p.position !== 'outside',
        sides,
        colorMode: p.colorMode === 'fixed' ? 0 : p.colorMode === 'selective' ? 1 : 2,
        color: p.colorMode === 'fixed' ? p.color : [0, 0, 0, p.opacity],
        darken: p.darken,
        palette,
      });
      if (!p.second) return first;
      const second = outlinePass(ctx.gpu, first, {
        width: Math.max(1, Math.round(toArt(p.width2))),
        eight: p.connect === 'eight',
        outer: true,
        inner: false,
        sides,
        colorMode: 0,
        color: p.color2,
        darken: 0,
        palette: null,
      });
      ctx.gpu.recycle(first);
      return second;
    });
    return { image };
  },
});
