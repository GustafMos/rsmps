/** Easing curves shared by animate, loop and friends. All map 0..1 to roughly 0..1. */
export const CURVE_OPTIONS = [
  { value: 'linear', label: 'Linear' },
  { value: 'ease-in', label: 'Ease in (slow start)' },
  { value: 'ease-out', label: 'Ease out (slow end)' },
  { value: 'ease-in-out', label: 'Smooth (slow both ends)' },
] as const;

export const EASE_OPTIONS = [
  ...CURVE_OPTIONS,
  { value: 'overshoot', label: 'Overshoot' },
  { value: 'bounce', label: 'Bounce at end' },
] as const;

export function ease(name: string, x: number): number {
  switch (name) {
    case 'ease-in':
      return x * x * x;
    case 'ease-out': {
      const y = 1 - x;
      return 1 - y * y * y;
    }
    case 'ease-in-out':
      return x * x * (3 - 2 * x);
    case 'overshoot': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      const y = x - 1;
      return 1 + c3 * y * y * y + c1 * y * y;
    }
    case 'bounce': {
      const n1 = 7.5625;
      const d1 = 2.75;
      if (x < 1 / d1) return n1 * x * x;
      if (x < 2 / d1) {
        const y = x - 1.5 / d1;
        return n1 * y * y + 0.75;
      }
      if (x < 2.5 / d1) {
        const y = x - 2.25 / d1;
        return n1 * y * y + 0.9375;
      }
      const y = x - 2.625 / d1;
      return n1 * y * y + 0.984375;
    }
    default:
      return x;
  }
}
