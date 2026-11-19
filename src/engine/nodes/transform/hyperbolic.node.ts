import { defineNode } from '../../define';

/**
 * Hyperbolic tiling (the Poincaré disc, Escher's Circle Limit): the picture fills a polygon in the middle, and copies of
 * it tile a disc, getting smaller toward the rim without ever reaching it.
 *
 * A tiling {p, q} has polygons with p sides, q of them meeting at every corner; it lives in this curved space when
 * (p - 2)(q - 2) > 4. A pixel is brought back to the middle polygon by mirroring: first across the polygon's lines of
 * symmetry (a p-fold kaleidoscope), then, if it lies beyond the polygon's edge, across that edge. An edge is a circle
 * that meets the rim at right angles, and mirroring in a circle is inversion. Repeat until the point is inside.
 */

/** The circle that is one edge of the middle polygon of {p, q}: its centre is at distance `d` on the x axis, radius `r`. */
export function hyperbolicEdge(p: number, q: number): { d: number; r: number } {
  const s = Math.sin(Math.PI / p);
  const c = Math.cos(Math.PI / q);
  const d = 1 / Math.sqrt(Math.max(1e-9, 1 - (s * s) / (c * c)));
  return { d, r: Math.sqrt(Math.max(0, d * d - 1)) };
}

/** The smallest q that makes {p, q} hyperbolic. */
export function minCorners(p: number): number {
  for (let q = 3; q < 64; q++) if ((p - 2) * (q - 2) > 4) return q;
  return 7;
}

export default defineNode({
  id: 'hyperbolic',
  title: 'Hyperbolic Tiling',
  category: 'transform',
  description: 'Tiles a disc with copies of the picture that shrink toward the rim and never reach it, like Escher’s Circle Limit prints.',
  keywords: ['hyperbolic', 'poincare', 'escher', 'circle limit', 'tiling', 'tessellation', 'disc', 'disk', 'kaleidoscope', 'trippy', 'psychedelic', 'non-euclidean', 'geometry', 'visuals', 'vj'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    sides: { type: 'number', default: 5, min: 3, max: 12, step: 1, integer: true, label: 'Sides', hint: 'Sides of every tile.' },
    corners: { type: 'number', default: 4, min: 3, max: 12, step: 1, integer: true, label: 'Tiles per corner', hint: 'How many tiles meet at a corner. Raised by itself when the pair would not fit this curved space.' },
    zoom: { type: 'number', default: 1, min: 0.2, max: 6, step: 0.01, label: 'Picture zoom', hint: 'How much of the picture one tile shows.' },
    discSize: { type: 'number', default: 0.98, min: 0.2, max: 3, step: 0.01, label: 'Disc size', hint: '1 fits the disc to the frame height. Above 1 goes into it.' },
    spin: { type: 'number', default: 1, min: -8, max: 8, step: 1, integer: true, label: 'Spin', hint: 'Steps of one tile side per loop (the disc looks the same after each). 0 = still.' },
    drift: { type: 'number', default: 0.3, min: 0, max: 0.9, step: 0.01, label: 'Drift', hint: 'The middle of the disc slides out toward the rim and back, once per loop. 0 = still.' },
    pictureSpin: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: 'Picture spin', hint: 'Whole turns of the picture inside every tile per loop.' },
    outside: { type: 'enum', default: 'black', options: [{ value: 'black', label: 'Black' }, { value: 'clear', label: 'Transparent' }, { value: 'mirror', label: 'Mirrored disc' }], label: 'Outside the disc' },
    lines: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Tile edges', hint: 'Darkens the edges of the tiles.' },
  },
  summary: (p) => `{${p.sides}, ${Math.max(p.corners, minCorners(p.sides))}}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (!src) return { image: src };
    const sides = Math.round(p.sides);
    const corners = Math.max(Math.round(p.corners), minCorners(sides));
    const e = hyperbolicEdge(sides, corners);
    const ph = ctx.time.phase;
    const TAU = Math.PI * 2;
    const image = ctx.gpu.pass({
      label: 'hyperbolic',
      size: src,
      textures: { src },
      uniforms: {
        n: sides,
        d: e.d,
        r: e.r,
        zoom: p.zoom,
        disc: p.discSize,
        turn: (ph * TAU * Math.round(p.spin)) / sides,
        // out and back once per loop
        drift: p.drift * Math.sin(ph * Math.PI) * Math.sin(ph * Math.PI),
        ptu: ph * TAU * Math.round(p.pictureSpin),
        outside: p.outside === 'black' ? 0 : p.outside === 'clear' ? 1 : 2,
        lines: p.lines,
      },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let aspect = u.size.x / u.size.y;
  var z = (uv - 0.5) * vec2f(aspect, 1.0) * 2.0 / u.disc;
  var r2 = dot(z, z);
  if (r2 >= 1.0) {
    if (u.outside < 0.5) { return vec4f(0.0, 0.0, 0.0, 1.0); }
    if (u.outside < 1.5) { return vec4f(0.0); }
    z = z / r2;  // the disc mirrored in its own rim
    r2 = dot(z, z);
  }
  // slide the middle of the disc (a move of this curved space: (z + a) / (1 + a z) for a on the x axis)
  let a = u.drift;
  let num = z + vec2f(a, 0.0);
  let den = vec2f(1.0 + a * z.x, a * z.y);
  z = vec2f(num.x * den.x + num.y * den.y, num.y * den.x - num.x * den.y) / dot(den, den);
  let ct = cos(u.turn);
  let stn = sin(u.turn);
  z = vec2f(z.x * ct - z.y * stn, z.x * stn + z.y * ct);
  let seg = PI / u.n;
  let c = vec2f(u.d, 0.0);
  var edge = 1.0;
  for (var i = 0; i < 40; i++) {
    // the polygon's own mirrors: fold the direction into one wedge
    var ang = atan2(z.y, z.x);
    ang = abs(((ang % (2.0 * seg)) + 2.0 * seg) % (2.0 * seg) - seg);
    z = length(z) * vec2f(cos(ang), sin(ang));
    let dc = z - c;
    let k = dot(dc, dc);
    edge = min(edge, abs(sqrt(k) - u.r));
    if (k >= u.r * u.r) { break; }
    z = c + dc * (u.r * u.r / k);  // mirror in the edge
  }
  // the picture, centred on the tile; the tile reaches out to d - r
  let reach = u.d - u.r;
  let cp = cos(u.ptu);
  let sp = sin(u.ptu);
  let t = vec2f(z.x * cp - z.y * sp, z.x * sp + z.y * cp) / (reach * 2.0 * u.zoom);
  // the tile is as tall as the picture; the picture keeps its proportions
  var st = vec2f(t.x / aspect, t.y) + 0.5;
  st = 1.0 - abs(1.0 - fract(st * 0.5) * 2.0);
  let s = textureSampleLevel(src, smp, st, 0.0);
  let shade = 1.0 - u.lines * (1.0 - smoothstep(0.0, 0.03 * reach + 0.004, edge));
  return vec4f(s.rgb * shade, s.a);
}`,
    });
    return { image };
  },
});
