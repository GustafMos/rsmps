import { defineNode } from '../../define';
import { SPECK_PARAMS, SPECKS_WGSL, speckUniforms, type SpeckParamValues } from '../../lib/specks';

/** Stand-alone specks: the generator that Analog Video uses for tape dropouts, as its own node that can sit over anything. */
export default defineNode({
  id: 'specks',
  title: 'Specks / Dropouts',
  category: 'stylize',
  description:
    'Tape dropouts, dust, dots, blocks and film scratches drawn as editable particles over the picture: density, clustering, length, thickness, shape, colour, opacity, blend, flicker and drift. The same generator that Analog Video uses for its dropouts.',
  keywords: ['dropout', 'speck', 'dust', 'scratch', 'tape', 'vhs', 'film', 'noise', 'damage', 'particles', 'glitch', 'streak'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    animate: { type: 'bool', default: false, label: 'Animate', hint: 'Off = one frozen pattern. On = the pattern changes every N frames and loops with the project.' },
    amount: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Amount', group: 'Dropouts / specks', hint: 'Density. 0 = none.' },
    ...SPECK_PARAMS,
    speckBand: { ...SPECK_PARAMS.speckBand, default: 'uniform' },
  },
  summary: (p) => `${p.speckShape} ${Math.round(p.amount * 100)}%`,
  render(ctx) {
    const src = ctx.in.image;
    const p = ctx.params;
    if (p.amount <= 0) return { image: src };
    const animate = p.animate === true;
    const image = ctx.gpu.pass({
      label: 'specks',
      size: src,
      textures: { src },
      uniforms: speckUniforms(p as unknown as SpeckParamValues, { amount: p.amount, unit: src.unit, time: animate ? ctx.time : null }),
      wgsl: /* wgsl */ `${SPECKS_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smpNearest, uv, 0.0);
  var rgb = unpremul(c).rgb;
  let hit = spField(px);
  if (hit.cov > 0.0) {
    let held = unpremul(textureSampleLevel(src, smpNearest, vec2f((px.x - hit.d - 3.0 * u.spUnit) / u.size.x, uv.y), 0.0)).rgb;
    rgb = spApply(rgb, hit, held);
  }
  return premul(vec4f(rgb, c.a));
}`,
    });
    return { image };
  },
});
