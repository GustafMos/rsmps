import { defineNode } from '../../define';

/**
 * Radial lens distortion, one-parameter division model (Fitzgibbon): with positions measured from the centre in units of
 * the half diagonal, a straight-lens point at radius ru lands at radius rd where ru = rd / (1 + k rd²). Negative k is
 * barrel distortion (wide lenses, action cameras), positive k is pincushion (long lenses). The model has an exact inverse,
 * rd = 2 ru / (1 + sqrt(1 - 4 k ru²)), so Distort followed by Undistort with the same amount gives the picture back.
 */
export const lensK = (amount: number): number => -0.5 * amount;

/** Where an output position (centre units) reads the source. `null`: nothing of the source lands there. */
export function lensSource(x: number, y: number, k: number, undistort: boolean): [number, number] | null {
  const r2 = x * x + y * y;
  if (!undistort) {
    const d = 1 + k * r2;
    return d <= 0.02 ? null : [x / d, y / d];
  }
  const disc = 1 - 4 * k * r2;
  if (disc < 0) return null;
  const f = 2 / (1 + Math.sqrt(disc));
  return [x * f, y * f];
}

/**
 * The zoom (1 or less: zoom in) at which no empty edge shows: every point on the border of the output reads inside the
 * source. `cx, cy` is the centre (0..1), `w, h` the picture size.
 */
export function lensFillScale(k: number, undistort: boolean, w: number, h: number, cx = 0.5, cy = 0.5): number {
  const half = 0.5 * Math.hypot(w, h);
  const inside = (s: number): boolean => {
    for (let i = 0; i < 64; i++) {
      const t = i / 16;
      const side = Math.floor(t);
      const f = t - side;
      const u = side === 0 ? f : side === 1 ? 1 : side === 2 ? 1 - f : 0;
      const v = side === 0 ? 0 : side === 1 ? f : side === 2 ? 1 : 1 - f;
      const q = lensSource(((u - cx) * w * s) / half, ((v - cy) * h * s) / half, k, undistort);
      if (!q) return false;
      const su = (q[0] * half) / w + cx;
      const sv = (q[1] * half) / h + cy;
      if (su < -1e-4 || su > 1 + 1e-4 || sv < -1e-4 || sv > 1 + 1e-4) return false;
    }
    return true;
  };
  if (inside(1)) return 1;
  let lo = 0.05;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (inside(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

export default defineNode({
  id: 'lens-distortion',
  title: 'Lens Distortion',
  category: 'filter',
  description: 'Bends the picture like a lens does (barrel, fisheye or pincushion), or removes that bend from footage so straight lines are straight again.',
  keywords: ['undistort', 'barrel', 'pincushion', 'fisheye', 'fish eye', 'wide angle', 'gopro', 'action camera', 'lens correction', 'straighten', 'bulge', 'warp', 'curvature'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    mode: { type: 'enum', default: 'distort', options: [{ value: 'distort', label: 'Distort' }, { value: 'undistort', label: 'Undistort' }], label: 'Mode', hint: 'Distort adds the bend of a lens. Undistort removes it: the same amount undoes what Distort did.' },
    amount: { type: 'number', default: 0.3, min: -1, max: 1, step: 0.005, label: 'Amount', hint: 'Above 0: barrel, the bulge of a wide lens. Below 0: pincushion. To correct footage, choose Undistort and raise this until straight lines are straight.' },
    center: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: 0, max: 1, step: 0.001, label: 'Center', hint: 'The middle of the lens. 0.5, 0.5 is the middle of the picture.' },
    fill: { type: 'bool', default: true, label: 'Fill the frame', hint: 'Zooms in just enough that no empty edge shows.' },
    zoom: { type: 'number', default: 1, min: 0.25, max: 4, step: 0.005, label: 'Zoom' },
    edge: { type: 'enum', default: 'clear', options: [{ value: 'clear', label: 'Transparent' }, { value: 'repeat', label: 'Repeat the edge' }, { value: 'mirror', label: 'Mirror' }], label: 'Outside', hint: 'What shows where the bent picture does not reach.' },
  },
  summary: (p) => `${p.mode === 'undistort' ? 'undistort' : 'distort'} ${p.amount}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (!src) return { image: src };
    if (Math.abs(p.amount) < 1e-4 && Math.abs(p.zoom - 1) < 1e-4) return { image: src };
    const k = lensK(p.amount);
    const undistort = p.mode === 'undistort';
    const c = p.center as [number, number];
    const fit = p.fill ? lensFillScale(k, undistort, src.width, src.height, c[0], c[1]) : 1;
    const image = ctx.gpu.pass({
      label: 'lens-distortion',
      size: src,
      textures: { src },
      uniforms: { k, undistort, center: c, scale: fit / p.zoom, edge: p.edge === 'clear' ? 0 : p.edge === 'repeat' ? 1 : 2 },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let half = 0.5 * length(u.size);
  let p = (uv - u.center) * u.size / half * u.scale;
  let r2 = dot(p, p);
  var q = p;
  if (u.undistort > 0.5) {
    let disc = 1.0 - 4.0 * u.k * r2;
    if (disc < 0.0) { return vec4f(0.0); }
    q = p * 2.0 / (1.0 + sqrt(disc));
  } else {
    let d = 1.0 + u.k * r2;
    if (d <= 0.02) { return vec4f(0.0); }
    q = p / d;
  }
  var st = q * half / u.size + u.center;
  if (u.edge < 0.5) {
    // half a pixel of soft edge so the border of the bent picture is not jagged
    let e = min(min(st.x, 1.0 - st.x) * u.size.x, min(st.y, 1.0 - st.y) * u.size.y);
    if (e <= -0.5) { return vec4f(0.0); }
    return textureSampleLevel(src, smp, clamp(st, vec2f(0.0), vec2f(1.0)), 0.0) * clamp(e + 0.5, 0.0, 1.0);
  }
  if (u.edge > 1.5) { st = 1.0 - abs(1.0 - fract(st * 0.5) * 2.0); }
  return textureSampleLevel(src, smp, clamp(st, vec2f(0.0), vec2f(1.0)), 0.0);
}`,
    });
    return { image };
  },
});
