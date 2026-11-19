import { defineNode } from '../../define';

/**
 * Kaleidoscope regions: the frame is cut into regions (squares, hexagons, irregular cells or rings) and every region is its
 * own little kaleidoscope: mirrored wedges around the middle of the region. Each region can look at the same spot of the
 * picture (a wall of identical kaleidoscopes) or at its own place in it (the picture stays readable, broken into jewels).
 * Spin makes whole turns per loop; neighbours can turn opposite ways.
 */
const SHAPES = { squares: 0, hexagons: 1, cells: 2, rings: 3 } as const;

export default defineNode({
  id: 'kaleido-regions',
  title: 'Kaleidoscope Regions',
  category: 'transform',
  description: 'Cuts the picture into squares, hexagons, irregular cells or rings, and makes every region its own kaleidoscope. From a wall of identical jewels to a readable picture broken into facets.',
  keywords: ['kaleidoscope', 'regions', 'tiles', 'cells', 'hexagon', 'honeycomb', 'facets', 'mirror', 'trippy', 'psychedelic', 'mosaic', 'voronoi', 'rings', 'jewel', 'compound eye', 'visuals', 'vj'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    shape: {
      type: 'enum',
      default: 'hexagons',
      options: [
        { value: 'squares', label: 'Squares' },
        { value: 'hexagons', label: 'Hexagons' },
        { value: 'cells', label: 'Irregular cells' },
        { value: 'rings', label: 'Rings' },
      ],
      label: 'Regions',
    },
    size: { type: 'number', default: 0.2, min: 0.02, max: 1, step: 0.005, label: 'Region size', hint: 'Share of the picture height.' },
    segments: { type: 'number', default: 6, min: 0, max: 24, step: 1, integer: true, label: 'Mirrors', hint: 'Mirrored wedges inside every region. 0 = no kaleidoscope, the regions only turn.' },
    look: {
      type: 'enum',
      default: 'own',
      options: [
        { value: 'own', label: 'Its own place' },
        { value: 'same', label: 'The same spot' },
      ],
      label: 'Each region shows',
      hint: 'Its own place keeps the picture readable. The same spot repeats one kaleidoscope everywhere.',
    },
    spot: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: 0, max: 1, step: 0.005, label: 'Spot', visibleIf: (p) => p.look === 'same' },
    zoom: { type: 'number', default: 1, min: 0.1, max: 8, step: 0.01, label: 'Zoom', hint: 'How much of the picture each region shows. Below 1 shows more.' },
    twist: { type: 'number', default: 0, min: -180, max: 180, step: 1, unit: 'deg', label: 'Turn' },
    scatter: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Random turn', hint: 'Every region is turned by a different amount.' },
    spin: { type: 'number', default: 1, min: -8, max: 8, step: 1, integer: true, label: 'Spin', hint: 'Whole turns per loop. 0 = still.' },
    counter: { type: 'bool', default: true, label: 'Counter-spin', hint: 'Neighbouring regions spin opposite ways.' },
    edges: { type: 'number', default: 0.15, min: 0, max: 1, step: 0.01, label: 'Dark edges', hint: 'Darkens every region toward its rim, like facets.' },
  },
  summary: (p) => `${p.shape} · ${p.segments} mirrors`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (!src) return { image: src };
    const image = ctx.gpu.pass({
      label: 'kaleido-regions',
      size: src,
      textures: { src },
      uniforms: {
        shape: SHAPES[p.shape as keyof typeof SHAPES] ?? 1,
        cell: Math.max(0.01, p.size),
        seg: p.segments,
        same: p.look === 'same',
        spot: p.spot,
        zoom: p.zoom,
        twist: (p.twist * Math.PI) / 180,
        scatter: p.scatter,
        spin: ctx.time.phase * Math.PI * 2 * Math.round(p.spin),
        counter: p.counter,
        edges: p.edges,
      },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let aspect = u.size.x / u.size.y;
  // p: the frame in units of its height, so regions are not stretched
  let p = (uv - 0.5) * vec2f(aspect, 1.0);
  var centre = vec2f(0.0);  // middle of this region
  var id = vec2f(0.0);      // which region
  var rim = 1.0;            // 0 at the middle of the region, 1 at its rim
  var parity = 0.0;
  if (u.shape < 0.5) {
    id = floor(p / u.cell + 0.5);
    centre = id * u.cell;
    let l = abs(p - centre) / (u.cell * 0.5);
    rim = max(l.x, l.y);
    parity = abs(id.x + id.y) % 2.0;
  } else if (u.shape < 1.5) {
    // nearest of two offset grids of hexagon middles
    let s = vec2f(1.0, 1.7320508) * u.cell;
    let a = (floor(p / s) + 0.5) * s;
    let b = (floor((p - s * 0.5) / s) + 0.5) * s + s * 0.5;
    let da = p - a;
    let db = p - b;
    if (dot(da, da) < dot(db, db)) { centre = a; parity = 0.0; } else { centre = b; parity = 1.0; }
    id = floor(centre / u.cell * 2.0 + 0.5);
    let l = abs(p - centre) / (u.cell * 0.5);
    rim = max(l.x, l.x * 0.5 + l.y * 0.8660254);
  } else if (u.shape < 2.5) {
    // irregular cells: the nearest of the scattered points of the 3 x 3 squares around
    let g = floor(p / u.cell);
    var best = 1.0e9;
    var second = 1.0e9;
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let c = g + vec2f(f32(i), f32(j));
        let site = (c + 0.15 + 0.7 * hash22(c)) * u.cell;
        let d = distance(p, site);
        if (d < best) { second = best; best = d; centre = site; id = c; } else if (d < second) { second = d; }
      }
    }
    rim = clamp(best / max(second, 1.0e-5), 0.0, 1.0);
    parity = abs(id.x + id.y) % 2.0;
  } else {
    // rings: each ring is a strip bent round; its "middle" is the point on its centre line nearest to the pixel
    let r = length(p);
    let k = floor(r / u.cell);
    id = vec2f(k, 0.0);
    let mid = (k + 0.5) * u.cell;
    let dir = p / max(r, 1.0e-5);
    // wedges round the ring: more of them further out, so they stay about square
    let n = max(1.0, floor((k + 0.5) * 6.0));
    var ang = atan2(p.y, p.x);
    let w = TAU / n;
    let ai = floor(ang / w + 0.5);
    ang = ai * w;
    centre = mid * vec2f(cos(ang), sin(ang));
    id = vec2f(k, ai);
    rim = max(abs(r - mid) / (u.cell * 0.5), abs(atan2(dir.y, dir.x) - ang) / (w * 0.5));
    parity = abs(k + ai) % 2.0;
  }
  var l = p - centre;
  // turn: the same for all, a different one for each, and the spin
  var dirSpin = 1.0;
  if (u.counter > 0.5 && parity > 0.5) { dirSpin = -1.0; }
  let turn = u.twist + u.scatter * TAU * hash21(id + 3.7) + u.spin * dirSpin;
  var a = atan2(l.y, l.x) + turn;
  let r = length(l);
  if (u.seg >= 1.0) {
    let seg = PI / u.seg;
    a = abs(((a % (2.0 * seg)) + 2.0 * seg) % (2.0 * seg) - seg);
  }
  l = r * vec2f(cos(a), sin(a)) / u.zoom;
  var origin = centre;
  if (u.same > 0.5) { origin = (u.spot - 0.5) * vec2f(aspect, 1.0); }
  var st = (origin + l) / vec2f(aspect, 1.0) + 0.5;
  st = 1.0 - abs(1.0 - fract(st * 0.5) * 2.0);
  let c = textureSampleLevel(src, smp, st, 0.0);
  let shade = 1.0 - u.edges * smoothstep(0.55, 1.0, rim);
  return vec4f(c.rgb * shade, c.a);
}`,
    });
    return { image };
  },
});
