import { defineNode } from '../../define';
import { GEN_HASH_WGSL, GEN_PALETTE_WGSL, genPaletteTexture, rgba } from '../../lib/gen-common';

const MODES = { cells: 0, crackle: 1, distance: 2 } as const;

export default defineNode({
  id: 'voronoi',
  title: 'Voronoi',
  category: 'generate',
  description: 'Cellular texture: coloured cells, crackle lines or a distance field. Cell centres can drift in a perfect loop.',
  keywords: ['cells', 'cellular', 'crackle', 'cracks', 'stained glass', 'worley', 'mosaic', 'texture', 'tiles'],
  inputs: { size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'cells',
      label: 'Look',
      options: [
        { value: 'cells', label: 'Colored cells' },
        { value: 'crackle', label: 'Crackle lines' },
        { value: 'distance', label: 'Distance glow' },
      ],
    },
    scale: { type: 'number', default: 120, min: 4, max: 2000, unit: 'px', label: 'Cell size' },
    jitter: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Irregularity', hint: '0 = regular grid, 1 = fully random.' },
    colors: {
      type: 'palette',
      label: 'Cell colors',
      default: [
        [0.1, 0.2, 0.45],
        [0.2, 0.6, 0.75],
        [0.95, 0.85, 0.55],
        [0.9, 0.4, 0.35],
      ],
      visibleIf: (p) => p.mode === 'cells',
    },
    colorA: { type: 'color', default: [0.96, 0.94, 0.88, 1], label: 'Cell color', visibleIf: (p) => p.mode !== 'cells' },
    colorB: { type: 'color', default: [0.08, 0.08, 0.14, 1], label: 'Line color' },
    lineWidth: { type: 'number', default: 3, min: 0, max: 200, unit: 'px', label: 'Line width', visibleIf: (p) => p.mode !== 'distance' },
    motion: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Motion', group: 'Animation', hint: 'How far each cell centre wanders. 0 = still.' },
    cycles: { type: 'number', default: 0, min: 0, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Cycles per loop', group: 'Animation', hint: 'Whole laps per loop so it repeats exactly.' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, integer: true, label: 'Seed' },
  },
  summary: (p) => `${p.mode} · ${Math.round(p.scale)}px${p.motion > 0 && p.cycles > 0 ? ' · moving' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const size = ctx.in.size ?? ctx.canvas;
    const animated = p.motion > 0 && p.cycles > 0;
    const phase = animated ? ctx.time.phase : 0;
    const pal = genPaletteTexture(ctx.gpu, p.colors);
    const image = ctx.gpu.pass({
      label: 'voronoi',
      size,
      textures: { pal: pal.texture },
      uniforms: {
        palN: pal.count,
        mode: MODES[p.mode as keyof typeof MODES] ?? 0,
        cell: Math.max(2, p.scale),
        jitter: p.jitter,
        motion: animated ? p.motion : 0,
        turn: phase * p.cycles, // whole laps at phase 1
        seed: p.seed,
        lw: p.lineWidth,
        a: rgba(p.colorA),
        b: rgba(p.colorB),
      },
      wgsl: /* wgsl */ `
${GEN_HASH_WGSL}
${GEN_PALETTE_WGSL}
fn site(cell: vec2f) -> vec2f {
  let r = rnd4(i32(cell.x), i32(cell.y), i32(u.seed));
  let base = vec2f(0.5) + (r.xy - 0.5) * 0.8 * u.jitter;
  let ang = TAU * (u.turn + r.z);
  let ang2 = TAU * (u.turn + r.w);
  return base + u.motion * 0.3 * vec2f(cos(ang), sin(ang2));
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let p = px / u.cell + vec2f(u.seed * 0.37, u.seed * 0.71);
  let ip = floor(p);
  let fp = p - ip;
  var mr = vec2f(0.0); var mg = vec2f(0.0); var md = 100.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = vec2f(f32(i), f32(j));
      let r = g + site(ip + g) - fp;
      let d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  }
  var ed = 100.0;
  for (var j = -2; j <= 2; j++) {
    for (var i = -2; i <= 2; i++) {
      let g = mg + vec2f(f32(i), f32(j));
      let r = g + site(ip + g) - fp;
      let dd = r - mr;
      if (dot(dd, dd) > 0.00001) { ed = min(ed, dot(0.5 * (mr + r), normalize(dd))); }
    }
  }
  let edgePx = ed * u.cell;
  let line = clamp(0.5 + u.lw * 0.5 - edgePx, 0.0, 1.0) * select(0.0, 1.0, u.lw > 0.0);
  let mode = i32(u.mode);
  var col = vec4f(0.0);
  if (mode == 0) {
    let id = ip + mg;
    let h = rnd4(i32(id.x), i32(id.y), i32(u.seed) + 77).x;
    col = mix(vec4f(palAt(h), 1.0), u.b, line * u.b.a);
    return premul(col);
  } else if (mode == 1) {
    return mix(premul(u.a), premul(u.b), line);
  }
  let t = clamp(sqrt(md) * 1.4, 0.0, 1.0);
  return premul(mix(u.b, u.a, t));
}`,
    });
    return { image };
  },
});
