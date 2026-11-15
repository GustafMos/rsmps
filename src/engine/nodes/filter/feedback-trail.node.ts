import { defineNode } from '../../define';
import { pullFrames } from '../../lib/fx-video';
import type { ImageValue } from '../../types';

const BLEND = ['max', 'add', 'behind'];

export default defineNode({
  id: 'feedback-trail',
  title: 'Echo Trail',
  category: 'filter',
  description:
    'Leaves a trail of fading echoes behind the picture, each one moved, scaled, turned, recoloured and softened a little more than the last, like video feedback. Works on moving footage (echoes come from earlier frames) or on a still image (echoes are copies of it).',
  keywords: ['echo', 'trail', 'feedback', 'ghost', 'streak', 'smear', 'afterimage', 'motion trail', 'tunnel', 'video feedback', 'repeat'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    mode: {
      type: 'enum',
      default: 'time',
      label: 'Echoes come from',
      options: [
        { value: 'time', label: 'Earlier frames (moving footage)' },
        { value: 'still', label: 'Copies of this frame (no time)' },
      ],
    },
    echoes: { type: 'number', default: 8, min: 1, max: 48, softMax: 16, step: 1, integer: true, label: 'Echoes', group: 'Trail', hint: 'In "earlier frames" mode every echo re-renders the input once.' },
    spacing: { type: 'number', default: 2, min: 1, max: 48, softMax: 12, step: 1, integer: true, label: 'Frames between echoes', group: 'Trail', visibleIf: (p) => p.mode === 'time' },
    decay: { type: 'number', default: 0.75, min: 0, max: 1, step: 0.01, label: 'Fade per echo', group: 'Trail', hint: 'Each echo keeps this fraction of the previous one.' },
    blend: {
      type: 'enum',
      default: 'max',
      label: 'Blend',
      group: 'Trail',
      options: [
        { value: 'max', label: 'Lighten (bright wins)' },
        { value: 'add', label: 'Add (glowing)' },
        { value: 'behind', label: 'Behind (sprites on transparency)' },
      ],
    },
    offsetX: { type: 'number', default: 14, min: -400, max: 400, softMax: 200, step: 0.5, unit: 'px', label: 'Shift X per echo', group: 'Transform' },
    offsetY: { type: 'number', default: 0, min: -400, max: 400, softMax: 200, step: 0.5, unit: 'px', label: 'Shift Y per echo', group: 'Transform' },
    scale: { type: 'number', default: 1, min: 0.5, max: 1.5, step: 0.001, label: 'Scale per echo', group: 'Transform', hint: 'Below 1 spirals into a tunnel, above 1 blooms outward.' },
    rotation: { type: 'number', default: 0, min: -45, max: 45, step: 0.1, unit: 'deg', label: 'Turn per echo', group: 'Transform' },
    pivotX: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, unit: 'norm', label: 'Pivot X', group: 'Transform' },
    pivotY: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, unit: 'norm', label: 'Pivot Y', group: 'Transform' },
    hueShift: { type: 'number', default: 0, min: -180, max: 180, step: 1, unit: 'deg', label: 'Hue shift per echo', group: 'Colour' },
    darken: { type: 'number', default: 0.12, min: 0, max: 0.6, step: 0.01, label: 'Darken per echo', group: 'Colour', hint: 'Older echoes sink into the dark, for depth.' },
    desaturate: { type: 'number', default: 0, min: 0, max: 0.6, step: 0.01, label: 'Desaturate per echo', group: 'Colour' },
    blurGrowth: { type: 'number', default: 0, min: 0, max: 20, softMax: 8, step: 0.1, unit: 'px', label: 'Blur growth per echo', group: 'Colour' },
  },
  summary: (p) => `${p.echoes} echoes · ${p.mode === 'time' ? 'frames' : 'still'}`,
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const blend = BLEND.indexOf(p.blend);
    const rot = (p.rotation * Math.PI) / 180;
    const wgsl = /* wgsl */ `
fn xform(uv: vec2f, k: f32) -> vec2f {
  let piv = vec2f(u.pivx, u.pivy);
  let pp = (uv - piv) * u.size - u.off * k;
  let ang = -u.rot * k;
  let c = cos(ang); let s = sin(ang);
  let r = vec2f(c * pp.x - s * pp.y, s * pp.x + c * pp.y) / pow(u.scl, k);
  return piv + r / u.size;
}
fn adjust(c: vec4f, k: f32) -> vec4f {
  var s = unpremul(c);
  var hsv = rgbToHsv(s.rgb);
  hsv.x = fract(hsv.x + u.hue * k + 1.0);
  hsv.y = hsv.y * pow(1.0 - u.desat, k);
  s = vec4f(hsvToRgb(hsv) * pow(1.0 - u.dark, k), s.a);
  return premul(s) * pow(u.decay, k);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = textureSampleLevel(acc, smpNearest, uv, 0.0);
  let tuv = xform(uv, u.k);
  var e = vec4f(0.0);
  let rad = u.blur * u.k;
  if (rad > 0.4) {
    let t = 1.0 / u.size;
    e = textureSampleLevel(echo, smp, tuv, 0.0);
    for (var i = 0; i < 12; i++) {
      let ang = f32(i) * 0.5236;
      let ring = select(0.5, 1.0, (i & 1) == 0);
      e += textureSampleLevel(echo, smp, tuv + vec2f(cos(ang), sin(ang)) * rad * ring * t, 0.0);
    }
    e = e / 13.0;
  } else {
    e = textureSampleLevel(echo, smp, tuv, 0.0);
  }
  let inside = f32(all(tuv >= vec2f(0.0)) && all(tuv <= vec2f(1.0)));
  e = adjust(e, u.k) * inside;
  if (u.blend < 0.5) { return max(a, e); }
  if (u.blend < 1.5) { return min(a + e, vec4f(1.0)); }
  return a + e * (1.0 - a.a);
}`;
    let acc: ImageValue = src;
    for (let k = 1; k <= p.echoes; k++) {
      const frame = p.mode === 'time' ? await pullFrames(ctx as never, 'image', -k * Math.round(p.spacing)) : src;
      if (!frame) continue;
      acc = gpu.pass({
        label: `echo-${k}`,
        size: src,
        format: k === p.echoes ? 'rgba8unorm' : 'rgba16float',
        textures: { acc, echo: frame },
        uniforms: {
          k,
          off: [p.offsetX, p.offsetY],
          rot,
          scl: Math.max(0.05, p.scale),
          pivx: p.pivotX,
          pivy: p.pivotY,
          hue: p.hueShift / 360,
          desat: p.desaturate,
          dark: p.darken,
          decay: p.decay,
          blur: p.blurGrowth,
          blend,
        },
        wgsl,
      });
    }
    return { image: acc };
  },
});
