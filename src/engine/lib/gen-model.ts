/**
 * Shared types and helpers for the 3D model loaders (gen-gltf.ts, gen-obj.ts) and the `model-3d` node.
 *
 * ENGINE SPACE: x right, y up, z into the screen (the camera sits on -z), like the rest of the generators.
 * glTF and OBJ are right-handed with +z towards the viewer, so loaders MIRROR z (positions and normals). Triangle
 * winding as seen on screen stays counter-clockwise, so indices are NOT swapped.
 */

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelError';
  }
}

/** Generous limits so a bad file cannot freeze or exhaust the GPU. */
export const MAX_TRIANGLES = 2_000_000;
export const MAX_VERTICES = 4_000_000;

export interface ModelTexture {
  /**
   * Encoded image (PNG / JPEG ...) as embedded in the file, sliced ONCE at parse time. Pass this same ArrayBuffer
   * object to Host.decodeImageBytes every render: the host caches decoded textures per buffer object.
   */
  data: ArrayBuffer;
  mime: string;
}

export interface ModelMaterial {
  /** Straight sRGB rgba, 0..1 (glTF's linear factor is converted). */
  baseColor: [number, number, number, number];
  doubleSided: boolean;
  /** 'blend' is rendered as 'mask' (no sorted transparency). */
  alphaMode: 'opaque' | 'mask' | 'blend';
  alphaCutoff: number;
  texture: ModelTexture | null;
}

/** A run of triangles (index range) that share one material. */
export interface ModelGroup {
  /** First index (not triangle). */
  start: number;
  /** Number of indices (3 x triangles). */
  count: number;
  material: number;
}

export interface ParsedModel {
  /** xyz per vertex, engine space. */
  positions: Float32Array;
  /** xyz per vertex, unit length, engine space. */
  normals: Float32Array;
  /** uv per vertex (glTF convention: v = 0 is the top row of the image). */
  uvs: Float32Array;
  /** rgba8 per vertex, sRGB, straight alpha (255 when the file has no vertex colours). */
  colors: Uint8Array;
  indices: Uint32Array;
  groups: ModelGroup[];
  materials: ModelMaterial[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
  vertexCount: number;
  triangleCount: number;
  hasUVs: boolean;
  hasColors: boolean;
  /** Things that were present but ignored (animations, skins ...). */
  notes: string[];
}

export const DEFAULT_MATERIAL: ModelMaterial = {
  baseColor: [0.8, 0.8, 0.8, 1],
  doubleSided: false,
  alphaMode: 'opaque',
  alphaCutoff: 0.5,
  texture: null,
};

export function srgbFromLinear(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * Smooth vertex normals (area weighted). Vertices at the same position share one normal, so UV seams and
 * duplicated vertices do not show as creases. Expects counter-clockwise winding in a right-handed space.
 */
export function computeNormals(positions: Float32Array, indices: ArrayLike<number>): Float32Array {
  const n = positions.length / 3;
  const weld = new Map<string, number>();
  const group = new Uint32Array(n);
  let groups = 0;
  for (let i = 0; i < n; i++) {
    const key = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
    let g = weld.get(key);
    if (g === undefined) {
      g = groups++;
      weld.set(key, g);
    }
    group[i] = g;
  }
  const acc = new Float64Array(groups * 3);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]];
    const ax = positions[b * 3] - positions[a * 3], ay = positions[b * 3 + 1] - positions[a * 3 + 1], az = positions[b * 3 + 2] - positions[a * 3 + 2];
    const bx = positions[c * 3] - positions[a * 3], by = positions[c * 3 + 1] - positions[a * 3 + 1], bz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    for (const v of [a, b, c]) {
      const g = group[v] * 3;
      acc[g] += nx;
      acc[g + 1] += ny;
      acc[g + 2] += nz;
    }
  }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const g = group[i] * 3;
    const l = Math.hypot(acc[g], acc[g + 1], acc[g + 2]);
    if (l > 1e-20) {
      out[i * 3] = acc[g] / l;
      out[i * 3 + 1] = acc[g + 1] / l;
      out[i * 3 + 2] = acc[g + 2] / l;
    } else out[i * 3 + 1] = 1;
  }
  return out;
}

export function computeBounds(positions: Float32Array): ParsedModel['bounds'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  if (!isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

export function checkLimits(vertexCount: number, triangleCount: number): void {
  if (triangleCount > MAX_TRIANGLES) {
    throw new ModelError(
      `This model has ${triangleCount.toLocaleString('en-US')} triangles; the limit is ${MAX_TRIANGLES.toLocaleString('en-US')}. Reduce (decimate) it in your 3D tool and export again.`,
    );
  }
  if (vertexCount > MAX_VERTICES) {
    throw new ModelError(
      `This model has ${vertexCount.toLocaleString('en-US')} vertices; the limit is ${MAX_VERTICES.toLocaleString('en-US')}. Reduce (decimate) it in your 3D tool and export again.`,
    );
  }
}

/** Turn per-material index lists into one index array with contiguous groups. */
export function packGroups(lists: { material: number; indices: Uint32Array }[]): { indices: Uint32Array; groups: ModelGroup[] } {
  const sorted = [...lists].sort((a, b) => a.material - b.material);
  let total = 0;
  for (const l of sorted) total += l.indices.length;
  const indices = new Uint32Array(total);
  const groups: ModelGroup[] = [];
  let at = 0;
  for (const l of sorted) {
    indices.set(l.indices, at);
    const last = groups[groups.length - 1];
    if (last && last.material === l.material) last.count += l.indices.length;
    else groups.push({ start: at, count: l.indices.length, material: l.material });
    at += l.indices.length;
  }
  return { indices, groups };
}
