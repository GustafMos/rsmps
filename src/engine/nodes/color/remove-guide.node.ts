import { defineNode } from '../../define';

/**
 * "Keep only what I drew": takes the printed guide (rotoscope sheets) out of a scanned frame.
 * - Blue guide: by colour. The non-photo blue is bright in green and blue, pencil and ink are not, so darkness is read from the
 *   blue channel and everything lighter than the threshold becomes paper.
 * - Faint / outline guide: when the original frame is wired in, the guide is rebuilt from it exactly as the printer drew it and divided
 *   out (scan = guide x drawing). Without it a threshold just above the guide's own darkness is used.
 */
export default defineNode({
  id: 'remove-guide',
  title: 'Remove Printed Guide',
  category: 'color',
  description:
    'Keep only what you drew on a rotoscope sheet: removes the printed guide picture (non-photo blue, faint or outline) from a scanned frame, using the original frame when you wire it in, otherwise color or a threshold.',
  keywords: ['scan', 'rotoscope', 'guide', 'keep only what I drew', 'non-photo blue', 'dropout', 'faint', 'outline', 'ink', 'paper', 'clean', 'difference'],
  inputs: {
    image: { type: 'image', required: true, label: 'Scan' },
    original: { type: 'image', label: 'Original frame' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    guide: {
      type: 'enum',
      default: 'blue',
      options: [
        { value: 'blue', label: 'Non-photo blue picture' },
        { value: 'faint', label: 'Faint picture' },
        { value: 'outline', label: 'Outline' },
      ],
      label: 'Printed guide',
    },
    blueGuide: { type: 'bool', default: false, label: 'Blue guide', hint: 'Only used with an Original frame wired in, so the guide is rebuilt in the right color.', visibleIf: (p) => p.guide !== 'blue' },
    strength: { type: 'number', default: 0.3, min: 0.05, max: 1, step: 0.01, label: 'Printed strength', hint: 'The "Guide strength" / lightness the sheet was printed with (faint and blue pictures).', group: 'Guide' },
    threshold: { type: 'number', default: 0.2, min: 0, max: 0.9, step: 0.005, label: 'Guide threshold', hint: 'Darkness below which a mark counts as guide, not drawing. Used when there is no Original frame. Faint and outline add the printed strength.', group: 'Guide' },
    softness: { type: 'number', default: 0.1, min: 0.005, max: 0.6, step: 0.005, label: 'Edge softness', group: 'Guide' },
    output: {
      type: 'enum',
      default: 'paper',
      options: [
        { value: 'paper', label: 'Drawing on white paper' },
        { value: 'ink', label: 'Drawing only' },
      ],
      label: 'Output',
      group: 'Output',
    },
  },
  summary: (p) => `${p.guide}${p.output === 'ink' ? ' · ink only' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const orig = ctx.in.original;
    const mode = p.guide === 'blue' ? 0 : p.guide === 'faint' ? 1 : 2;
    const image = ctx.gpu.pass({
      label: 'remove-guide',
      size: src,
      textures: { src, orig: orig ?? src },
      uniforms: {
        mode,
        hasOrig: orig ? 1 : 0,
        blueTone: p.guide === 'blue' || p.blueGuide ? 1 : 0,
        k: p.strength,
        thr: mode === 0 ? p.threshold : Math.min(0.9, p.threshold + (p.guide === 'faint' ? p.strength : 0)),
        soft: p.softness,
        ink: p.output === 'ink' ? 1 : 0,
      },
      wgsl: /* wgsl */ `
const NPB = vec3f(0.5098, 0.7843, 0.9412);

fn lum3(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

// the guide as the printer drew it, from the original frame (white = no printed ink)
fn guideAt(uv: vec2f) -> vec3f {
  let t = 1.0 / vec2f(textureDimensions(orig));
  let o = textureSampleLevel(orig, smp, uv, 0.0);
  let oc = o.rgb + vec3f(1.0 - o.a);
  if (u.mode < 1.5) {
    if (u.blueTone > 0.5) {
      let dark = (1.0 - lum3(oc)) * u.k;
      return vec3f(1.0) - dark * (vec3f(1.0) - NPB);
    }
    return vec3f(1.0) - (vec3f(1.0) - oc) * u.k;
  }
  var l: array<f32, 9>;
  var n = 0;
  for (var j = -1; j <= 1; j++) { for (var i = -1; i <= 1; i++) {
    let s = textureSampleLevel(orig, smp, uv + vec2f(f32(i), f32(j)) * t, 0.0);
    l[n] = lum3(s.rgb + vec3f(1.0 - s.a));
    n++;
  } }
  let gx = l[2] + 2.0 * l[5] + l[8] - l[0] - 2.0 * l[3] - l[6];
  let gy = l[6] + 2.0 * l[7] + l[8] - l[0] - 2.0 * l[1] - l[2];
  let e = min(1.0, length(vec2f(gx, gy)) * 255.0 / 4.0 / 80.0);
  if (u.blueTone > 0.5) { return vec3f(1.0) - e * (vec3f(1.0) - NPB); }
  return vec3f(1.0 - 0.85 * e);
}

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  var c = clamp(s.rgb + vec3f(1.0 - s.a), vec3f(0.0), vec3f(1.0));
  if (u.hasOrig > 0.5) {
    let g = guideAt(uv);
    // where the guide printed (darker than white) divide it out; where it is nearly black we cannot tell, leave paper
    var d = c / max(g, vec3f(0.15));
    d = select(d, vec3f(1.0), g < vec3f(0.15));
    c = clamp(d, vec3f(0.0), vec3f(1.0));
    // small registration error leaves hairlines of the guide: a low threshold clears them
    let dk = 1.0 - min(c.r, min(c.g, c.b));
    let keep = smoothstep(0.05, 0.05 + u.soft, dk);
    c = vec3f(1.0) - (vec3f(1.0) - c) * keep;
  } else {
    var dk = 1.0 - min(c.r, min(c.g, c.b));
    if (u.mode < 0.5) { dk = 1.0 - c.b; }
    let keep = smoothstep(u.thr, u.thr + u.soft, dk);
    c = vec3f(1.0) - (vec3f(1.0) - c) * keep;
  }
  if (u.ink > 0.5) {
    let dark = 1.0 - min(c.r, min(c.g, c.b));
    let a = smoothstep(0.02, 0.14, dark);
    return vec4f(clamp(c - vec3f(1.0 - a), vec3f(0.0), vec3f(a)), a);
  }
  return vec4f(c, 1.0);
}`,
    });
    return { image };
  },
});
