import type { ColorValue, ImageValue, NodeGpu, ParamDef } from '../types';

/** Every transition mode, in shader order. The label starts with its family so the inspector list reads as groups. */
export const TRANSITION_MODES = [
  ['crossfade', 'Blend · Crossfade'],
  ['flash', 'Blend · Flash through white'],
  ['dip', 'Blend · Dip to colour'],
  ['bayer-2', 'Dither · Ordered 2×2'],
  ['bayer-4', 'Dither · Ordered 4×4'],
  ['bayer-8', 'Dither · Ordered 8×8'],
  ['blue-noise', 'Dither · Blue-noise dissolve'],
  ['diffusion', 'Dither · Diffusion-like dissolve'],
  ['noise-dissolve', 'Dither · Random pixel dissolve'],
  ['halftone', 'Dither · Halftone dots grow'],
  ['lines', 'Dither · Scan-line dissolve'],
  ['blocks', 'Dither · Block mosaic flip'],
  ['pixelate-through', 'Dither · Pixelate through'],
  ['palette', 'Dither · Palette dissolve'],
  ['luma', 'Wipe · Luma (brightness decides)'],
  ['iris', 'Wipe · Iris (circle)'],
  ['clock', 'Wipe · Clock'],
  ['linear', 'Wipe · Linear (angle)'],
  ['noise-wipe', 'Wipe · Cloudy noise'],
  ['burn', 'Wipe · Burn'],
  ['ripple', 'Wipe · Ripple'],
  ['cross-zoom', 'Warp · Cross zoom'],
  ['melt', 'Warp · Melt (each drives the other)'],
  ['liquid', 'Warp · Liquid'],
  ['push', 'Warp · Push / slide'],
  ['spin', 'Warp · Spin'],
  ['mosh', 'Glitch · Block smear (data mosh)'],
  ['streak', 'Glitch · Streak wipe (pixel-sort style)'],
  ['glitch-cut', 'Glitch · Glitch cut'],
  ['rgb-split', 'Glitch · RGB split fade'],
  ['tv-roll', 'Glitch · TV roll'],
] as const;

export type TransitionMode = (typeof TRANSITION_MODES)[number][0];

/** The controls shared by Transition and Transition (auto). `progress` is added by each node. */
export const transitionParams = {
  mode: { type: 'enum', default: 'bayer-4', label: 'Style', options: TRANSITION_MODES.map(([value, label]) => ({ value, label })) },
  softness: { type: 'number', default: 0.15, min: 0, max: 1, step: 0.01, label: 'Softness', hint: 'Width of the soft edge between the two pictures.' },
  cell: { type: 'number', default: 24, min: 1, max: 400, softMax: 160, step: 1, unit: 'px', label: 'Pattern size', hint: 'Size of the dither cells, blocks, dots, lines or noise features.' },
  angle: { type: 'number', default: 0, min: -180, max: 180, step: 1, unit: 'deg', label: 'Direction', hint: 'Wipe, push and melt direction (0 = towards the right).' },
  amount: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Strength', hint: 'How strong the warping, glow or glitch is.' },
  seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed' },
  center: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', step: 0.001, label: 'Centre', hint: 'Where iris, clock, ripple, zoom and spin start.' },
  edgeColor: { type: 'color', default: [1, 0.55, 0.1, 1], label: 'Edge / dip colour', hint: 'Burn glow, flash tint and the colour to dip through.' },
  lumaFrom: {
    type: 'enum',
    default: 'a',
    label: 'Brightness taken from',
    options: [
      { value: 'a', label: 'Picture A' },
      { value: 'b', label: 'Picture B' },
      { value: 'map', label: 'The Map input' },
    ],
    visibleIf: (p: Record<string, unknown>) => p.mode === 'luma',
  },
  invert: { type: 'bool', default: false, label: 'Reverse the order', hint: 'Swap which parts change first (dark/bright, inside/outside, start/end).' },
  fit: {
    type: 'enum',
    default: 'cover',
    label: 'Fit B to A',
    options: [
      { value: 'cover', label: 'Fill (crop to A)' },
      { value: 'stretch', label: 'Stretch' },
    ],
  },
} as const satisfies Record<string, ParamDef>;

export interface TransitionSettings {
  mode: string;
  softness: number;
  cell: number;
  angle: number;
  amount: number;
  seed: number;
  center: [number, number];
  edgeColor: ColorValue;
  lumaFrom: string;
  invert: boolean;
  fit: string;
}

const SHADER = /* wgsl */ `
fn A(q: vec2f) -> vec4f { return textureSampleLevel(ta, smp, clamp(q, vec2f(0.0), vec2f(1.0)), 0.0); }
fn B(q0: vec2f) -> vec4f {
  let q = (clamp(q0, vec2f(0.0), vec2f(1.0)) - 0.5) * u.bscale + 0.5;
  return sampleCrisp(tb, q, u.btpp);
}
fn lumaOf(c: vec4f) -> f32 { return luma(unpremul(c).rgb); }
fn reveal(th: f32, t: f32, soft: f32) -> f32 {
  let s = max(soft, 0.0002);
  return clamp((t * (1.0 + s) - th) / s, 0.0, 1.0);
}
fn bayerN(p: vec2i, bits: i32) -> f32 {
  var v = 0u;
  for (var l = bits - 1; l >= 0; l--) {
    let xb = u32((p.x >> u32(l)) & 1);
    let yb = u32((p.y >> u32(l)) & 1);
    v = v * 4u + ((xb * 2u) ^ (yb * 3u));
  }
  let n = f32(1u << u32(bits * 2));
  return (f32(v) + 0.5) / n;
}
fn fbm(p0: vec2f) -> f32 {
  var p = p0; var s = 0.0; var a = 0.5;
  for (var i = 0; i < 4; i++) { s += a * vnoise(p); a *= 0.5; p = p * 2.03 + 7.1; }
  return s / 0.9375;
}
fn inside(q: vec2f) -> bool { return all(q >= vec2f(0.0)) && all(q <= vec2f(1.0)); }
fn rotp(p: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(c * p.x - s * p.y, s * p.x + c * p.y); }

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let t = u.t;
  let soft = u.soft;
  let dir = vec2f(cos(u.ang), sin(u.ang));
  let aspect = u.size.x / u.size.y;
  let c = u.center;
  let bump = sin(PI * t);
  let cellp = floor(px / max(u.cell, 1.0));
  var res = vec4f(0.0);
  switch (i32(u.mode)) {
    // ---- blends
    case 0: { res = mix(A(uv), B(uv), t); }
    case 1: {
      let m = smoothstep(0.35, 0.65, t);
      let col = mix(A(uv), B(uv), m);
      res = vec4f(col.rgb + mix(vec3f(1.0), u.edge.rgb, 0.35) * pow(bump, 4.0) * u.amount * 1.1 * max(col.a, 0.2), col.a);
    }
    case 2: {
      let w = 0.5 - 0.25 * soft * 2.0;
      let dip = vec4f(u.edge.rgb * u.edge.a, u.edge.a);
      if (t < 0.5) { res = mix(A(uv), dip, clamp(t / w, 0.0, 1.0)); }
      else { res = mix(dip, B(uv), clamp((t - (1.0 - w)) / w, 0.0, 1.0)); }
    }
    // ---- dither family
    case 3: { res = mix(A(uv), B(uv), reveal(bayerN(vec2i(cellp), 1), t, soft * 0.3)); }
    case 4: { res = mix(A(uv), B(uv), reveal(bayerN(vec2i(cellp), 2), t, soft * 0.3)); }
    case 5: { res = mix(A(uv), B(uv), reveal(bayerN(vec2i(cellp), 3), t, soft * 0.3)); }
    case 6: {
      let th = fract(dot(cellp + vec2f(u.seed), vec2f(0.7548776662, 0.5698402910)));
      res = mix(A(uv), B(uv), reveal(th, t, soft * 0.3));
    }
    case 7: {
      let th = fract(52.9829189 * fract(dot(cellp + vec2f(u.seed), vec2f(0.06711056, 0.00583715))));
      res = mix(A(uv), B(uv), reveal(th, t, soft * 0.3));
    }
    case 8: { res = mix(A(uv), B(uv), reveal(hash21(cellp + vec2f(u.seed * 1.7)), t, soft * 0.3)); }
    case 9: {
      let g = rotp(px / max(u.cell, 2.0), 0.7853982);
      let d = length(fract(g) - 0.5) / 0.7071;
      let w = 0.04 + soft * 0.3;
      let r = mix(-w, 1.0 + w, t);
      res = mix(A(uv), B(uv), 1.0 - smoothstep(r - w, r + w, d));
    }
    case 10: {
      let row = floor(px.y / max(u.cell * 0.25, 1.0));
      let th = clamp(uv.x * 0.7 + 0.3 * hash21(vec2f(row, u.seed)), 0.0, 1.0);
      res = mix(A(uv), B(uv), reveal(th, t, soft * 0.5 + 0.02));
    }
    case 11: { res = mix(A(uv), B(uv), reveal(hash21(cellp + vec2f(u.seed * 3.1)), t, soft * 0.5)); }
    case 12: {
      let bs = 1.0 + (max(u.cell, 2.0) - 1.0) * pow(bump, 1.5);
      let q = (floor(px / bs) + 0.5) * bs / u.size;
      res = mix(A(q), B(q), smoothstep(0.5 - soft * 0.2 - 0.001, 0.5 + soft * 0.2 + 0.001, t));
    }
    case 13: {
      let n = mix(48.0, 3.0, bump);
      let a = A(uv); let b = B(uv);
      let qa = vec4f(floor(unpremul(a).rgb * n + 0.5) / n, 1.0) * a.a;
      let qb = vec4f(floor(unpremul(b).rgb * n + 0.5) / n, 1.0) * b.a;
      let th = bayerN(vec2i(floor(px / max(u.cell / 8.0, 1.0))), 3);
      res = mix(qa, qb, reveal(th, t, soft * 0.3));
    }
    // ---- wipes
    case 14: {
      var l = lumaOf(A(uv));
      if (u.lumaFrom > 0.5 && u.lumaFrom < 1.5) { l = lumaOf(B(uv)); }
      if (u.lumaFrom > 1.5) { l = luma(textureSampleLevel(tmap, smp, uv, 0.0).rgb); }
      res = mix(A(uv), B(uv), reveal(select(l, 1.0 - l, u.invert > 0.5), t, max(soft, 0.03)));
    }
    case 15: {
      let d = length((uv - c) * vec2f(aspect, 1.0));
      let far = max(max(length((vec2f(0.0) - c) * vec2f(aspect, 1.0)), length((vec2f(1.0, 0.0) - c) * vec2f(aspect, 1.0))), max(length((vec2f(0.0, 1.0) - c) * vec2f(aspect, 1.0)), length((vec2f(1.0) - c) * vec2f(aspect, 1.0))));
      let th = d / far;
      res = mix(A(uv), B(uv), reveal(select(th, 1.0 - th, u.invert > 0.5), t, max(soft, 0.02)));
    }
    case 16: {
      let v = uv - c;
      let a = atan2(v.x, -v.y);
      res = mix(A(uv), B(uv), reveal(fract(a / TAU + select(0.0, 0.0, u.invert > 0.5)), t, max(soft * 0.5, 0.01)));
    }
    case 17: {
      let th = dot(uv - 0.5, dir) / (abs(dir.x) + abs(dir.y)) + 0.5;
      res = mix(A(uv), B(uv), reveal(select(th, 1.0 - th, u.invert > 0.5), t, max(soft, 0.01)));
    }
    case 18: {
      let n = smoothstep(0.15, 0.85, fbm(px / max(u.cell * 4.0, 4.0) + vec2f(u.seed * 3.7)));
      res = mix(A(uv), B(uv), reveal(select(n, 1.0 - n, u.invert > 0.5), t, max(soft, 0.03)));
    }
    case 19: {
      let n = smoothstep(0.1, 0.9, 0.75 * fbm(px / max(u.cell * 4.0, 4.0) + vec2f(u.seed * 3.7)) + 0.25 * (1.0 - uv.y));
      let w = max(soft, 0.08);
      let x = (t * (1.0 + w) - n) / w;
      let a = A(uv); let b = B(uv);
      let charred = a * (1.0 - 0.85 * smoothstep(0.0, 0.7, x));
      var col = mix(charred, b, smoothstep(0.7, 1.0, x));
      let e = sin(clamp(x, 0.0, 1.0) * PI);
      col = vec4f(col.rgb + u.edge.rgb * e * u.amount * 2.5, max(col.a, e * 0.0 + col.a));
      res = select(a, col, x > 0.0);
    }
    case 20: {
      let d = length((uv - c) * vec2f(aspect, 1.0)) / 1.2;
      let x = clamp((t * (1.0 + max(soft, 0.05)) - d) / max(soft, 0.05), 0.0, 1.0);
      let wave = sin(d * 70.0 - t * 12.0) * sin(PI * x) * u.amount * 0.03;
      let off = normalize(uv - c + vec2f(0.0001)) * wave / vec2f(aspect, 1.0);
      res = mix(A(uv + off), B(uv + off), x);
    }
    // ---- warps
    case 21: {
      var ca = vec4f(0.0); var cb = vec4f(0.0);
      for (var k = 0; k < 10; k++) {
        let s = f32(k) / 9.0;
        ca += A(c + (uv - c) / (1.0 + u.amount * 1.5 * t * s));
        cb += B(c + (uv - c) / (1.0 + u.amount * 1.5 * (1.0 - t) * s));
      }
      res = mix(ca / 10.0, cb / 10.0, smoothstep(0.2, 0.8, t));
    }
    case 22: {
      let a0 = A(uv); let b0 = B(uv);
      let d = dir * (lumaOf(b0) - 0.5) * t * u.amount * 0.5;
      let e = dir * (lumaOf(a0) - 0.5) * (1.0 - t) * u.amount * 0.5;
      res = mix(A(uv + d), B(uv - e), smoothstep(0.2, 0.8, t));
    }
    case 23: {
      let np = px / max(u.cell * 4.0, 4.0) + vec2f(u.seed * 5.3);
      let d = (vec2f(fbm(np), fbm(np + vec2f(19.0, 7.0))) - 0.5) * u.amount * 0.5 * bump;
      res = mix(A(uv + d), B(uv - d), smoothstep(0.25, 0.75, t));
    }
    case 24: {
      let s = dir / (abs(dir.x) + abs(dir.y));
      let qa = uv - s * t;
      let qb = uv - s * (t - 1.0);
      if (inside(qb)) { res = B(qb); } else { res = A(qa); }
    }
    case 25: {
      let p = (uv - c) * vec2f(aspect, 1.0);
      let th = u.amount * TAU * 0.5;
      let za = 1.0 + t * 0.6;
      let zb = 1.0 + (1.0 - t) * 0.6;
      let qa = rotp(p, th * t) / za / vec2f(aspect, 1.0) + c;
      let qb = rotp(p, -th * (1.0 - t)) / zb / vec2f(aspect, 1.0) + c;
      res = mix(A(qa), B(qb), smoothstep(0.3, 0.7, t));
    }
    // ---- glitch
    case 26: {
      let h = hash21(cellp + vec2f(u.seed * 2.3));
      let d = (hash22(cellp + vec2f(u.seed, 4.0)) - 0.5) * 3.0 * u.amount * bump * u.cell / u.size;
      res = mix(A(uv + d), B(uv), reveal(h, t, soft * 0.4));
    }
    case 27: {
      let row = floor(px.y / max(u.cell * 0.25, 1.0));
      let h = hash21(vec2f(row, u.seed));
      let f = t * 1.4 - 0.4 * h;
      let len = u.amount * 0.5 * smoothstep(0.0, 0.15, t) * (1.0 - smoothstep(0.85, 1.0, t));
      if (uv.x < f) { res = B(uv); }
      else if (uv.x < f + len) { res = A(vec2f(clamp(f, 0.0, 1.0), uv.y)); }
      else { res = A(uv); }
    }
    case 28: {
      let g = pow(max(0.0, 1.0 - abs(t - 0.5) * 5.0), 1.5);
      let band = floor(px.y / max(u.cell * 0.5, 2.0));
      let slot = floor(t * 24.0);
      let sh = (hash21(vec2f(band, slot + u.seed)) - 0.5) * u.amount * 0.6 * g;
      let split = u.amount * 0.03 * g;
      let base = t < 0.5;
      var ca = vec4f(0.0);
      if (base) { ca = vec4f(A(uv + vec2f(sh + split, 0.0)).r, A(uv + vec2f(sh, 0.0)).g, A(uv + vec2f(sh - split, 0.0)).b, A(uv + vec2f(sh, 0.0)).a); }
      else { ca = vec4f(B(uv + vec2f(sh + split, 0.0)).r, B(uv + vec2f(sh, 0.0)).g, B(uv + vec2f(sh - split, 0.0)).b, B(uv + vec2f(sh, 0.0)).a); }
      res = ca;
    }
    case 29: {
      let tr = smoothstep(0.0, 0.75, t); let tg = smoothstep(0.125, 0.875, t); let tb = smoothstep(0.25, 1.0, t);
      let off = vec2f(u.amount * 0.03 * bump, 0.0);
      let ar = A(uv + off); let ag = A(uv); let ab = A(uv - off);
      let br = B(uv + off); let bg = B(uv); let bb = B(uv - off);
      res = vec4f(mix(ar.r, br.r, tr), mix(ag.g, bg.g, tg), mix(ab.b, bb.b, tb), mix(ag.a, bg.a, tg));
    }
    case 30: {
      let row = floor(px.y);
      let jit = (hash21(vec2f(row, floor(t * 40.0) + u.seed)) - 0.5) * 0.04 * u.amount * bump;
      let uvj = uv + vec2f(jit, 0.0);
      let qa = uvj - vec2f(0.0, t);
      let qb = uvj - vec2f(0.0, t - 1.0);
      if (inside(qb)) { res = B(qb); } else { res = A(qa); }
      let seam = abs(uv.y - t);
      res = res * (1.0 - 0.9 * (1.0 - smoothstep(0.0, 0.02 * u.amount * 2.0, seam)) * bump);
    }
    default: { res = mix(A(uv), B(uv), t); }
  }
  return res;
}`;

/** Runs one transition frame. `progress` is clamped to 0..1; 0 returns A and 1 returns B exactly. */
export function runTransition(gpu: NodeGpu, a: ImageValue, b: ImageValue, map: ImageValue | null, s: TransitionSettings, progress: number): ImageValue {
  const t = Math.max(0, Math.min(1, progress));
  const sameSize = a.width === b.width && a.height === b.height;
  if (t <= 0) return a;
  if (t >= 1 && sameSize) return b;
  const modeIndex = Math.max(0, TRANSITION_MODES.findIndex(([id]) => id === s.mode));
  const ratioA = a.width / a.height;
  const ratioB = b.width / b.height;
  let bscale: [number, number] = [1, 1];
  if (s.fit === 'cover') bscale = ratioB > ratioA ? [ratioA / ratioB, 1] : [1, ratioB / ratioA];
  const btpp: [number, number] = [(b.width * bscale[0]) / a.width, (b.height * bscale[1]) / a.height];
  const useMode = t >= 1 ? 0 : modeIndex;
  return gpu.pass({
    label: 'transition',
    size: a,
    textures: { ta: a, tb: b, tmap: map ?? a },
    uniforms: {
      mode: useMode,
      t,
      soft: s.softness,
      cell: s.cell,
      ang: (s.angle * Math.PI) / 180,
      amount: s.amount,
      seed: s.seed * 1.37,
      center: s.center,
      edge: s.edgeColor,
      lumaFrom: s.lumaFrom === 'b' ? 1 : s.lumaFrom === 'map' && map ? 2 : 0,
      invert: s.invert,
      bscale,
      btpp,
    },
    wgsl: SHADER,
  });
}
