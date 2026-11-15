import { defineNode } from '../../define';
import type { ImageValue } from '../../types';

const KEYS = ['brightness', 'hue', 'saturation', 'red', 'green', 'blue'];

export default defineNode({
  id: 'pixel-sort',
  title: 'Pixel Sort',
  category: 'filter',
  description:
    'The glitch classic: runs of pixels whose brightness falls inside a window are sorted along the row (or column) into smooth streaks. Runs longer than about twice the pass count are only partly sorted, which gives the ragged edge.',
  keywords: ['glitch', 'sort', 'streak', 'datamosh', 'asdf', 'melt', 'drip', 'smear', 'threshold'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    direction: {
      type: 'enum',
      default: 'horizontal',
      label: 'Sort along',
      options: [
        { value: 'horizontal', label: 'Rows (left to right)' },
        { value: 'vertical', label: 'Columns (top to bottom)' },
      ],
    },
    key: {
      type: 'enum',
      default: 'brightness',
      label: 'Sort by',
      options: [
        { value: 'brightness', label: 'Brightness' },
        { value: 'hue', label: 'Hue' },
        { value: 'saturation', label: 'Saturation' },
        { value: 'red', label: 'Red' },
        { value: 'green', label: 'Green' },
        { value: 'blue', label: 'Blue' },
      ],
    },
    descending: { type: 'bool', default: false, label: 'Reverse order' },
    low: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.005, label: 'Sort pixels from brightness', group: 'Which pixels' },
    high: { type: 'number', default: 0.85, min: 0, max: 1, step: 0.005, label: 'up to brightness', group: 'Which pixels' },
    invertWindow: { type: 'bool', default: false, label: 'Sort everything outside the window', group: 'Which pixels' },
    passes: { type: 'number', default: 64, min: 1, max: 512, softMax: 160, step: 1, integer: true, label: 'Passes', group: 'Quality', hint: 'Each pass moves pixels one step. More passes = longer, fuller streaks and more work. Capped for speed.' },
  },
  summary: (p) => `${p.key} · ${p.passes} passes`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const passes = Math.max(1, Math.round(p.passes));
    const vertical = p.direction === 'vertical';
    const key = KEYS.indexOf(p.key);
    const wgsl = /* wgsl */ `
fn keyOf(c: vec4f) -> f32 {
  let s = unpremul(c);
  switch (i32(u.key)) {
    case 0: { return luma(s.rgb); }
    case 1: { return rgbToHsv(s.rgb).x; }
    case 2: { return rgbToHsv(s.rgb).y; }
    case 3: { return s.r; }
    case 4: { return s.g; }
    default: { return s.b; }
  }
}
fn inWindow(c: vec4f) -> bool {
  let l = luma(unpremul(c).rgb);
  let inside = l >= u.low && l <= u.high && c.a > 0.001;
  return inside != (u.invert > 0.5);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let me = textureSampleLevel(cur, smpNearest, uv, 0.0);
  let idx = select(floor(px.x), floor(px.y), u.vertical > 0.5);
  let count = select(u.size.x, u.size.y, u.vertical > 0.5);
  let left = (i32(idx) + i32(u.parity)) % 2 == 0;
  let pidx = select(idx - 1.0, idx + 1.0, left);
  if (pidx < 0.0 || pidx >= count || !inWindow(me)) { return me; }
  let puv = select(vec2f((pidx + 0.5) / u.size.x, uv.y), vec2f(uv.x, (pidx + 0.5) / u.size.y), u.vertical > 0.5);
  let other = textureSampleLevel(cur, smpNearest, puv, 0.0);
  if (!inWindow(other)) { return me; }
  var a = keyOf(me);
  var b = keyOf(other);
  if (u.desc > 0.5) { a = -a; b = -b; }
  // the left element must hold the smaller key
  let swap = select(b > a, b < a, left);
  return select(me, other, swap);
}`;
    let img: ImageValue = src;
    for (let i = 0; i < passes; i++) {
      img = gpu.pass({
        label: `pixel-sort-${i}`,
        size: src,
        textures: { cur: img },
        uniforms: { key, vertical, parity: i % 2, low: p.low, high: Math.max(p.high, p.low), invert: p.invertWindow, desc: p.descending },
        wgsl,
      });
    }
    return { image: img };
  },
});
