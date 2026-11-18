import { defineNode } from '../../define';
import { SPACE_OPTIONS, primariesMatrix, rows, spaceDef, transferIndex } from '../../lib/color-math';
import { COLOR_WGSL } from '../../lib/color-wgsl';

export default defineNode({
  id: 'color-space',
  title: 'Color Space',
  category: 'color',
  description:
    'Converts the picture\'s values between color spaces: sRGB, linear light, gamma 2.2 / 2.4, Display P3, Rec.2020 and the log curves Cineon, S-Log3, LogC3, V-Log, ACEScct, DaVinci Intermediate and Samsung Log. Use it to feed a log LUT or to grade in linear.',
  keywords: ['grade', 'color space', 'color space', 'colorspace', 'transform', 'convert', 'linear', 'gamma', 'p3', 'display p3', 'rec2020', 'rec 2020', 'rec709', 'rec.709', 'log', 'cineon', 's-log3', 'slog3', 'logc', 'logc3', 'v-log', 'vlog', 'acescct', 'davinci intermediate', 'samsung log', 'samsung', 'galaxy log', 'oetf', 'eotf', 'gamut'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    from: { type: 'enum', default: 'srgb', label: 'From', options: SPACE_OPTIONS, hint: 'What the incoming values ARE. The engine\'s pictures are sRGB, so leave this on sRGB unless an earlier node changed the encoding.' },
    to: {
      type: 'enum',
      default: 'linear',
      label: 'To',
      options: SPACE_OPTIONS,
      hint:
        'What the values become. The result is still shown as sRGB, so a linear or log result looks dark / flat: that is the data, not a bug. Primaries are converted between Rec.709, P3 (D65) and Rec.2020 exactly (matrices derived from the chromaticities, D65 white, no adaptation). Log curves are the TRANSFER curves only (Rec.709 primaries): camera gamuts such as S-Gamut3 or AWG are not applied. Samsung Log is the exception: its gamut is Rec.2020, so From: Samsung Log, To: sRGB is the complete conversion of Galaxy log footage. Camera logs offered here are only those whose published constants are included; F-Log, Canon Log and N-Log are left out.',
    },
  },
  summary: (p) => `${spaceDef(p.from).id} → ${spaceDef(p.to).id}`,
  render(ctx) {
    const p = ctx.params;
    const a = spaceDef(p.from);
    const b = spaceDef(p.to);
    const [r0, r1, r2] = rows(primariesMatrix(a.primaries, b.primaries));
    const image = ctx.gpu.pass({
      label: 'color-space',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: { m0: r0, m1: r1, m2: r2, fromTf: transferIndex(a.transfer), toTf: transferIndex(b.transfer) },
      wgsl: /* wgsl */ `${COLOR_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let lin = cg_dec(s.rgb, u.fromTf);
  let o = vec3f(dot(u.m0, lin), dot(u.m1, lin), dot(u.m2, lin));
  return premul(vec4f(clamp(cg_enc(o, u.toTf), vec3f(0.0), vec3f(1.0)), s.a));
}`,
    });
    return { image };
  },
});
