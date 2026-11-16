import { defineNode } from '../../define';
import { validRegions } from '../../lib/track-core';
import { MAX_REGIONS, REGION_WGSL, regionTable } from '../../lib/track-gpu';
import type { ImageValue } from '../../types';

const MAX_SPRITES = 8;

export default defineNode({
  id: 'region-stamp',
  title: 'Stamp On Regions',
  category: 'track',
  description:
    'Places a sprite (an image, flare, emoji, logo...) on every region. Fit it to each box or give it a fixed size, rotate it, and wire several images into Sprites to give different objects different pictures.',
  keywords: ['stamp', 'sprite', 'sticker', 'emoji', 'flare', 'attach', 'overlay', 'place', 'decorate', 'regions'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    regions: { type: 'regions', required: true, label: 'Regions' },
    sprites: { type: 'image', multi: true, label: 'Sprites' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: false,
  params: {
    sizeMode: {
      type: 'enum',
      default: 'fit',
      options: [
        { value: 'fit', label: 'Fit to each box' },
        { value: 'fixed', label: 'Fixed size' },
      ],
      label: 'Size',
    },
    scale: { type: 'number', default: 1, min: 0.05, max: 10, step: 0.01, label: 'Scale', hint: 'Multiplies the fitted size (or the fixed size).' },
    fixedSize: { type: 'number', default: 64, min: 1, max: 2000, step: 1, unit: 'px', label: 'Height', visibleIf: (p) => p.sizeMode === 'fixed' },
    anchor: {
      type: 'enum',
      default: 'center',
      options: [
        { value: 'center', label: 'Center of the box' },
        { value: 'top', label: 'On top of the box' },
        { value: 'bottom', label: 'Below the box' },
      ],
      label: 'Place at',
    },
    offset: { type: 'vec2', default: [0, 0], min: -1, max: 1, step: 0.005, unit: 'norm', label: 'Nudge' },
    rotation: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotation' },
    opacity: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Opacity' },
    variation: {
      type: 'enum',
      default: 'id',
      options: [
        { value: 'none', label: 'Always the first sprite' },
        { value: 'id', label: 'By region id' },
        { value: 'index', label: 'By position in the list' },
      ],
      label: 'Which sprite',
      hint: 'With several sprites wired in, how each region picks one.',
    },
  },
  summary: (p) => `${p.sizeMode === 'fit' ? 'fit' : `${p.fixedSize}px`} · ${p.variation}`,
  render(ctx) {
    const p = ctx.params;
    const img = ctx.in.image;
    const sprites = (ctx.in.sprites as ImageValue[]).slice(0, MAX_SPRITES);
    const items = validRegions(ctx.in.regions.items).slice(0, MAX_REGIONS);
    if (!sprites.length || !items.length) return { image: img };
    const pick = (id: number, i: number) => {
      const k = p.variation === 'none' ? 0 : p.variation === 'id' ? id : i;
      return ((Math.floor(k) % sprites.length) + sprites.length) % sprites.length;
    };
    const info = items.map((r, i) => {
      const s = sprites[pick(r.id, i)];
      return [pick(r.id, i), s.width / s.height, 0, 0];
    });
    const regs = regionTable(ctx.gpu, items.map((r) => r.box), [info]);
    const textures: Record<string, ImageValue | { texture: GPUTexture }> = { base: img, regs };
    sprites.forEach((s, i) => (textures[`s${i}`] = s));
    const chain = sprites.map((_, i) => `if (k == ${i}) { return textureSampleLevel(s${i}, smp, uv, 0.0); }`).join('\n  ');
    const image = ctx.gpu.pass({
      label: 'region-stamp',
      size: img,
      textures,
      uniforms: {
        n: items.length,
        fit: p.sizeMode === 'fit',
        scale: p.scale,
        fixed: p.fixedSize,
        anchor: p.anchor === 'center' ? 0 : p.anchor === 'top' ? 1 : 2,
        off: p.offset,
        rot: (p.rotation * Math.PI) / 180,
        op: p.opacity,
      },
      wgsl: /* wgsl */ `
${REGION_WGSL}
fn sprite(k: i32, uv: vec2f) -> vec4f {
  ${chain}
  return vec4f(0.0);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var acc = textureSampleLevel(base, smpNearest, uv, 0.0);
  let count = i32(u.n);
  let cs = cos(u.rot);
  let sn = sin(u.rot);
  for (var i = 0; i < count; i++) {
    let b = regBox(i) * vec4f(u.size, u.size);
    let info = regExtra(i, 0);
    let a = max(info.y, 0.0001);
    let bs = max(b.zw - b.xy, vec2f(1.0));
    var sz = vec2f(0.0);
    if (u.fit > 0.5) {
      let w = min(bs.x, bs.y * a) * u.scale;
      sz = vec2f(w, w / a);
    } else {
      sz = vec2f(u.fixed * a, u.fixed) * u.scale;
    }
    var c = (b.xy + b.zw) * 0.5;
    if (u.anchor > 0.5 && u.anchor < 1.5) { c.y = b.y - sz.y * 0.5; }
    else if (u.anchor > 1.5) { c.y = b.w + sz.y * 0.5; }
    c += u.off * bs;
    let l = px - c;
    let q = vec2f(l.x * cs + l.y * sn, -l.x * sn + l.y * cs);
    let suv = q / sz + 0.5;
    if (suv.x >= 0.0 && suv.y >= 0.0 && suv.x <= 1.0 && suv.y <= 1.0) {
      let s = sprite(i32(info.x), suv) * u.op;
      acc = over(s, acc);
    }
  }
  return acc;
}`,
    });
    return { image };
  },
});
