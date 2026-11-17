/**
 * Wavefront .obj loader: v / vt / vn / f (triangles, quads and larger polygons are fan-triangulated, negative
 * indices work). Materials (.mtl), groups, smoothing groups and object names are ignored: one default material.
 */
import {
  DEFAULT_MATERIAL,
  ModelError,
  checkLimits,
  computeBounds,
  computeNormals,
  type ParsedModel,
} from './gen-model';

export function parseObj(buf: ArrayBuffer): ParsedModel {
  const text = new TextDecoder().decode(new Uint8Array(buf));
  const v: number[] = [];
  const vt: number[] = [];
  const vn: number[] = [];
  const keyToVertex = new Map<string, number>();
  const outPos: number[] = [];
  const outUv: number[] = [];
  const outNrm: (number | -1)[] = []; // normal index per output vertex (-1 = none)
  const faceNrmIndex: number[] = [];
  const indices: number[] = [];
  let hasUVs = false;
  let faces = 0;

  const resolve = (token: string, vCount: number, tCount: number, nCount: number): number => {
    const parts = token.split('/');
    const fix = (s: string | undefined, count: number): number => {
      if (s === undefined || s === '') return -1;
      const n = parseInt(s, 10);
      if (!Number.isFinite(n) || n === 0) return -2;
      const i = n > 0 ? n - 1 : count + n;
      return i >= 0 && i < count ? i : -2;
    };
    const vi = fix(parts[0], vCount);
    const ti = fix(parts[1], tCount);
    const ni = fix(parts[2], nCount);
    if (vi < 0 || ti === -2 || ni === -2) throw new ModelError('This .obj has a face that points at a missing vertex, UV or normal.');
    const key = `${vi}/${ti}/${ni}`;
    let out = keyToVertex.get(key);
    if (out === undefined) {
      out = outPos.length / 3;
      keyToVertex.set(key, out);
      outPos.push(v[vi * 3], v[vi * 3 + 1], v[vi * 3 + 2]);
      if (ti >= 0) {
        hasUVs = true;
        outUv.push(vt[ti * 2], 1 - vt[ti * 2 + 1]); // OBJ v = 0 is the bottom row
      } else outUv.push(0, 0);
      faceNrmIndex.push(ni);
      outNrm.push(ni);
    }
    return out;
  };

  let from = 0;
  while (from < text.length) {
    let to = text.indexOf('\n', from);
    if (to < 0) to = text.length;
    const line = text.slice(from, to).trim();
    from = to + 1;
    if (!line || line[0] === '#') continue;
    const t = line.split(/\s+/);
    switch (t[0]) {
      case 'v':
        v.push(parseFloat(t[1]) || 0, parseFloat(t[2]) || 0, parseFloat(t[3]) || 0);
        break;
      case 'vt':
        vt.push(parseFloat(t[1]) || 0, parseFloat(t[2]) || 0);
        break;
      case 'vn':
        vn.push(parseFloat(t[1]) || 0, parseFloat(t[2]) || 0, parseFloat(t[3]) || 0);
        break;
      case 'f': {
        if (t.length < 4) break;
        const ids: number[] = [];
        for (let i = 1; i < t.length; i++) ids.push(resolve(t[i], v.length / 3, vt.length / 2, vn.length / 3));
        for (let i = 1; i < ids.length - 1; i++) indices.push(ids[0], ids[i], ids[i + 1]);
        faces++;
        break;
      }
      default:
        break; // o, g, s, usemtl, mtllib, l, p ...
    }
  }
  if (!indices.length) throw new ModelError('This .obj file contains no faces to draw.');
  const vertexCount = outPos.length / 3;
  checkLimits(vertexCount, indices.length / 3);

  const positions = new Float32Array(outPos);
  // normals: use the file's where given, smooth computed ones elsewhere
  const normals = new Float32Array(vertexCount * 3);
  const idx = Uint32Array.from(indices);
  if (outNrm.some((n) => n < 0)) normals.set(computeNormals(positions, idx));
  for (let i = 0; i < vertexCount; i++) {
    const ni = outNrm[i];
    if (ni >= 0) {
      const [x, y, z] = [vn[ni * 3], vn[ni * 3 + 1], vn[ni * 3 + 2]];
      const l = Math.hypot(x, y, z) || 1;
      normals[i * 3] = x / l;
      normals[i * 3 + 1] = y / l;
      normals[i * 3 + 2] = z / l;
    }
  }
  // engine space: mirror z
  for (let i = 0; i < vertexCount; i++) {
    positions[i * 3 + 2] = -positions[i * 3 + 2];
    normals[i * 3 + 2] = -normals[i * 3 + 2];
  }
  void faces;
  return {
    positions,
    normals,
    uvs: new Float32Array(outUv),
    colors: new Uint8Array(vertexCount * 4).fill(255),
    indices: idx,
    groups: [{ start: 0, count: idx.length, material: 0 }],
    materials: [{ ...DEFAULT_MATERIAL, baseColor: [...DEFAULT_MATERIAL.baseColor] }],
    bounds: computeBounds(positions),
    vertexCount,
    triangleCount: idx.length / 3,
    hasUVs,
    hasColors: false,
    notes: ['Materials (.mtl) are ignored: the model uses one gray material.'],
  };
}
