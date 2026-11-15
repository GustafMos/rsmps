// Example RSMPS plugin: horizontal glitch bands.
// One ES module, no imports. The default export is a node definition (or an array of them).
// Install it from the Plugins panel; the node then appears under Filter as "Glitch Bands".
export default {
  id: 'example/glitch',
  title: 'Glitch Bands',
  category: 'filter',
  description: 'Shifts horizontal bands of the image sideways, like a broken video signal.',
  keywords: ['glitch', 'shift', 'datamosh', 'vhs'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    // 'px' lengths arrive in render() already converted to texels of the input image.
    amount: { type: 'number', default: 24, min: 0, max: 400, step: 1, unit: 'px', label: 'Shift' },
    bands: { type: 'number', default: 12, min: 2, max: 120, step: 1, integer: true, label: 'Bands' },
  },
  summary: (p) => `${p.bands} bands`,
  render(ctx) {
    const image = ctx.gpu.pass({
      label: 'example-glitch',
      size: ctx.in.image, // same size and unit as the input
      textures: { src: ctx.in.image },
      uniforms: { amount: ctx.params.amount, bands: ctx.params.bands },
      wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let band = floor(uv.y * u.bands);
  // Deterministic pseudo-random shift per band, in -1..1 (never use Math.random in a node).
  let r = hash21(vec2f(band, 7.0)) * 2.0 - 1.0;
  let shift = select(0.0, r * u.amount / u.size.x, hash21(vec2f(band, 3.0)) > 0.5);
  let c = textureSampleLevel(src, smpNearest, vec2f(fract(uv.x + shift), uv.y), 0.0);
  return c;
}`,
    });
    return { image };
  },
};
