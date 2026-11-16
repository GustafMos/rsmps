import { defineNode } from '../../define';

const SIDES: Record<string, number> = { circle: 0, hexagon: 6, octagon: 8 };
const QUALITY: Record<string, number> = { draft: 64, normal: 160, high: 288 };
/** Largest radius (in texels) the gather pass ever works at; bigger blurs are done on a smaller copy and upsampled. */
const WORK_RADIUS = 4;

export default defineNode({
  id: 'lens-blur',
  title: 'Lens Blur',
  category: 'filter',
  description:
    'Out-of-focus blur with a real camera look: the blur is a disc or polygon (bokeh), bright lights bloom into visible discs, and an optional depth map keeps the in-focus band sharp.',
  keywords: ['bokeh', 'defocus', 'out of focus', 'depth of field', 'dof', 'camera', 'aperture', 'iris', 'tilt shift'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    depth: { type: 'image', label: 'Depth (optional)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    radius: { type: 'number', default: 14, min: 0, max: 300, softMax: 80, step: 0.5, unit: 'px', label: 'Blur size', hint: 'Radius of the out-of-focus disc.' },
    shape: {
      type: 'enum',
      default: 'circle',
      label: 'Aperture shape',
      group: 'Aperture',
      options: [
        { value: 'circle', label: 'Circle' },
        { value: 'hexagon', label: 'Hexagon' },
        { value: 'octagon', label: 'Octagon' },
      ],
    },
    rotation: { type: 'number', default: 0, min: -180, max: 180, step: 1, unit: 'deg', label: 'Blade rotation', group: 'Aperture', visibleIf: (p) => p.shape !== 'circle' },
    highlightThreshold: { type: 'number', default: 0.75, min: 0, max: 1, step: 0.01, label: 'Highlight cutoff', group: 'Highlights', hint: 'Areas brighter than this bloom into bokeh discs.' },
    highlightGain: { type: 'number', default: 4, min: 0, max: 12, softMax: 8, step: 0.1, label: 'Highlight boost', group: 'Highlights', hint: '0 = plain even blur.' },
    quality: {
      type: 'enum',
      default: 'normal',
      label: 'Quality',
      group: 'Quality',
      options: [
        { value: 'draft', label: 'Draft' },
        { value: 'normal', label: 'Normal' },
        { value: 'high', label: 'High' },
      ],
    },
    focus: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Focus depth', group: 'Depth map', hint: 'Depth value (0..1) that stays sharp. Only used when a depth image is wired.' },
    range: { type: 'number', default: 0.1, min: 0, max: 0.95, step: 0.01, label: 'In-focus range', group: 'Depth map', hint: 'Depth band around the focus that stays fully sharp.' },
  },
  summary: (p) => `${p.radius} px ${p.shape}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const depth = ctx.in.depth;
    if (p.radius < 0.5) return { image: src };
    const gpu = ctx.gpu;

    const down = Math.max(1, Math.ceil(p.radius / WORK_RADIUS));
    const w = Math.max(1, Math.round(src.width / down));
    const h = Math.max(1, Math.round(src.height / down));
    const low = { width: w, height: h, unit: src.unit / down };
    const taps = Math.round(QUALITY[p.quality] * (ctx.quality === 'preview' ? 0.5 : 1));
    const depthUniforms = { focus: p.focus, range: p.range, denom: Math.max(Math.max(p.focus, 1 - p.focus) - p.range, 0.05) };

    // 1. linear-light premultiplied copies at working resolution (box filtered): boost-weighted colour+alpha, and the weights.
    //    Weighting is done per full-resolution texel, so small bright lights keep their punch after downsampling.
    const prepWgsl = (out: string) => /* wgsl */ `
fn boost(c: vec4f) -> f32 {
  if (u.gain <= 0.0 || c.a <= 0.0001) { return 1.0; }
  let l = luma(c.rgb / c.a);
  return 1.0 + u.gain * smoothstep(u.thr, u.thr + 0.12 * (1.0 - u.thr) + 0.02, l);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let texel = 1.0 / vec2f(textureDimensions(src));
  var acc = vec4f(0.0);
  var wacc = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let s = unpremul(textureSampleLevel(src, smp, uv + vec2f(f32(i), f32(j)) * u.step * texel, 0.0));
      let c = vec4f(srgbToLinear(s.rgb) * s.a, s.a);
      let w = boost(c);
      acc += c * w;
      wacc += w;
    }
  }
  ${out}
}`;
    const prepOpts = { size: low, format: 'rgba16float' as const, textures: { src }, uniforms: { step: down / 3, gain: p.highlightGain, thr: Math.pow(p.highlightThreshold, 2.2) } };
    const lin = gpu.pass({ ...prepOpts, label: 'lens-prep', wgsl: prepWgsl('return acc / 9.0;') });
    const wts = gpu.pass({ ...prepOpts, label: 'lens-weights', wgsl: prepWgsl('return vec4f(wacc / 9.0);') });

    // 2. bounded gather: golden-angle spiral over a disc/polygon, weights boost highlights (and respect depth)
    const hasDepth = !!depth;
    const gathered = gpu.pass({
      label: 'lens-gather',
      size: low,
      format: 'rgba16float',
      textures: { lin, wts, depth: depth ?? null },
      uniforms: {
        radius: p.radius / down,
        taps,
        sides: SIDES[p.shape],
        rot: (p.rotation * Math.PI) / 180,
        ...depthUniforms,
      },
      wgsl: /* wgsl */ `
fn polyScale(theta: f32) -> f32 {
  if (u.sides < 1.0) { return 1.0; }
  let seg = TAU / u.sides;
  let a = (theta - u.rot) - seg * floor((theta - u.rot) / seg) - seg * 0.5;
  return cos(PI / u.sides) / cos(a);
}
${hasDepth ? `
fn cocAt(uv: vec2f) -> f32 {
  let d = textureSampleLevel(depth, smp, uv, 0.0).r;
  return clamp((abs(d - u.focus) - u.range) / u.denom, 0.0, 1.0);
}` : ''}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let texel = 1.0 / vec2f(textureDimensions(lin));
  let centre = textureSampleLevel(lin, smp, uv, 0.0);
  ${hasDepth ? 'let rad = u.radius * cocAt(uv);' : 'let rad = u.radius;'}
  if (rad < 0.35) { return centre / max(textureSampleLevel(wts, smp, uv, 0.0).r, 0.0001); }
  var acc = centre;
  var wsum = textureSampleLevel(wts, smp, uv, 0.0).r;
  let n = i32(clamp(u.taps, 8.0, 320.0));
  for (var i = 0; i < n; i++) {
    let t = (f32(i) + 0.5) / f32(n);
    let theta = f32(i) * 2.39996323;
    let ps = polyScale(theta);
    let r = sqrt(t) * ps;
    let off = vec2f(cos(theta), sin(theta)) * r * rad;
    let tuv = uv + off * texel;
    let c = textureSampleLevel(lin, smp, tuv, 0.0);
    var wt = ps * ps;
    ${hasDepth ? 'wt = wt * clamp(u.radius * cocAt(tuv) - length(off) + 1.0, 0.0, 1.0);' : ''}
    acc += c * wt; wsum += textureSampleLevel(wts, smp, tuv, 0.0).r * wt;
  }
  return acc / wsum;
}`,
    });

    // 3. back to sRGB premultiplied at full size; with depth, blend the sharp original back in where in focus
    const image = gpu.pass({
      label: 'lens-resolve',
      size: src,
      textures: { src, blurred: gathered, depth: depth ?? null },
      uniforms: { radius: p.radius, ...depthUniforms },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let b = textureSampleLevel(blurred, smp, uv, 0.0);
  let straight = select(vec3f(0.0), b.rgb / b.a, b.a > 0.0001);
  let blur = premul(vec4f(clamp(linearToSrgb(straight), vec3f(0.0), vec3f(1.0)), clamp(b.a, 0.0, 1.0)));
  ${
    hasDepth
      ? `let d = textureSampleLevel(depth, smp, uv, 0.0).r;
  let coc = clamp((abs(d - u.focus) - u.range) / u.denom, 0.0, 1.0);
  let k = smoothstep(0.0, 1.5, coc * u.radius);
  return mix(textureSampleLevel(src, smpNearest, uv, 0.0), blur, k);`
      : 'return blur;'
  }
}`,
    });
    return { image };
  },
});
