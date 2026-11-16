/**
 * JSON with object keys sorted (deep) and undefined members dropped. Cache keys are built from this, never from plain
 * JSON.stringify: two param objects that are deep-equal but were built in a different key order (a loaded project file, a plugin,
 * an object spread) must give the same key, otherwise the cache silently misses.
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (ArrayBuffer.isView(v)) return '[' + Array.from(v as unknown as ArrayLike<number>).join(',') + ']';
  const j = (v as { toJSON?: () => unknown }).toJSON;
  if (typeof j === 'function') return stableStringify(j.call(v));
  if (Array.isArray(v)) return '[' + v.map((x) => stableStringify(x)).join(',') + ']';
  const o = v as Record<string, unknown>;
  let out = '';
  for (const k of Object.keys(o).sort()) {
    const x = o[k];
    if (x === undefined || typeof x === 'function') continue;
    out += (out ? ',' : '') + JSON.stringify(k) + ':' + stableStringify(x);
  }
  return '{' + out + '}';
}
