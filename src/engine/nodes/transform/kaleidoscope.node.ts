import { defineNode } from '../../define';
import { rad } from '../../lib/copy-wgsl';
import { EDGE_WGSL } from '../../lib/util-wgsl';

const MODES = { kaleidoscope: 0, mirror: 1, polar: 2, logpolar: 3 } as const;

/**
 * Kaleidoscope / Mirror: one fragment pass, every mode is an inverse map from the output pixel to a source position.
 * Animation: `spin` (whole turns per loop) and `fall` / `scroll` (whole periods per loop) so everything loops by construction.
 */
export default defineNode({
  id: 'kaleidoscope',
  title: 'Kaleidoscope / Mirror',
  category: 'transform',
  description:
    'Folds a picture into mirrored wedges (kaleidoscope), mirrored tiles, a polar warp (the picture wrapped around a point) or a log-polar spiral tunnel (the picture repeating inwards forever, the spiral version of the infinite fall). Spins and falls in perfect loops.',
  keywords: ['kaleidoscope', 'mirror', 'symmetry', 'segments', 'mandala', 'polar', 'log-polar', 'logpolar', 'spiral', 'tunnel', 'fall', 'droste', 'wedge', 'radial', 'fractal', 'trippy', 'reflect'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'kaleidoscope',
      label: 'Mode',
      options: [
        { value: 'kaleidoscope', label: 'Kaleidoscope' },
        { value: 'mirror', label: 'Mirror tiles' },
        { value: 'polar', label: 'Polar' },
        { value: 'logpolar', label: 'Log-polar tunnel' },
      ],
    },
    segments: { type: 'number', default: 6, min: 1, max: 64, softMax: 32, step: 1, integer: true, label: 'Segments', hint: 'Kaleidoscope: wedges around the centre. Log-polar: spiral arms.', visibleIf: (p) => p.mode === 'kaleidoscope' || p.mode === 'logpolar' },
    centre: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: -1, max: 2, step: 0.005, label: 'Center', hint: 'Where the effect is centred on the frame.' },
    source: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: -1, max: 2, step: 0.005, label: 'Read from', hint: 'The part of the picture the wedges / tiles show.', visibleIf: (p) => p.mode === 'kaleidoscope' || p.mode === 'mirror' },
    zoom: { type: 'number', default: 1, min: 0.05, max: 20, step: 0.01, label: 'Zoom' },
    angle: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate' },
    spin: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin', hint: 'Whole turns per loop; 0 = still.' },
    scroll: { type: 'vec2', default: [0, 0], min: -16, max: 16, step: 1, label: 'Scroll', hint: 'Mirror tiles: whole mirror periods (two pictures) per loop. 0 = still.', visibleIf: (p) => p.mode === 'mirror' },
    ratio: { type: 'number', default: 0.35, min: 0.02, max: 0.95, step: 0.005, label: 'Shrink per repeat', hint: 'Log-polar: each ring inwards is this much smaller.', visibleIf: (p) => p.mode === 'logpolar' },
    twist: { type: 'number', default: 0, min: -4, max: 4, step: 0.05, label: 'Spiral twist', hint: 'Log-polar: turns per repeat (use a whole number for no seam).', visibleIf: (p) => p.mode === 'logpolar' },
    fall: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Fall', hint: 'Log-polar: whole repeats travelled per loop. Positive falls inwards.', visibleIf: (p) => p.mode === 'logpolar' },
  },
  summary: (p) => (p.mode === 'kaleidoscope' ? `${p.segments} segments` : p.mode === 'logpolar' ? `log-polar · ${p.segments} arms` : (p.mode as string)),
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const animated = p.spin !== 0 || p.fall !== 0 || p.scroll[0] !== 0 || p.scroll[1] !== 0;
    const phase = animated ? ctx.time.phase : 0;
    const mode = MODES[p.mode as keyof typeof MODES];
    const image = ctx.gpu.pass({
      label: 'kaleidoscope',
      size: src,
      textures: { src },
      uniforms: {
        mode,
        seg: Math.max(1, Math.round(p.segments)),
        ctr: [p.centre[0] * src.width, p.centre[1] * src.height],
        srcPt: [p.source[0] * src.width, p.source[1] * src.height],
        zoom: p.zoom,
        ang: rad(p.angle) + Math.PI * 2 * p.spin * phase,
        scroll: [p.scroll[0] * phase * 2 * src.width, p.scroll[1] * phase * 2 * src.height],
        lnR: Math.log(Math.min(0.97, Math.max(0.02, p.ratio))),
        twist: p.twist,
        fall: p.fall * phase,
      },
      wgsl: /* wgsl */ `
${EDGE_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let m = i32(u.mode + 0.5);
  let d = px - u.ctr;
  let r = length(d);
  let th = atan2(d.y, d.x) - u.ang;
  let sz = u.size;
  let rmax = 0.5 * length(sz);
  if (m == 0) {
    let seg = TAU / u.seg;
    var a = th - seg * floor(th / seg);
    a = abs(a - seg * 0.5);
    let q = u.srcPt + (r / u.zoom) * vec2f(cos(a), sin(a));
    return edgeSample(src, q, 3, true);
  }
  if (m == 1) {
    let c = cos(u.ang); let s = sin(u.ang);
    let rr = vec2f(d.x * c + d.y * s, -d.x * s + d.y * c);
    return edgeSample(src, u.srcPt + rr / u.zoom - u.scroll, 3, true);
  }
  if (m == 2) {
    let q = vec2f(fract(th / TAU + 1.0) * sz.x, clamp(r / (rmax / u.zoom), 0.0, 1.0) * sz.y);
    return edgeSample(src, q, 1, true);
  }
  // log-polar: ring index runs along the radius, arms around the angle
  let lr = log(max(r, 0.5) / (0.5 * min(sz.x, sz.y)) / u.zoom);
  let v = lr / u.lnR + u.fall;
  let a = th / TAU * u.seg + u.twist * v;
  let q = vec2f(fract(a) * sz.x, fract(v) * sz.y);
  return edgeSample(src, q, 2, true);
}`,
    });
    return { image };
  },
});
