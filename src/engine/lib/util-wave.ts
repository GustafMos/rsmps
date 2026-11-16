import { ease } from './util-ease';

export const WAVES = [
  { value: 'sine', label: 'Sine' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'saw-up', label: 'Ramp up' },
  { value: 'saw-down', label: 'Ramp down' },
  { value: 'square', label: 'Square' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'ping-pong-ease', label: 'Eased ping-pong' },
  { value: 'steps', label: 'Steps' },
  { value: 'noise', label: 'Smooth random wobble' },
] as const;

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise2(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const wx = fx * fx * (3 - 2 * fx);
  const wy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * wx + (c - a) * wy + (a - b - c + d) * wx * wy;
}

/** 1D noise that loops: p in 0..1 walks once around a circle in a 2D noise field. */
export function loopNoise1D(p: number, radius: number, seed: number): number {
  const a = p * Math.PI * 2;
  const n = valueNoise2(Math.cos(a) * radius + 11.3, Math.sin(a) * radius + 7.9, seed);
  return Math.min(1, Math.max(0, (n - 0.5) * 1.7 + 0.5));
}

export interface WaveOptions {
  wave: string;
  /** Position in the loop (cycles and phase offset already applied; only the fractional part matters). */
  t: number;
  /** For 'steps'. */
  steps: number;
  /** For 'noise'. */
  seed: number;
  /** For 'noise': more cycles = more wobbles per loop. */
  cycles: number;
}

/** Normalised wave value 0..1. */
export function waveValue(o: WaveOptions): number {
  const p = o.t - Math.floor(o.t);
  switch (o.wave) {
    case 'sine':
      return 0.5 - 0.5 * Math.cos(p * Math.PI * 2);
    case 'triangle':
      return 1 - Math.abs(1 - 2 * p);
    case 'saw-up':
      return p;
    case 'saw-down':
      return 1 - p;
    case 'square':
      return p < 0.5 ? 0 : 1;
    case 'bounce':
      return 4 * p * (1 - p);
    case 'ping-pong-ease':
      return ease('ease-in-out', 1 - Math.abs(1 - 2 * p));
    case 'steps': {
      const n = Math.max(2, Math.round(o.steps));
      return Math.min(1, Math.floor(p * n) / (n - 1));
    }
    case 'noise':
      return loopNoise1D(p, 0.4 + 0.6 * Math.max(1, o.cycles), o.seed);
    default:
      return p;
  }
}
