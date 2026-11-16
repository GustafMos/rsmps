import { defineNode } from '../../define';
import { clampProxy } from '../../lib/proxy-size';

/** WGSL for each filter: `fn enlarge(uv: vec2f) -> vec4f` over the texture `src`. All three are one pass, whatever the size. */
const ENLARGE: Record<string, string> = {
  // Exactly what the viewer's canvas does when it enlarges a proxy frame at zoom < 100 % (CSS image-rendering: auto = bilinear, texel-centre aligned).
  smooth: /* wgsl */ `
fn enlarge(uv: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }`,
  // What the viewer shows at zoom >= 100 % (image-rendering: pixelated).
  sharp: /* wgsl */ `
fn enlarge(uv: vec2f) -> vec4f { return textureSampleLevel(src, smpNearest, uv, 0.0); }`,
  // Catmull-Rom, 16 taps. Premultiplied: overshoot is clamped to [0, alpha].
  soft: /* wgsl */ `
fn crWeights(t: f32) -> vec4f {
  let t2 = t * t;
  let t3 = t2 * t;
  return vec4f(-0.5 * t3 + t2 - 0.5 * t, 1.5 * t3 - 2.5 * t2 + 1.0, -1.5 * t3 + 2.0 * t2 + 0.5 * t, 0.5 * t3 - 0.5 * t2);
}
fn enlarge(uv: vec2f) -> vec4f {
  let dims = vec2f(textureDimensions(src));
  let p = uv * dims - 0.5;
  let f = fract(p);
  let i = vec2i(floor(p));
  let wx = crWeights(f.x);
  let wy = crWeights(f.y);
  let hi = vec2i(dims) - vec2i(1);
  var acc = vec4f(0.0);
  for (var j = 0; j < 4; j++) {
    for (var k = 0; k < 4; k++) {
      let c = clamp(i + vec2i(k - 1, j - 1), vec2i(0), hi);
      acc += textureLoad(src, c, 0) * (wx[k] * wy[j]);
    }
  }
  let a = clamp(acc.a, 0.0, 1.0);
  return vec4f(clamp(acc.rgb, vec3f(0.0), vec3f(a)), a);
}`,
};

export default defineNode({
  id: 'render-scale',
  title: 'Render Scale',
  category: 'transform',
  description:
    'Renders everything before it at a lower resolution, then enlarges the result back to the full frame: the grainy, soft look of the low-resolution playback preview, kept in the export. Everything upstream gets cheaper (about scale squared) and a 4K project stays 4K.',
  keywords: ['proxy', 'preview look', 'low res', 'low resolution', 'downsample', 'resolution', 'lo-fi', 'quarter res', 'render at', 'upscale', 'keep the look', 'draft'],
  inputs: { image: { type: 'image', required: true, lazy: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    scale: {
      type: 'number',
      default: 25,
      min: 5,
      max: 100,
      step: 0.5,
      unit: '%',
      label: 'Render at',
      hint: 'The share of the full resolution the picture before this node is rendered at. Presets: 100, 75, 50, 33, 25, 12.5 (any number works; the engine goes down to 5 %). 100 does nothing.',
    },
    filter: {
      type: 'enum',
      default: 'smooth',
      options: [
        { value: 'smooth', label: 'Smooth' },
        { value: 'sharp', label: 'Sharp pixels' },
        { value: 'soft', label: 'Soft' },
      ],
      label: 'Enlarge with',
      hint: 'Smooth is the enlarging the viewer does to the playback preview (bilinear), so with the same percentage the export looks like that preview. Sharp pixels is nearest-neighbour (what the viewer shows when zoomed to 100 % or more).',
    },
    match: {
      type: 'bool',
      default: true,
      label: 'Match preview',
      hint: 'Follow the preview scale while playing. On: while the player is already rendering coarser than "Render at" (a playback proxy), this node does not go finer than that, so playback stays fast. Off: always exactly "Render at", even during playback. Paused and in exports the project is at 100 %, so the result is the same either way.',
    },
    mix: {
      type: 'number',
      default: 1,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'Mix',
      hint: '1 = only the low-resolution look. Below 1 it is blended with the true full-resolution picture, which then has to be rendered as well (slower).',
    },
  },
  summary: (p) => `${p.scale}% · ${p.filter}`,
  async render(ctx) {
    const p = ctx.params;
    const q = ctx.proxy;
    const scale = clampProxy(p.scale / 100);
    // Composition rule (docs/ENGINE.md): `scale` is an ABSOLUTE factor of the full frame. With "follow" on, the evaluation never goes finer than the
    // scope it runs in, so a Render Scale inside another one (or during a coarse playback proxy) takes the coarser of the two.
    const want = clampProxy(p.match ? Math.min(scale, q) : scale);
    const keep = p.mix < 1 ? 1 - p.mix : 0;
    const same = Math.abs(want - q) < 1e-9;

    // Nothing coarser to do (100 %, or the scope is already at or below this scale): the picture passes through untouched, zero passes.
    if (same || p.mix <= 0) return { image: await ctx.pull('image') };

    // Blending needs the true picture of this scope, which also tells the exact target size.
    const full = keep > 0 ? await ctx.pull('image') : null;
    if (keep > 0 && !full) return { image: null };
    const low = await ctx.pull('image', { proxy: want });
    if (!low) return { image: null };

    // Size and unit this image would have without the node: the low picture scaled by the ratio of the two canvases (same rounding as the engine).
    const cq = ctx.canvas;
    const cw = ctx.canvasAt(want);
    const width = full ? full.width : Math.max(1, Math.round((low.width * cq.width) / cw.width));
    const height = full ? full.height : Math.max(1, Math.round((low.height * cq.height) / cw.height));
    const unit = full ? full.unit : low.unit * (cq.unit / cw.unit);
    const withFull = !!full;
    const image = ctx.gpu.pass({
      label: `render-scale-${p.filter}${withFull ? '-mix' : ''}`,
      size: { width, height, unit },
      textures: { src: low, ...(withFull ? { fullImg: full } : {}) },
      uniforms: { amount: p.mix },
      wgsl: `${ENLARGE[p.filter] ?? ENLARGE.smooth}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let look = enlarge(uv);
  ${withFull ? 'return mix(textureSampleLevel(fullImg, smpNearest, uv, 0.0), look, u.amount);' : 'return look;'}
}`,
    });
    return { image };
  },
});
