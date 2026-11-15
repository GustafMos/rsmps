import { defineNode } from '../../define';

const MODES = [
  { value: 'normal', label: 'Normal' },
  { value: 'add', label: 'Add' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'difference', label: 'Difference' },
] as const;

/**
 * EXEMPLAR — two-image node. Shows: inputs of different sizes (the background defines the
 * output; the foreground is placed in normalised coordinates), enum → shader selector.
 */
export default defineNode({
  id: 'merge',
  title: 'Merge',
  category: 'composite',
  description: 'Put a foreground over a background with a blend mode. The background sets the output size.',
  keywords: ['over', 'composite', 'blend', 'layer', 'mix'],
  inputs: {
    background: { type: 'image', required: true, label: 'Background' },
    foreground: { type: 'image', label: 'Foreground' },
    mask: { type: 'mask', label: 'Mask' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: { type: 'enum', default: 'normal', options: MODES, label: 'Blend' },
    opacity: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Opacity' },
    center: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', step: 0.001, label: 'Position' },
    scale: { type: 'number', default: 1, min: 0.01, max: 20, step: 0.01, label: 'Scale' },
    fit: {
      type: 'enum',
      default: 'contain',
      options: [
        { value: 'contain', label: 'Fit inside' },
        { value: 'cover', label: 'Fill' },
        { value: 'stretch', label: 'Stretch' },
        { value: 'actual', label: 'Actual size' },
      ],
      label: 'Foreground size',
    },
  },
  summary: (p) => `${p.mode} · ${Math.round(p.opacity * 100)}%`,
  render(ctx) {
    const { background: bg, foreground: fg, mask } = ctx.in;
    if (!fg) return { image: bg };
    const p = ctx.params;
    // Foreground size in background texels.
    let fw = fg.width;
    let fh = fg.height;
    if (p.fit === 'stretch') {
      fw = bg.width;
      fh = bg.height;
    } else if (p.fit === 'actual') {
      // Same physical scale: compare units so a proxy render matches the full one.
      fw = (fg.width * bg.unit) / fg.unit;
      fh = (fg.height * bg.unit) / fg.unit;
    } else {
      const k = p.fit === 'contain' ? Math.min(bg.width / fg.width, bg.height / fg.height) : Math.max(bg.width / fg.width, bg.height / fg.height);
      fw = fg.width * k;
      fh = fg.height * k;
    }
    fw *= p.scale;
    fh *= p.scale;
    const image = ctx.gpu.pass({
      label: 'merge',
      size: bg,
      textures: { bg, fg, m: mask },
      uniforms: {
        mode: MODES.findIndex((m) => m.value === p.mode),
        opacity: p.opacity,
        center: p.center,
        fsize: [fw / bg.width, fh / bg.height],
      },
      wgsl: /* wgsl */ `
fn blend(mode: i32, b: vec3f, f: vec3f) -> vec3f {
  switch mode {
    case 1 { return b + f; }
    case 2 { return b * f; }
    case 3 { return 1.0 - (1.0 - b) * (1.0 - f); }
    case 4 { return select(1.0 - 2.0 * (1.0 - b) * (1.0 - f), 2.0 * b * f, b < vec3f(0.5)); }
    case 5 { return min(b, f); }
    case 6 { return max(b, f); }
    case 7 { return abs(b - f); }
    default { return f; }
  }
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let b = textureSampleLevel(bg, smpNearest, uv, 0.0);
  let fuv = (uv - u.center) / u.fsize + 0.5;
  if (fuv.x < 0.0 || fuv.y < 0.0 || fuv.x > 1.0 || fuv.y > 1.0) { return b; }
  var f = sampleCrisp(fg, fuv, vec2f(textureDimensions(fg)) / (u.fsize * u.size)) * u.opacity;
  ${mask ? 'f *= textureSampleLevel(m, smp, uv, 0.0).r;' : ''}
  let bs = unpremul(b); let fs = unpremul(f);
  // Blend where both exist, plain foreground where the background is empty.
  let mixed = mix(fs.rgb, clamp(blend(i32(u.mode), bs.rgb, fs.rgb), vec3f(0.0), vec3f(1.0)), bs.a);
  let rgb = mixed * f.a + b.rgb * (1.0 - f.a);
  return vec4f(rgb, f.a + b.a * (1.0 - f.a));
}`,
    });
    return { image };
  },
});
