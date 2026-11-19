import { defineNode } from '../../define';

/**
 * Droste: the picture contains a smaller copy of itself, which contains a smaller copy, and so on for ever.
 *
 * How: a point is written as (how far out, which direction) with the distance on a logarithmic scale, where "one copy
 * further in" is always the same step. Multiplying that pair as one complex number by (1 + i k) turns the stack of
 * rings into a spiral without bending shapes out of true (the map stays angle-preserving, like Escher's Print Gallery);
 * k is chosen so that going once round lands exactly a whole number of copies further in. The result is then brought
 * back to the size of the one copy that is actually drawn. Zooming moves along the logarithmic scale by whole copies
 * per loop, so the last frame is the first.
 */
export default defineNode({
  id: 'droste',
  title: 'Droste Spiral',
  category: 'transform',
  description: 'The picture inside itself, for ever: nested copies that shrink toward the middle, straight or wound into a spiral, with an endless zoom that loops.',
  keywords: ['droste', 'spiral', 'recursive', 'infinite zoom', 'picture in picture', 'escher', 'tunnel', 'trippy', 'psychedelic', 'nested', 'fractal', 'loop', 'visuals', 'vj'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    ratio: { type: 'number', default: 4, min: 1.2, max: 32, step: 0.05, label: 'Shrink', hint: 'How many times smaller each copy is than the one around it.' },
    arms: { type: 'number', default: 1, min: -6, max: 6, step: 1, integer: true, label: 'Spiral arms', hint: '0 = copies straight inside each other. 1 = one spiral. More arms, or below 0 for the other way round.' },
    center: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: 0, max: 1, step: 0.005, label: 'Center' },
    zoom: { type: 'number', default: 1, min: -8, max: 8, step: 1, integer: true, label: 'Zoom', hint: 'Copies travelled per loop. Above 0 falls in, below 0 flies out, 0 = still.' },
    spin: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: 'Spin', hint: 'Whole turns per loop.' },
    rotate: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Rotate' },
    shape: { type: 'enum', default: 'frame', options: [{ value: 'frame', label: 'Picture frame' }, { value: 'round', label: 'Round' }], label: 'Copy shape', hint: 'Picture frame: each copy is the whole picture. Round: each copy is a ring of it.' },
  },
  summary: (p) => `÷${p.ratio}${p.arms ? ` · ${p.arms} arm${Math.abs(p.arms) === 1 ? '' : 's'}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (!src) return { image: src };
    const ph = ctx.time.phase;
    const L = Math.log(Math.max(1.0001, p.ratio));
    const image = ctx.gpu.pass({
      label: 'droste',
      size: src,
      textures: { src },
      uniforms: {
        L,
        k: (Math.round(p.arms) * L) / (Math.PI * 2),
        center: p.center,
        shift: ph * Math.round(p.zoom) * L,
        turn: (p.rotate * Math.PI) / 180 + ph * Math.PI * 2 * Math.round(p.spin),
        round: p.shape === 'round',
      },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let aspect = u.size.x / u.size.y;
  let z = (uv - u.center) * vec2f(aspect, 1.0) * 2.0;
  let r = max(length(z), 1.0e-6);
  // (log distance, direction) times (1 + i k): the spiral
  let w = vec2f(log(r), atan2(z.y, z.x) + u.turn);
  var s = vec2f(w.x - u.k * w.y, w.y + u.k * w.x);
  s.x += u.shift;
  var q = vec2f(0.0);
  if (u.round > 0.5) {
    // one ring of the picture: distance between 1 / ratio and 1
    let lr = s.x - u.L * ceil(s.x / u.L);
    q = exp(lr) * vec2f(cos(s.y), sin(s.y));
  } else {
    q = exp(s.x - u.L * floor(s.x / u.L)) * vec2f(cos(s.y), sin(s.y));
    // bring it to the copy whose frame it lies in: inside the picture, outside the next copy
    let m = max(abs(q.x) / aspect, abs(q.y));
    q = q * exp(-u.L * ceil(log(max(m, 1.0e-6)) / u.L));
  }
  let st = q / vec2f(aspect, 1.0) * 0.5 + 0.5;
  return textureSampleLevel(src, smp, clamp(st, vec2f(0.0), vec2f(1.0)), 0.0);
}`,
    });
    return { image };
  },
});
