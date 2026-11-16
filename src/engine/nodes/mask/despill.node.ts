import { defineNode } from '../../define';

/**
 * Removes the colour cast a keyed backdrop leaves on the subject (green/blue fringe, reflected light).
 * The key colour is normalised to per-channel weights k' (0..1): the key's own channels are limited
 * to the average (or max) of the remaining channels, exactly like the classic "green = min(green, (red+blue)/2)".
 * It generalises to any key colour (cyan limits g and b against r, and so on).
 */
export default defineNode({
  id: 'despill',
  title: 'Despill',
  category: 'mask',
  description: 'Removes the colour cast of a key colour (green or blue screen spill) from the image edges.',
  keywords: ['spill', 'green screen', 'fringe', 'cast', 'chroma', 'decontaminate'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    key: { type: 'color', default: [0.0, 0.7, 0.25, 1], label: 'Key color' },
    amount: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Amount' },
    limit: {
      type: 'enum',
      default: 'average',
      options: [
        { value: 'average', label: 'Average of others' },
        { value: 'max', label: 'Max of others' },
      ],
      label: 'Limit',
    },
    keepLuma: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Keep brightness', hint: 'Adds back the brightness lost by removing the cast.' },
  },
  summary: (p) => `${Math.round(p.amount * 100)}%`,
  render(ctx) {
    const p = ctx.params;
    const k = [p.key[0], p.key[1], p.key[2]];
    const lo = Math.min(...k);
    const hi = Math.max(...k);
    if (hi - lo < 0.02 || p.amount <= 0) return { image: ctx.in.image };
    const ss = (e0: number, e1: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    // Channels where the key is strong count as "key channels"; weak ones (the blue in a typical green screen) are limiters.
    const kw = k.map((v) => ss(0.45, 0.75, (v - lo) / (hi - lo)));
    const image = ctx.gpu.pass({
      label: 'despill',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { kw, amount: p.amount, useMax: p.limit === 'max', keep: p.keepLuma },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let x = s.rgb;
  let inv = vec3f(1.0) - u.kw;
  let keyAvg = dot(x, u.kw) / max(u.kw.x + u.kw.y + u.kw.z, 1e-4);
  let otherAvg = dot(x, inv) / max(inv.x + inv.y + inv.z, 1e-4);
  let otherMax = max(max(x.r * step(0.5, inv.x), x.g * step(0.5, inv.y)), x.b * step(0.5, inv.z));
  let useMx = u.useMax > 0.5;
  let other = select(otherAvg, otherMax, useMx);
  let spill = max(0.0, keyAvg - other);
  var y = x - u.amount * spill * u.kw;
  y += (luma(x) - luma(y)) * u.keep * u.amount;
  return premul(vec4f(clamp(y, vec3f(0.0), vec3f(1.0)), s.a));
}`,
    });
    return { image };
  },
});
