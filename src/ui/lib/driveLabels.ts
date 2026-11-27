import { defOf } from '../../engine/group';
import type { Edge, NodeInstance } from '../../engine/types';
import { nodeDisplayName } from './nodeTitle';

/**
 * Row labels for the Motion outputs of a node that are wired: "→ SDF Shape Torus", so the Physics node says which object each body moves.
 * Keys are `out:port`. Empty when no Motion output is wired. Display only.
 */
export function motionLabels(nodes: readonly NodeInstance[], edges: readonly Edge[], nodeId: string, registry: { get(id: string): never | unknown }, assetName?: (id: string) => string | undefined): Record<string, string> {
  const out: Record<string, string[]> = {};
  for (const e of edges) {
    if (e.from.node !== nodeId || !/^motion\d+$/.test(e.from.port)) continue;
    const t = nodes.find((n) => n.id === e.to.node);
    if (!t) continue;
    const def = defOf(registry as never, t);
    (out[`out:${e.from.port}`] ??= []).push(`→ ${nodeDisplayName(t, def, assetName)}`);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join(', ')]));
}
