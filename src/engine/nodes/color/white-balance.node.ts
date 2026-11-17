import { defineNode } from '../../define';
import { type CatMethod, IDENTITY3, type M3, estimateNeutral, lerpM3, mulMM, neutralMatrix, rows, whiteBalanceMatrix } from '../../lib/color-math';
import { COLOR_WGSL } from '../../lib/color-wgsl';

/** Estimates of "auto" white balance, frozen per (node, upstream structure, frame, method, batch item): a pure memo, not node state. */
const autoMemo = new Map<string, [number, number, number]>();
const AUTO_SIDE = 48;

export default defineNode({
  id: 'white-balance',
  title: 'White Balance',
  category: 'color',
  description:
    'Corrects color cast in linear light with a real chromatic adaptation (Bradford or CAT16). Set the color temperature (Kelvin) and tint, pick something that should be gray, or let it estimate the cast automatically.',
  keywords: ['grade', 'white balance', 'wb', 'temperature', 'kelvin', 'tint', 'cast', 'neutral', 'gray world', 'color temperature', 'color temperature', 'bradford', 'cat16', 'warm', 'cool', 'correct'],
  cpu: true,
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    mode: {
      type: 'enum',
      default: 'temperature',
      label: 'Mode',
      options: [
        { value: 'temperature', label: 'Temperature and tint' },
        { value: 'neutral', label: 'Pick a neutral color' },
        { value: 'auto', label: 'Automatic' },
      ],
      hint: 'All maths runs in LINEAR light (sRGB curve removed, Rec.709 primaries, D65 white).',
    },
    temperature: {
      type: 'number',
      default: 6500,
      min: 2000,
      max: 12000,
      step: 10,
      label: 'Temperature',
      hint: 'In kelvin. The color temperature of the LIGHT in the scene, as in a raw converter: set 3200 for tungsten-lit footage and the picture turns cooler to compensate. 6500 leaves the picture alone. In the other modes this is an extra adjustment on top.',
    },
    tint: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Tint', hint: 'Moves along the line perpendicular to the temperature locus (Duv). Positive = magenta, negative = green.' },
    neutral: {
      type: 'color',
      default: [0.5, 0.5, 0.5, 1],
      label: 'Neutral color',
      hint: 'The color of something that should be gray or white in the picture. It is mapped to neutral (equal R, G, B) and everything else follows.',
      visibleIf: (p) => p.mode === 'neutral',
    },
    estimate: {
      type: 'enum',
      default: 'grey-world',
      label: 'Estimate from',
      options: [
        { value: 'grey-world', label: 'Gray world' },
        { value: 'white-patch', label: 'White patch' },
      ],
      hint: 'Both run on a 48 px downsample of the picture.',
      visibleIf: (p) => p.mode === 'auto',
    },
    frame: {
      type: 'number',
      default: 0,
      min: 0,
      max: 3600,
      step: 0.01,
      unit: 's',
      label: 'Estimate at',
      hint: 'The cast is measured once on the input at this time and stays fixed for the whole clip, so it never flickers.',
      visibleIf: (p) => p.mode === 'auto',
    },
    amount: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Strength', hint: 'How much of the neutral / automatic correction is applied.', visibleIf: (p) => p.mode !== 'temperature' },
    method: {
      type: 'enum',
      default: 'bradford',
      label: 'Adaptation',
      options: [
        { value: 'bradford', label: 'Bradford' },
        { value: 'cat16', label: 'CAT16' },
      ],
    },
    preserveLuminance: { type: 'bool', default: true, label: 'Preserve luminance', hint: 'Rescales each pixel so its Rec.709 luminance is the same as before the correction.' },
  },
  summary: (p) => (p.mode === 'temperature' ? `${p.temperature} K · tint ${p.tint.toFixed(2)}` : p.mode === 'neutral' ? 'neutral pick' : `auto · ${p.estimate}`),
  async render(ctx) {
    const p = ctx.params;
    const method = p.method as CatMethod;
    let m: M3 = whiteBalanceMatrix(p.temperature, p.tint, method);
    if (p.mode !== 'temperature') {
      let picked: [number, number, number];
      if (p.mode === 'neutral') picked = [p.neutral[0], p.neutral[1], p.neutral[2]];
      else {
        const key = `${ctx.nodeId}|${ctx.inputSignature('image')}|${p.frame}|${p.estimate}|${ctx.item.index}`;
        let hit = autoMemo.get(key);
        if (!hit) {
          const image = await ctx.pull('image', { seconds: p.frame });
          if (!image) hit = [0.5, 0.5, 0.5];
          else {
            const small = ctx.gpu.pass({
              label: 'white-balance-downsample',
              size: { width: AUTO_SIDE, height: AUTO_SIDE },
              textures: { src: image },
              wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var sum = vec4f(0.0);
  let cell = 1.0 / u.size;
  for (var j = 0; j < 8; j++) {
    for (var i = 0; i < 8; i++) {
      let o = (vec2f(f32(i), f32(j)) + 0.5) / 8.0 - 0.5;
      sum += textureSampleLevel(src, smp, uv + o * cell, 0.0);
    }
  }
  return sum / 64.0;
}`,
            });
            hit = estimateNeutral(await ctx.gpu.read(small, true), p.estimate as 'grey-world' | 'white-patch');
            ctx.gpu.recycle(small);
          }
          autoMemo.set(key, hit);
          while (autoMemo.size > 64) autoMemo.delete(autoMemo.keys().next().value as string);
        }
        picked = hit;
      }
      const correction = lerpM3(IDENTITY3, neutralMatrix(picked, method), p.amount);
      m = mulMM(m, correction);
    }
    const [r0, r1, r2] = rows(m);
    const image = ctx.gpu.pass({
      label: 'white-balance',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { m0: r0, m1: r1, m2: r2, keepY: p.preserveLuminance },
      wgsl: /* wgsl */ `${COLOR_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let lin = srgbToLinear(s.rgb);
  var o = vec3f(dot(u.m0, lin), dot(u.m1, lin), dot(u.m2, lin));
  if (u.keepY > 0.5) {
    let y1 = cg_luma(o);
    if (y1 > 1e-5) { o = o * (cg_luma(lin) / y1); }
  }
  return premul(vec4f(linearToSrgb(clamp(o, vec3f(0.0), vec3f(1.0))), s.a));
}`,
    });
    return { image };
  },
});
