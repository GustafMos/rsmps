/**
 * glTF 2.0 loader (.glb and self-contained .gltf). Pure TypeScript, no dependencies, no GPU.
 *
 * Supported: scenes / node hierarchy (TRS and matrix), meshes with triangle, triangle-strip and triangle-fan
 * primitives, every accessor component type (normalised or not, byteStride, sparse), POSITION, NORMAL (computed when
 * missing), TEXCOORD_0, COLOR_0, indices, materials (baseColorFactor, baseColorTexture, KHR_materials_pbrSpecularGlossiness
 * diffuse, doubleSided, alphaMode). Skins, animations, morph targets, cameras and lights are ignored (the mesh is
 * shown in its rest pose) and listed in `notes`.
 * Rejected with a clear message: Draco / meshopt compression, external .bin / image files, non-2.0 versions.
 */
import {
  DEFAULT_MATERIAL,
  ModelError,
  checkLimits,
  computeBounds,
  computeNormals,
  packGroups,
  srgbFromLinear,
  type ModelMaterial,
  type ParsedModel,
} from './gen-model';

export const MSG_EXTERNAL = 'This .gltf needs its external files (.bin or image files). Export it as a single .glb instead.';
export const MSG_COMPRESSED = 'This model uses Draco or meshopt compression, which is not supported. Re-export it without Draco/meshopt compression.';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
type Mat4 = number[]; // column-major, like glTF

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: Mat4, b: Mat4): Mat4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function trs(t: number[], q: number[], s: number[]): Mat4 {
  const [x, y, z, w] = q;
  const [xx, yy, zz, xy, xz, yz, wx, wy, wz] = [x * x, y * y, z * z, x * y, x * z, y * z, w * x, w * y, w * z];
  return [
    (1 - 2 * (yy + zz)) * s[0], 2 * (xy + wz) * s[0], 2 * (xz - wy) * s[0], 0,
    2 * (xy - wz) * s[1], (1 - 2 * (xx + zz)) * s[1], 2 * (yz + wx) * s[1], 0,
    2 * (xz + wy) * s[2], 2 * (yz - wx) * s[2], (1 - 2 * (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function nodeMatrix(node: Json): Mat4 {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix.map(Number);
  return trs(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1]);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeDataUri(uri: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(uri);
  if (!m) throw new ModelError(MSG_EXTERNAL);
  const isB64 = m[2].split(';').includes('base64');
  const bytes = isB64 ? base64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]));
  return { bytes, mime: m[1] || 'application/octet-stream' };
}

/** Split a .glb into its JSON and BIN chunks. */
function readGlb(buf: ArrayBuffer): { json: Json; bin: Uint8Array | null } {
  const dv = new DataView(buf);
  if (buf.byteLength < 20) throw new ModelError('This .glb file is truncated.');
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new ModelError(`Unsupported glTF version ${version}: only glTF 2.0 is supported.`);
  let json: Json = null;
  let bin: Uint8Array | null = null;
  let at = 12;
  const total = Math.min(dv.getUint32(8, true), buf.byteLength);
  while (at + 8 <= total) {
    const len = dv.getUint32(at, true);
    const type = dv.getUint32(at + 4, true);
    const start = at + 8;
    if (start + len > buf.byteLength) throw new ModelError('This .glb file is truncated.');
    if (type === 0x4e4f534a && json === null) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len)));
    else if (type === 0x004e4942 && bin === null) bin = new Uint8Array(buf, start, len);
    at = start + ((len + 3) & ~3);
  }
  if (!json) throw new ModelError('This .glb file has no JSON chunk.');
  return { json, bin };
}

const COMPONENT: Record<number, { size: number; read: (dv: DataView, o: number) => number; max: number }> = {
  5120: { size: 1, read: (dv, o) => dv.getInt8(o), max: 127 },
  5121: { size: 1, read: (dv, o) => dv.getUint8(o), max: 255 },
  5122: { size: 2, read: (dv, o) => dv.getInt16(o, true), max: 32767 },
  5123: { size: 2, read: (dv, o) => dv.getUint16(o, true), max: 65535 },
  5125: { size: 4, read: (dv, o) => dv.getUint32(o, true), max: 4294967295 },
  5126: { size: 4, read: (dv, o) => dv.getFloat32(o, true), max: 1 },
};
const TYPE_SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

class Reader {
  constructor(
    private json: Json,
    private buffers: Uint8Array[],
  ) {}

  private view(index: number): { dv: DataView; offset: number; length: number; stride: number } {
    const bv = this.json.bufferViews?.[index];
    if (!bv) throw new ModelError(`Broken glTF: missing bufferView ${index}.`);
    const buf = this.buffers[bv.buffer];
    if (!buf) throw new ModelError(`Broken glTF: missing buffer ${bv.buffer}.`);
    const offset = bv.byteOffset ?? 0;
    if (offset + bv.byteLength > buf.byteLength) throw new ModelError('Broken glTF: a bufferView reaches past the end of its buffer.');
    return { dv: new DataView(buf.buffer, buf.byteOffset, buf.byteLength), offset, length: bv.byteLength, stride: bv.byteStride ?? 0 };
  }

  /** Raw bytes of a bufferView (copied, so the result is a stable ArrayBuffer). */
  viewBytes(index: number): ArrayBuffer {
    const bv = this.json.bufferViews?.[index];
    if (!bv) throw new ModelError(`Broken glTF: missing bufferView ${index}.`);
    const buf = this.buffers[bv.buffer];
    if (!buf) throw new ModelError(`Broken glTF: missing buffer ${bv.buffer}.`);
    const start = buf.byteOffset + (bv.byteOffset ?? 0);
    return buf.buffer.slice(start, start + bv.byteLength) as ArrayBuffer;
  }

  /** Accessor as numbers. `normalise` is honoured only when the accessor says `normalized`. */
  read(index: number): { data: Float32Array | Uint32Array; count: number; size: number } {
    const acc = this.json.accessors?.[index];
    if (!acc) throw new ModelError(`Broken glTF: missing accessor ${index}.`);
    if (acc.type === 'MAT2' || acc.type === 'MAT3' || acc.type === 'MAT4') throw new ModelError('Unsupported glTF: matrix accessors used as mesh data.');
    const comp = COMPONENT[acc.componentType];
    const size = TYPE_SIZE[acc.type];
    if (!comp || !size) throw new ModelError(`Unsupported glTF accessor (componentType ${acc.componentType}, type ${acc.type}).`);
    const count: number = acc.count;
    const integer = acc.componentType !== 5126;
    const out = integer && !acc.normalized ? new Uint32Array(count * size) : new Float32Array(count * size);
    if (acc.bufferView !== undefined) {
      const v = this.view(acc.bufferView);
      const stride = v.stride || comp.size * size;
      const base = v.offset + (acc.byteOffset ?? 0);
      if (count > 0 && base + stride * (count - 1) + comp.size * size > v.offset + v.length) {
        throw new ModelError('Broken glTF: an accessor reaches past the end of its bufferView.');
      }
      const norm = acc.normalized && integer;
      for (let i = 0; i < count; i++) {
        for (let k = 0; k < size; k++) {
          let x = comp.read(v.dv, base + i * stride + k * comp.size);
          if (norm) x = Math.max(x / comp.max, -1);
          out[i * size + k] = x;
        }
      }
    }
    const sp = acc.sparse;
    if (sp) {
      const iv = this.view(sp.indices.bufferView);
      const vv = this.view(sp.values.bufferView);
      const ic = COMPONENT[sp.indices.componentType];
      const norm = acc.normalized && integer;
      for (let i = 0; i < sp.count; i++) {
        const target = ic.read(iv.dv, iv.offset + (sp.indices.byteOffset ?? 0) + i * ic.size);
        for (let k = 0; k < size; k++) {
          let x = comp.read(vv.dv, vv.offset + (sp.values.byteOffset ?? 0) + (i * size + k) * comp.size);
          if (norm) x = Math.max(x / comp.max, -1);
          out[target * size + k] = x;
        }
      }
    }
    return { data: out, count, size };
  }
}

interface RawPrim {
  positions: Float32Array; // local
  normals: Float32Array | null;
  uvs: Float32Array | null;
  colors: Float32Array | null; // rgba, linear
  indices: Uint32Array; // triangles
  material: number;
  world: Mat4;
}

function triangulate(mode: number, idx: Uint32Array): Uint32Array {
  if (mode === 4) return idx.length % 3 === 0 ? idx : idx.slice(0, idx.length - (idx.length % 3));
  const n = idx.length;
  if (n < 3) return new Uint32Array(0);
  const out = new Uint32Array((n - 2) * 3);
  if (mode === 5) {
    for (let i = 0; i < n - 2; i++) {
      // alternate winding so every triangle faces the same way
      if (i % 2 === 0) out.set([idx[i], idx[i + 1], idx[i + 2]], i * 3);
      else out.set([idx[i + 1], idx[i], idx[i + 2]], i * 3);
    }
  } else {
    for (let i = 0; i < n - 2; i++) out.set([idx[0], idx[i + 1], idx[i + 2]], i * 3);
  }
  return out;
}

function det3(m: Mat4): number {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

/** Inverse transpose of the upper 3x3 (row-major 3x3 result applied as n' = N * n). */
function normalMatrix(m: Mat4): number[] {
  const a = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]; // row-major 3x3
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8] = a;
  const c0 = a4 * a8 - a5 * a7, c1 = a5 * a6 - a3 * a8, c2 = a3 * a7 - a4 * a6;
  const det = a0 * c0 + a1 * c1 + a2 * c2 || 1;
  const inv = [c0, a2 * a7 - a1 * a8, a1 * a5 - a2 * a4, c1, a0 * a8 - a2 * a6, a2 * a3 - a0 * a5, c2, a1 * a6 - a0 * a7, a0 * a4 - a1 * a3].map((x) => x / det);
  // inverse transpose = transpose(inv)
  return [inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]];
}

export function parseGltf(buf: ArrayBuffer): ParsedModel {
  const head = buf.byteLength >= 4 ? new DataView(buf).getUint32(0, true) : 0;
  let json: Json;
  let bin: Uint8Array | null = null;
  if (head === 0x46546c67) {
    ({ json, bin } = readGlb(buf));
  } else {
    try {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
    } catch {
      throw new ModelError('This file is not a valid glTF (.glb or .gltf).');
    }
  }
  if (!json || typeof json !== 'object' || !json.asset) throw new ModelError('This file is not a valid glTF (.glb or .gltf).');
  if (String(json.asset.version ?? '2.0').split('.')[0] !== '2') throw new ModelError(`Unsupported glTF version ${json.asset.version}: only glTF 2.0 is supported.`);

  const used: string[] = [...(json.extensionsRequired ?? []), ...(json.extensionsUsed ?? [])];
  if (used.includes('KHR_draco_mesh_compression') || used.includes('EXT_meshopt_compression') || used.includes('KHR_meshopt_compression')) {
    throw new ModelError(MSG_COMPRESSED);
  }
  const notes: string[] = [];

  const buffers: Uint8Array[] = (json.buffers ?? []).map((b: Json, i: number) => {
    if (b.uri === undefined) {
      if (i === 0 && bin) return bin;
      throw new ModelError('Broken glTF: a buffer has no data.');
    }
    if (typeof b.uri === 'string' && b.uri.startsWith('data:')) return decodeDataUri(b.uri).bytes;
    throw new ModelError(MSG_EXTERNAL);
  });
  const reader = new Reader(json, buffers);

  // --- materials ---------------------------------------------------------
  const images: Json[] = json.images ?? [];
  const textureCache = new Map<number, ModelMaterial['texture']>();
  const loadTexture = (texIndex: number | undefined): ModelMaterial['texture'] => {
    if (texIndex === undefined) return null;
    if (textureCache.has(texIndex)) return textureCache.get(texIndex)!;
    const tex = json.textures?.[texIndex];
    const img = tex ? images[tex.source ?? tex.extensions?.EXT_texture_webp?.source ?? -1] : undefined;
    let out: ModelMaterial['texture'] = null;
    if (img) {
      if (img.bufferView !== undefined) out = { data: reader.viewBytes(img.bufferView), mime: img.mimeType ?? 'image/png' };
      else if (typeof img.uri === 'string' && img.uri.startsWith('data:')) {
        const d = decodeDataUri(img.uri);
        out = { data: d.bytes.buffer.slice(d.bytes.byteOffset, d.bytes.byteOffset + d.bytes.byteLength) as ArrayBuffer, mime: img.mimeType ?? d.mime };
      } else throw new ModelError(MSG_EXTERNAL);
    }
    textureCache.set(texIndex, out);
    return out;
  };
  const materials: ModelMaterial[] = [];
  const matOf = (m: Json): ModelMaterial => {
    const sg = m.extensions?.KHR_materials_pbrSpecularGlossiness;
    const pbr = m.pbrMetallicRoughness ?? {};
    const f: number[] = sg ? (sg.diffuseFactor ?? [1, 1, 1, 1]) : (pbr.baseColorFactor ?? [1, 1, 1, 1]);
    const texInfo = sg ? sg.diffuseTexture : pbr.baseColorTexture;
    const mode: string = m.alphaMode ?? 'OPAQUE';
    return {
      baseColor: [srgbFromLinear(f[0]), srgbFromLinear(f[1]), srgbFromLinear(f[2]), f[3] ?? 1],
      doubleSided: !!m.doubleSided,
      alphaMode: mode === 'MASK' ? 'mask' : mode === 'BLEND' ? 'blend' : 'opaque',
      alphaCutoff: m.alphaCutoff ?? 0.5,
      texture: texInfo && (texInfo.texCoord ?? 0) === 0 ? loadTexture(texInfo.index) : null,
    };
  };
  const defaultMaterialIndex = () => {
    materials.push({ ...DEFAULT_MATERIAL, baseColor: [...DEFAULT_MATERIAL.baseColor] });
    return materials.length - 1;
  };
  const jsonMaterials: Json[] = json.materials ?? [];
  jsonMaterials.forEach((m) => materials.push(matOf(m)));
  let fallbackMaterial = -1;

  // --- geometry ----------------------------------------------------------
  const prims: RawPrim[] = [];
  const walk = (nodeIndex: number, parent: Mat4, depth: number) => {
    if (depth > 64) throw new ModelError('Broken glTF: the node hierarchy is too deep (or loops).');
    const node = json.nodes?.[nodeIndex];
    if (!node) return;
    const world = mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = json.meshes?.[node.mesh];
      for (const p of mesh?.primitives ?? []) {
        if (p.extensions?.KHR_draco_mesh_compression) throw new ModelError(MSG_COMPRESSED);
        const mode = p.mode ?? 4;
        if (mode < 4 || p.attributes?.POSITION === undefined) continue; // points / lines are not rendered
        if (p.targets?.length && !notes.includes('Morph targets are ignored (the base mesh is shown).')) notes.push('Morph targets are ignored (the base mesh is shown).');
        const pos = reader.read(p.attributes.POSITION);
        if (pos.size !== 3) throw new ModelError('Broken glTF: POSITION must be a VEC3.');
        const nrm = p.attributes.NORMAL !== undefined ? reader.read(p.attributes.NORMAL) : null;
        const uv = p.attributes.TEXCOORD_0 !== undefined ? reader.read(p.attributes.TEXCOORD_0) : null;
        const col = p.attributes.COLOR_0 !== undefined ? reader.read(p.attributes.COLOR_0) : null;
        let idx: Uint32Array;
        if (p.indices !== undefined) idx = Uint32Array.from(reader.read(p.indices).data as ArrayLike<number>);
        else idx = Uint32Array.from({ length: pos.count }, (_, i) => i);
        for (let i = 0; i < idx.length; i++) if (idx[i] >= pos.count) throw new ModelError('Broken glTF: an index points past the end of the vertex data.');
        const tris = triangulate(mode, idx);
        let colors: Float32Array | null = null;
        if (col) {
          colors = new Float32Array(pos.count * 4);
          for (let i = 0; i < pos.count; i++) {
            for (let k = 0; k < 3; k++) colors[i * 4 + k] = col.data[i * col.size + k] as number;
            colors[i * 4 + 3] = col.size === 4 ? (col.data[i * 4 + 3] as number) : 1;
          }
        }
        let material = p.material ?? -1;
        if (material < 0 || material >= jsonMaterials.length) {
          if (fallbackMaterial < 0) fallbackMaterial = defaultMaterialIndex();
          material = fallbackMaterial;
        }
        prims.push({
          positions: pos.data as Float32Array,
          normals: nrm && nrm.size === 3 ? (nrm.data as Float32Array) : null,
          uvs: uv && uv.size === 2 ? (uv.data as Float32Array) : null,
          colors,
          indices: tris,
          material,
          world,
        });
      }
      if (node.skin !== undefined && !notes.includes('Skinned meshes are shown in their rest pose.')) notes.push('Skinned meshes are shown in their rest pose.');
    }
    for (const c of node.children ?? []) walk(c, world, depth + 1);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene?.nodes?.length) for (const n of scene.nodes) walk(n, IDENTITY, 0);
  else {
    const isChild = new Set<number>();
    (json.nodes ?? []).forEach((n: Json) => (n.children ?? []).forEach((c: number) => isChild.add(c)));
    (json.nodes ?? []).forEach((_: Json, i: number) => !isChild.has(i) && walk(i, IDENTITY, 0));
  }
  if (json.animations?.length) notes.push('Animations are ignored (the model is shown still).');
  if (!prims.length) throw new ModelError('This file contains no triangle meshes to draw.');

  // --- merge into one vertex / index set (engine space) -------------------
  let vertexCount = 0;
  let triangleCount = 0;
  for (const p of prims) {
    vertexCount += p.positions.length / 3;
    triangleCount += p.indices.length / 3;
  }
  checkLimits(vertexCount, triangleCount);

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Uint8Array(vertexCount * 4).fill(255);
  let hasUVs = false;
  let hasColors = false;
  const lists: { material: number; indices: Uint32Array }[] = [];
  let vo = 0;
  for (const p of prims) {
    const n = p.positions.length / 3;
    const nm = normalMatrix(p.world);
    const nrm = p.normals ?? computeNormals(p.positions, p.indices);
    const flip = det3(p.world) < 0;
    const m = p.world;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]];
      const o = (vo + i) * 3;
      positions[o] = m[0] * x + m[4] * y + m[8] * z + m[12];
      positions[o + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
      positions[o + 2] = -(m[2] * x + m[6] * y + m[10] * z + m[14]); // engine space: mirror z
      const [nx, ny, nz] = [nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]];
      let tx = nm[0] * nx + nm[1] * ny + nm[2] * nz;
      let ty = nm[3] * nx + nm[4] * ny + nm[5] * nz;
      let tz = nm[6] * nx + nm[7] * ny + nm[8] * nz;
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l; ty /= l; tz /= l;
      normals[o] = tx;
      normals[o + 1] = ty;
      normals[o + 2] = -tz;
    }
    if (p.uvs) {
      hasUVs = true;
      uvs.set(p.uvs, vo * 2);
    }
    if (p.colors) {
      hasColors = true;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < 3; k++) colors[(vo + i) * 4 + k] = Math.round(srgbFromLinear(p.colors[i * 4 + k]) * 255);
        colors[(vo + i) * 4 + 3] = Math.round(Math.min(1, Math.max(0, p.colors[i * 4 + 3])) * 255);
      }
    }
    const idx = new Uint32Array(p.indices.length);
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [p.indices[t] + vo, p.indices[t + 1] + vo, p.indices[t + 2] + vo];
      // a transform that mirrors the mesh reverses its winding (glTF spec): swap to keep it counter-clockwise
      idx[t] = a;
      idx[t + 1] = flip ? c : b;
      idx[t + 2] = flip ? b : c;
    }
    lists.push({ material: p.material, indices: idx });
    vo += n;
  }
  const packed = packGroups(lists);
  if (jsonMaterials.some((m) => m.alphaMode === 'BLEND')) notes.push('Alpha-blended materials are drawn as cut-outs (no sorted transparency).');
  return {
    positions,
    normals,
    uvs,
    colors,
    indices: packed.indices,
    groups: packed.groups,
    materials,
    bounds: computeBounds(positions),
    vertexCount,
    triangleCount,
    hasUVs,
    hasColors,
    notes,
  };
}
