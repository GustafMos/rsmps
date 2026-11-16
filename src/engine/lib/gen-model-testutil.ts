/** Builders for tiny glTF / OBJ files, used by the model loader and `model-3d` tests (and handy for experiments). */

export interface MeshSpec {
  positions: ArrayLike<number>;
  normals?: ArrayLike<number>;
  uvs?: ArrayLike<number>;
  colors?: ArrayLike<number>; // rgba floats
  indices?: ArrayLike<number>;
  uint16?: boolean;
  /** glTF material object (pbrMetallicRoughness ...). */
  material?: Record<string, unknown>;
  mode?: number;
}

function pad4(n: number): number {
  return (n + 3) & ~3;
}

/** Build the JSON + binary pair for one or more meshes. `nodes` overrides the default single-node scene. */
export function buildGltfParts(
  meshes: MeshSpec[],
  opts: { nodes?: Record<string, unknown>[]; sceneNodes?: number[]; extra?: Record<string, unknown> } = {},
): { json: Record<string, any>; bin: Uint8Array } {
  const chunks: Uint8Array[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  let offset = 0;
  const addView = (bytes: Uint8Array, target?: number) => {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    const padded = new Uint8Array(pad4(bytes.byteLength));
    padded.set(bytes);
    chunks.push(padded);
    offset += padded.byteLength;
    return bufferViews.length - 1;
  };
  const addAccessor = (view: number, componentType: number, count: number, type: string, extra: Record<string, unknown> = {}) => {
    accessors.push({ bufferView: view, componentType, count, type, ...extra });
    return accessors.length - 1;
  };
  const materials: Record<string, unknown>[] = [];
  const gltfMeshes = meshes.map((m) => {
    const pos = new Float32Array(Array.from(m.positions));
    let min = [Infinity, Infinity, Infinity];
    let max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
    const attributes: Record<string, number> = {
      POSITION: addAccessor(addView(new Uint8Array(pos.buffer), 34962), 5126, pos.length / 3, 'VEC3', { min, max }),
    };
    if (m.normals) {
      const a = new Float32Array(Array.from(m.normals));
      attributes.NORMAL = addAccessor(addView(new Uint8Array(a.buffer), 34962), 5126, a.length / 3, 'VEC3');
    }
    if (m.uvs) {
      const a = new Float32Array(Array.from(m.uvs));
      attributes.TEXCOORD_0 = addAccessor(addView(new Uint8Array(a.buffer), 34962), 5126, a.length / 2, 'VEC2');
    }
    if (m.colors) {
      const a = new Float32Array(Array.from(m.colors));
      attributes.COLOR_0 = addAccessor(addView(new Uint8Array(a.buffer), 34962), 5126, a.length / 4, 'VEC4');
    }
    const prim: Record<string, unknown> = { attributes };
    if (m.mode !== undefined) prim.mode = m.mode;
    if (m.indices) {
      const idx = m.uint16 ? new Uint16Array(Array.from(m.indices)) : new Uint32Array(Array.from(m.indices));
      prim.indices = addAccessor(addView(new Uint8Array(idx.buffer), 34963), m.uint16 ? 5123 : 5125, idx.length, 'SCALAR');
    }
    if (m.material) {
      materials.push(m.material);
      prim.material = materials.length - 1;
    }
    return { primitives: [prim] };
  });
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.byteLength;
  }
  const nodes = opts.nodes ?? gltfMeshes.map((_, i) => ({ mesh: i }));
  const json: Record<string, any> = {
    asset: { version: '2.0', generator: 'gen-model-testutil' },
    scene: 0,
    scenes: [{ nodes: opts.sceneNodes ?? nodes.map((_, i) => i).filter((i) => !nodes.some((n) => ((n.children as number[]) ?? []).includes(i))) }],
    nodes,
    meshes: gltfMeshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
    ...(materials.length ? { materials } : {}),
    ...opts.extra,
  };
  return { json, bin };
}

export function toGlb(json: Record<string, unknown>, bin: Uint8Array | null): ArrayBuffer {
  const j = new TextEncoder().encode(JSON.stringify(json));
  const jPad = new Uint8Array(pad4(j.length)).fill(0x20);
  jPad.set(j);
  const binPad = bin ? new Uint8Array(pad4(bin.length)) : new Uint8Array(0);
  if (bin) binPad.set(bin);
  const total = 12 + 8 + jPad.length + (bin ? 8 + binPad.length : 0);
  const out = new ArrayBuffer(total);
  const dv = new DataView(out);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jPad.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, jPad.length).set(jPad);
  if (bin) {
    const o = 20 + jPad.length;
    dv.setUint32(o, binPad.length, true);
    dv.setUint32(o + 4, 0x004e4942, true);
    new Uint8Array(out, o + 8, binPad.length).set(binPad);
  }
  return out;
}

/** One-call .glb from meshes. */
export function meshGlb(meshes: MeshSpec | MeshSpec[], opts?: Parameters<typeof buildGltfParts>[1]): ArrayBuffer {
  const { json, bin } = buildGltfParts(Array.isArray(meshes) ? meshes : [meshes], opts);
  return toGlb(json, bin);
}

/** Self-contained .gltf (base64 buffer) as bytes. */
export function meshGltf(meshes: MeshSpec | MeshSpec[], opts?: Parameters<typeof buildGltfParts>[1]): ArrayBuffer {
  const { json, bin } = buildGltfParts(Array.isArray(meshes) ? meshes : [meshes], opts);
  let s = '';
  for (const b of bin) s += String.fromCharCode(b);
  (json.buffers as { uri?: string }[])[0].uri = `data:application/octet-stream;base64,${btoa(s)}`;
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function textBytes(text: string): ArrayBuffer {
  const b = new TextEncoder().encode(text);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/* ---- procedural meshes (right-handed, counter-clockwise, as glTF wants) ---- */

export function triangleMesh(): MeshSpec {
  return { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], uint16: true };
}

/** A square quad in the XY plane at depth z (CCW seen from +z), `half` wide. */
export function quadMesh(z: number, half: number, material?: Record<string, unknown>): MeshSpec {
  return {
    positions: [-half, -half, z, half, -half, z, half, half, z, -half, half, z],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 1, 1, 1, 1, 0, 0, 0],
    indices: [0, 1, 2, 0, 2, 3],
    uint16: true,
    material,
  };
}

/** Cube with 24 vertices (per-face normals and UVs). */
export function cubeMesh(half = 0.5, material?: Record<string, unknown>): MeshSpec {
  const faces: [number[], number[], number[]][] = [
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  faces.forEach(([n, u, v], f) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      for (let k = 0; k < 3; k++) positions.push((n[k] + u[k] * a + v[k] * b) * half);
      normals.push(...n);
      uvs.push((a + 1) / 2, 1 - (b + 1) / 2);
    }
    indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  return { positions, normals, uvs, indices, material };
}

export function uvSphereMesh(segments: number, rings: number, radius = 1, withNormals = true): MeshSpec {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let r = 0; r <= rings; r++) {
    const th = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const ph = (s / segments) * Math.PI * 2;
      const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
      positions.push(n[0] * radius, n[1] * radius, n[2] * radius);
      normals.push(...n);
      uvs.push(s / segments, r / rings);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b); // CCW seen from outside
    }
  }
  return { positions, normals: withNormals ? normals : undefined, uvs, indices };
}

export function torusMesh(major: number, minor: number, segments: number, sides: number): MeshSpec {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const u = (i / segments) * Math.PI * 2;
    for (let j = 0; j <= sides; j++) {
      const v = (j / sides) * Math.PI * 2;
      const n = [Math.cos(v) * Math.cos(u), Math.sin(v), Math.cos(v) * Math.sin(u)];
      positions.push((major + minor * Math.cos(v)) * Math.cos(u), minor * Math.sin(v), (major + minor * Math.cos(v)) * Math.sin(u));
      normals.push(...n);
    }
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const a = i * (sides + 1) + j;
      const b = a + sides + 1;
      indices.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  return { positions, normals, indices };
}

/** Wavefront OBJ text for an indexed triangle mesh (1-based, with vn when given). */
export function toObjText(m: MeshSpec): string {
  const lines: string[] = [];
  const p = m.positions;
  for (let i = 0; i < p.length; i += 3) lines.push(`v ${p[i]} ${p[i + 1]} ${p[i + 2]}`);
  if (m.uvs) for (let i = 0; i < m.uvs.length; i += 2) lines.push(`vt ${m.uvs[i]} ${m.uvs[i + 1]}`);
  if (m.normals) for (let i = 0; i < m.normals.length; i += 3) lines.push(`vn ${m.normals[i]} ${m.normals[i + 1]} ${m.normals[i + 2]}`);
  const idx = m.indices ?? Array.from({ length: p.length / 3 }, (_, i) => i);
  for (let i = 0; i < idx.length; i += 3) {
    const f = [0, 1, 2].map((k) => {
      const v = idx[i + k] + 1;
      return m.uvs && m.normals ? `${v}/${v}/${v}` : m.uvs ? `${v}/${v}` : m.normals ? `${v}//${v}` : `${v}`;
    });
    lines.push(`f ${f.join(' ')}`);
  }
  return lines.join('\n');
}
