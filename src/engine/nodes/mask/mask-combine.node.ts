import { defineNode } from '../../define';

const OPS = [
  { value: 'union', label: 'Union' },
  { value: 'add', label: 'Add' },
  { value: 'subtract', label: 'Subtract' },
  { value: 'intersect', label: 'Intersect' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'difference', label: 'Difference' },
] as const;

export default defineNode({
  id: 'mask-combine',
  title: 'Combine Masks',
  category: 'mask',
  description: 'Adds, subtracts or intersects two masks. B is resampled to the size of A.',
  keywords: ['union', 'subtract', 'intersect', 'boolean', 'and', 'or', 'merge'],
  inputs: {
    a: { type: 'mask', required: true, label: 'A' },
    b: { type: 'mask', label: 'B' },
  },
  outputs: { mask: { type: 'mask', label: 'Mask' } },
  params: {
    op: { type: 'enum', default: 'union', options: OPS, label: 'Operation' },
  },
  summary: (p) => p.op,
  render(ctx) {
    const { a, b } = ctx.in;
    if (!b) return { mask: a };
    const mask = ctx.gpu.passMask({
      label: 'mask-combine',
      size: a,
      textures: { a, b },
      uniforms: { op: OPS.findIndex((o) => o.value === ctx.params.op) },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let x = textureSampleLevel(a, smp, uv, 0.0).r;
  let y = textureSampleLevel(b, smp, uv, 0.0).r;
  var v = max(x, y);
  switch i32(u.op) {
    case 1 { v = min(x + y, 1.0); }
    case 2 { v = max(x - y, 0.0); }
    case 3 { v = min(x, y); }
    case 4 { v = x * y; }
    case 5 { v = abs(x - y); }
    default { }
  }
  return vec4f(vec3f(v), 1.0);
}`,
    });
    return { mask };
  },
});
