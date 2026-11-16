import { defineNode } from '../../define';
import { WHEEL_SCALE, WORKING_ID, type V3, tfDecode, tfEncode, transferIndex, wheelVec } from '../../lib/color-math';
import { COLOR_WGSL } from '../../lib/color-wgsl';

const NEUTRAL: [number, number, number, number] = [0.5, 0.5, 0.5, 1];

export default defineNode({
  id: 'color-wheels',
  title: 'Lift Gamma Gain',
  category: 'color',
  description:
    'Primary colour correction with lift, gamma, gain and offset (each a colour wheel plus a master), contrast with a pivot, and saturation. A second mode takes ASC CDL values (slope, offset, power, saturation) typed in from other software.',
  keywords: ['grade', 'lift', 'gamma', 'gain', 'offset', 'wheels', 'primary', 'asc cdl', 'cdl', 'slope', 'power', 'contrast', 'pivot', 'colour balance', 'color balance', 'resolve'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    mode: {
      type: 'enum',
      default: 'lgg',
      label: 'Mode',
      options: [
        { value: 'lgg', label: 'Lift Gamma Gain' },
        { value: 'cdl', label: 'ASC CDL' },
      ],
      hint: 'LGG per channel x in the working space: x1 = x^(1/gamma); x2 = x1 * gain; x3 = x2 * (1 - lift) + lift; x4 = x3 + offset; out = (x4 - pivot) * contrast + pivot. Black goes to lift (+offset), white to gain (+offset), gamma bends the mid-tones without moving either. ASC CDL: out = max(x * slope + offset, 0)^power, then saturation about Rec.709 luma (as the CDL spec).',
    },
    space: {
      type: 'enum',
      default: 'display',
      label: 'Working space',
      options: [
        { value: 'display', label: 'Display' },
        { value: 'linear', label: 'Linear light' },
        { value: 'log', label: 'Cineon log' },
      ],
      hint: 'The space the formula runs in. Display is what colourists expect from display-referred footage (and what CDL values from video-gamma pipelines assume). Linear makes gain behave like exposure. Log makes offset a uniform brightness shift in stops.',
    },
    liftColor: { type: 'color', default: NEUTRAL, label: 'Lift color', group: 'Lift', visibleIf: (p) => p.mode === 'lgg', hint: 'Pick a colour: only its difference from grey matters (neutral grey = no tint).' },
    liftMaster: { type: 'number', default: 0, min: -0.5, max: 0.5, step: 0.005, label: 'Lift master', group: 'Lift', visibleIf: (p) => p.mode === 'lgg' },
    gammaColor: { type: 'color', default: NEUTRAL, label: 'Gamma color', group: 'Gamma', visibleIf: (p) => p.mode === 'lgg' },
    gammaMaster: { type: 'number', default: 0, min: -0.9, max: 3, softMax: 1, step: 0.005, label: 'Gamma master', group: 'Gamma', visibleIf: (p) => p.mode === 'lgg', hint: 'Gamma value = 1 + master. Positive brightens the mid-tones.' },
    gainColor: { type: 'color', default: NEUTRAL, label: 'Gain color', group: 'Gain', visibleIf: (p) => p.mode === 'lgg' },
    gainMaster: { type: 'number', default: 0, min: -1, max: 3, softMax: 1, step: 0.005, label: 'Gain master', group: 'Gain', visibleIf: (p) => p.mode === 'lgg', hint: 'Gain = 1 + master (a multiplier of white).' },
    offsetColor: { type: 'color', default: NEUTRAL, label: 'Offset color', group: 'Offset', visibleIf: (p) => p.mode === 'lgg' },
    offsetMaster: { type: 'number', default: 0, min: -0.5, max: 0.5, step: 0.005, label: 'Offset master', group: 'Offset', visibleIf: (p) => p.mode === 'lgg' },
    contrast: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'Contrast', group: 'Contrast', visibleIf: (p) => p.mode === 'lgg', hint: 'Linear slope about the pivot, in the working space.' },
    pivot: { type: 'number', default: 0.435, min: 0.01, max: 0.99, step: 0.005, label: 'Pivot', group: 'Contrast', visibleIf: (p) => p.mode === 'lgg', hint: 'The display value that contrast leaves unchanged (converted into the working space). 0.435 is the DaVinci Resolve default.' },
    slopeR: { type: 'number', default: 1, min: 0, max: 4, softMax: 3, step: 0.001, label: 'Slope R', group: 'ASC CDL', visibleIf: (p) => p.mode === 'cdl' },
    slopeG: { type: 'number', default: 1, min: 0, max: 4, softMax: 3, step: 0.001, label: 'Slope G', group: 'ASC CDL', visibleIf: (p) => p.mode === 'cdl' },
    slopeB: { type: 'number', default: 1, min: 0, max: 4, softMax: 3, step: 0.001, label: 'Slope B', group: 'ASC CDL', visibleIf: (p) => p.mode === 'cdl' },
    cdlOffsetR: { type: 'number', default: 0, min: -1, max: 1, step: 0.001, label: 'Offset R', group: 'ASC CDL', visibleIf: (p) => p.mode === 'cdl' },
    cdlOffsetG: { type: 'number', default: 0, min: -1, max: 1, step: 0.001, label: 'Offset G', group: 'ASC CDL', visibleIf: (p) => p.mode === 'cdl' },
    cdlOffsetB: { type: 'number', default: 0, min: -1, max: 1, step: 0.001, label: 'Offset B', group: 'ASC CDL', visibleIf: (p) => p.mode === 'cdl' },
    powerR: { type: 'number', default: 1, min: 0.05, max: 4, softMax: 3, step: 0.001, label: 'Power R', group: 'ASC CDL', visibleIf: (p) => p.mode === 'cdl' },
    powerG: { type: 'number', default: 1, min: 0.05, max: 4, softMax: 3, step: 0.001, label: 'Power G', group: 'ASC CDL', visibleIf: (p) => p.mode === 'cdl' },
    powerB: { type: 'number', default: 1, min: 0.05, max: 4, softMax: 3, step: 0.001, label: 'Power B', group: 'ASC CDL', visibleIf: (p) => p.mode === 'cdl' },
    saturation: { type: 'number', default: 1, min: 0, max: 4, softMax: 3, step: 0.01, label: 'Saturation', hint: 'Scales colour about Rec.709 luma of the working-space values (the ASC CDL definition). Use the Saturation node for luminance-exact results.' },
  },
  summary: (p) => (p.mode === 'cdl' ? 'ASC CDL' : `LGG · ${p.space}`),
  render(ctx) {
    const p = ctx.params;
    const ws = WORKING_ID[p.space as 'display' | 'linear' | 'log'];
    const lift = wheelVec(p.liftColor, p.liftMaster, WHEEL_SCALE.lift);
    const gam = wheelVec(p.gammaColor, p.gammaMaster, WHEEL_SCALE.gamma).map((v) => 1 + v);
    const gain = wheelVec(p.gainColor, p.gainMaster, WHEEL_SCALE.gain).map((v) => 1 + v);
    const offset = wheelVec(p.offsetColor, p.offsetMaster, WHEEL_SCALE.offset);
    const pivot = tfEncode(ws, tfDecode('srgb', p.pivot));
    const image = ctx.gpu.pass({
      label: 'color-wheels',
      size: ctx.in.image,
      textures: { src: ctx.in.image },
      uniforms: {
        cdl: p.mode === 'cdl',
        ws: transferIndex(ws),
        lift: lift as V3,
        invGamma: gam.map((g) => 1 / Math.max(g, 0.01)),
        gain,
        offset,
        slope: [p.slopeR, p.slopeG, p.slopeB],
        cdlOffset: [p.cdlOffsetR, p.cdlOffsetG, p.cdlOffsetB],
        power: [p.powerR, p.powerG, p.powerB],
        contrast: p.contrast,
        pivot,
        sat: p.saturation,
      },
      wgsl: /* wgsl */ `${COLOR_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let x = cg_enc(cg_dec(s.rgb, 0.0), u.ws);
  var y: vec3f;
  if (u.cdl > 0.5) {
    y = pow(max(x * u.slope + u.cdlOffset, vec3f(0.0)), u.power);
  } else {
    y = pow(max(x, vec3f(0.0)), u.invGamma) * u.gain;
    y = y * (vec3f(1.0) - u.lift) + u.lift + u.offset;
    y = (y - vec3f(u.pivot)) * u.contrast + vec3f(u.pivot);
  }
  let l = cg_luma(y);
  y = vec3f(l) + u.sat * (y - vec3f(l));
  let lin = clamp(cg_dec(y, u.ws), vec3f(0.0), vec3f(1.0));
  return premul(vec4f(cg_enc(lin, 0.0), s.a));
}`,
    });
    return { image };
  },
});
