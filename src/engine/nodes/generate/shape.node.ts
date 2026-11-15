import { defineNode } from '../../define';
import { rgba } from '../../lib/gen-common';

const KINDS = { rectangle: 0, ellipse: 1, polygon: 2, star: 3, line: 4, ring: 5 } as const;

export default defineNode({
  id: 'shape',
  title: 'Shape',
  category: 'generate',
  description:
    'A crisp vector shape (rectangle, ellipse, polygon, star, line or ring) with fill, outline and soft edge. Wire number nodes into any setting to animate it.',
  keywords: ['rectangle', 'rect', 'square', 'circle', 'ellipse', 'polygon', 'triangle', 'hexagon', 'star', 'line', 'ring', 'sdf', 'vector'],
  inputs: { size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    kind: {
      type: 'enum',
      default: 'rectangle',
      label: 'Shape',
      options: [
        { value: 'rectangle', label: 'Rectangle' },
        { value: 'ellipse', label: 'Ellipse / circle' },
        { value: 'polygon', label: 'Polygon' },
        { value: 'star', label: 'Star' },
        { value: 'line', label: 'Line' },
        { value: 'ring', label: 'Ring' },
      ],
    },
    x: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Position X', group: 'Placement' },
    y: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Position Y', group: 'Placement' },
    width: { type: 'number', default: 0.5, min: 0, max: 3, step: 0.005, unit: 'norm', label: 'Width', group: 'Placement', hint: 'As a fraction of the frame’s shorter side.' },
    height: { type: 'number', default: 0.5, min: 0, max: 3, step: 0.005, unit: 'norm', label: 'Height', group: 'Placement', hint: 'As a fraction of the frame’s shorter side. Not used by lines.' },
    rotation: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotation', group: 'Placement' },
    cornerRadius: { type: 'number', default: 24, min: 0, max: 1000, unit: 'px', label: 'Corner radius', group: 'Shape', visibleIf: (p) => p.kind === 'rectangle' },
    sides: { type: 'number', default: 5, min: 3, max: 24, step: 1, integer: true, label: 'Sides / points', group: 'Shape', visibleIf: (p) => p.kind === 'polygon' || p.kind === 'star' },
    sharpness: { type: 'number', default: 0.55, min: 0, max: 1, step: 0.01, label: 'Point sharpness', group: 'Shape', visibleIf: (p) => p.kind === 'star' },
    thickness: { type: 'number', default: 24, min: 0, max: 1000, unit: 'px', label: 'Thickness', group: 'Shape', hint: 'Ring thickness or line thickness.', visibleIf: (p) => p.kind === 'ring' || p.kind === 'line' },
    fill: { type: 'color', default: [1, 0.55, 0.25, 1], label: 'Fill colour', group: 'Look' },
    stroke: { type: 'color', default: [1, 1, 1, 1], label: 'Outline colour', group: 'Look' },
    strokeWidth: { type: 'number', default: 0, min: 0, max: 500, unit: 'px', label: 'Outline width', group: 'Look', hint: 'Centred on the shape edge. 0 = no outline.' },
    soft: { type: 'number', default: 0, min: 0, max: 500, unit: 'px', label: 'Soft edge', group: 'Look', hint: '0 = a crisp 1px antialiased edge.' },
  },
  summary: (p) => `${p.kind}${p.kind === 'polygon' || p.kind === 'star' ? ` (${p.sides})` : ''} at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`,
  render(ctx) {
    const p = ctx.params;
    const size = ctx.in.size ?? ctx.canvas;
    const image = ctx.gpu.pass({
      label: 'shape',
      size,
      uniforms: {
        kind: KINDS[p.kind as keyof typeof KINDS] ?? 0,
        pos: [p.x, p.y],
        dim: [Math.max(0, p.width), Math.max(0, p.height)],
        rot: p.rotation,
        radius: p.cornerRadius,
        sides: Math.max(3, Math.round(p.sides)),
        sharp: Math.min(1, Math.max(0, p.sharpness)),
        thick: p.thickness,
        sw: p.strokeWidth,
        soft: p.soft,
        fillC: rgba(p.fill),
        strokeC: rgba(p.stroke),
      },
      wgsl: /* wgsl */ `
fn sdEllipse(p: vec2f, b: vec2f) -> f32 {
  let k0 = length(p / b);
  let k1 = length(p / (b * b));
  if (k1 < 1e-6) { return -min(b.x, b.y); }
  return k0 * (k0 - 1.0) / k1;
}
// regular polygon, circumradius 1, one vertex pointing up
fn sdPoly(p: vec2f, n: f32) -> f32 {
  let an = TAU / n;
  let ang = atan2(p.x, -p.y);
  let bn = ((ang % an) + an) % an - an * 0.5;
  let apo = cos(an * 0.5);
  var q = length(p) * vec2f(cos(bn), abs(sin(bn)));
  q.x -= apo;
  q.y -= clamp(q.y, 0.0, apo * tan(an * 0.5));
  return length(q) * sign(q.x);
}
// star with n points, circumradius 1, one point up; m in [2, n] = sharpness
fn sdStar(pin: vec2f, n: f32, m: f32) -> f32 {
  let an = PI / n;
  let en = PI / m;
  let acs = vec2f(cos(an), sin(an));
  let ecs = vec2f(cos(en), sin(en));
  let ang = atan2(pin.x, -pin.y);
  let bn = ((ang % (2.0 * an)) + 2.0 * an) % (2.0 * an) - an;
  var p = length(pin) * vec2f(cos(bn), abs(sin(bn)));
  p -= acs;
  p += ecs * clamp(-dot(p, ecs), 0.0, acs.y / ecs.y);
  return length(p) * sign(p.x);
}
fn cov(d: f32, w: f32) -> f32 { return clamp(0.5 - d / w, 0.0, 1.0); }

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let short = min(u.size.x, u.size.y);
  let a = radians(u.rot);
  let c = cos(a); let s = sin(a);
  let p0 = px - u.pos * u.size;
  let p = vec2f(c * p0.x + s * p0.y, -s * p0.x + c * p0.y);
  let b = max(u.dim * short * 0.5, vec2f(0.001));
  let kind = i32(u.kind);
  var d = 0.0;
  if (kind == 0) {
    let r = min(u.radius, min(b.x, b.y));
    let q = abs(p) - b + vec2f(r);
    d = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
  } else if (kind == 1) {
    d = sdEllipse(p, b);
  } else if (kind == 2) {
    d = sdPoly(p / b, u.sides) * min(b.x, b.y);
  } else if (kind == 3) {
    d = sdStar(p / b, u.sides, mix(2.0, u.sides, u.sharp)) * min(b.x, b.y);
  } else if (kind == 4) {
    d = length(vec2f(p.x - clamp(p.x, -b.x, b.x), p.y)) - u.thick * 0.5;
  } else {
    d = abs(sdEllipse(p, b) + u.thick * 0.5) - u.thick * 0.5;
  }
  let w = max(1.0, u.soft);
  let fillCov = cov(d, w) * u.fillC.a;
  let fillCol = vec4f(u.fillC.rgb * fillCov, fillCov);
  var out = fillCol;
  if (u.sw > 0.0) {
    let sc = cov(abs(d) - u.sw * 0.5, w) * u.strokeC.a;
    out = vec4f(u.strokeC.rgb * sc, sc) + fillCol * (1.0 - sc);
  }
  return out;
}`,
    });
    return { image };
  },
});
