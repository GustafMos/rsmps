import { defineNode } from '../../define';

/**
 * Escape-time fractals: for every pixel a number is squared and added to again and again, and the colour says how many
 * rounds it took to fly away (or that it never did). One pass; the cost is the iteration count.
 *
 * Everything that moves is tied to the loop: the spin, the colours and the Julia constant each make a whole number of
 * turns per loop, and the zoom breathes in and out once per cycle, so the last frame joins the first.
 * Numbers on the graphics card have about 7 digits, so the picture goes blocky beyond a zoom of roughly 2^17.
 * With a picture wired in, the first time the travelling number lands on the picture it takes that pixel's colour
 * (an "orbit trap"): the picture is stamped along the fractal's own shapes.
 */
export const FRACTAL_KINDS: Record<string, { label: string; id: number; center: [number, number]; span: number }> = {
  mandelbrot: { label: 'Mandelbrot', id: 0, center: [-0.6, 0], span: 3.2 },
  julia: { label: 'Julia', id: 1, center: [0, 0], span: 3.2 },
  ship: { label: 'Burning ship', id: 2, center: [-0.4, -0.5], span: 3.6 },
  tricorn: { label: 'Tricorn', id: 3, center: [-0.2, 0], span: 4 },
  newton: { label: 'Newton', id: 4, center: [0, 0], span: 3.2 },
  phoenix: { label: 'Phoenix', id: 5, center: [0, 0], span: 3 },
};

/** Cosine palettes: colour = a + b * cos(2 pi (c t + d)). */
export const FRACTAL_PALETTES: Record<string, { label: string; a: number[]; b: number[]; c: number[]; d: number[] }> = {
  psychedelic: { label: 'Psychedelic', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0, 0.33, 0.67] },
  fire: { label: 'Fire', a: [0.5, 0.3, 0.1], b: [0.5, 0.35, 0.15], c: [1, 1, 1], d: [0.5, 0.6, 0.7] },
  ocean: { label: 'Ocean', a: [0.2, 0.45, 0.6], b: [0.2, 0.4, 0.4], c: [1, 1, 1], d: [0.6, 0.45, 0.3] },
  neon: { label: 'Neon', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [2, 1, 1], d: [0.5, 0.2, 0.25] },
  sunset: { label: 'Sunset', a: [0.6, 0.4, 0.45], b: [0.4, 0.35, 0.35], c: [1, 1, 0.5], d: [0, 0.15, 0.4] },
  acid: { label: 'Acid', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 2, 3], d: [0.1, 0.4, 0.7] },
  ice: { label: 'Ice', a: [0.6, 0.7, 0.8], b: [0.4, 0.3, 0.2], c: [1, 1, 1], d: [0.55, 0.6, 0.65] },
  mono: { label: 'Black and white', a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0.5, 0.5, 0.5] },
};

const CORE_WGSL = /* wgsl */ `
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn cdiv(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x + a.y * b.y, a.y * b.x - a.x * b.y) / max(dot(b, b), 1.0e-12); }
fn cpow(z: vec2f, n: f32) -> vec2f {
  let r = length(z);
  if (r < 1.0e-12) { return vec2f(0.0); }
  let a = atan2(z.y, z.x) * n;
  return pow(r, n) * vec2f(cos(a), sin(a));
}
fn pal(t: f32) -> vec3f { return clamp(u.pa + u.pb * cos(TAU * (u.pc * t + u.pd)), vec3f(0.0), vec3f(1.0)); }
`;

/** `trap` = the variant that reads a wired picture. */
function fractalWgsl(trap: boolean): string {
  return /* wgsl */ `${CORE_WGSL}
fn shade(p0: vec2f) -> vec4f {
  var z = p0;
  var c = p0;
  let kind = i32(u.kind);
  if (kind == 1 || kind == 5) { c = u.jc; }
  if (kind == 0 || kind == 2 || kind == 3) { z = vec2f(0.0); }
  var prev = vec2f(0.0);
  var i = 0;
  let n = i32(u.iter);
  var escaped = false;
  var root = 0.0;
  ${trap ? 'var hit = vec4f(0.0);' : ''}
  for (; i < n; i++) {
    if (kind == 4) {
      // Newton's method on z^3 = 1: every start slides to one of three roots
      let z2 = cmul(z, z);
      let nz = z - cdiv(cmul(z2, z) - vec2f(1.0, 0.0), 3.0 * z2);
      if (dot(nz - z, nz - z) < 1.0e-7) { z = nz; escaped = true; break; }
      z = nz;
    } else {
      var w = z;
      if (kind == 2) { w = abs(z); }
      if (kind == 3) { w = vec2f(z.x, -z.y); }
      var nz = c;
      if (u.power == 2.0) { nz += cmul(w, w); } else { nz += cpow(w, u.power); }
      // Phoenix: the round before last pulls on this one, which bends the Julia shapes into feathers
      if (kind == 5) { nz = cmul(z, z) + vec2f(u.jc.x, 0.0) + u.jc.y * prev; prev = z; }
      z = nz;
      if (dot(z, z) > 256.0) { escaped = true; break; }
    }
    ${
      trap
        ? `if (i > 0 && hit.a == 0.0) {
      let q = z * u.trapScale + 0.5;
      if (q.x > 0.0 && q.x < 1.0 && q.y > 0.0 && q.y < 1.0) {
        let s = textureSampleLevel(trap, smp, q, 0.0);
        if (s.a > 0.05) { hit = s; }
      }
    }`
        : ''
    }
  }
  ${trap ? 'if (hit.a > 0.0) { let k = 1.0 - 0.6 * f32(i) / f32(n); return vec4f(hit.rgb * k, hit.a); }' : ''}
  if (kind == 4) {
    // which root: by its angle; shade by how long it took
    root = floor((atan2(z.y, z.x) / TAU + 1.0) * 3.0 + 0.5) / 3.0;
    let t = root + f32(i) * 0.02 * u.density + u.cycle;
    return vec4f(pal(t) * (1.0 - 0.75 * f32(i) / f32(n)), 1.0);
  }
  if (!escaped) { return vec4f(u.inside.rgb, 1.0); }
  // smooth count: no bands between one round and the next
  let nu = f32(i) + 1.0 - log2(max(log2(dot(z, z)) * 0.5, 1.0e-6)) / log2(max(u.power, 1.01));
  return vec4f(pal(nu * 0.03 * u.density + u.cycle), 1.0);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let aspect = u.size.x / u.size.y;
  var acc = vec4f(0.0);
  let ss = i32(u.ss);
  for (var j = 0; j < ss * ss; j++) {
    let o = (vec2f(f32(j % ss), f32(j / ss)) + 0.5) / f32(ss) - 0.5;
    var p = ((px + o) / u.size - 0.5) * vec2f(aspect, 1.0) * u.span;
    p = vec2f(p.x * u.rot.x - p.y * u.rot.y, p.x * u.rot.y + p.y * u.rot.x) + u.center;
    acc += shade(p);
  }
  let c = acc / f32(ss * ss);
  return vec4f(c.rgb * c.a, c.a);
}`;
}

const isJulia = (p: Record<string, unknown>) => p.kind === 'julia' || p.kind === 'phoenix';

export default defineNode({
  id: 'fractal',
  title: 'Fractal',
  category: 'generate',
  description: 'Mandelbrot, Julia, Burning ship, Tricorn, Newton and Phoenix fractals with zoom, spin, breathing and colours that cycle with the loop. Wire a picture in and it is stamped along the fractal’s shapes.',
  keywords: ['mandelbrot', 'julia', 'fractal', 'burning ship', 'tricorn', 'newton', 'phoenix', 'trippy', 'psychedelic', 'zoom', 'infinite', 'math', 'orbit trap', 'multibrot', 'visuals', 'vj'],
  inputs: { image: { type: 'image', label: 'Picture' }, size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    kind: { type: 'enum', default: 'mandelbrot', options: Object.entries(FRACTAL_KINDS).map(([value, v]) => ({ value, label: v.label })), label: 'Fractal' },
    center: { type: 'vec2', default: [0, 0], min: -4, max: 4, step: 0.0001, label: 'Move', hint: 'Where you look, from the usual view of this fractal.' },
    zoom: { type: 'number', default: 0, min: -2, max: 17, step: 0.01, label: 'Zoom', hint: 'Each step doubles the size. Beyond about 17 the picture goes blocky: the numbers run out of digits.' },
    rotate: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Rotate' },
    iterations: { type: 'number', default: 120, min: 8, max: 600, softMax: 300, step: 1, integer: true, label: 'Detail', hint: 'Rounds per pixel. More shows finer filaments (needed when zoomed in) and costs more.' },
    power: { type: 'number', default: 2, min: 2, max: 8, step: 0.01, label: 'Power', hint: '2 is the classic. 3 and up give more arms.', visibleIf: (p) => p.kind !== 'newton' && p.kind !== 'phoenix' },
    julia: { type: 'vec2', default: [-0.8, 0.156], min: -2, max: 2, step: 0.001, label: 'Julia number', hint: 'Every value is a different Julia set. Try -0.4, 0.6 or 0.285, 0.01.', visibleIf: isJulia },
    orbit: { type: 'number', default: 0.05, min: 0, max: 1, step: 0.005, label: 'Julia motion', hint: 'The Julia number circles by this much each loop, so the shape morphs.', visibleIf: isJulia },
    palette: { type: 'enum', default: 'psychedelic', options: Object.entries(FRACTAL_PALETTES).map(([value, v]) => ({ value, label: v.label })), label: 'Colors' },
    density: { type: 'number', default: 1, min: 0.05, max: 10, step: 0.01, label: 'Color bands', hint: 'How quickly the colours repeat going outward.' },
    inside: { type: 'color', default: [0, 0, 0, 1], label: 'Inside color' },
    cycle: { type: 'number', default: 1, min: -8, max: 8, step: 1, integer: true, label: 'Color cycles', hint: 'Times the colours run through per loop. 0 = still.' },
    spin: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: 'Spin', hint: 'Whole turns per loop.' },
    breathe: { type: 'number', default: 0, min: 0, max: 6, step: 0.05, label: 'Zoom breathing', hint: 'Zooms in by this many steps and back out again, once per loop.' },
    trapScale: { type: 'number', default: 0.5, min: 0.05, max: 4, step: 0.01, label: 'Picture size', hint: 'Size of the wired picture inside the fractal (smaller number = larger picture).' },
    smooth: { type: 'bool', default: false, label: 'Smooth edges', hint: 'Four samples per pixel: cleaner filaments, four times the cost.' },
  },
  summary: (p) => `${FRACTAL_KINDS[p.kind as string]?.label ?? p.kind} · zoom ${p.zoom}`,
  render(ctx) {
    const p = ctx.params;
    const kind = FRACTAL_KINDS[p.kind as string] ?? FRACTAL_KINDS.mandelbrot;
    const pal = FRACTAL_PALETTES[p.palette as string] ?? FRACTAL_PALETTES.psychedelic;
    const ph = ctx.time.phase;
    const TAU = Math.PI * 2;
    const zoom = p.zoom + p.breathe * (0.5 - 0.5 * Math.cos(ph * TAU));
    const a = (p.rotate * Math.PI) / 180 + ph * TAU * Math.round(p.spin);
    const jc = p.julia as number[];
    const trap = ctx.in.image;
    const image = ctx.gpu.pass({
      label: 'fractal',
      size: ctx.in.size ?? ctx.canvas,
      textures: trap ? { trap } : {},
      uniforms: {
        kind: kind.id,
        center: [kind.center[0] + (p.center as number[])[0], kind.center[1] + (p.center as number[])[1]],
        span: kind.span / Math.pow(2, zoom),
        rot: [Math.cos(a), Math.sin(a)],
        iter: Math.round(p.iterations),
        power: p.kind === 'newton' || p.kind === 'phoenix' ? 2 : p.power,
        jc: [jc[0] + p.orbit * Math.cos(ph * TAU), jc[1] + p.orbit * Math.sin(ph * TAU)],
        pa: pal.a, pb: pal.b, pc: pal.c, pd: pal.d,
        density: p.density,
        cycle: ph * Math.round(p.cycle),
        inside: p.inside,
        trapScale: p.trapScale,
        ss: p.smooth ? 2 : 1,
      },
      wgsl: fractalWgsl(!!trap),
    });
    return { image };
  },
});
