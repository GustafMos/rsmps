import { defineNode } from '../../define';
import type { VectorValue } from '../../types';

const OPS = [
  { value: 'add', label: 'Add A + B' },
  { value: 'subtract', label: 'Subtract A − B' },
  { value: 'multiply', label: 'Multiply A × B' },
  { value: 'scale', label: 'Scale A by number' },
  { value: 'mix', label: 'Mix A to B' },
  { value: 'normalize', label: 'Normalize A' },
  { value: 'cross', label: 'Cross product' },
  { value: 'rotate', label: 'Rotate A around B' },
  { value: 'length', label: 'Length of A' },
  { value: 'distance', label: 'Distance A to B' },
  { value: 'dot', label: 'Dot product' },
] as const;

type Op = (typeof OPS)[number]['value'];
const USES_B: readonly string[] = ['add', 'subtract', 'multiply', 'mix', 'cross', 'rotate', 'distance', 'dot'];
const finite = (n: number): number => (Number.isFinite(n) ? n : 0);
const len = (v: VectorValue): number => Math.hypot(v[0], v[1], v[2]);
const dot = (a: VectorValue, b: VectorValue): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: VectorValue, b: VectorValue): VectorValue => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: VectorValue): VectorValue => {
  const l = len(v);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0];
};

/**
 * Pure: the operation on two vectors. `vector` and `value` are both always given: operations that make a number (length, distance, dot)
 * put it in `value` and pass A through; the others put the length of the result in `value`.
 */
export function applyVectorMath(op: string, a: VectorValue, b: VectorValue, factor: number, angle: number): { vector: VectorValue; value: number } {
  let v: VectorValue = a;
  let n: number | null = null;
  switch (op as Op) {
    case 'add':
      v = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
      break;
    case 'subtract':
      v = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      break;
    case 'multiply':
      v = [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
      break;
    case 'scale':
      v = [a[0] * factor, a[1] * factor, a[2] * factor];
      break;
    case 'mix':
      v = [a[0] + (b[0] - a[0]) * factor, a[1] + (b[1] - a[1]) * factor, a[2] + (b[2] - a[2]) * factor];
      break;
    case 'normalize':
      v = unit(a);
      break;
    case 'cross':
      v = cross(a, b);
      break;
    case 'rotate': {
      // Rodrigues' rotation of A around the axis B (right-handed, degrees). No axis = no rotation.
      const k = unit(b);
      if (len(k) > 0) {
        const t = (angle * Math.PI) / 180;
        const c = Math.cos(t);
        const s = Math.sin(t);
        const kxa = cross(k, a);
        const kd = dot(k, a) * (1 - c);
        v = [a[0] * c + kxa[0] * s + k[0] * kd, a[1] * c + kxa[1] * s + k[1] * kd, a[2] * c + kxa[2] * s + k[2] * kd];
      }
      break;
    }
    case 'length':
      n = len(a);
      break;
    case 'distance':
      n = len([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
      break;
    case 'dot':
      n = dot(a, b);
      break;
  }
  const vector: VectorValue = [finite(v[0]), finite(v[1]), finite(v[2])];
  return { vector, value: finite(n ?? len(vector)) };
}

export default defineNode({
  id: 'vector-math',
  title: 'Vector Math',
  category: 'math',
  description: 'Calculate with vectors (three numbers on one wire): add, subtract, scale, mix, normalize, cross and dot product, length, distance and rotation around an axis. Gives a vector and a number.',
  keywords: ['vector', 'xyz', 'add', 'subtract', 'scale', 'mix', 'lerp', 'length', 'magnitude', 'normalize', 'cross', 'dot', 'distance', 'rotate', 'axis', 'calculate'],
  inputs: {
    a: { type: 'vector', label: 'A' },
    b: { type: 'vector', label: 'B' },
  },
  outputs: {
    vector: { type: 'vector', label: 'Vector' },
    value: { type: 'number', label: 'Number' },
  },
  params: {
    op: { type: 'enum', default: 'add', options: OPS, label: 'Operation' },
    factor: { type: 'number', default: 1, min: -1000000, max: 1000000, step: 0.01, label: 'Number', hint: 'Scale: what A is multiplied by. Mix: 0 = A, 1 = B.', visibleIf: (p) => p.op === 'scale' || p.op === 'mix' },
    angle: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 1, unit: 'deg', label: 'Angle', visibleIf: (p) => p.op === 'rotate' },
  },
  summary: (p) => {
    const label = OPS.find((o) => o.value === p.op)?.label ?? p.op;
    return p.op === 'scale' || p.op === 'mix' ? `${label} · ${p.factor}` : p.op === 'rotate' ? `${label} · ${p.angle}°` : label;
  },
  render(ctx) {
    const p = ctx.params;
    const zero: VectorValue = [0, 0, 0];
    return applyVectorMath(p.op, ctx.in.a ?? zero, USES_B.includes(p.op) ? (ctx.in.b ?? zero) : zero, p.factor, p.angle);
  },
});
