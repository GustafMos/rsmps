/**
 * Which nodes place an object in 3D, and what "neutral" means for each: used by the inspector's Reset buttons and by the on-picture
 * handles in the viewer (viewer/XformGizmo.tsx). Pure.
 */
import { resolveCamera, type XformP } from '../../engine/lib/gen-3d';
import type { AnyNodeDef, CameraValue } from '../../engine/types';

export type ResetKind = 'position' | 'rotation' | 'size' | 'all';

export interface Transform3d {
  /**
   * 'object' = the shared transform of the 3D family (3D Object, 3D Model, SDF 3D, Image to 3D, Gaussian Splat, Splat from Video):
   * Move X/Y/Z, Rotate X/Y/Z, Object scale and the built-in or wired camera. Only these get the handles in the viewer.
   * 'pose' = a node with its own tilt / turn settings (Glass, Hypercube): Reset buttons only.
   */
  kind: 'object' | 'pose';
  /** Param values that put the object in the middle / truly unrotated / at its normal size. */
  position: Record<string, unknown>;
  rotation: Record<string, unknown>;
  size: Record<string, unknown>;
}

const isNum = (def: AnyNodeDef, key: string): boolean => (def.params as Record<string, { type: string } | undefined>)[key]?.type === 'number';
const dflt = (def: AnyNodeDef, key: string): unknown => (def.params as Record<string, { default: unknown } | undefined>)[key]?.default;

export const OBJECT_KEYS = { pos: ['posX', 'posY', 'posZ'], rot: ['rotX', 'rotY', 'rotZ'], scale: 'objectScale' } as const;

/** The transform a node type offers, or null. The 3D family is recognised by its params, so a new member needs nothing here. */
export function transformOf(def: AnyNodeDef | undefined | null): Transform3d | null {
  if (!def) return null;
  if ([...OBJECT_KEYS.pos, ...OBJECT_KEYS.rot, OBJECT_KEYS.scale, 'x', 'y', 'scale', 'fov'].every((k) => isNum(def, k)) && 'camera' in def.inputs) {
    return {
      kind: 'object',
      // Frame X / Y also slide the object about in the picture (built-in camera), so "centre" puts them back too
      position: { posX: 0, posY: 0, posZ: 0, x: 0.5, y: 0.5 },
      rotation: { rotX: 0, rotY: 0, rotZ: 0 },
      size: { objectScale: 1 },
    };
  }
  if (def.id === 'glass' && isNum(def, 'tilt') && isNum(def, 'turn') && isNum(def, 'roll')) {
    return { kind: 'pose', position: { position: [0.5, 0.5] }, rotation: { tilt: 0, turn: 0, roll: 0 }, size: { size: dflt(def, 'size') } };
  }
  if (def.id === 'hypercube' && isNum(def, 'tilt') && isNum(def, 'turn')) {
    return { kind: 'pose', position: { center: [0, 0] }, rotation: { tilt: 0, turn: 0 }, size: { scale: dflt(def, 'scale') } };
  }
  return null;
}

/**
 * The param changes for one Reset button. Params driven by a wire are left out: the wire decides their value, and writing under it
 * would only surprise the user the day the wire is removed.
 */
export function resetPatch(t: Transform3d, kind: ResetKind, wired: ReadonlySet<string> = new Set()): Record<string, unknown> {
  const parts = kind === 'all' ? [t.position, t.rotation, t.size] : [t[kind]];
  const out: Record<string, unknown> = {};
  for (const part of parts) for (const [k, v] of Object.entries(part)) if (!wired.has(k) && v !== undefined) out[k] = v;
  return out;
}

/** True when applying `patch` would change nothing (the button is then shown switched off). */
export function patchIsNoop(params: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  return Object.entries(patch).every(([k, v]) => JSON.stringify(params[k]) === JSON.stringify(v));
}

/** The camera a member of the 3D family renders with: the wired one, else its simple built-in camera (same code as the nodes). */
export function cameraOf(params: Record<string, unknown>, wired: CameraValue | null, width: number, height: number): CameraValue {
  return resolveCamera(params as unknown as XformP, wired, width, height);
}

/** Nominal radius of the family's objects in scene units before Object scale (primitives and fitted models fill about this). */
export const OBJECT_RADIUS = 0.95;
