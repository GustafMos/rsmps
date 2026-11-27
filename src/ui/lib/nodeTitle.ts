import type { AnyNodeDef, NodeInstance, ParamDef } from '../../engine/types';

type AssetLookup = (id: string) => string | undefined;

/** The suffix a node's definition asks for ("Torus", "Spacesh"), or null. Display only. */
export function nodeTitleSuffix(node: Pick<NodeInstance, 'params'>, def: AnyNodeDef | undefined, assetName: AssetLookup = () => undefined): string | null {
  if (!def?.titleSuffix) return null;
  const params: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(def.params as Record<string, ParamDef>)) params[k] = node.params[k] ?? p.absent ?? p.default;
  try {
    return def.titleSuffix(params as never, { assetName }) || null;
  } catch {
    return null;
  }
}

/**
 * The name a node is shown under: the user's own name if it was renamed (no suffix then), else the type's title plus its
 * identity word ("SDF Shape Torus", "3D Object Spacesh"). Display only: never use it as a key or for search.
 */
export function nodeDisplayName(node: Pick<NodeInstance, 'label' | 'type' | 'params'>, def: AnyNodeDef | undefined, assetName?: AssetLookup): string {
  if (node.label) return node.label;
  const base = def?.title || node.type;
  const suffix = nodeTitleSuffix(node, def, assetName);
  return suffix ? `${base} ${suffix}` : base;
}

/** Resolver over the Media library's current assets (id to file name). */
export const libraryAssetName = (library: { list(): { id: string; name: string }[] }): AssetLookup => {
  let map: Map<string, string> | null = null;
  return (id) => (map ??= new Map(library.list().map((a) => [a.id, a.name]))).get(id);
};
