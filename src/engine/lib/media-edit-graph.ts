/**
 * Keeps the edit of every Media Timeline node in step with its wires, as a pure function of two graph documents.
 *   - a new wire into `clips` / `sounds` appends a clip for it at the end (so wiring three clips in gives a playable sequence at once);
 *   - a removed wire takes its clips with it; reordered wires renumber the clips so each still shows the same source.
 * Nodes that did not exist in `prev` (loaded, pasted) are left alone. Called by the editor store on every edit.
 */
import { wiresInto } from '../graph';
import type { GraphDoc, NodeInstance } from '../types';
import { reconcileInterleave } from './interleave-graph';
import { MEDIA_TIMELINE_ID, appendSource, normalizeEdit, remapSources, syncParts, type SourceInfo } from './media-edit';
import { STOP_MOTION_ID, clampFps, normalizeShots, shotSpans, totalSeconds } from './stop-motion';

/** What a Stop Motion node is to a Media Timeline: one part (cut) per shot, in the node's own animation time. */
export function stopMotionSource(node: NodeInstance): SourceInfo {
  const fps = clampFps(node.params.fps);
  const shots = normalizeShots(node.params.shots);
  return { name: node.label || 'Stop Motion', duration: totalSeconds(shots, fps), parts: shotSpans(shots, fps).map((s) => ({ start: s.start, duration: s.duration })) };
}

const sameSequence = (a: NodeInstance | undefined, b: NodeInstance): boolean => !!a && a.params.shots === b.params.shots && a.params.fps === b.params.fps;

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
        if (src) edit = appendSource(edit, port, wire, src.type === STOP_MOTION_ID && port === 'clips' ? stopMotionSource(src) : describe({ node: src, port: e.from.port }, port));
      });
    }
    // A Stop Motion wired in whose shots or frame rate changed: its cuts follow (new shots appear as new cuts at the end).
    wiresInto(next, node.id, 'clips').forEach((e, wire) => {
      const src = next.nodes.find((n) => n.id === e.from.node);
      if (!src || src.type !== STOP_MOTION_ID || sameSequence(prev.nodes.find((n) => n.id === src.id), src)) return;
      if (!wiresInto(prev, node.id, 'clips').some((w) => w.id === e.id)) return; // a new wire: appendSource made its cuts above
      edit = syncParts(edit, wire, stopMotionSource(src));
      changed = true;
    });
    if (changed) out = { ...out, nodes: out.nodes.map((n) => (n.id === node.id ? { ...n, params: { ...n.params, edit } } : n)) };
  }
  // Frame Interleave keeps its source count, base length and project frames in step the same way.
  return reconcileInterleave(prev, out, (from) => describe(from, 'clips').duration);
}

/**
 * "Update cuts from Stop Motion": bring the cuts of every Stop Motion wired straight into Media Timeline `timelineId` in step with its
 * shots (see `syncParts`). The same graph object when nothing is wired or nothing changes.
 */
export function updateStopMotionCuts(graph: GraphDoc, timelineId: string): GraphDoc {
  const node = graph.nodes.find((n) => n.id === timelineId && n.type === MEDIA_TIMELINE_ID);
  if (!node) return graph;
  let edit = normalizeEdit(node.params.edit);
  wiresInto(graph, timelineId, 'clips').forEach((e, wire) => {
    const src = graph.nodes.find((n) => n.id === e.from.node);
    if (src?.type === STOP_MOTION_ID) edit = syncParts(edit, wire, stopMotionSource(src));
  });
  return { ...graph, nodes: graph.nodes.map((n) => (n.id === timelineId ? { ...n, params: { ...n.params, edit } } : n)) };
}
