import { defineNode } from '../../define';
import { BRAILLE, CHARSETS, GLYPH_H, GLYPH_W, ASCII_PRINTABLE, builtinGlyph, coverage, descriptor, uniqueChars, type Glyph } from '../../lib/fx-ascii-font';
import { paletteTexture } from '../../lib/fx-util';
import type { Host, ImageValue, NodeGpu } from '../../types';
import { gaussianBlur } from '../filter/blur.node';

const MAX_GLYPHS = 256;
const HOST_W = 8;
const HOST_H = 12;
const TERMINAL: Record<string, [number, number, number, number]> = { green: [0.3, 1, 0.4, 1], amber: [1, 0.68, 0.15, 1], white: [0.92, 0.95, 1, 1] };

interface GlyphSet {
  w: number;
  h: number;
  chars: string[];
  glyphs: Glyph[];
}

/** Rasterise characters through the host (system font) into the same cell format as the built-in font. */
function hostGlyph(host: Host, font: string, ch: string): Glyph | null {
  const raster = host.rasterizeText?.bind(host);
  if (!raster) return null;
  const bmp = raster({ text: ch, font, sizePx: 32, weight: 400, italic: false, align: 'left', lineHeight: 1, maxWidthPx: 128 });
  if (!bmp || bmp.width <= 0 || bmp.height <= 0) return null;
  const out = new Float32Array(HOST_W * HOST_H);
  const s = HOST_H / bmp.height;
  const tw = Math.min(HOST_W, bmp.width * s);
  const x0 = (HOST_W - tw) / 2;
  for (let y = 0; y < HOST_H; y++)
    for (let x = 0; x < HOST_W; x++) {
      // area average of the source pixels covered by this cell pixel
      const sx0 = ((x - x0) / tw) * bmp.width;
      const sx1 = ((x + 1 - x0) / tw) * bmp.width;
      const sy0 = (y / HOST_H) * bmp.height;
      const sy1 = ((y + 1) / HOST_H) * bmp.height;
      if (sx1 <= 0 || sx0 >= bmp.width) continue;
      let sum = 0;
      let n = 0;
      for (let yy = Math.floor(sy0); yy < Math.min(bmp.height, Math.ceil(sy1)); yy++)
        for (let xx = Math.max(0, Math.floor(sx0)); xx < Math.min(bmp.width, Math.ceil(sx1)); xx++) { sum += bmp.data[(yy * bmp.width + xx) * 4 + 3] / 255; n++; }
      out[y * HOST_W + x] = n ? sum / n : 0;
    }
  return out;
}

function buildGlyphSet(chars: string[], host: Host, font: string): GlyphSet {
  const useHost = font.trim() !== '' && !!host.rasterizeText;
  const w = useHost ? HOST_W : GLYPH_W;
  const h = useHost ? HOST_H : GLYPH_H;
  const list: { ch: string; g: Glyph; c: number }[] = [];
  for (const ch of chars) {
    const glyph = useHost ? hostGlyph(host, font, ch) ?? (ch === ' ' ? new Float32Array(w * h) : null) : builtinGlyph(ch);
    if (glyph) list.push({ ch, g: glyph, c: coverage(glyph) });
  }
  if (useHost && list.length === 0) return buildGlyphSet(chars, host, '');
  list.sort((a, b) => a.c - b.c);
  let pick = list;
  if (list.length > MAX_GLYPHS) pick = Array.from({ length: MAX_GLYPHS }, (_, i) => list[Math.round((i * (list.length - 1)) / (MAX_GLYPHS - 1))]);
  if (pick.length === 0) {
    const sp = new Float32Array(w * h);
    pick = [{ ch: ' ', g: sp, c: 0 }];
  }
  return { w, h, chars: pick.map((p) => p.ch), glyphs: pick.map((p) => p.g) };
}

/** Characters of the chosen charset, restricted to what the built-in font can draw. */
export function charsetChars(charset: string, custom: string, hostFont: boolean): string[] {
  const src = charset === 'custom' ? custom || CHARSETS.classic : CHARSETS[charset] ?? CHARSETS.classic;
  const chars = uniqueChars(src, (ch) => (hostFont ? true : !!builtinGlyph(ch)));
  if (!chars.includes(' ') && charset !== 'custom' && charset !== 'braille' && charset !== 'binary' && charset !== 'digits' && charset !== 'letters') chars.unshift(' ');
  return chars;
}

function buildTextures(gpu: NodeGpu, set: GlyphSet) {
  const G = set.glyphs.length;
  const atlas = new Float32Array(G * set.w * set.h * 4);
  set.glyphs.forEach((g, i) => {
    for (let y = 0; y < set.h; y++) for (let x = 0; x < set.w; x++) atlas[(y * G * set.w + i * set.w + x) * 4] = g[y * set.w + x];
  });
  let mx = 0.0001;
  const descs = set.glyphs.map((g) => descriptor(g, set.w, set.h, 3));
  for (const d of descs) mx = Math.max(mx, d.reduce((a, b) => a + b, 0) / 9);
  const desc = new Float32Array(G * 3 * 4);
  descs.forEach((d, i) => {
    const n = Array.from(d, (v) => Math.min(1, v / mx));
    const mean = n.reduce((a, b) => a + b, 0) / 9;
    const base = i * 12;
    for (let k = 0; k < 8; k++) desc[base + k] = n[k];
    desc[base + 8] = n[8];
    desc[base + 9] = mean;
  });
  return { atlas: gpu.dataTexture(atlas, G * set.w, set.h), desc: gpu.dataTexture(desc, G * 3, 1) };
}

export default defineNode({
  id: 'ascii-art',
  title: 'ASCII Art',
  category: 'stylize',
  description:
    'Redraws the picture as a grid of text characters. Pick a character set (classic ramp, blocks, braille dots, digits, your own text), match by brightness or by the shape of each cell so edges become / \\ | and _, and colour it like the source, one ink, a palette or a green terminal. Also outputs the glyphs as a mask.',
  keywords: ['ascii', 'text', 'characters', 'terminal', 'matrix', 'console', 'braille', 'typewriter', 'letters', 'code', 'hacker', 'monospace', 'glyph'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' }, mask: { type: 'mask', label: 'Glyph mask' } },
  maskable: true,
  params: {
    charset: {
      type: 'enum',
      default: 'classic',
      label: 'Characters',
      options: [
        { value: 'classic', label: 'Classic ramp  .:-=+*#%@' },
        { value: 'long', label: 'Long ramp (70 levels)' },
        { value: 'blocks', label: 'Blocks  ░▒▓█' },
        { value: 'braille', label: 'Braille dots (256 patterns)' },
        { value: 'lines', label: 'Line pieces  - _ | / \\ +' },
        { value: 'binary', label: 'Binary 0 1' },
        { value: 'digits', label: 'Digits' },
        { value: 'letters', label: 'Letters only' },
        { value: 'all', label: 'Every printable character' },
        { value: 'custom', label: 'My own characters' },
      ],
    },
    custom: { type: 'string', default: ' .oO@', label: 'My characters', visibleIf: (p) => p.charset === 'custom', hint: 'Any text. The characters are sorted by how much ink they use, so it works as a light-to-dark ramp whatever you type.' },
    font: { type: 'string', kind: 'font', default: '', label: 'Font', hint: 'Empty = the built-in bitmap font (works everywhere, identical every time). Choose a system font to use its glyphs when the app can draw text.' },
    cellSize: { type: 'number', default: 8, min: 3, max: 120, softMax: 48, step: 0.5, unit: 'px', label: 'Character width', group: 'Grid', hint: 'Width of one character cell. The height follows the font shape.' },
    output: {
      type: 'enum',
      default: 'same',
      label: 'Output size',
      group: 'Grid',
      options: [
        { value: 'same', label: 'Same as the picture' },
        { value: 'native', label: 'Exact character grid (crisp export)' },
      ],
    },
    scale: { type: 'number', default: 2, min: 1, max: 16, softMax: 8, step: 1, integer: true, label: 'Pixels per font pixel', group: 'Grid', visibleIf: (p) => p.output === 'native' },
    match: {
      type: 'enum',
      default: 'brightness',
      label: 'Choose characters by',
      group: 'Matching',
      options: [
        { value: 'brightness', label: 'Brightness (ramp)' },
        { value: 'shape', label: 'Shape (edges become / \\ | _)' },
      ],
    },
    edgeBoost: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Favour edges', group: 'Matching', visibleIf: (p) => p.match === 'shape', hint: 'Higher = in busy cells the line shape matters more than the average brightness.' },
    contrast: { type: 'number', default: 1.2, min: 0.2, max: 4, step: 0.01, label: 'Contrast', group: 'Matching' },
    gamma: { type: 'number', default: 1, min: 0.2, max: 3, step: 0.01, label: 'Gamma', group: 'Matching', hint: 'Above 1 uses fewer dense characters.' },
    brightness: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Brightness', group: 'Matching' },
    invert: { type: 'bool', default: false, label: 'Invert (dark picture parts get dense characters)', group: 'Matching' },
    colorMode: {
      type: 'enum',
      default: 'source',
      label: 'Colour',
      group: 'Colour',
      options: [
        { value: 'source', label: 'From the picture' },
        { value: 'ink', label: 'One ink colour' },
        { value: 'palette', label: 'Nearest palette colour' },
        { value: 'terminal', label: 'Terminal (green / amber / white)' },
      ],
    },
    terminal: {
      type: 'enum',
      default: 'green',
      label: 'Terminal colour',
      group: 'Colour',
      options: [
        { value: 'green', label: 'Green phosphor' },
        { value: 'amber', label: 'Amber' },
        { value: 'white', label: 'White' },
      ],
      visibleIf: (p) => p.colorMode === 'terminal',
    },
    ink: { type: 'color', default: [0.95, 0.95, 0.95, 1], label: 'Ink colour', group: 'Colour', visibleIf: (p) => p.colorMode === 'ink' },
    palette: {
      type: 'palette',
      default: [[0.04, 0.04, 0.1], [0.9, 0.2, 0.4], [0.25, 0.75, 0.9], [0.98, 0.9, 0.5], [1, 1, 1]],
      label: 'Palette',
      group: 'Colour',
      visibleIf: (p) => p.colorMode === 'palette',
    },
    inkGain: { type: 'number', default: 1.5, min: 0.5, max: 3, step: 0.01, label: 'Colour boost', group: 'Colour', visibleIf: (p) => p.colorMode === 'source' || p.colorMode === 'palette' },
    background: {
      type: 'enum',
      default: 'black',
      label: 'Background',
      group: 'Colour',
      options: [
        { value: 'black', label: 'Black' },
        { value: 'color', label: 'A colour' },
        { value: 'blurred', label: 'The picture, blurred and dimmed' },
        { value: 'transparent', label: 'Transparent' },
      ],
    },
    backgroundColor: { type: 'color', default: [0.02, 0.03, 0.05, 1], label: 'Background colour', group: 'Colour', visibleIf: (p) => p.background === 'color' },
    glow: { type: 'number', default: 0, min: 0, max: 3, step: 0.01, label: 'Glow', group: 'Colour', hint: 'Soft light around the characters, like a monitor.' },
  },
  summary: (p) => `${p.charset} · ${p.match} · ${p.cellSize} px`,
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const hostFont = p.font.trim() !== '' && !!ctx.host.rasterizeText;
    const chars = charsetChars(p.charset, p.custom, hostFont);
    const set = buildGlyphSet(chars, ctx.host, p.font);
    const G = set.glyphs.length;
    const { atlas, desc } = buildTextures(gpu, set);

    // grid
    const cellW = Math.max(2, p.cellSize);
    const cellH = (cellW * set.h) / set.w;
    const cols = Math.max(1, Math.floor(src.width / cellW));
    const rows = Math.max(1, Math.floor(src.height / cellH));
    const native = p.output === 'native';
    const outW = native ? cols * set.w * Math.round(p.scale) : src.width;
    const outH = native ? rows * set.h * Math.round(p.scale) : src.height;
    const out = { width: outW, height: outH, unit: src.unit * (outW / src.width) };
    const cellPx = [outW / cols, outH / rows];
    const grid = { width: cols, height: rows, unit: 1 };

    // 1. per-cell colour (mean of a 4x4 grid of taps) and character slot
    const cellCol = gpu.pass({
      label: 'ascii-colour',
      size: grid,
      format: 'rgba16float',
      textures: { src },
      uniforms: {},
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let cell = vec2f(1.0) / u.size;
  var acc = vec4f(0.0);
  for (var j = 0; j < 4; j++) { for (var i = 0; i < 4; i++) {
    acc += textureSampleLevel(src, smp, uv + (vec2f(f32(i), f32(j)) / 4.0 + 0.125 - 0.5) * cell, 0.0);
  } }
  return acc / 16.0;
}`,
    });
    const slot = gpu.pass({
      label: 'ascii-match',
      size: grid,
      format: 'rgba16float',
      textures: { src, desc },
      uniforms: {
        G,
        shape: p.match === 'shape',
        contrast: p.contrast,
        gamma: p.gamma,
        bright: p.brightness,
        invert: p.invert,
        edge: p.edgeBoost,
      },
      wgsl: /* wgsl */ `
fn tone(l: f32) -> f32 {
  var v = clamp((l - 0.5) * u.contrast + 0.5 + u.bright, 0.0, 1.0);
  v = pow(v, u.gamma);
  return select(v, 1.0 - v, u.invert > 0.5);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let cell = vec2f(1.0) / u.size;
  var t: array<f32, 9>;
  var mean = 0.0;
  var lo = 1.0; var hi = 0.0;
  for (var j = 0; j < 3; j++) { for (var i = 0; i < 3; i++) {
    var acc = 0.0;
    for (var b = 0; b < 2; b++) { for (var a = 0; a < 2; a++) {
      let q = uv + ((vec2f(f32(i), f32(j)) + (vec2f(f32(a), f32(b)) + 0.5) * 0.5) / 3.0 - 0.5) * cell;
      let s = textureSampleLevel(src, smp, q, 0.0);
      acc += luma(s.rgb) + (1.0 - s.a) * 0.0;
    } }
    let v = tone(acc / 4.0);
    t[j * 3 + i] = v;
    mean += v / 9.0;
    lo = min(lo, v); hi = max(hi, v);
  } }
  var best = 0;
  if (u.shape < 0.5) {
    best = clamp(i32(floor(mean * (u.G - 1.0) + 0.5)), 0, i32(u.G) - 1);
  } else {
    let n = i32(u.G);
    let ws = 1.0 + u.edge * 6.0 * (hi - lo);
    var bestCost = 1e9;
    for (var g = 0; g < n; g++) {
      let d0 = textureLoad(desc, vec2i(g * 3, 0), 0);
      let d1 = textureLoad(desc, vec2i(g * 3 + 1, 0), 0);
      let d2 = textureLoad(desc, vec2i(g * 3 + 2, 0), 0);
      let e = vec4f(t[0] - d0.x, t[1] - d0.y, t[2] - d0.z, t[3] - d0.w);
      let f = vec4f(t[4] - d1.x, t[5] - d1.y, t[6] - d1.z, t[7] - d1.w);
      let h = t[8] - d2.x;
      let structure = dot(e, e) + dot(f, f) + h * h;
      let md = mean - d2.y;
      let cost = ws * structure + 9.0 * md * md * 2.0;
      if (cost < bestCost) { bestCost = cost; best = g; }
    }
  }
  return vec4f(f32(best), mean, 0.0, 1.0);
}`,
    });

    // 2. draw the glyphs
    const colorMode = p.colorMode === 'source' ? 0 : p.colorMode === 'palette' ? 2 : 1;
    const inkColor = p.colorMode === 'terminal' ? TERMINAL[p.terminal] : p.ink;
    const bgMode = p.colorMode === 'terminal' ? 0 : ['black', 'color', 'blurred', 'transparent'].indexOf(p.background);
    const bgColor = p.colorMode === 'terminal' && p.background === 'transparent' ? [0, 0, 0, 0] : p.background === 'color' ? p.backgroundColor : p.background === 'transparent' ? [0, 0, 0, 0] : [0, 0, 0, 1];
    const blurred = p.background === 'blurred' && p.colorMode !== 'terminal' ? gaussianBlur(gpu, src, cellW * 1.2) : null;
    const pal = p.colorMode === 'palette' && p.palette.length > 0 ? paletteTexture(gpu, p.palette) : null;
    const render = (asMask: boolean) => ({
      size: out,
      textures: { atlas, slot, cellCol, blurred, pal },
      uniforms: {
        cols,
        rows,
        gw: set.w,
        gh: set.h,
        cellPx,
        colorMode: pal || colorMode !== 2 ? colorMode : 0,
        ink: inkColor,
        bgMode,
        bg: bgColor,
        gain: p.inkGain,
        sharp: Math.max(1, cellPx[0] / set.w),
        palN: Math.max(1, p.palette.length),
        G,
      },
      wgsl: /* wgsl */ `
fn atlasAt(slot: i32, x: i32, y: i32) -> f32 {
  return textureLoad(atlas, vec2i(slot * i32(u.gw) + clamp(x, 0, i32(u.gw) - 1), clamp(y, 0, i32(u.gh) - 1)), 0).r;
}
fn cover(slot: i32, g: vec2f) -> f32 {
  let f = g - 0.5;
  let i0 = vec2i(floor(f));
  let w = fract(f);
  let a = mix(atlasAt(slot, i0.x, i0.y), atlasAt(slot, i0.x + 1, i0.y), w.x);
  let b = mix(atlasAt(slot, i0.x, i0.y + 1), atlasAt(slot, i0.x + 1, i0.y + 1), w.x);
  return clamp((mix(a, b, w.y) - 0.5) * u.sharp + 0.5, 0.0, 1.0);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let cellF = px / u.cellPx;
  let ci = vec2i(clamp(floor(cellF), vec2f(0.0), vec2f(u.cols - 1.0, u.rows - 1.0)));
  let local = clamp(cellF - vec2f(ci), vec2f(0.0), vec2f(0.9999));
  let s = textureLoad(slot, ci, 0);
  let cc = textureLoad(cellCol, ci, 0);
  let sl = i32(s.r + 0.5);
  var cov = cover(sl, local * vec2f(u.gw, u.gh)) * cc.a;
  ${asMask ? 'return vec4f(cov, cov, cov, 1.0);' : ''}
  var inkc = u.ink.rgb;
  if (u.colorMode < 0.5) {
    let c = select(vec3f(0.0), cc.rgb / cc.a, cc.a > 0.001);
    inkc = clamp(c * u.gain, vec3f(0.0), vec3f(1.0));
  } else if (u.colorMode > 1.5) {
    ${pal ? `
    let c = select(vec3f(0.0), cc.rgb / cc.a, cc.a > 0.001);
    var best = 1e9;
    var pick = vec3f(0.0);
    for (var i = 0; i < i32(u.palN); i++) {
      let pc = textureLoad(pal, vec2i(i, 0), 0).rgb;
      let d = dot(pc - c, pc - c);
      if (d < best) { best = d; pick = pc; }
    }
    inkc = pick;
    ` : ''}
  }
  var bgc = vec4f(u.bg.rgb * u.bg.a, u.bg.a);
  ${blurred ? 'if (u.bgMode > 1.5 && u.bgMode < 2.5) { bgc = textureSampleLevel(blurred, smp, uv, 0.0) * 0.35; }' : ''}
  let ia = cov * u.ink.a;
  return vec4f(inkc * ia + bgc.rgb * (1.0 - ia), ia + bgc.a * (1.0 - ia));
}`,
    });
    let image = gpu.pass({ label: 'ascii-draw', ...render(false) }) as ImageValue;
    const mask = gpu.passMask({ label: 'ascii-mask', ...render(true) });
    if (p.glow > 0) {
      const halo = gaussianBlur(gpu, image, cellPx[1] * 1.1);
      image = gpu.pass({
        label: 'ascii-glow',
        size: out,
        textures: { image, halo },
        uniforms: { glow: p.glow },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = textureSampleLevel(image, smpNearest, uv, 0.0);
  let h = textureSampleLevel(halo, smp, uv, 0.0);
  let o = a + h * u.glow * 0.8;
  return vec4f(min(o.rgb, vec3f(1.0)), min(max(o.a, a.a), 1.0));
}`,
      });
    }
    void BRAILLE;
    void ASCII_PRINTABLE;
    return { image, mask };
  },
});
