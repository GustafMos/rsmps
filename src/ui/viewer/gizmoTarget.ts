import type { Registry } from '../../engine/define';
import type { GraphDoc } from '../../engine/types';
import { transformOf } from '../lib/xform3d';

/**
 * Which node the on-picture 3D handles belong to, or null for none. Pure.
 *
 *  1. The one selected node, when it is a 3D object AND the picture in the viewer comes from it (it is the viewed node or feeds it):
 *     handles drawn over an unrelated picture would point at nothing.
 *  2. Nothing (or something else) selected: the viewed node itself when it is a 3D object, else the only 3D object feeding it. With two
 *     or more there is no obvious one, and the user picks by selecting.
 *
 * `level` is the graph level on screen (the inside of the open group), `viewed` the viewer's node, which may be a path into a group.
 * A bypassed node draws nothing of its own, so it gets no handles.
 */
export function gizmoTarget(level: GraphDoc, selection: readonly string[], viewed: string | null, path: readonly string[], registry: Pick<Registry, 'get'>): string | null {
  const is3d = (id: string): boolean => {
    const n = level.nodes.find((x) => x.id === id);
    return !!n && !n.bypass && transformOf(registry.get(n.type))?.kind === 'object';
  };
  // the viewed node as an id of this level, when it lives here
  const prefix = path.length ? path.join('/') + '/' : '';
  const local = viewed && viewed.startsWith(prefix) && !viewed.slice(prefix.length).includes('/') ? viewed.slice(prefix.length) : null;
  const here = local && level.nodes.some((n) => n.id === local) ? local : null;
  const upstream = new Set<string>();
  if (here) {
    const todo = [here];
    while (todo.length) {
      const id = todo.pop()!;
      if (upstream.has(id)) continue;
      upstream.add(id);
      for (const e of level.edges) if (e.to.node === id) todo.push(e.from.node);
    }
  }
  if (selection.length === 1 && is3d(selection[0])) {
    // the viewed node is on another level (inside or outside a group): we cannot follow the wires there, so trust the selection
    if (!here || upstream.has(selection[0])) return selection[0];
  }
  if (!here) return null;
  if (is3d(here)) return here;
  const feeding = [...upstream].filter(is3d);
  return feeding.length === 1 ? feeding[0] : null;
}
