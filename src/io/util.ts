/** Small shared helpers for src/io (no browser APIs at import time, so they are unit-testable). */
import { stableStringify } from '../engine/lib/stable-json';
import { upstream } from '../engine/graph';
import type { GraphDoc } from '../engine/types';

/** Same string hash the engine uses for its cache keys. */
export function hashString(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

/**
 * Hash of everything that can change a pixel of the VIEWED node: project settings, and the node types, params, bypass flags and wires
 * of the viewed node and everything upstream of it. Positions, labels, collapsed state and frames are ignored so dragging a node does
 * not throw away the frame cache, and so is every node that does not feed the view: editing a branch the viewer is not looking at
 * keeps the finished frames. `also`: nodes outside that chain which still matter (the active Output node: its frame settings decide
 * the size of the picture).
 */
export function renderHash(graph: GraphDoc, node: string | null, port: string | undefined, extra = '', also: Iterable<string> = []): string {
  let ids: Set<string> | null = null;
  if (node && graph.nodes.some((n) => n.id === node)) {
    ids = upstream(graph, node);
    for (const id of also) ids.add(id);
  }
  const nodes = graph.nodes.filter((n) => !ids || ids.has(n.id)).map((n) => [n.id, n.type, n.params, n.bypass ? 1 : 0]);
  const edges = graph.edges.filter((e) => !ids || ids.has(e.to.node)).map((e) => [e.from.node, e.from.port, e.to.node, e.to.port]);
  return hashString(stableStringify([graph.project, nodes, edges, node, port ?? '', extra]));
}

/** Total frame count of a project (at least 1). */
export function totalFramesOf(project: { duration: number; fps: number }): number {
  return Math.max(1, Math.round(project.duration * project.fps));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

export function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError');
}

let channel: MessageChannel | null = null;
/** Let the event loop (input, painting) run, without the 4 ms clamp of nested setTimeout. */
export function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise((r) => setTimeout(r, 0));
  channel ??= new MessageChannel();
  const ch = channel;
  return new Promise((resolve) => {
    ch.port1.onmessage = () => resolve();
    ch.port2.postMessage(0);
  });
}

export function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}
