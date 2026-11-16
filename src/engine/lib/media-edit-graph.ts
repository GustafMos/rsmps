/**
 * Keeps the edit of every Media Timeline node in step with its wires, as a pure function of two graph documents.
 *   - a new wire into `clips` / `sounds` appends a clip for it at the end (so wiring three clips in gives a playable sequence at once);
 *   - a removed wire takes its clips with it; reordered wires renumber the clips so each still shows the same source.
 * Nodes that did not exist in `prev` (loaded, pasted) are left alone. Called by the editor store on every edit.
 */
import { wiresInto } from '../graph';
import type { GraphDoc, NodeInstance } from '../types';
import { MEDIA_TIMELINE_ID, appendSource, normalizeEdit, remapSources, type SourceInfo } from './media-edit';

/** What a source is: its label and natural length. The caller knows the host (asset info); this module stays pure. */
export type DescribeSource = (from: { node: NodeInstance; port: string }, to: 'clips' | 'sounds') => SourceInfo;

export function reconcileMediaEdits(prev: GraphDoc, next: GraphDoc, describe: DescribeSource): GraphDoc {
  if (prev === next) return next;
  let out = next;
  for (const node of next.nodes) {
    if (node.type !== MEDIA_TIMELINE_ID || !prev.nodes.some((n) => n.id === node.id)) continue;
    let edit = normalizeEdit(node.params.edit);
    let changed = false;
    for (const port of ['clips', 'sounds'] as const) {
      const before = wiresInto(prev, node.id, port);
      const after = wiresInto(next, node.id, port);
      const bIds = before.map((e) => e.id);
      const aIds = after.map((e) => e.id);
      if (bIds.length === aIds.length && bIds.every((id, i) => id === aIds[i])) continue;
      changed = true;
      edit = remapSources(edit, port, bIds, aIds);
      after.forEach((e, wire) => {
        if (bIds.includes(e.id)) return;
        const src = next.nodes.find((n) => n.id === e.from.node);
        if (src) edit = appendSource(edit, port, wire, describe({ node: src, port: e.from.port }, port));
      });
    }
    if (changed) out = { ...out, nodes: out.nodes.map((n) => (n.id === node.id ? { ...n, params: { ...n.params, edit } } : n)) };
  }
  return out;
}
