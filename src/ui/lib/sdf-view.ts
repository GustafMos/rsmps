/**
 * How the viewer, the handles and tap-to-select treat an SDF Scene. Pure.
 *
 * "The picture scene" is the SDF Scene whose picture the viewer shows: that is what the handles are drawn over and what a tap picks from.
 * It is found from the viewed node:
 *  - the SDF Scene node itself, or its Scene Output;
 *  - an SDF node inside a scene (a shape, combine, move or modify has no picture of its own): the NEAREST scene around it, so the viewer
 *    falls back to that scene's Scene Output (`sdfViewFallback`) instead of saying "no image";
 *  - any other node that exactly one SDF Scene feeds on its own level (an effect after the scene, an Output).
 */
import { defOf, groupAtPath, levelGraph, nodeAtPath, PATH_SEP } from '../../engine/group';
import { isSdfOnlyDef, isSdfSceneNode } from '../../engine/sdf-scene-group';
import { SDF_RENDER_ID, SDF_RENDER_TYPE } from '../../engine/lib/sdf-scene-params';
import type { Registry } from '../../engine/define';
import type { GraphDoc } from '../../engine/types';

const segs = (id: string): string[] => id.split(PATH_SEP).filter((p) => p && !p.startsWith('~'));

/** The nearest SDF Scene around the node at this full path (not the node itself), as a path of group ids, or null. */
export function sceneAround(root: GraphDoc, nodeId: string): string[] | null {
  const parts = segs(nodeId);
  for (let n = parts.length - 1; n >= 1; n--) {
    const g = groupAtPath(root, parts.slice(0, n));
    if (g && isSdfSceneNode(g)) return parts.slice(0, n);
  }
  return null;
}

/** The SDF Scene whose picture the viewer shows for this viewed node (a path of group ids), or null when it is not showing one. */
export function sdfPictureScene(root: GraphDoc, viewed: string | null, registry: Pick<Registry, 'get'>): string[] | null {
  if (!viewed) return null;
  const node = nodeAtPath(root, viewed);
  if (!node) return null;
  const parts = segs(viewed);
  if (isSdfSceneNode(node)) return parts;
  if (node.type === SDF_RENDER_TYPE) {
    const up = parts.slice(0, -1);
    const g = up.length ? groupAtPath(root, up) : null;
    return g && isSdfSceneNode(g) ? up : null;
  }
  const def = defOf(registry, node);
  if (isSdfOnlyDef(def)) return sceneAround(root, viewed);
  // a node after the scene: exactly one SDF Scene feeding it on its own level
  const level = levelGraph(root, parts.slice(0, -1));
  const seen = new Set<string>();
  const todo = [parts[parts.length - 1]];
  const scenes: string[] = [];
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = level.nodes.find((x) => x.id === id);
    if (n && isSdfSceneNode(n)) {
      scenes.push(id);
      continue;
    }
    for (const e of level.edges) if (e.to.node === id) todo.push(e.from.node);
  }
  return scenes.length === 1 ? [...parts.slice(0, -1), scenes[0]] : null;
}

/**
 * The node the viewer should draw INSTEAD of the viewed one, or null for no change. Only SDF nodes inside a scene (they make a shape tree, not
 * a picture) are replaced, by the Scene Output of the nearest scene around them: the picture of the scene they belong to.
 */
export function sdfViewFallback(root: GraphDoc, viewed: string | null, registry: Pick<Registry, 'get'>): string | null {
  if (!viewed) return null;
  const node = nodeAtPath(root, viewed);
  if (!node || node.type === SDF_RENDER_TYPE || isSdfSceneNode(node)) return null;
  const def = defOf(registry, node);
  if (!isSdfOnlyDef(def)) return null;
  const scene = sceneAround(root, viewed);
  return scene ? [...scene, SDF_RENDER_ID].join(PATH_SEP) : null;
}

/** True when `scene` is the open path or one of the levels above it: the picture then belongs to the group the editor is in (or around). */
export const sceneHoldsPath = (scene: readonly string[], path: readonly string[]): boolean => scene.length <= path.length && scene.every((id, i) => path[i] === id);

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Tap to select                                                                                                                  */
/* ------------------------------------------------------------------------------------------------------------------------------ */

export type TapPlan =
  | { kind: 'none' }
  /** Tap on empty background inside a scene. */
  | { kind: 'deselect' }
  /** Show the level at `path`, select `node` there. `enter` = the node is a scene or group that the tap goes into: open it and select `inner` there. */
  | { kind: 'select'; path: string[]; node: string; enter?: { inner: string | null }; hint?: 'first' | 'wired' };

/**
 * What a tap on the picture does. `picked` is the id of the shape under the finger (a flat path such as `scene1/shape2`) or null for background.
 *
 *  - Inside the scene: the tapped shape is selected. A shape inside a scene nested in this one selects that nested scene's node (a second tap on
 *    it goes in).
 *  - Outside the scene: the first tap selects the scene node, a tap while it is selected goes IN and selects the shape.
 *  - A shape that belongs to a scene wired in from somewhere else (not inside the open group): the owner node on the level they share is
 *    selected, the open group is left for that.
 */
export function planTap(o: { path: readonly string[]; selection: readonly string[]; picked: string | null; insideScene: boolean }): TapPlan {
  if (!o.picked) return o.insideScene ? { kind: 'deselect' } : { kind: 'none' };
  const parts = segs(o.picked);
  if (!parts.length) return { kind: 'none' };
  const groups = parts.slice(0, -1);
  let c = 0;
  while (c < o.path.length && c < groups.length && o.path[c] === groups[c]) c++;
  const level = o.path.slice(0, c);
  const node = parts[c];
  const isGroup = c < parts.length - 1;
  const here = c === o.path.length;
  if (!isGroup) return { kind: 'select', path: level, node };
  const wired = !here && c < o.path.length;
  if (here && o.selection.length === 1 && o.selection[0] === node) return { kind: 'select', path: level, node, enter: { inner: parts[c + 1] ?? null } };
  return { kind: 'select', path: level, node, hint: wired ? 'wired' : 'first' };
}
