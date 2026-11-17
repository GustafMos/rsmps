import { describe, expect, it } from 'vitest';
import { MSG_COMPRESSED, MSG_EXTERNAL, parseGltf } from './gen-gltf';
import { ModelError, checkLimits, computeNormals } from './gen-model';
import { parseModelBytes } from './gen-model-load';
import { parseObj } from './gen-obj';
import { buildGltfParts, cubeMesh, meshGlb, meshGltf, quadMesh, textBytes, toGlb, toObjText, triangleMesh, uvSphereMesh } from './gen-model-testutil';

const close = (a: ArrayLike<number>, b: number[], eps = 1e-5) => b.forEach((v, i) => expect(Math.abs(a[i] - v)).toBeLessThan(eps));
const err = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ModelError);
    return (e as Error).message;
  }
  return '';
};

describe('glTF loader', () => {
  it('reads a single triangle from a .glb (engine space mirrors z, normals computed)', () => {
    const m = parseGltf(meshGlb(triangleMesh()));
    expect(m.vertexCount).toBe(3);
    expect(m.triangleCount).toBe(1);
    close(m.positions, [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    // computed normal of a CCW triangle in the XY plane is +z in glTF space, so -z in engine space
    close(m.normals, [0, 0, -1, 0, 0, -1, 0, 0, -1]);
    expect(Array.from(m.indices)).toEqual([0, 1, 2]);
    expect(m.materials.length).toBe(1);
    expect(m.groups).toEqual([{ start: 0, count: 3, material: 0 }]);
  });

  it('reads a cube with normals and UVs; both .glb and base64 .gltf agree', () => {
    const glb = parseGltf(meshGlb(cubeMesh(0.5)));
    const gltf = parseGltf(meshGltf(cubeMesh(0.5)));
    for (const m of [glb, gltf]) {
      expect(m.vertexCount).toBe(24);
      expect(m.triangleCount).toBe(12);
      expect(m.hasUVs).toBe(true);
      expect(m.bounds.min).toEqual([-0.5, -0.5, -0.5]);
      expect(m.bounds.max).toEqual([0.5, 0.5, 0.5]);
    }
    expect(Array.from(glb.positions)).toEqual(Array.from(gltf.positions));
    expect(Array.from(glb.uvs)).toEqual(Array.from(gltf.uvs));
    // the +z face (glTF) has normal (0,0,1) -> engine (0,0,-1)
    close(glb.normals.subarray(0, 3), [0, 0, -1]);
  });

  it('applies node transforms: translation / rotation / scale, nested, and matrix form', () => {
    const s = Math.SQRT1_2;
    const { json, bin } = buildGltfParts([triangleMesh()], {
      nodes: [
        { children: [1], translation: [10, 0, 0] },
        { mesh: 0, rotation: [0, s, 0, s], scale: [2, 2, 2] }, // 90 degrees about Y, doubled
      ],
      sceneNodes: [0],
    });
    const m = parseGltf(toGlb(json, bin));
    // glTF-space vertex (1,0,0): scale 2 -> (2,0,0); rotate 90deg about Y -> (0,0,-2); translate -> (10,0,-2); engine mirrors z -> (10,0,2)
    close(m.positions.subarray(3, 6), [10, 0, 2], 1e-5);
    close(m.positions.subarray(6, 9), [10, 2, 0], 1e-5);
    const mat = buildGltfParts([triangleMesh()], { nodes: [{ mesh: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1] }] });
    const m2 = parseGltf(toGlb(mat.json, mat.bin));
    close(m2.positions.subarray(0, 3), [5, 6, -7]);
  });

  it('a mirroring node (negative scale) keeps triangles counter-clockwise', () => {
    const { json, bin } = buildGltfParts([triangleMesh()], { nodes: [{ mesh: 0, scale: [-1, 1, 1] }] });
    const m = parseGltf(toGlb(json, bin));
    expect(Array.from(m.indices)).toEqual([0, 2, 1]);
    close(m.normals.subarray(0, 3), [0, 0, -1]); // still faces the viewer
  });

  it('computes smooth normals when missing (sphere: normal points outward)', () => {
    const m = parseGltf(meshGlb(uvSphereMesh(16, 8, 1, false)));
    for (let i = 0; i < m.vertexCount; i += 7) {
      const p = m.positions.subarray(i * 3, i * 3 + 3);
      const n = m.normals.subarray(i * 3, i * 3 + 3);
      const l = Math.hypot(p[0], p[1], p[2]);
      if (l < 0.2) continue;
      expect(p[0] * n[0] + p[1] * n[1] + p[2] * n[2]).toBeGreaterThan(0.9 * l);
    }
  });

  it('converts triangle strips and fans, and non-indexed meshes', () => {
    const quad = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0];
    const strip = parseGltf(meshGlb({ positions: quad, mode: 5 }));
    expect(strip.triangleCount).toBe(2);
    expect(Array.from(strip.indices)).toEqual([0, 1, 2, 2, 1, 3]);
    const fan = parseGltf(meshGlb({ positions: quad, mode: 6 }));
    expect(Array.from(fan.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    const plain = parseGltf(meshGlb({ positions: quad.slice(0, 9) }));
    expect(Array.from(plain.indices)).toEqual([0, 1, 2]);
  });

  it('reads normalised colours, interleaved (byteStride) data and sparse accessors', () => {
    // hand-built: one buffer view with stride 16 holding POSITION (12 bytes) + 4 unsigned-byte colour bytes
    const verts = 3;
    const bin = new Uint8Array(16 * verts);
    const dv = new DataView(bin.buffer);
    const pos = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    for (let i = 0; i < verts; i++) {
      for (let k = 0; k < 3; k++) dv.setFloat32(i * 16 + k * 4, pos[i * 3 + k], true);
      bin.set([255, 0, 0, 255], i * 16 + 12);
    }
    const json = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 } }] }],
      accessors: [
        { bufferView: 0, componentType: 5126, count: verts, type: 'VEC3' },
        { bufferView: 0, byteOffset: 12, componentType: 5121, normalized: true, count: verts, type: 'VEC4' },
      ],
      bufferViews: [{ buffer: 0, byteLength: bin.length, byteStride: 16 }],
      buffers: [{ byteLength: bin.length }],
    };
    const m = parseGltf(toGlb(json, bin));
    expect(m.hasColors).toBe(true);
    expect(Array.from(m.colors.subarray(0, 4))).toEqual([255, 0, 0, 255]);
    close(m.positions, [0, 0, 0, 1, 0, 0, 0, 1, 0]);

    // sparse accessor: base all zeros, one element overridden
    const sbin = new Uint8Array(4 + 12);
    new DataView(sbin.buffer).setUint16(0, 1, true); // sparse index 1
    new DataView(sbin.buffer).setFloat32(4, 5, true);
    new DataView(sbin.buffer).setFloat32(8, 6, true);
    new DataView(sbin.buffer).setFloat32(12, 7, true);
    const sparse = {
      asset: { version: '2.0' },
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ componentType: 5126, count: 3, type: 'VEC3', sparse: { count: 1, indices: { bufferView: 0, componentType: 5123 }, values: { bufferView: 1 } } }],
      bufferViews: [{ buffer: 0, byteLength: 2 }, { buffer: 0, byteOffset: 4, byteLength: 12 }],
      buffers: [{ byteLength: sbin.length }],
    };
    close(parseGltf(toGlb(sparse, sbin)).positions, [0, 0, 0, 5, 6, -7, 0, 0, 0]);
  });

  it('reads materials: factor (linear to sRGB), double sided, alpha modes, embedded texture bytes', () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const { json, bin } = buildGltfParts([quadMesh(0, 1, { pbrMetallicRoughness: { baseColorFactor: [0.2, 0.2, 0.2, 0.5], baseColorTexture: { index: 0 } }, doubleSided: true, alphaMode: 'BLEND' })]);
    // append the image as an extra buffer view
    const joined = new Uint8Array(bin.length + 8);
    joined.set(bin);
    joined.set(png, bin.length);
    json.bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: 8 });
    json.buffers[0].byteLength = joined.length;
    json.images = [{ bufferView: json.bufferViews.length - 1, mimeType: 'image/png' }];
    json.textures = [{ source: 0 }];
    const m = parseGltf(toGlb(json, joined));
    const mat = m.materials[0];
    expect(mat.doubleSided).toBe(true);
    expect(mat.alphaMode).toBe('blend');
    expect(mat.baseColor[0]).toBeCloseTo(0.4845, 3); // 0.2 linear = 0.4845 sRGB
    expect(mat.baseColor[3]).toBe(0.5);
    expect(mat.texture?.mime).toBe('image/png');
    expect(Array.from(new Uint8Array(mat.texture!.data))).toEqual(Array.from(png));
    expect(m.notes.join(' ')).toMatch(/cut-outs/);
  });

  it('groups triangles by material', () => {
    const m = parseGltf(meshGlb([quadMesh(0, 1, { doubleSided: false }), quadMesh(1, 1, { doubleSided: true })]));
    expect(m.groups.length).toBe(2);
    expect(m.groups.map((g) => g.count)).toEqual([6, 6]);
    expect(m.materials[1].doubleSided).toBe(true);
  });

  it('rejects unsupported files with clear messages', () => {
    const external = { asset: { version: '2.0' }, nodes: [], buffers: [{ uri: 'model.bin', byteLength: 10 }] };
    expect(err(() => parseGltf(textBytes(JSON.stringify(external))))).toBe(MSG_EXTERNAL);
    const draco = { asset: { version: '2.0' }, extensionsRequired: ['KHR_draco_mesh_compression'], extensionsUsed: ['KHR_draco_mesh_compression'] };
    expect(err(() => parseGltf(textBytes(JSON.stringify(draco))))).toBe(MSG_COMPRESSED);
    expect(MSG_COMPRESSED).toMatch(/re-export it without Draco\/meshopt compression/i);
    const meshopt = { asset: { version: '2.0' }, extensionsUsed: ['EXT_meshopt_compression'] };
    expect(err(() => parseGltf(textBytes(JSON.stringify(meshopt))))).toBe(MSG_COMPRESSED);
    expect(err(() => parseGltf(textBytes(JSON.stringify({ asset: { version: '1.0' } }))))).toMatch(/only glTF 2.0/);
    expect(err(() => parseGltf(textBytes('not json')))).toMatch(/not a valid glTF/);
    const glb = new Uint8Array(meshGlb(triangleMesh()));
    new DataView(glb.buffer).setUint32(4, 1, true);
    expect(err(() => parseGltf(glb.buffer))).toMatch(/Unsupported glTF version 1/);
    expect(err(() => parseGltf(meshGlb({ positions: [0, 0, 0], mode: 0 })))).toMatch(/no triangle meshes/);
    // an index past the vertex data
    expect(err(() => parseGltf(meshGlb({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 9], uint16: true })))).toMatch(/index points past/);
  });

  it('notes animations / skins / morph targets without failing', () => {
    const { json, bin } = buildGltfParts([triangleMesh()]);
    json.animations = [{ channels: [], samplers: [] }];
    json.nodes[0].skin = 0;
    const m = parseGltf(toGlb(json, bin));
    expect(m.notes.join(' ')).toMatch(/Animations are ignored/);
    expect(m.notes.join(' ')).toMatch(/rest pose/);
  });

  it('enforces the triangle and vertex limits with a readable message', () => {
    expect(() => checkLimits(10, 2_000_000)).not.toThrow();
    expect(err(() => checkLimits(10, 2_000_001))).toMatch(/2,000,001 triangles; the limit is 2,000,000/);
    expect(err(() => checkLimits(4_000_001, 10))).toMatch(/vertices; the limit is 4,000,000/);
  });
});

describe('OBJ loader', () => {
  it('reads v/vt/vn faces, triangulates quads, flips v, mirrors z', () => {
    const obj = ['# a quad', 'v 0 0 0', 'v 1 0 0', 'v 1 1 0', 'v 0 1 0', 'vt 0 0', 'vt 1 0', 'vt 1 1', 'vt 0 1', 'vn 0 0 1', 'f 1/1/1 2/2/1 3/3/1 4/4/1'].join('\n');
    const m = parseObj(textBytes(obj));
    expect(m.vertexCount).toBe(4);
    expect(m.triangleCount).toBe(2);
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(m.hasUVs).toBe(true);
    close(m.uvs.subarray(0, 2), [0, 1]); // v flipped
    close(m.normals.subarray(0, 3), [0, 0, -1]);
    expect(m.materials.length).toBe(1);
  });

  it('supports negative indices and v//vn and plain v forms; computes missing normals', () => {
    const neg = parseObj(textBytes('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1'));
    expect(neg.triangleCount).toBe(1);
    close(neg.normals.subarray(0, 3), [0, 0, -1]);
    const vn = parseObj(textBytes('v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 1 0\nf 1//1 2//1 3//1'));
    close(vn.normals.subarray(0, 3), [0, 1, 0]);
    expect(vn.hasUVs).toBe(false);
  });

  it('round-trips a sphere through toObjText', () => {
    const m = parseObj(textBytes(toObjText(uvSphereMesh(12, 6, 1))));
    expect(m.triangleCount).toBe(12 * 6 * 2);
    expect(m.bounds.max[1]).toBeCloseTo(1, 5);
  });

  it('rejects broken files', () => {
    expect(err(() => parseObj(textBytes('v 0 0 0')))).toMatch(/no faces/);
    expect(err(() => parseObj(textBytes('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 7')))).toMatch(/missing vertex/);
  });
});

describe('format detection', () => {
  it('picks the loader from the bytes', () => {
    expect(parseModelBytes(meshGlb(triangleMesh())).triangleCount).toBe(1);
    expect(parseModelBytes(meshGltf(triangleMesh())).triangleCount).toBe(1);
    expect(parseModelBytes(textBytes('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3')).triangleCount).toBe(1);
    expect(err(() => parseModelBytes(new Uint8Array([1, 2]).buffer))).toMatch(/too small/);
    expect(err(() => parseModelBytes(new Uint8Array([0, 1, 2, 3, 4, 5]).buffer))).toMatch(/Unrecognized 3D file/);
  });
  it('computeNormals welds duplicate positions', () => {
    // two triangles sharing positions but not vertex ids: the shared edge gets one blended normal
    const p = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1]);
    const n = computeNormals(p, [0, 1, 2, 3, 4, 5]);
    expect(Array.from(n.subarray(0, 3))).toEqual(Array.from(n.subarray(9, 12)));
  });
});
