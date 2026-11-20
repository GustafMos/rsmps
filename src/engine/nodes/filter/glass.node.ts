import { defineNode } from '../../define';
import { wander } from '../../lib/shake';

/**
 * Glass: a solid piece of glass held in front of the picture, drawn by following light through it.
 *
 * For every pixel a ray leaves the camera. If it meets the glass it bends on the way in (Snell's law), travels through,
 * bends again on the way out, and lands on the picture, which stands as a flat screen some distance behind. Red, green
 * and blue bend by slightly different amounts (dispersion), so each is followed separately: that is where the coloured
 * fringes of a prism come from. A share of the light is mirrored off the surface instead (more at grazing angles), and
 * a lamp adds a glint. Where the ray misses the glass the picture is untouched.
 *
 * The glass is described by a distance function (how far is this point from the surface), so the ray can walk to it in
 * safe steps, and the same function turned inside out walks the ray through the inside. The camera looks from the front
 * with a little perspective; with no bending a ray lands exactly on the pixel it started from.
 */
export const GLASS_SHAPES: Record<string, { label: string; id: number }> = {
  louvres: { label: 'Tilted strips', id: 0 },
  rods: { label: 'Reeded glass', id: 1 },
  prism: { label: 'Prism', id: 2 },
  sphere: { label: 'Sphere', id: 3 },
  cube: { label: 'Cube', id: 4 },
  diamond: { label: 'Diamond', id: 5 },
  crystal: { label: 'Long crystal', id: 6 },
  lens: { label: 'Lens', id: 7 },
  ring: { label: 'Ring', id: 8 },
  cylinder: { label: 'Cylinder', id: 9 },
  hexagon: { label: 'Hexagon bar', id: 10 },
  slab: { label: 'Flat pane', id: 11 },
  waves: { label: 'Wavy pane', id: 12 },
  pyramid: { label: 'Pyramid', id: 13 },
};

/** Rows of the turn matrix for angles about x (tilt), y (turn) and z (roll), radians: applied as roll, then tilt, then turn. */
export function glassRotation(tilt: number, turn: number, roll: number): [number[], number[], number[]] {
  const cx = Math.cos(tilt), sx = Math.sin(tilt);
  const cy = Math.cos(turn), sy = Math.sin(turn);
  const cz = Math.cos(roll), sz = Math.sin(roll);
  // R = Ry * Rx * Rz
  return [
    [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx],
    [cx * sz, cx * cz, -sx],
    [-sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx],
  ];
}

const WGSL = /* wgsl */ `
fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}
// one strip: a shallow wedge (thicker at one edge), so its faces are not parallel and it throws the picture aside like a
// thin prism instead of only nudging it like a window pane. An exact distance (a convex shape cut from planes).
fn strip(p: vec3f, half: f32) -> f32 {
  let c = cos(u.detail);
  let s = sin(u.detail);
  let q = vec2f(p.x * c - p.z * s, p.x * s + p.z * c);
  // the two faces lean toward each other: normals (-+slope, +-1) normalised
  // The lean is an angle of its own (the Wedge setting), not a share of the thickness: tied to the thickness it grew
  // with the number of strips until almost every ray was trapped inside and came out as coloured noise.
  // The strip is never thinner than a fifth of its thickness at the thin edge.
  let slope = min(u.wedge, 0.8 * u.thick / half);
  let inv = 1.0 / sqrt(1.0 + slope * slope);
  let front = (q.y - u.thick - slope * q.x) * inv;
  let back = (-q.y - u.thick - slope * q.x) * inv;
  let m = max(max(abs(q.x) - half, abs(p.y) - 1.0), max(front, back));
  return m;
}
fn rot2(p: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(p.x * c - p.y * s, p.x * s + p.y * c); }
// distance from a point (in the glass's own space, about -1..1) to its surface; negative inside
fn shape(p: vec3f) -> f32 {
  let k = i32(u.shape);
  let n = max(1.0, u.count);
  if (k == 0) {
    // Flat strips side by side, each turned on its long axis. A point can be nearest to the strip NEXT to the one whose
    // slot it is in (the strips are turned, so they reach over the slot lines): measure to this strip and both neighbours.
    // Only whole strips exist, so the pane ends on a strip, never part-way through one.
    let pitch = 2.0 / n;
    let slot = clamp(floor((p.x + 1.0) / pitch), 0.0, n - 1.0);
    var d = 1.0e9;
    for (var j = -1; j <= 1; j++) {
      let idx = slot + f32(j);
      if (idx < 0.0 || idx > n - 1.0) { continue; }
      d = min(d, strip(vec3f(p.x + 1.0 - (idx + 0.5) * pitch, p.y, p.z), pitch * 0.49));
    }
    return d;
  }
  if (k == 1) {
    // Reeded glass: a pane with a flat back and a front of gentle ridges. (Whole round rods looked right from the
    // front only: toward the edge of a rod the light is bent past all reason and comes out as noise.)
    let pitch = 2.0 / n;
    let c = (fract((p.x + 1.0) / pitch) - 0.5) * pitch;
    let depth = pitch * 0.22;
    let front = p.z - u.thick - depth * (cos(c / pitch * TAU) - 1.0) * 0.5 - depth;
    // the ridge is at most this steep, which is what keeps the distance from being overestimated
    return max(max(front * 0.82, -p.z - u.thick), max(abs(p.x) - 1.0, abs(p.y) - 1.0));
  }
  if (k == 2) {
    // triangular prism lying along y
    let q = vec2f(abs(p.x), p.z);
    let tri = max(q.x * 0.8660254 + q.y * 0.5, -q.y) - 0.4;
    return max(tri, abs(p.y) - 1.0);
  }
  if (k == 3) { return length(p) - 0.8; }
  if (k == 4) { return sdBox(p, vec3f(0.6)) - 0.02; }
  if (k == 5) { let q = abs(p); return (q.x + q.y + q.z - 0.9) * 0.57735; }
  if (k == 6) { let q = abs(p * vec3f(1.0, 0.45, 1.0)); return (q.x + q.y + q.z - 0.5) * 0.4; }
  if (k == 7) {
    // two bowls of glass back to back
    let r = 1.6;
    let off = r - u.thick * 1.5 - 0.05;
    return max(length(p - vec3f(0.0, 0.0, off)) - r, length(p + vec3f(0.0, 0.0, off)) - r);
  }
  if (k == 8) { let q = vec2f(length(p.xy) - 0.62, p.z); return length(q) - 0.22; }
  if (k == 9) { return max(length(p.xz) - 0.45, abs(p.y) - 1.0); }
  if (k == 10) {
    let q = abs(p);
    return max(max(q.x * 0.8660254 + q.z * 0.5, q.z) - 0.45, q.y - 1.0);
  }
  if (k == 11) { return sdBox(p, vec3f(1.0, 1.0, u.thick)); }
  if (k == 12) {
    // a pane whose front ripples
    let ripple = 0.5 * u.thick * sin(p.x * n * 1.5708 + sin(p.y * 2.0) * u.detail * 2.0);
    return max(sdBox(p, vec3f(1.0, 1.0, u.thick * 2.0)), p.z - u.thick - ripple) * 0.6;
  }
  // pyramid: the top half of a diamond
  let q = abs(p - vec3f(0.0, -0.35, 0.0));
  return max((q.x + q.y + q.z - 1.0) * 0.57735, -(p.y + 0.35));
}
fn toGlass(p: vec3f) -> vec3f {
  let q = p - u.pos;
  return vec3f(dot(q, u.r0), dot(q, u.r1), dot(q, u.r2)) / u.scale;
}
fn map(p: vec3f) -> f32 { return shape(toGlass(p)) * u.scale; }
fn normalAt(p: vec3f) -> vec3f {
  let e = vec2f(1.0, -1.0) * 0.0015;
  return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}
// where a ray that left the glass lands on the picture, as a picture position
fn landing(q: vec3f, d: vec3f, aspect: f32) -> vec2f {
  var hit = q.xy;
  if (d.z < -0.02) { hit = q.xy + d.xy * ((-u.back - q.z) / d.z); }
  let s = hit * u.cam / (u.cam + u.back);
  var st = vec2f(s.x / aspect, -s.y) * 0.5 + 0.5;
  st = 1.0 - abs(1.0 - fract(st * 0.5) * 2.0);
  return st;
}
// through the glass with one bending strength; returns where on the picture it lands
fn through(p0: vec3f, rd: vec3f, n0: vec3f, ior: f32, aspect: f32) -> vec2f {
  var d = refract(rd, n0, 1.0 / ior);
  if (dot(d, d) < 0.5) { d = rd; }
  var p = p0 - n0 * 0.004;
  // glass thinner than the step in (a knife edge): there is no inside to walk, the ray goes straight on
  if (map(p) > 0.0) { return landing(p0, rd, aspect); }
  // up to two inside bounces: a ray that cannot get out (total reflection) is mirrored back in
  for (var b = 0; b < 2; b++) {
    var t = 0.0;
    for (var i = 0; i < 40; i++) {
      let dist = -map(p + d * t);
      if (dist < 0.0012) { break; }
      t += max(dist, 0.004);
      if (t > 6.0) { break; }
    }
    p = p + d * t;
    // step back inside a hair before reading the slope: right on an edge the slope is undefined and gives noise
    let n = -normalAt(p - d * 0.002);
    let o = refract(d, n, ior);
    if (dot(o, o) > 0.5) { return landing(p + o * 0.004, o, aspect); }
    d = reflect(d, n);
    p = p + d * 0.006;
  }
  // still trapped after two bounces (a ray that came in through an edge): where it ends up is anybody's guess and
  // differs from pixel to pixel, so show what lies straight behind instead of noise
  return landing(p0, rd, aspect);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let aspect = u.size.x / u.size.y;
  let src0 = textureSampleLevel(src, smpNearest, uv, 0.0);
  let s = (uv - 0.5) * vec2f(aspect, -1.0) * 2.0;
  let ro = vec3f(0.0, 0.0, u.cam);
  let rd = normalize(vec3f(s, -u.cam));
  var t = max(0.0, u.cam - u.reach);
  var hit = false;
  var near = 1.0e9;
  for (var i = 0; i < 64; i++) {
    let dist = map(ro + rd * t);
    near = min(near, dist);
    if (dist < 0.0012) { hit = true; break; }
    t += dist;
    if (t > u.cam + u.reach) { break; }
  }
  if (!hit) { return src0; }
  let p = ro + rd * t;
  var n = normalAt(p);
  if (u.frost > 0.0) {
    // frosted: the surface points every which way on a small scale
    let j = vec3f(hash21(px), hash21(px + 17.0), hash21(px + 41.0)) - 0.5;
    n = normalize(n + j * u.frost);
  }
  let r = unpremul(textureSampleLevel(src, smp, through(p, rd, n, u.ior - u.disp, aspect), 0.0));
  let g = unpremul(textureSampleLevel(src, smp, through(p, rd, n, u.ior, aspect), 0.0));
  let b = unpremul(textureSampleLevel(src, smp, through(p, rd, n, u.ior + u.disp, aspect), 0.0));
  var col = vec3f(r.r, g.g, b.b) * u.tint.rgb;
  // mirror: more at grazing angles; it shows the picture as if it surrounded the glass
  let cosi = clamp(dot(-rd, n), 0.0, 1.0);
  let f0 = pow((u.ior - 1.0) / (u.ior + 1.0), 2.0);
  let fres = (f0 + (1.0 - f0) * pow(1.0 - cosi, 5.0)) * u.mirror;
  let rr = reflect(rd, n);
  var ruv = vec2f(rr.x / aspect, -rr.y) * 0.5 + 0.5;
  ruv = 1.0 - abs(1.0 - fract(ruv * 0.5) * 2.0);
  let refl = unpremul(textureSampleLevel(src, smp, ruv, 0.0)).rgb;
  col = mix(col, refl, clamp(fres, 0.0, 1.0));
  // the glint of a lamp up and to the left of the camera
  let lamp = normalize(vec3f(-0.5, 0.7, 0.6));
  col += u.glint * pow(max(dot(rr, lamp), 0.0), 48.0);
  let a = max(max(r.a, g.a), b.a);
  return premul(vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), max(a, src0.a)));
}`;

const hasCount = (p: Record<string, unknown>) => p.shape === 'louvres' || p.shape === 'rods' || p.shape === 'waves';
const hasThick = (p: Record<string, unknown>) => ['louvres', 'rods', 'lens', 'slab', 'waves'].includes(p.shape as string);

export default defineNode({
  id: 'glass',
  title: 'Glass',
  category: 'filter',
  description: 'A piece of glass in front of the picture, with light followed through it: tilted strips, reeded glass, a prism, a sphere, a diamond and more. It bends the picture, splits it into colours at the edges, mirrors and glints, and can turn, spin and sway as if hand held.',
  keywords: ['glass', 'prism', 'refraction', 'raytraced', 'ray traced', 'crystal', 'lens', 'reeded', 'fluted', 'dispersion', 'rainbow', 'chromatic', 'mirage', 'distort', '3d', 'diamond', 'kaleidoscope', 'in front of lens', 'music video', 'trippy'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    shape: { type: 'enum', default: 'louvres', options: Object.entries(GLASS_SHAPES).map(([value, v]) => ({ value, label: v.label })), label: 'Shape' },
    size: { type: 'number', default: 0.8, min: 0.05, max: 3, step: 0.01, label: 'Size', hint: '1 reaches from top to bottom of the picture.' },
    position: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: -0.5, max: 1.5, step: 0.005, label: 'Position' },
    count: { type: 'number', default: 7, min: 1, max: 40, step: 1, integer: true, label: 'Strips', visibleIf: hasCount },
    detail: { type: 'number', default: 25, min: -80, max: 80, step: 0.5, unit: 'deg', label: 'Strip angle', hint: 'How far each strip is turned on its own axis (for the wavy pane: how much the waves wander).', visibleIf: (p) => p.shape === 'louvres' || p.shape === 'waves' },
    wedge: { type: 'number', default: 8, min: 0, max: 25, step: 0.5, unit: 'deg', label: 'Wedge', hint: 'How much each strip is a thin prism: thicker at one edge. 0 = flat strips that only nudge the picture. More throws the picture further aside and splits its colours more.', visibleIf: (p) => p.shape === 'louvres' },
    thickness: { type: 'number', default: 0.1, min: 0.01, max: 0.6, step: 0.005, label: 'Thickness', visibleIf: hasThick },
    tilt: { type: 'number', default: 8, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Tilt', hint: 'Leaning toward or away from you.', group: 'Turn' },
    turn: { type: 'number', default: -18, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Turn', hint: 'Turning left or right.', group: 'Turn' },
    roll: { type: 'number', default: 4, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Roll', hint: 'Turning like a steering wheel.', group: 'Turn' },
    spinTilt: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: 'Spin tilt', hint: 'Whole turns per loop.', group: 'Motion' },
    spinTurn: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: 'Spin turn', hint: 'Whole turns per loop.', group: 'Motion' },
    spinRoll: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: 'Spin roll', hint: 'Whole turns per loop.', group: 'Motion' },
    sway: { type: 'number', default: 8, min: 0, max: 90, step: 0.5, unit: 'deg', label: 'Hand sway', hint: 'The glass wanders by up to this much, like a piece held in the hand in front of the lens.', group: 'Motion' },
    swaySpeed: { type: 'number', default: 0.3, min: 0.05, max: 4, step: 0.05, label: 'Sway speed', group: 'Motion', visibleIf: (p) => (p.sway as number) > 0 },
    drift: { type: 'number', default: 0.03, min: 0, max: 0.5, step: 0.005, label: 'Hand drift', hint: 'The glass also moves about by this share of the picture.', group: 'Motion' },
    ior: { type: 'number', default: 1.5, min: 1, max: 2.6, step: 0.01, label: 'Bending', hint: 'How strongly the glass bends light. Water 1.33, window glass 1.5, diamond 2.4. 1 = no bending.', group: 'Glass' },
    dispersion: { type: 'number', default: 0.04, min: 0, max: 0.4, step: 0.002, label: 'Color split', hint: 'How differently red and blue bend: the rainbow fringes.', group: 'Glass' },
    distance: { type: 'number', default: 1.2, min: 0.05, max: 6, step: 0.01, label: 'Picture distance', hint: 'How far behind the glass the picture stands. Further = the glass throws the picture further aside.', group: 'Glass' },
    mirror: { type: 'number', default: 1, min: 0, max: 4, step: 0.01, label: 'Reflection', group: 'Glass' },
    glint: { type: 'number', default: 0.5, min: 0, max: 3, step: 0.01, label: 'Glint', group: 'Glass' },
    frost: { type: 'number', default: 0, min: 0, max: 1, step: 0.005, label: 'Frosted', group: 'Glass' },
    tint: { type: 'color', default: [1, 1, 1, 1], label: 'Glass color', group: 'Glass' },
    seed: { type: 'number', default: 1, min: 0, max: 999, step: 1, integer: true, label: 'Seed', group: 'Motion', hint: 'Another number, another sway.' },
  },
  summary: (p) => `${GLASS_SHAPES[p.shape as string]?.label ?? p.shape} · bending ${p.ior}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (!src) return { image: src };
    const time = ctx.time;
    const ph = time.phase;
    const TAU = Math.PI * 2;
    const loop = time.loop ? time.duration : 0;
    const deg = Math.PI / 180;
    const sw = p.sway * deg;
    const w = (k: number) => wander(time.seconds, p.swaySpeed, 0.45, p.seed + k, loop);
    const rot = glassRotation(
      p.tilt * deg + ph * TAU * Math.round(p.spinTilt) + sw * w(1),
      p.turn * deg + ph * TAU * Math.round(p.spinTurn) + sw * w(2),
      p.roll * deg + ph * TAU * Math.round(p.spinRoll) + sw * 0.5 * w(3),
    );
    const aspect = src.width / src.height;
    const pos = p.position as number[];
    const scale = Math.max(0.02, p.size);
    const image = ctx.gpu.pass({
      label: 'glass',
      size: src,
      textures: { src },
      uniforms: {
        shape: GLASS_SHAPES[p.shape as string]?.id ?? 0,
        scale,
        pos: [(pos[0] - 0.5) * 2 * aspect + p.drift * 2 * w(4), -(pos[1] - 0.5) * 2 + p.drift * 2 * w(5), 0],
        // the matrix turns the glass; its transpose (these rows used as columns) brings a point into the glass's space
        r0: [rot[0][0], rot[1][0], rot[2][0]],
        r1: [rot[0][1], rot[1][1], rot[2][1]],
        r2: [rot[0][2], rot[1][2], rot[2][2]],
        count: p.count,
        detail: p.detail * deg,
        thick: p.thickness,
        wedge: Math.tan((Math.max(0, p.wedge) * Math.PI) / 180),
        ior: Math.max(1.0001, p.ior),
        disp: Math.min(p.dispersion, Math.max(0, p.ior - 1.0001)),
        back: p.distance,
        cam: 4,
        reach: scale * 1.9 + 0.2,
        mirror: p.mirror,
        glint: p.glint,
        frost: p.frost * 0.6,
        tint: p.tint,
      },
      wgsl: WGSL,
    });
    return { image };
  },
});
