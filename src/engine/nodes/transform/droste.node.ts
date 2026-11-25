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
 *
 * Shape: "how far out" need not be a circle's radius. Measured as a square's, a hexagon's or a star's it gives copies
 * of that outline; Petals and Twist bend the measure itself, so the spiral becomes a flower or a whirlpool.
 * Driver: a second picture (noise, an Oscilloscope, anything) pushes every point along the spiral (in or out) and
 * round it, by its brightness. Because the push happens on the logarithmic scale it is the same at every size, which
 * is what makes the whole tunnel breathe with the driver instead of only its surface.
 */
export const DROSTE_SHAPES = { frame: 0, round: 1, square: 2, diamond: 3, hexagon: 4, triangle: 5, star: 6, flower: 7, heart: 8 } as const;

/** `driven` = the variant that reads a wired driver picture. */
function drosteWgsl(driven: boolean): string {
  return /* wgsl */ `
// how far out a point is, measured in the chosen outline (1 = on the outline that touches the frame)
fn reach(q: vec2f, aspect: f32) -> f32 {
  let k = i32(u.shape);
  let a = atan2(q.y, q.x);
  let r = length(q);
  if (k == 0) { return max(abs(q.x) / aspect, abs(q.y)); }
  if (k == 1) { return r; }
  if (k == 2) { return max(abs(q.x), abs(q.y)); }
  if (k == 3) { return (abs(q.x) + abs(q.y)) * 0.7071; }
  if (k == 4) { let p = abs(q); return max(p.x * 0.8660254 + p.y * 0.5, p.y); }
  if (k == 5) { return max(abs(q.x) * 0.8660254 + q.y * 0.5, -q.y) * 1.2; }
  if (k == 6) {
    // a star: the outline swings in and out u.points times round
    return r / (0.72 + 0.28 * cos(a * u.points));
  }
  if (k == 7) {
    // a flower: rounded petals
    return r / (0.62 + 0.38 * abs(cos(a * u.points * 0.5)));
  }
  // heart
  let h = vec2f(q.x, -q.y + 0.25);
  let ha = atan2(h.x, h.y);
  return length(h) / (0.55 + 0.45 * pow(abs(ha) / PI, 0.6) * 1.6 - 0.25 * abs(sin(ha)));
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let aspect = u.size.x / u.size.y;
  let z = (uv - u.center) * vec2f(aspect, 1.0) * 2.0;
  let r = max(length(z), 1.0e-6);
  let ang = atan2(z.y, z.x);
  // (log distance, direction) times (1 + i k): the spiral
  let w = vec2f(log(r), ang + u.turn);
  var s = vec2f(w.x - u.k * w.y, w.y + u.k * w.x);
  // petals: the distance swells and shrinks round the circle, so each turn of the spiral is scalloped
  s.x += u.petalDepth * cos(ang * u.petals + u.petalTurn);
  // twist: the further in, the more it is turned, so straight nesting becomes a whirlpool
  s.y += u.twist * w.x;
  ${
    driven
      ? `// the driver: bright pushes one way, dark the other, mid-grey leaves the point alone
  var duv = uv;
  if (u.driveSpace > 0.5) {
    // read along the spiral itself, so the same disturbance repeats in every copy
    duv = vec2f(fract(s.y / TAU + 0.5), fract(s.x / u.L));
  }
  let dv = unpremul(textureSampleLevel(driver, smp, duv, 0.0));
  let push = (luma(dv.rgb) - 0.5) * 2.0 * dv.a;
  s.x += u.drive * push * u.L;
  s.y += u.driveTurn * push;`
      : ''
  }
  s.x += u.shift;
  // one whole copy: between 1 / ratio and 1 of the outline
  var q = exp(s.x - u.L * floor(s.x / u.L)) * vec2f(cos(s.y), sin(s.y));
  let m = reach(q, aspect);
  q = q * exp(-u.L * ceil(log(max(m, 1.0e-6)) / u.L));
  if (u.shape > 0.5) {
    // every outline but the picture frame is measured in units of the height: fit it inside the picture
    q = q * u.fit;
  }
  let st = q / vec2f(aspect, 1.0) * 0.5 + 0.5;
  return textureSampleLevel(src, smp, 1.0 - abs(1.0 - fract(clamp(st, vec2f(-1.0), vec2f(2.0)) * 0.5) * 2.0), 0.0);
}`;
}

const hasPoints = (p: Record<string, unknown>) => p.shape === 'star' || p.shape === 'flower';

export default defineNode({
  id: 'droste',
  title: 'Droste Spiral',
  category: 'transform',
  description: 'The picture inside itself, for ever: nested copies that shrink toward the middle, straight or wound into a spiral, in the outline of a frame, circle, hexagon, star, flower or heart, with an endless zoom that loops. A second picture (noise, an Oscilloscope) can drive the shape.',
  keywords: ['droste', 'spiral', 'recursive', 'infinite zoom', 'picture in picture', 'escher', 'tunnel', 'trippy', 'psychedelic', 'nested', 'fractal', 'loop', 'visuals', 'vj', 'whirlpool', 'vortex', 'flower', 'dreamy', 'audio reactive'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    driver: { type: 'image', label: 'Driver' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    ratio: { type: 'number', default: 4, min: 1.2, max: 32, step: 0.05, label: 'Shrink', hint: 'How many times smaller each copy is than the one around it.' },
    arms: { type: 'number', default: 1, min: -6, max: 6, step: 1, integer: true, label: 'Spiral arms', hint: '0 = copies straight inside each other. 1 = one spiral. More arms, or below 0 for the other way round.' },
    shape: {
      type: 'enum',
      default: 'frame',
      options: [
        { value: 'frame', label: 'Picture frame' },
        { value: 'round', label: 'Round' },
        { value: 'square', label: 'Square' },
        { value: 'diamond', label: 'Diamond' },
        { value: 'hexagon', label: 'Hexagon' },
        { value: 'triangle', label: 'Triangle' },
        { value: 'star', label: 'Star' },
        { value: 'flower', label: 'Flower' },
        { value: 'heart', label: 'Heart' },
      ],
      label: 'Copy shape',
      hint: 'The outline of every copy. Picture frame: each copy is the whole picture. The others cut each copy to that shape.',
    },
    points: { type: 'number', default: 5, min: 2, max: 16, step: 1, integer: true, label: 'Points', visibleIf: hasPoints },
    petals: { type: 'number', default: 0, min: 0, max: 24, step: 1, integer: true, label: 'Petals', hint: 'Scallops round every turn of the spiral: it becomes a flower or a cog. 0 = smooth.' },
    petalDepth: { type: 'number', default: 0.15, min: 0, max: 1, step: 0.005, label: 'Petal depth', visibleIf: (p) => (p.petals as number) > 0 },
    petalSpin: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: 'Petal spin', hint: 'Whole turns of the petals per loop.', visibleIf: (p) => (p.petals as number) > 0 },
    twist: { type: 'number', default: 0, min: -3, max: 3, step: 0.01, label: 'Whirl', hint: 'Turns the copies more the further in they are: a whirlpool. Works with any number of arms.' },
    center: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: 0, max: 1, step: 0.005, label: 'Center' },
    zoom: { type: 'number', default: 1, min: -8, max: 8, step: 1, integer: true, label: 'Zoom', hint: 'Copies travelled per loop. Above 0 falls in, below 0 flies out, 0 = still.' },
    spin: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: 'Spin', hint: 'Whole turns per loop.' },
    rotate: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Rotate' },
    drive: { type: 'number', default: 0.5, min: -3, max: 3, step: 0.01, label: 'Driver push', group: 'Driver', hint: 'With a picture wired into Driver: how far its bright and dark parts push the spiral in and out, in copies. Wire Noise for a dreamy drift, an Oscilloscope for a spiral that follows the sound.' },
    driveTurn: { type: 'number', default: 0, min: -3, max: 3, step: 0.01, label: 'Driver turn', group: 'Driver', hint: 'How far the driver turns the spiral round its middle.' },
    driveSpace: {
      type: 'enum',
      default: 'screen',
      options: [
        { value: 'screen', label: 'As it lies on screen' },
        { value: 'spiral', label: 'Along the spiral' },
      ],
      label: 'Driver reads',
      group: 'Driver',
      hint: 'On screen: the driver picture sits over the frame. Along the spiral: it is wrapped round the spiral, so the same disturbance repeats in every copy.',
    },
  },
  summary: (p) => `÷${p.ratio}${p.arms ? ` · ${p.arms} arm${Math.abs(p.arms) === 1 ? '' : 's'}` : ''}${p.shape !== 'frame' ? ` · ${p.shape}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (!src) return { image: src };
    const driver = ctx.in.driver;
    const ph = ctx.time.phase;
    const L = Math.log(Math.max(1.0001, p.ratio));
    const TAU = Math.PI * 2;
    const image = ctx.gpu.pass({
      label: 'droste',
      size: src,
      textures: driver ? { src, driver } : { src },
      uniforms: {
        L,
        k: (Math.round(p.arms) * L) / TAU,
        center: p.center,
        shift: ph * Math.round(p.zoom) * L,
        turn: (p.rotate * Math.PI) / 180 + ph * TAU * Math.round(p.spin),
        shape: DROSTE_SHAPES[p.shape as keyof typeof DROSTE_SHAPES] ?? 0,
        points: Math.max(2, Math.round(p.points)),
        petals: Math.round(p.petals),
        petalDepth: Math.round(p.petals) > 0 ? p.petalDepth * L * 0.5 : 0,
        petalTurn: ph * TAU * Math.round(p.petalSpin),
        twist: p.twist,
        // outlines measured in heights reach 1 at the top and bottom edge: this keeps the widest of them inside
        fit: 0.98,
        drive: p.drive,
        driveTurn: p.driveTurn,
        driveSpace: p.driveSpace === 'spiral',
      },
      wgsl: drosteWgsl(!!driver),
    });
    return { image };
  },
});
