import { defineNode } from '../../define';
import { rgba } from '../../lib/gen-common';

const KINDS = { checker: 0, stripes: 1, grid: 2, dots: 3, hex: 4, bricks: 5 } as const;
/** Length of the repeating tile, in multiples of `size`, along x and y (scroll moves by whole tiles). */
const PERIOD: Record<keyof typeof KINDS, [number, number]> = {
  checker: [2, 2],
  stripes: [1, 1],
  grid: [1, 1],
  dots: [1, 1],
  hex: [1, Math.sqrt(3)],
  bricks: [1, 1],
};

export default defineNode({
  id: 'pattern',
  title: 'Pattern',
  category: 'generate',
  description: 'Checkerboard, stripes, grid, dots, hexagons or bricks in two colors. Can scroll in a perfect loop.',
  keywords: ['checker', 'checkerboard', 'stripes', 'lines', 'grid', 'dots', 'halftone', 'hexagon', 'brick', 'tile', 'texture'],
  inputs: { size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    kind: {
      type: 'enum',
      default: 'checker',
      label: 'Pattern',
      options: [
        { value: 'checker', label: 'Checkerboard' },
        { value: 'stripes', label: 'Stripes' },
        { value: 'grid', label: 'Grid' },
        { value: 'dots', label: 'Dots' },
        { value: 'hex', label: 'Hexagons' },
        { value: 'bricks', label: 'Bricks' },
      ],
    },
    cellSize: { type: 'number', default: 64, min: 2, max: 2000, unit: 'px', label: 'Cell size', hint: 'Square size for the checkerboard; repeat distance for the others.' },
    colorA: { type: 'color', default: [0.12, 0.13, 0.2, 1], label: 'Background color' },
    colorB: { type: 'color', default: [0.95, 0.75, 0.3, 1], label: 'Pattern color' },
    lineWidth: {
      type: 'number',
      default: 6,
      min: 0,
      max: 500,
      unit: 'px',
      label: 'Line width',
      hint: 'Thickness of stripes, grid, hex and mortar lines. For dots it is the dot radius.',
      visibleIf: (p) => p.kind !== 'checker',
    },
    angle: { type: 'number', default: 0, min: -180, max: 180, step: 1, unit: 'deg', label: 'Angle' },
    scrollX: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Scroll X', hint: 'Whole repeats per loop, so it loops exactly. 0 = still.' },
    scrollY: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Scroll Y', hint: 'Whole repeats per loop, so it loops exactly. 0 = still.' },
  },
  summary: (p) => `${p.kind} · ${Math.round(p.cellSize)}px${p.scrollX || p.scrollY ? ' · scrolling' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const size = ctx.in.size ?? ctx.canvas;
    const kind = p.kind as keyof typeof KINDS;
    const animated = p.scrollX !== 0 || p.scrollY !== 0;
    const phase = animated ? ctx.time.phase : 0;
    const cell = Math.max(1, p.cellSize);
    const per = PERIOD[kind] ?? [1, 1];
    const image = ctx.gpu.pass({
      label: 'pattern',
      size,
      uniforms: {
        kind: KINDS[kind] ?? 0,
        cell,
        lw: Math.max(0, p.lineWidth),
        angle: p.angle,
        shift: [p.scrollX * phase * per[0] * cell, p.scrollY * phase * per[1] * cell],
        a: rgba(p.colorA),
        b: rgba(p.colorB),
      },
      wgsl: /* wgsl */ `
fn cover(d: f32) -> f32 { return clamp(0.5 - d, 0.0, 1.0); } // d in texels, negative = inside

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let ar = radians(u.angle);
  let c = cos(ar); let s = sin(ar);
  let r = px - u.size * 0.5;
  var q = vec2f(c * r.x + s * r.y, -s * r.x + c * r.y) + u.size * 0.5;
  q = q - u.shift; // pattern moves along +x / +y
  let k = u.cell;
  let hw = u.lw * 0.5;
  var m = 0.0;
  let kind = i32(u.kind);
  if (kind == 0) {
    // checkerboard: smooth square waves, 1 texel antialiasing
    let sx = clamp(sin(PI * q.x / k) * k / PI, -1.0, 1.0);
    let sy = clamp(sin(PI * q.y / k) * k / PI, -1.0, 1.0);
    m = 0.5 - 0.5 * sx * sy;
  } else if (kind == 1) {
    let d = abs((fract(q.x / k + 0.5) - 0.5) * k);
    m = cover(d - hw);
  } else if (kind == 2) {
    let dx = abs((fract(q.x / k + 0.5) - 0.5) * k);
    let dy = abs((fract(q.y / k + 0.5) - 0.5) * k);
    m = cover(min(dx, dy) - hw);
  } else if (kind == 3) {
    let g = (fract(q / k) - 0.5) * k;
    m = cover(length(g) - u.lw);
  } else if (kind == 4) {
    // hexagonal lattice, cell width = k
    let p = q / k;
    let rr = vec2f(1.0, 1.7320508);
    let h = rr * 0.5;
    let a = (p - rr * floor(p / rr)) - h;
    let pb = p - h;
    let b = (pb - rr * floor(pb / rr)) - h;
    var gv = b;
    if (dot(a, a) < dot(b, b)) { gv = a; }
    let ag = abs(gv);
    let dh = max(dot(ag, normalize(vec2f(1.0, 1.7320508))), ag.x);
    let edge = (0.5 - dh) * k; // distance to the nearest hex edge
    m = cover(edge - hw);
  } else {
    // bricks: width k, height k/2, every other row shifted by half a brick
    let hgt = k * 0.5;
    let row = floor(q.y / hgt);
    let off = select(0.0, k * 0.5, (i32(row) & 1) == 1);
    let dx = abs((fract((q.x + off) / k + 0.5) - 0.5) * k);
    let dy = abs((fract(q.y / hgt + 0.5) - 0.5) * hgt);
    m = cover(min(dx, dy) - hw);
  }
  return mix(premul(u.a), premul(u.b), m);
}`,
    });
    return { image };
  },
});
