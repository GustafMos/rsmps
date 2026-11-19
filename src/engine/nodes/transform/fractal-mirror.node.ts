import { defineNode } from '../../define';

/**
 * Fractal mirror: the picture is folded like paper (everything left of the middle is mirrored to the right, everything
 * above to below), turned, enlarged and moved, and then the same is done again to the result, several times over.
 * Each round doubles the mirrors, so a few rounds give a kaleidoscope inside a kaleidoscope: shapes that repeat at every
 * size, made of your own picture. Spin makes whole turns per loop and Breathe swings once per loop, so it loops.
 */
export default defineNode({
  id: 'fractal-mirror',
  title: 'Fractal Mirror',
  category: 'transform',
  description: 'Folds, turns and enlarges the picture again and again, so it becomes a kaleidoscope inside a kaleidoscope: shapes that repeat at every size, made of your own picture.',
  keywords: ['fractal', 'kaleidoscope', 'mirror', 'fold', 'trippy', 'psychedelic', 'ifs', 'mandala', 'recursive', 'symmetry', 'visuals', 'vj', 'snowflake'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    rounds: { type: 'number', default: 4, min: 1, max: 10, step: 1, integer: true, label: 'Rounds', hint: 'How many times the fold is repeated. Each round doubles the mirrors.' },
    scale: { type: 'number', default: 1.5, min: 1, max: 3, step: 0.01, label: 'Enlarge', hint: 'How much each round enlarges. Higher = finer detail sooner.' },
    angle: { type: 'number', default: 30, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Turn', hint: 'How much each round turns. This changes the whole pattern.' },
    offset: { type: 'vec2', default: [0.5, 0.3], min: -2, max: 2, step: 0.005, label: 'Shift', hint: 'How far each round moves the picture before the next fold.' },
    petals: { type: 'number', default: 0, min: 0, max: 24, step: 1, integer: true, label: 'Petals', hint: 'Above 0 the whole pattern is first made into a rosette with this many mirrored wedges.' },
    spin: { type: 'number', default: 1, min: -8, max: 8, step: 1, integer: true, label: 'Spin', hint: 'Whole turns of every fold per loop: the inner layers turn faster than the outer ones. 0 = still.' },
    breathe: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.005, label: 'Breathe', hint: 'The shift swings by this much, once per loop.' },
    zoom: { type: 'number', default: 1, min: 0.1, max: 8, step: 0.01, label: 'Zoom' },
  },
  summary: (p) => `${p.rounds} rounds · turn ${p.angle}°`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (!src) return { image: src };
    const ph = ctx.time.phase;
    const TAU = Math.PI * 2;
    // every fold makes whole turns per loop: anything less and the pattern at the end of the loop is not the one at its start
    const a = (p.angle * Math.PI) / 180 + ph * TAU * Math.round(p.spin);
    const off = p.offset as number[];
    const swing = p.breathe * Math.sin(ph * TAU);
    const image = ctx.gpu.pass({
      label: 'fractal-mirror',
      size: src,
      textures: { src },
      uniforms: { rounds: p.rounds, scale: p.scale, rot: [Math.cos(a), Math.sin(a)], off: [off[0] + swing, off[1] + swing * 0.6], petals: p.petals, zoom: p.zoom },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let aspect = u.size.x / u.size.y;
  var p = (uv - 0.5) * vec2f(aspect, 1.0) * 2.0 / u.zoom;
  if (u.petals >= 1.0) {
    // rosette: fold the angle into one wedge and mirror every other wedge
    let seg = PI / u.petals;
    var a = atan2(p.y, p.x);
    a = abs(((a % (2.0 * seg)) + 2.0 * seg) % (2.0 * seg) - seg);
    p = length(p) * vec2f(cos(a), sin(a));
  }
  let n = i32(u.rounds);
  for (var i = 0; i < n; i++) {
    p = abs(p);
    p = vec2f(p.x * u.rot.x - p.y * u.rot.y, p.x * u.rot.y + p.y * u.rot.x);
    p = p * u.scale - u.off;
  }
  // back onto the picture, mirrored at its edges so there is never a seam
  var st = p / vec2f(aspect, 1.0) * 0.5 + 0.5;
  st = 1.0 - abs(1.0 - fract(st * 0.5) * 2.0);
  return textureSampleLevel(src, smp, st, 0.0);
}`,
    });
    return { image };
  },
});
