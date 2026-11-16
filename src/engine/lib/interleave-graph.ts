/**
 * Keeps the derived, hidden params of every Frame Interleave node in step with the graph (a node only sees its own params, and
 * `projectLength(params)` only sees params):
 *   count        = number of wires into `sources` (the node cannot see its wires; the engine does not evaluate a lazy input)
 *   baseSeconds  = length of the first wired source that has a known length, filled in while it is still 0 (the user may overwrite it)
 *   frames       = frames the project will have, for the "cycle does not divide N frames" hint in the summary
 * Pure function of two graph documents; the same object back when nothing changes. Called from `reconcileMediaEdits` (editor store, every commit).
 */
import { wiresInto } from '../graph';
import type { GraphDoc, NodeInstance } from '../types';
import { interleaveSeconds, parsePattern } from './interleave';

export const FRAME_INTERLEAVE_ID = 'frame-interleave';

/** Natural length in seconds of what a wire comes from; 0 = unknown. */
export type DescribeLength = (from: { node: NodeInstance; port: string }) => number;

export function reconcileInterleave(prev: GraphDoc, next: GraphDoc, length: DescribeLength): GraphDoc {
  let out = next;
  for (const node of next.nodes) {
    if (node.type !== FRAME_INTERLEAVE_ID || !prev.nodes.some((n) => n.id === node.id)) continue;
    const wires = wiresInto(next, node.id, 'sources');
    const params: Record<string, unknown> = { ...node.params };
    params.count = wires.length;
    if (!(Number(params.baseSeconds) > 0)) {
      for (const e of wires) {
        const src = next.nodes.find((n) => n.id === e.from.node);
        const d = src ? length({ node: src, port: e.from.port }) : 0;
        if (d > 0) {
          params.baseSeconds = d;
          break;
        }
      }
    }
    const fps = next.project.fps > 0 ? next.project.fps : 1;
    let seconds = next.project.duration;
    if (params.setsLength === true && params.mode === 'every-frame' && params.timing !== 'same-length' && wires.length > 1) {
      const s = interleaveSeconds(Number(params.baseSeconds) || 0, parsePattern(params.pattern, wires.length).pattern, Math.max(1, Number(params.hold) || 1));
      if (s > 0) seconds = s;
    }
    params.frames = Math.max(1, Math.round(seconds * fps));
    const same = Object.keys(params).every((k) => params[k] === node.params[k]) && Object.keys(node.params).every((k) => k in params);
    if (!same) out = { ...out, nodes: out.nodes.map((n) => (n.id === node.id ? { ...n, params } : n)) };
  }
  return out;
}
