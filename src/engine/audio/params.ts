import type { AnyNodeDef, ParamDef } from '../types';
import type { AudioParams } from './types';

/**
 * Resolve stored params into what a kernel sees: defaults for missing values, numbers clamped to
 * min/max (and rounded for `integer`), enums validated. Mutates and returns `out` when given
 * (the runner reuses one object per node so kernels may keep a reference).
 *
 * v1: number params wired from frame-domain number nodes are NOT applied in the stream domain;
 * the stored value is used.
 */
export function resolveParams(def: AnyNodeDef, raw: Record<string, unknown> | undefined, out: AudioParams = {}): AudioParams {
  for (const [key, p] of Object.entries(def.params as Record<string, ParamDef>)) {
    const v = raw?.[key];
    switch (p.type) {
      case 'number': {
        let n = typeof v === 'number' && Number.isFinite(v) ? v : p.default;
        if (p.min !== undefined) n = Math.max(p.min, n);
        if (p.max !== undefined) n = Math.min(p.max, n);
        out[key] = p.integer ? Math.round(n) : n;
        break;
      }
      case 'bool':
        out[key] = typeof v === 'boolean' ? v : p.default;
        break;
      case 'enum':
        out[key] = typeof v === 'string' && p.options.some((o) => o.value === v) ? v : p.default;
        break;
      case 'string':
        out[key] = typeof v === 'string' ? v : p.default;
        break;
      case 'assets':
        out[key] = Array.isArray(v) ? v.filter((x) => typeof x === 'string') : p.default;
        break;
      default:
        out[key] = v === undefined ? structuredClone(p.default) : v;
    }
  }
  return out;
}
