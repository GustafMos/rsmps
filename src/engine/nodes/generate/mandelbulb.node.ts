import { defineNode } from '../../define';
import { FRACTAL_PALETTES } from './fractal.node';

/**
 * Mandelbulb: the Mandelbrot idea in three dimensions. A point is "raised to a power" by multiplying its two angles and
 * taking a power of its distance, the starting point is added, and that is repeated; points that never fly away are the
 * solid. It is drawn by walking a ray from the camera in steps, each step as long as the fractal is known to be far
 * away (a distance estimate), until the ray touches the surface. Colour comes from how close the travelling point came
 * to the middle, light from the slope of the surface, and the dark creases from how many steps the ray needed.
 * The camera circles and the power swings in whole cycles per loop. It is the most expensive node of the fractal family:
 * the cost is pixels x steps x rounds, so it is rendered at half size by default and enlarged.
 */
/** tex = the variant with a picture wrapped round the bulb (its colour, and optionally its relief). */
const marchWgsl = (tex: boolean): string => /* wgsl */ `
fn pal(t: f32) -> vec3f { return clamp(u.pa + u.pb * cos(TAU * (u.pc * t + u.pd)), vec3f(0.0), vec3f(1.0)); }
// distance to the surface (never more than the truth), and how near the travelling point came to the middle
${
  tex
    ? `// the picture wrapped round the bulb like a map round a globe: longitude across, latitude down
fn wrapUv(p: vec3f) -> vec2f {
  let r = max(length(p), 1.0e-6);
  return vec2f(fract(atan2(p.y, p.x) / TAU * u.texScale + u.texTurn), acos(clamp(p.z / r, -1.0, 1.0)) / PI);
}`
    : ''
}
fn bulbCore(p: vec3f) -> vec2f {
  var z = p;
  var dr = 1.0;
  var r = 0.0;
  var trap = 1.0e9;
  let n = i32(u.rounds);
  for (var i = 0; i < n; i++) {
    r = length(z);
    if (r > 2.0) { break; }
    let theta = acos(clamp(z.z / max(r, 1.0e-6), -1.0, 1.0)) * u.power;
    let phi = atan2(z.y, z.x) * u.power;
    dr = pow(r, u.power - 1.0) * u.power * dr + 1.0;
    z = pow(r, u.power) * vec3f(sin(theta) * cos(phi), sin(theta) * sin(phi), cos(theta)) + p;
    trap = min(trap, length(z));
  }
  return vec2f(0.5 * log(max(r, 1.0e-6)) * r / dr, trap);
}
fn bulb(p: vec3f) -> vec2f {
  let d = bulbCore(p);
  ${
    tex
      ? `// relief: bright parts of the picture stand out of the surface, dark parts sink in. The step is shortened to
  // match, because the true surface may now be nearer than the plain bulb says.
  if (u.relief != 0.0) {
    let l = luma(textureSampleLevel(pic, smp, wrapUv(p), 0.0).rgb);
    return vec2f((d.x - u.relief * (l - 0.5)) * 0.6, d.y);
  }`
      : ''
  }
  return d;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let aspect = u.size.x / u.size.y;
  let s = (uv - 0.5) * vec2f(aspect, -1.0) * 2.0;
  // camera on a circle round the bulb, looking at its middle
  let ro = u.dist * vec3f(cos(u.yaw) * cos(u.pitch), sin(u.yaw) * cos(u.pitch), sin(u.pitch));
  let fw = normalize(-ro);
  let rt = normalize(cross(fw, vec3f(0.0, 0.0, 1.0)));
  let up = cross(rt, fw);
  let rd = normalize(fw * u.lens + rt * s.x + up * s.y);
  var t = max(0.0, length(ro) - 2.2);
  var hit = false;
  var steps = 0.0;
  var trap = 0.0;
  let n = i32(u.steps);
  for (var i = 0; i < n; i++) {
    let d = bulb(ro + rd * t);
    trap = d.y;
    if (d.x < 0.0006 * t * u.fine) { hit = true; break; }
    t += d.x;
    steps += 1.0;
    if (t > u.dist + 3.0) { break; }
  }
  if (!hit) {
    if (u.clear > 0.5) { return vec4f(0.0); }
    let g = 0.5 + 0.5 * s.y;
    return vec4f(mix(u.bg.rgb * 0.35, u.bg.rgb, g), 1.0);
  }
  let pos = ro + rd * t;
  let e = 0.0012 * t;
  let nor = normalize(vec3f(
    bulb(pos + vec3f(e, 0.0, 0.0)).x - bulb(pos - vec3f(e, 0.0, 0.0)).x,
    bulb(pos + vec3f(0.0, e, 0.0)).x - bulb(pos - vec3f(0.0, e, 0.0)).x,
    bulb(pos + vec3f(0.0, 0.0, e)).x - bulb(pos - vec3f(0.0, 0.0, e)).x));
  let light = normalize(rt * 0.6 + up * 0.7 - fw * 0.5);
  let diff = max(dot(nor, light), 0.0);
  let spec = pow(max(dot(reflect(-light, nor), -rd), 0.0), 24.0);
  let ao = pow(clamp(1.0 - steps / u.steps, 0.0, 1.0), 1.6);
  var base = pal(trap * u.density + u.cycle);
  ${tex ? 'let tx = textureSampleLevel(pic, smp, wrapUv(pos), 0.0); base = mix(base, unpremul(tx).rgb, u.texMix * tx.a);' : ''}
  let rgb = base * (0.4 + 0.85 * diff) * mix(0.35, 1.0, ao) + vec3f(spec) * 0.4 * ao;
  return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), 1.0);
}`;

export default defineNode({
  id: 'mandelbulb',
  title: 'Mandelbulb',
  category: 'generate',
  description: 'A fractal in three dimensions: a knobbly, endlessly detailed bulb that the camera circles while its shape slowly swings. Heavy: lower Resolution or Steps if playback stutters.',
  keywords: ['mandelbulb', 'fractal', '3d', 'texture', 'video on 3d', 'displace', 'mandelbrot', 'trippy', 'psychedelic', 'raymarch', 'alien', 'bulb', 'visuals', 'vj', 'math'],
  inputs: { image: { type: 'image', label: 'Texture' }, size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    power: { type: 'number', default: 8, min: 2, max: 16, step: 0.05, label: 'Power', hint: '8 is the classic bulb. Lower is rounder, higher has more knobs.' },
    morph: { type: 'number', default: 1, min: 0, max: 6, step: 0.05, label: 'Morph', hint: 'The power swings up and down by this much, once per loop, so the shape breathes.' },
    distance: { type: 'number', default: 2.2, min: 1.2, max: 8, step: 0.01, label: 'Camera distance' },
    orbit: { type: 'number', default: 1, min: -8, max: 8, step: 1, integer: true, label: 'Orbit', hint: 'Whole trips of the camera round the bulb per loop. 0 = still.' },
    yaw: { type: 'number', default: 30, min: -180, max: 180, step: 1, unit: 'deg', label: 'Turn' },
    pitch: { type: 'number', default: 20, min: -85, max: 85, step: 1, unit: 'deg', label: 'Height' },
    palette: { type: 'enum', default: 'sunset', options: Object.entries(FRACTAL_PALETTES).map(([value, v]) => ({ value, label: v.label })), label: 'Colors' },
    density: { type: 'number', default: 0.5, min: 0.1, max: 8, step: 0.01, label: 'Color bands' },
    cycle: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: 'Color cycles', hint: 'Times the colours run through per loop.' },
    background: { type: 'color', default: [0.05, 0.06, 0.1, 1], label: 'Background', hint: 'Alpha 0 = transparent, to put the bulb over a picture.' },
    texMix: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Texture amount', group: 'Texture', hint: 'With a picture or video wired into Texture: how much of the surface colour comes from it instead of the colour set.' },
    texScale: { type: 'number', default: 1, min: 1, max: 8, step: 1, integer: true, label: 'Texture repeats', group: 'Texture', hint: 'How many times the picture goes round the bulb.' },
    texSpin: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: 'Texture spin', group: 'Texture', hint: 'Whole trips of the picture round the bulb per loop.' },
    relief: { type: 'number', default: 0, min: -0.5, max: 0.5, step: 0.005, label: 'Relief', group: 'Texture', hint: 'Bright parts of the picture push the surface out, dark parts pull it in (the other way round below 0). A video makes the surface move.' },
    rounds: { type: 'number', default: 8, min: 3, max: 16, step: 1, integer: true, label: 'Detail', hint: 'Rounds of the formula. More = finer surface, more cost.' },
    steps: { type: 'number', default: 64, min: 16, max: 200, step: 1, integer: true, label: 'Steps', hint: 'How far the ray is followed into the creases. More = deeper detail, more cost.' },
    resolution: {
      type: 'enum',
      default: 'half',
      options: [
        { value: 'quarter', label: 'Quarter, fastest' },
        { value: 'half', label: 'Half' },
        { value: 'full', label: 'Full, slowest' },
      ],
      label: 'Resolution',
      hint: 'The bulb is rendered at this share of the frame and enlarged.',
    },
  },
  summary: (p) => `power ${p.power} · ${p.resolution}`,
  render(ctx) {
    const p = ctx.params;
    const out = ctx.in.size ?? ctx.canvas;
    const k = p.resolution === 'full' ? 1 : p.resolution === 'quarter' ? 4 : 2;
    const size = { width: Math.max(8, Math.round(out.width / k)), height: Math.max(8, Math.round(out.height / k)), unit: out.unit / k };
    const pal = FRACTAL_PALETTES[p.palette as string] ?? FRACTAL_PALETTES.sunset;
    const ph = ctx.time.phase;
    const TAU = Math.PI * 2;
    const bg = p.background as number[];
    const pic = ctx.in.image;
    const small = ctx.gpu.pass({
      label: 'mandelbulb',
      size,
      textures: pic ? { pic } : {},
      uniforms: {
        texMix: p.texMix,
        texScale: Math.round(p.texScale),
        texTurn: ph * Math.round(p.texSpin),
        relief: p.relief,
        power: Math.max(1.5, p.power + p.morph * Math.sin(ph * TAU)),
        rounds: Math.round(p.rounds),
        steps: Math.round(p.steps),
        dist: p.distance,
        yaw: (p.yaw * Math.PI) / 180 + ph * TAU * Math.round(p.orbit),
        pitch: (p.pitch * Math.PI) / 180,
        lens: 1.8,
        fine: k, // at a reduced size a pixel covers more of the surface: stop the ray a little earlier
        pa: pal.a, pb: pal.b, pc: pal.c, pd: pal.d,
        density: p.density,
        cycle: ph * Math.round(p.cycle),
        bg: [bg[0], bg[1], bg[2]],
        clear: (bg[3] ?? 1) < 0.5,
      },
      wgsl: marchWgsl(!!pic),
    });
    if (k === 1) return { image: small };
    const image = ctx.gpu.pass({ label: 'mandelbulb-up', size: out, textures: { src: small }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }' });
    return { image };
  },
});
