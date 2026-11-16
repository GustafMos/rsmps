import { defineNode } from '../../define';
import { mod } from '../../lib/util-time';

const BINARY = ['add', 'subtract', 'multiply', 'divide', 'power', 'min', 'max', 'modulo'] as const;

const OPS = [
  { value: 'add', label: 'Add A + B' },
  { value: 'subtract', label: 'Subtract A−B' },
  { value: 'multiply', label: 'Multiply A × B' },
  { value: 'divide', label: 'Divide A ÷ B' },
  { value: 'power', label: 'Power A ^ B' },
  { value: 'min', label: 'Smaller of A, B' },
  { value: 'max', label: 'Larger of A, B' },
  { value: 'modulo', label: 'Remainder A mod B' },
  { value: 'abs', label: 'Absolute value of A' },
  { value: 'floor', label: 'Round A down' },
  { value: 'ceil', label: 'Round A up' },
  { value: 'round', label: 'Round A to nearest' },
  { value: 'sin', label: 'Sine of A' },
  { value: 'cos', label: 'Cosine of A' },
  { value: 'sqrt', label: 'Square root of A' },
  { value: 'negate', label: 'Negate A' },
] as const;

const isBinary = (op: string) => (BINARY as readonly string[]).includes(op);

export function applyMath(op: string, a: number, b: number): number {
  let r: number;
  switch (op) {
    case 'add':
      r = a + b;
      break;
    case 'subtract':
      r = a - b;
      break;
    case 'multiply':
      r = a * b;
      break;
    case 'divide':
      r = b === 0 ? 0 : a / b;
      break;
    case 'power':
      r = Math.pow(a, b);
      break;
    case 'min':
      r = Math.min(a, b);
      break;
    case 'max':
      r = Math.max(a, b);
      break;
    case 'modulo':
      r = b === 0 ? 0 : mod(a, Math.abs(b));
      break;
    case 'abs':
      r = Math.abs(a);
      break;
    case 'floor':
      r = Math.floor(a);
      break;
    case 'ceil':
      r = Math.ceil(a);
      break;
    case 'round':
      r = Math.round(a);
      break;
    case 'sin':
      r = Math.sin(a);
      break;
    case 'cos':
      r = Math.cos(a);
      break;
    case 'sqrt':
      r = a < 0 ? 0 : Math.sqrt(a);
      break;
    case 'negate':
      r = -a;
      break;
    default:
      r = a;
  }
  return Number.isFinite(r) ? r : 0;
}

export default defineNode({
  id: 'math',
  title: 'Math',
  category: 'math',
  description: 'Calculate with numbers: add, multiply, round, sine and more. Both inputs can be wired.',
  keywords: ['add', 'subtract', 'multiply', 'divide', 'power', 'min', 'max', 'modulo', 'abs', 'floor', 'round', 'sin', 'cos', 'sqrt', 'calculate', 'operation'],
  inputs: {},
  outputs: { value: { type: 'number', label: 'Result' } },
  params: {
    op: { type: 'enum', default: 'add', options: OPS, label: 'Operation' },
    a: { type: 'number', default: 0, min: -1000000, max: 1000000, step: 0.01, label: 'A' },
    b: { type: 'number', default: 1, min: -1000000, max: 1000000, step: 0.01, label: 'B', visibleIf: (p) => isBinary(String(p.op)) },
    clamp: { type: 'bool', default: false, label: 'Clamp 0..1' },
  },
  summary: (p) => {
    const sym: Record<string, string> = { add: '+', subtract: '-', multiply: '×', divide: '÷', power: '^', modulo: 'mod' };
    return isBinary(p.op) ? (sym[p.op] ? `A ${sym[p.op]} B` : `${p.op}(A, B)`) : `${p.op}(A)`;
  },
  render(ctx) {
    const p = ctx.params;
    let v = applyMath(p.op, p.a, p.b);
    if (p.clamp) v = Math.min(1, Math.max(0, v));
    return { value: v };
  },
});
