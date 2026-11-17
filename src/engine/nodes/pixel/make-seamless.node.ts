import { defineNode } from '../../define';
import { PIXEL_SIZE_PARAM, withArtGrid } from '../../lib/art-grid';
import type { ImageValue, NodeGpu } from '../../types';

const BAYER = /* wgsl */ `
fn bayer4(x: i32, y: i32) -> f32 {
  var m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[(y & 3) * 4 + (x & 3)] + 0.5) / 16.0;
}
fn at(x: i32, y: i32) -> vec4f {
  let d = vec2i(textureDimensions(src));
  return textureLoad(src, vec2i(((x % d.x) + d.x) % d.x, ((y % d.y) + d.y) % d.y), 0);
}`;

/** Half-offset and blend along one axis: the image shifted by half its size is laid under the image, which fades out toward the two borders that must match. */
function offsetBlend(gpu: NodeGpu, src: ImageValue, ax: boolean, ay: boolean, feather: number, hard: boolean): ImageValue {
  return gpu.pass({
    label: 'make-seamless-offset',
    size: src,
    textures: { src },
    uniforms: { ax, ay, feather, hard },
    wgsl: /* wgsl */ `
${BAYER}
// 0 at the border pixel, 1 at distance fw
fn ramp(d: i32, len: i32) -> f32 {
  let fw = max(1.0, u.feather * f32(len) * 0.5);
  let t = clamp(f32(d) / fw, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let d = vec2i(textureDimensions(src));
  let x = i32(floor(px.x));
  let y = i32(floor(px.y));
  var sx = 0;
  var sy = 0;
  var m = 1.0;
  if (u.ax > 0.5) { sx = d.x / 2; m *= ramp(min(x, d.x - 1 - x), d.x); }
  if (u.ay > 0.5) { sy = d.y / 2; m *= ramp(min(y, d.y - 1 - y), d.y); }
  let a = textureLoad(src, vec2i(x, y), 0);
  let b = at(x + sx, y + sy);
  if (u.hard > 0.5) { return select(b, a, m > bayer4(x, y)); }
  return mix(b, a, m);
}`,
  });
}

/** Mirror: the second half of the picture is the mirror image of the first, so opposite borders show the same pixels. */
function mirror(gpu: NodeGpu, src: ImageValue, ax: boolean, ay: boolean): ImageValue {
  return gpu.pass({
    label: 'make-seamless-mirror',
    size: src,
    textures: { src },
    uniforms: { ax, ay },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let d = vec2i(textureDimensions(src));
  var x = i32(floor(px.x));
  var y = i32(floor(px.y));
  if (u.ax > 0.5 && x * 2 >= d.x) { x = d.x - 1 - x; }
  if (u.ay > 0.5 && y * 2 >= d.y) { y = d.y - 1 - y; }
  return textureLoad(src, vec2i(x, y), 0);
}`,
  });
}

/** Edge match along one axis: over `width` pixels each border is pulled toward the average of the two borders. */
function edgeMatch(gpu: NodeGpu, src: ImageValue, vertical: boolean, width: number, hard: boolean): ImageValue {
  return gpu.pass({
    label: 'make-seamless-edge',
    size: src,
    textures: { src },
    uniforms: { vertical, width, hard },
    wgsl: /* wgsl */ `
${BAYER}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let d = vec2i(textureDimensions(src));
  let x = i32(floor(px.x));
  let y = i32(floor(px.y));
  var pos = x;
  var len = d.x;
  if (u.vertical > 0.5) { pos = y; len = d.y; }
  let band = max(1.0, min(u.width, f32(len) * 0.5));
  let here = textureLoad(src, vec2i(x, y), 0);
  let near = f32(min(pos, len - 1 - pos));
  if (near >= band) { return here; }
  let t = 1.0 - near / band;                 // 1 on the border pixel, 0 at the edge of the band
  var first = textureLoad(src, vec2i(0, y), 0);
  var last = textureLoad(src, vec2i(d.x - 1, y), 0);
  var mirrorPos = vec2i(d.x - 1 - x, y);
  if (u.vertical > 0.5) {
    first = textureLoad(src, vec2i(x, 0), 0);
    last = textureLoad(src, vec2i(x, d.y - 1), 0);
    mirrorPos = vec2i(x, d.y - 1 - y);
  }
  if (u.hard > 0.5) {
    // pixel art: no new colors. Near the seam some pixels come from the other side.
    return select(here, textureLoad(src, mirrorPos, 0), bayer4(x, y) < 0.5 * t);
  }
  let diff = first - last;
  let low = pos * 2 < len;
  var out = here - 0.5 * diff * t;
  if (!low) { out = here + 0.5 * diff * t; }
  let a = clamp(out.a, 0.0, 1.0);
  return vec4f(clamp(out.rgb, vec3f(0.0), vec3f(a)), a);
}`,
  });
}

export default defineNode({
  id: 'make-seamless',
  title: 'Make Seamless',
  category: 'pixel',
  description:
    'Makes a picture tile: opposite borders get to match, so repeating it shows no seam. Offset blend moves the picture by half its size and fades the original over it away from the borders (the classic method: the seam is hidden in a soft cross); Mirror reflects the picture so opposite borders are the same pixels; Edge match pulls each border toward the other over a width. ' +
    'Pixel art mode never makes a new color: the blend becomes an ordered-dither cross-over. Check the result with Array: grid 3 x 3, gap 0, output size Same as input.',
  keywords: ['tileable', 'seamless', 'tile', 'wrap', 'texture', 'repeat', 'offset', 'pattern', 'edge', 'loop'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    method: {
      type: 'enum',
      default: 'offset',
      label: 'Method',
      options: [
        { value: 'offset', label: 'Offset blend' },
        { value: 'mirror', label: 'Mirror' },
        { value: 'edge', label: 'Edge match' },
      ],
    },
    axis: {
      type: 'enum',
      default: 'both',
      label: 'Axis',
      options: [
        { value: 'both', label: 'Both' },
        { value: 'x', label: 'Horizontal' },
        { value: 'y', label: 'Vertical' },
      ],
      hint: 'Horizontal makes the left and right borders match (a strip that repeats sideways).',
    },
    feather: { type: 'number', default: 0.5, min: 0.05, max: 1, step: 0.01, label: 'Feather', hint: 'How far from the borders the blend reaches, as a fraction of half the picture.', visibleIf: (p) => p.method === 'offset' },
    width: { type: 'number', default: 8, min: 1, max: 256, softMax: 64, step: 1, unit: 'px', label: 'Width', hint: 'How far from each border the picture is pulled toward its opposite border.', visibleIf: (p) => p.method === 'edge' },
    hard: { type: 'bool', default: false, label: 'Pixel art', hint: 'Never makes a new color: the cross-over is ordered dither instead of a fade. Automatic when the picture is on an art grid (after Pixelate).', visibleIf: (p) => p.method !== 'mirror' },
    pixelSize: PIXEL_SIZE_PARAM,
  },
  summary: (p) => `${p.method} · ${p.axis}`,
  render(ctx) {
    const p = ctx.params;
    const ax = p.axis !== 'y';
    const ay = p.axis !== 'x';
    const image = withArtGrid(ctx.gpu, ctx.in.image, p.pixelSize, (art, { toArt, active }) => {
      const hard = p.hard || active;
      if (p.method === 'mirror') return mirror(ctx.gpu, art, ax, ay);
      if (p.method === 'offset') {
        // One axis at a time: a combined cross would show the seams of the shifted copy at the ends of its own centre lines.
        let out = ax ? offsetBlend(ctx.gpu, art, true, false, p.feather, hard) : art;
        if (ay) {
          const prev = out;
          out = offsetBlend(ctx.gpu, out, false, true, p.feather, hard);
          if (prev !== art) ctx.gpu.recycle(prev);
        }
        return out;
      }
      const w = Math.max(1, toArt(p.width));
      let out = ax ? edgeMatch(ctx.gpu, art, false, w, hard) : art;
      if (ay) {
        const prev = out;
        out = edgeMatch(ctx.gpu, out, true, w, hard);
        if (prev !== art) ctx.gpu.recycle(prev);
      }
      return out;
    });
    return { image };
  },
});
