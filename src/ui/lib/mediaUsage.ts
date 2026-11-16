/** Which assets the nodes of a graph use. Nodes keep asset ids inside their params (a list, a single id, or nested JSON such as a timeline). */
import type { NodeInstance } from '../../engine/types';

const MAX_DEPTH = 8;
/** Asset ids are short; a longer string is text or data, never an id. */
const MAX_ID_LEN = 64;

function leaves(v: unknown, out: Set<string>, depth: number): void {
  if (typeof v === 'string') {
    if (v.length > 0 && v.length <= MAX_ID_LEN) out.add(v);
  } else if (depth < MAX_DEPTH && v && typeof v === 'object') {
    if (Array.isArray(v)) for (const x of v) leaves(x, out, depth + 1);
    else for (const x of Object.values(v)) leaves(x, out, depth + 1);
  }
}

/** Short strings found in a params object, remembered per object: params are replaced (never mutated) when they change. */
const memo = new WeakMap<object, string[]>();
function leafStrings(params: object): string[] {
  let l = memo.get(params);
  if (!l) {
    const set = new Set<string>();
    leaves(params, set, 0);
    memo.set(params, (l = [...set]));
  }
  return l;
}

/** asset id -> ids of the nodes that use it (only assets that ARE used appear). Strings that are not in `assetIds` are ignored. */
export function assetUsage(nodes: readonly NodeInstance[], assetIds: ReadonlySet<string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!assetIds.size) return out;
  for (const n of nodes) {
    if (!n.params) continue;
    for (const s of leafStrings(n.params)) if (assetIds.has(s)) (out.get(s) ?? out.set(s, []).get(s)!).push(n.id);
  }
  return out;
}

export function usageEqual(a: ReadonlyMap<string, readonly string[]>, b: ReadonlyMap<string, readonly string[]>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || w.length !== v.length || v.some((x, i) => x !== w[i])) return false;
  }
  return true;
}
