/**
 * What the viewer needs to know about the SDF Scene it shows, for this moment: the evaluated shape tree (the numbers of the current frame,
 * the scene's own Move / Rotate / Size / Spin included, exactly what the renderer draws) and the camera the picture was taken with.
 * Used by the per-shape handles (XformGizmo) and by tap-to-select (Viewer).
 */
import { groupAtPath, levelGraph } from '../../engine/group';
import { sdfRay } from '../../engine/lib/sdf-eval';
import { SDF_SCENE_PARAMS, SDF_RENDER_ID } from '../../engine/lib/sdf-scene-params';
import { rayAt, lensOf, type Lens, type V3 } from './gizmoMath';
import { cameraOf } from '../lib/xform3d';
import type { Io } from '../../io/api';
import type { CameraValue, GraphDoc, SdfNode, SdfValue } from '../../engine/types';

export interface SdfView {
  /** The scene's path (group ids from the top level). */
  scene: string[];
  root: SdfNode;
  picture: SdfValue['picture'];
  camera: CameraValue;
}

const params = (g: GraphDoc, scene: readonly string[]): Record<string, unknown> => {
  const node = groupAtPath(g, scene);
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(SDF_SCENE_PARAMS as Record<string, { default: unknown }>)) out[k] = node?.params[k] ?? p.default;
  return out;
};

/**
 * Ask the engine for the scene's current tree and camera. A wired Camera is evaluated the way the Scene Output sees it; without one the
 * scene's built-in camera numbers are used. Returns null when the scene is empty or evaluation fails.
 */
export async function loadSdfView(io: Pick<Io, 'evaluate'>, graph: GraphDoc, scene: readonly string[], o: { seconds: number; item: number; width: number; height: number }): Promise<SdfView | null> {
  const id = [...scene, SDF_RENDER_ID].join('/');
  // a small proxy: only the numbers of the tree are wanted here, not the picture
  const value = (await io.evaluate(graph, id, { port: 'sdf', seconds: o.seconds, item: o.item, proxy: 0.1 })) as SdfValue | null;
  if (!value || value.kind !== 'sdf' || !value.root) return null;
  let wired: CameraValue | null = null;
  const parentPath = scene.slice(0, -1);
  const level = levelGraph(graph, parentPath);
  const edge = level.edges.find((e) => e.to.node === scene[scene.length - 1] && e.to.port === 'camera');
  if (edge) {
    const cam = (await io.evaluate(graph, [...parentPath, edge.from.node].join('/'), { port: edge.from.port, seconds: o.seconds, item: o.item, proxy: 0.1 })) as { kind?: string } | null;
    if (cam && cam.kind === 'camera') wired = cam as CameraValue;
  }
  const camera = cameraOf(params(graph, scene), wired, o.width, o.height);
  return { scene: [...scene], root: value.root, picture: value.picture, camera };
}

export const lensOfView = (v: SdfView, width: number, height: number): Lens => lensOf(v.camera, width, height);

/** The shape under a point of the picture (frame coordinates, 0..1, y down), or null for background. */
export function pickShapeAt(v: SdfView, width: number, height: number, fx: number, fy: number): string | null {
  const ray = rayAt(lensOfView(v, width, height), fx, fy);
  if (!ray) return null;
  return sdfRay(v.root, ray.ro as V3, ray.rd as V3, { picture: v.picture })?.id ?? null;
}
