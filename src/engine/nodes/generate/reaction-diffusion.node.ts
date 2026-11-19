import { defineNode } from '../../define';
import { gaussianBlur } from '../filter/blur.node';
import type { ImageValue } from '../../types';

/**
 * Reaction-diffusion patterns (Turing patterns): the spots of a leopard, the stripes of a zebra, the maze of a brain coral.
 * In nature two substances spread at different speeds, one switching the pattern on nearby and the other switching it
 * off further away. That is what one round here does: every point becomes "its near surroundings minus its wider
 * surroundings", pushed toward on or off. A few rounds turn any start into an even pattern of the chosen size.
 * The start is slowly churning noise (or the wired picture), and every frame is grown from scratch, so there is no
 * memory to go wrong: any frame can be rendered alone, and the loop closes because the noise does.
 */
export default defineNode({
  id: 'reaction-diffusion',
  title: 'Reaction Diffusion',
  category: 'generate',
  description: 'Living patterns like leopard spots, zebra stripes, coral and fingerprints, slowly morphing. Wire a picture in and the pattern grows along its shapes.',
  keywords: ['reaction diffusion', 'turing', 'pattern', 'spots', 'stripes', 'coral', 'maze', 'organic', 'leopard', 'zebra', 'fingerprint', 'trippy', 'psychedelic', 'cells', 'growth', 'visuals', 'vj', 'gray scott'],
  inputs: { image: { type: 'image', label: 'Grow from' }, size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    scale: { type: 'number', default: 3, min: 0.5, max: 20, step: 0.1, label: 'Pattern size %', hint: 'Width of one spot or stripe, percent of the picture width.' },
    kind: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Spots to maze', hint: 'Below 0: separate spots. Around 0: a maze of stripes. Above 0: holes in a solid.' },
    rounds: { type: 'number', default: 5, min: 1, max: 10, step: 1, integer: true, label: 'Rounds', hint: 'More rounds make the pattern more even and more its own; fewer keep more of the start.' },
    flow: { type: 'number', default: 0.6, min: 0, max: 4, step: 0.05, label: 'Flow', hint: 'How far the pattern morphs during one loop. 0 = frozen.' },
    follow: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Follow picture', hint: 'With a picture wired in: how much its light and dark steer the pattern.' },
    colorA: { type: 'color', default: [0.04, 0.03, 0.1, 1], label: 'Color A' },
    colorB: { type: 'color', default: [0.98, 0.85, 0.4, 1], label: 'Color B' },
    edge: { type: 'color', default: [0.9, 0.2, 0.4, 1], label: 'Edge color' },
    edgeWidth: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Edge width' },
    soft: { type: 'number', default: 0.15, min: 0.01, max: 1, step: 0.01, label: 'Softness' },
    seed: { type: 'number', default: 1, min: 0, max: 999, step: 1, integer: true, label: 'Seed' },
  },
  summary: (p) => `${p.scale}% · ${p.rounds} rounds`,
  render(ctx) {
    const p = ctx.params;
    const out = ctx.in.size ?? ctx.in.image ?? ctx.canvas;
    // grown on a small copy: the pattern is soft, and its size is a share of the width anyway
    const k = Math.max(1, Math.round(out.width / 320));
    const small = { width: Math.max(8, Math.round(out.width / k)), height: Math.max(8, Math.round(out.height / k)), unit: out.unit / k };
    const from = ctx.in.image;
    let x: ImageValue = ctx.gpu.pass({
      label: 'rd-start',
      size: small,
      textures: from ? { pic: from } : {},
      uniforms: { phase: ctx.time.phase, flow: p.flow, seed: p.seed * 13.7, follow: from ? p.follow : 0, freq: 100 / Math.max(0.5, p.scale) },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let aspect = u.size.x / u.size.y;
  let q = uv * vec2f(aspect, 1.0) * u.freq * 0.6 / aspect + u.seed;
  var v = loopNoise(q, u.phase, u.flow);
  ${from ? 'v = mix(v, luma(unpremul(textureSampleLevel(pic, smp, uv, 0.0)).rgb), u.follow);' : ''}
  return vec4f(vec3f(v), 1.0);
}`,
    });
    const r1 = Math.max(0.6, ((p.scale / 100) * small.width) / 2.4);
    for (let i = 0; i < Math.round(p.rounds); i++) {
      const near = gaussianBlur(ctx.gpu, x, r1);
      const far = gaussianBlur(ctx.gpu, x, r1 * 2.2);
      x = ctx.gpu.pass({
        label: 'rd-round',
        size: small,
        textures: { near, far },
        uniforms: { bias: p.kind * 0.06 },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = textureSampleLevel(near, smp, uv, 0.0).r;
  let b = textureSampleLevel(far, smp, uv, 0.0).r;
  // on where the near surroundings beat the wider ones, pushed hard toward on or off
  let v = clamp(0.5 + (a - b + u.bias) * 9.0, 0.0, 1.0);
  return vec4f(vec3f(v), 1.0);
}`,
      });
    }
    const image = ctx.gpu.pass({
      label: 'rd-colour',
      size: out,
      textures: { src: x },
      uniforms: { a: p.colorA, b: p.colorB, e: p.edge, ew: p.edgeWidth, soft: p.soft },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let v = textureSampleLevel(src, smp, uv, 0.0).r;
  let t = smoothstep(0.5 - u.soft * 0.5, 0.5 + u.soft * 0.5, v);
  var c = mix(u.a, u.b, t);
  // the edge: where the pattern is neither on nor off
  let rim = (1.0 - smoothstep(0.0, 0.5 * u.ew + 0.001, abs(v - 0.5))) * step(0.001, u.ew);
  c = mix(c, u.e, rim * u.e.a);
  return premul(c);
}`,
    });
    return { image };
  },
});
