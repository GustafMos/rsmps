import { defineNode } from '../../define';

const EDGES = ['clamp', 'wrap', 'mirror'];

export default defineNode({
  id: 'wave-warp',
  title: 'Wave Warp',
  category: 'filter',
  description:
    'Bends the picture with sine waves (rows slide sideways, columns slide up and down), a flowing noise warp and optional tear lines. Waves are still until you give them whole cycles per loop, so the result loops exactly.',
  keywords: ['wave', 'ripple', 'sine', 'wobble', 'warp', 'distort', 'tear', 'shear', 'heat haze', 'underwater', 'glitch'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    waveX: { type: 'number', default: 12, min: 0, max: 300, softMax: 100, step: 0.5, unit: 'px', label: 'Rows slide by', group: 'Horizontal wave', hint: 'Each row is moved sideways by a sine of its height.' },
    waveXLength: { type: 'number', default: 160, min: 4, max: 4000, softMax: 1000, step: 1, unit: 'px', label: 'Wavelength', group: 'Horizontal wave', visibleIf: (p) => (p.waveX as number) > 0 },
    waveXCycles: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Moves (waves per loop)', group: 'Horizontal wave', hint: '0 = the wave stands still.', visibleIf: (p) => (p.waveX as number) > 0 },
    waveY: { type: 'number', default: 0, min: 0, max: 300, softMax: 100, step: 0.5, unit: 'px', label: 'Columns slide by', group: 'Vertical wave' },
    waveYLength: { type: 'number', default: 160, min: 4, max: 4000, softMax: 1000, step: 1, unit: 'px', label: 'Wavelength', group: 'Vertical wave', visibleIf: (p) => (p.waveY as number) > 0 },
    waveYCycles: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Moves (waves per loop)', group: 'Vertical wave', visibleIf: (p) => (p.waveY as number) > 0 },
    noiseAmount: { type: 'number', default: 0, min: 0, max: 300, softMax: 100, step: 0.5, unit: 'px', label: 'Noise warp', group: 'Noise warp' },
    noiseScale: { type: 'number', default: 120, min: 4, max: 2000, softMax: 600, step: 1, unit: 'px', label: 'Feature size', group: 'Noise warp', visibleIf: (p) => (p.noiseAmount as number) > 0 },
    noiseEvolution: { type: 'number', default: 0, min: 0, max: 16, step: 0.1, label: 'Evolution per loop', group: 'Noise warp', hint: '0 = frozen warp.', visibleIf: (p) => (p.noiseAmount as number) > 0 },
    tears: { type: 'number', default: 0, min: 0, max: 64, softMax: 24, step: 1, integer: true, label: 'Tear lines', group: 'Tears', hint: 'Thin bands that slip sideways.' },
    tearShift: { type: 'number', default: 40, min: 0, max: 600, softMax: 200, step: 1, unit: 'px', label: 'Tear distance', group: 'Tears', visibleIf: (p) => (p.tears as number) > 0 },
    tearHeight: { type: 'number', default: 10, min: 1, max: 200, softMax: 60, step: 0.5, unit: 'px', label: 'Tear height', group: 'Tears', visibleIf: (p) => (p.tears as number) > 0 },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', group: 'Tears', visibleIf: (p) => (p.tears as number) > 0 || (p.noiseAmount as number) > 0 },
    edge: {
      type: 'enum',
      default: 'mirror',
      label: 'Outside the picture',
      options: [
        { value: 'clamp', label: 'Repeat the edge pixels' },
        { value: 'wrap', label: 'Wrap around' },
        { value: 'mirror', label: 'Mirror' },
      ],
    },
  },
  summary: (p) => [p.waveX > 0 && `rows ${p.waveX} px`, p.waveY > 0 && `columns ${p.waveY} px`, p.noiseAmount > 0 && 'noise', p.tears > 0 && `${p.tears} tears`].filter(Boolean).join(' · ') || 'no warp',
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (p.waveX <= 0 && p.waveY <= 0 && p.noiseAmount <= 0 && p.tears <= 0) return { image: src };
    const moving = (p.waveX > 0 && p.waveXCycles !== 0) || (p.waveY > 0 && p.waveYCycles !== 0) || (p.noiseAmount > 0 && p.noiseEvolution > 0);
    const phase = moving ? ctx.time.phase : 0;
    const image = ctx.gpu.pass({
      label: 'wave-warp',
      size: src,
      textures: { src },
      uniforms: {
        wx: [p.waveX, p.waveXLength, p.waveXCycles * Math.PI * 2 * phase],
        wy: [p.waveY, p.waveYLength, p.waveYCycles * Math.PI * 2 * phase],
        noise: [p.noiseAmount, p.noiseScale, p.noiseEvolution],
        nphase: p.noiseEvolution > 0 ? phase : 0,
        tears: p.tears,
        tearShift: p.tearShift,
        tearHeight: p.tearHeight,
        seed: p.seed * 7.3,
        edge: Math.max(0, EDGES.indexOf(p.edge)),
      },
      wgsl: /* wgsl */ `
fn fold(q: vec2f) -> vec2f {
  if (u.edge < 0.5) { return clamp(q, vec2f(0.0), vec2f(1.0)); }
  if (u.edge < 1.5) { return fract(q); }
  let m = abs(q);
  return vec2f(1.0) - abs(vec2f(1.0) - (m - 2.0 * floor(m * 0.5)));
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var d = vec2f(0.0);
  if (u.wx.x > 0.0) { d.x += sin(px.y / u.wx.y * TAU + u.wx.z) * u.wx.x; }
  if (u.wy.x > 0.0) { d.y += sin(px.x / u.wy.y * TAU + u.wy.z) * u.wy.x; }
  if (u.noise.x > 0.0) {
    let np = px / u.noise.y + vec2f(u.seed, u.seed * 0.37);
    d += (vec2f(loopNoise(np, u.nphase, u.noise.z), loopNoise(np + vec2f(41.0, 17.0), u.nphase, u.noise.z)) - 0.5) * 2.0 * u.noise.x;
  }
  let n = i32(u.tears);
  for (var i = 0; i < n; i++) {
    let y0 = hash21(vec2f(f32(i) * 1.7, u.seed)) * u.size.y;
    let h = u.tearHeight * (0.4 + hash21(vec2f(f32(i), u.seed + 5.0)));
    if (px.y >= y0 && px.y < y0 + h) { d.x += (hash21(vec2f(f32(i), u.seed + 11.0)) - 0.5) * 2.0 * u.tearShift; }
  }
  return textureSampleLevel(src, smp, fold(uv + d / u.size), 0.0);
}`,
    });
    return { image };
  },
});
