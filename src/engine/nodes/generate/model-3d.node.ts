import { defineNode } from '../../define';
import { cameraBasis, PROJECTION_ID, simpleCamera } from '../../lib/gen-camera';
import { rgba, rotationZYX } from '../../lib/gen-common';
import { ModelError, type ParsedModel } from '../../lib/gen-model';
import { parseModelBytes } from '../../lib/gen-model-load';
import type { ImageValue } from '../../types';

/**
 * 3D Model: renders an imported glTF (.glb / self-contained .gltf) or .obj mesh with the same camera system and lighting
 * as `object-3d`. A real rasteriser (vertex + index buffers, 4x MSAA, depth buffer) runs through `ctx.gpu.device`.
 *
 * LIMITS (mentioned in the description too): up to 2,000,000 triangles / 4,000,000 vertices.
 *
 * CACHING. The engine caches node RESULTS, not buffers, and a node must stay stateless (rule 9). Parsing a model and
 * uploading it to the GPU are expensive and the inputs never change between frames, so two WeakMaps hold DERIVED,
 * IMMUTABLE data:
 *   parsed:  ArrayBuffer returned by Host.assetBytes  ->  ParsedModel (or the error it produced)
 *   gpuData: same ArrayBuffer -> GPUDevice -> vertex/index buffers
 * This is safe because (a) both are pure functions of the file bytes (same bytes, same result, so the cache can never
 * change what a render produces), (b) the host returns the SAME ArrayBuffer object for an asset until it is removed or
 * replaced (assumption stated by the host contract), so a changed file is a new key, and (c) entries die with the
 * ArrayBuffer (WeakMap), and GPU buffers die with their device: a recovered/replaced device is a different key, so a
 * lost device's buffers are never touched again. Nothing is released by hand.
 *
 * EXOTIC CAMERAS. Perspective and orthographic are exact. Fisheye, panoramic and cylindrical projections are applied per
 * VERTEX in the vertex shader, so straight triangle edges stay straight between vertices: dense meshes look right, huge
 * triangles distort, and a triangle straddling the panorama's back seam smears across the frame.
 */

const parsed = new WeakMap<ArrayBuffer, ParsedModel | { error: string }>();
interface GpuModel {
  vertex: GPUBuffer;
  index: GPUBuffer;
  wire: GPUBuffer | null;
}
const gpuData = new WeakMap<ArrayBuffer, WeakMap<GPUDevice, GpuModel>>();

interface Pipelines {
  cull: GPURenderPipeline;
  both: GPURenderPipeline;
  wire: GPURenderPipeline;
  frameLayout: GPUBindGroupLayout;
  matLayout: GPUBindGroupLayout;
  white: GPUTexture;
  nearest: GPUSampler;
  linear: GPUSampler;
}
const pipelines = new WeakMap<GPUDevice, Promise<Pipelines>>();

const MAX_MSAA_BYTES = 700 * 1024 * 1024;
const MAX_WIRE_TRIANGLES = 300_000;

const SHADER = /* wgsl */ `
const PI: f32 = 3.14159265358979;
struct Frame {
  model: mat4x4f,
  rot: mat4x4f,
  camPos: vec4f,    // xyz, w = projection id
  camRight: vec4f,  // xyz, w = tan(fov/2)
  camUp: vec4f,     // xyz, w = fov in radians
  camFwd: vec4f,    // xyz, w = ortho half size
  view: vec4f,      // short/width, short/height, 2*shiftX, 2*shiftY
  depth: vec4f,     // near, far, wire depth nudge, 0
  light: vec4f,     // xyz toward the light (world), w = ambient
  shade: vec4f,     // specular, gloss, cel bands (0 = smooth), shading (0 smooth, 1 flat, 2 unlit)
  tint: vec4f,      // rgb, a
  opts: vec4f,      // colour mode (0 model, 1 tint, 2 override), nearest texture, 0, 0
  wire: vec4f,
};
struct Mat { color: vec4f, info: vec4f };  // info: alphaMode (0 opaque, 1 cutout), cutoff, hasTexture, 0
@group(0) @binding(0) var<uniform> fr: Frame;
@group(0) @binding(1) var smpNearest: sampler;
@group(0) @binding(2) var smpLinear: sampler;
@group(1) @binding(0) var<uniform> mt: Mat;
@group(1) @binding(1) var baseTex: texture_2d<f32>;

struct VIn { @location(0) pos: vec3f, @location(1) nrm: vec3f, @location(2) uv: vec2f, @location(3) col: vec4f };
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) wpos: vec3f,
  @location(1) wnrm: vec3f,
  @location(2) uv: vec2f,
  @location(3) col: vec4f,
};

fn project(wp: vec3f) -> vec4f {
  let d = wp - fr.camPos.xyz;
  let v = vec3f(dot(d, fr.camRight.xyz), dot(d, fr.camUp.xyz), dot(d, fr.camFwd.xyz));
  let proj = i32(fr.camPos.w);
  let near = fr.depth.x; let far = fr.depth.y;
  let sw = fr.view.x; let sh = fr.view.y; let sx = fr.view.z; let sy = fr.view.w;
  let tanH = fr.camRight.w;
  if (proj == 1) {
    // perspective, with a real w so triangles behind the camera are clipped properly
    return vec4f((v.x / tanH + sx * v.z) * sw, (v.y / tanH + sy * v.z) * sh, far * (v.z - near) / (far - near), v.z);
  }
  if (proj == 0) {
    let h = fr.camFwd.w;
    return vec4f((v.x / h + sx) * sw, (v.y / h + sy) * sh, (v.z - near) / (far - near), 1.0);
  }
  // exotic lenses: per-vertex projection, depth = distance from the camera
  let l = max(length(v), 1e-6);
  let dir = v / l;
  var uf = vec2f(0.0);
  let z = clamp((l - near) / (far - near), 0.0, 1.0);
  if (proj == 2) {
    let th = acos(clamp(dir.z, -1.0, 1.0));
    let r = th / (fr.camUp.w * 0.5);
    let xy = v.xy;
    let xl = length(xy);
    var d2 = vec2f(0.0);
    if (xl > 1e-6) { d2 = xy / xl; }
    uf = d2 * r;
    return vec4f((uf.x + sx) * sw, (uf.y + sy) * sh, z, 1.0);
  }
  let lon = atan2(dir.x, dir.z);
  var ny = 0.0;
  if (proj == 3) {
    ny = asin(clamp(dir.y, -1.0, 1.0)) / (PI * 0.5);
  } else {
    let hr = max(length(dir.xz), 1e-6);
    ny = (dir.y / hr) / tan(clamp(fr.camUp.w * 0.5, 0.01, 1.5));
  }
  return vec4f(lon / PI + sx * sw, ny + sy * sh, z, 1.0);
}

fn transform(i: VIn) -> VOut {
  var o: VOut;
  let wp = (fr.model * vec4f(i.pos, 1.0)).xyz;
  o.wpos = wp;
  o.wnrm = normalize((fr.rot * vec4f(i.nrm, 0.0)).xyz);
  o.uv = i.uv;
  o.col = i.col;
  o.clip = project(wp);
  return o;
}
@vertex fn vs(i: VIn) -> VOut { return transform(i); }
@vertex fn vsWire(i: VIn) -> VOut {
  var o = transform(i);
  o.clip.z = o.clip.z - fr.depth.z * o.clip.w;
  return o;
}

fn toonLit(diff: f32) -> f32 {
  let st = fr.shade.z;
  if (st < 1.5) { return diff; }
  return min(floor(diff * st), st - 1.0) / (st - 1.0);
}

@fragment fn fs(i: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var base = mt.color * i.col;
  if (mt.info.z > 0.5) {
    var t = textureSampleLevel(baseTex, smpLinear, i.uv, 0.0);
    if (fr.opts.y > 0.5) { t = textureSampleLevel(baseTex, smpNearest, i.uv, 0.0); }
    var rgb = vec3f(0.0);
    if (t.a > 0.00001) { rgb = t.rgb / t.a; }
    base = base * vec4f(rgb, t.a);
  }
  let mode = i32(fr.opts.x);
  if (mode == 1) { base = base * fr.tint; }
  if (mode == 2) { base = vec4f(fr.tint.rgb, base.a * fr.tint.a); }
  if (mt.info.x > 0.5 && base.a < mt.info.y) { discard; }
  // opaque and cut-out materials are fully opaque; a tint / override colour may add transparency
  base.a = select(1.0, fr.tint.a, mode != 0);
  var col = base.rgb;
  let shading = i32(fr.shade.w);
  if (shading != 2) {
    var V = normalize(fr.camPos.xyz - i.wpos);
    if (i32(fr.camPos.w) == 0) { V = -fr.camFwd.xyz; }
    var n = normalize(i.wnrm);
    if (shading == 1) {
      n = normalize(cross(dpdx(i.wpos), dpdy(i.wpos)));
      if (dot(n, V) < 0.0) { n = -n; }
    } else if (!front) {
      n = -n;
    }
    let L = normalize(fr.light.xyz);
    let diff = max(dot(n, L), 0.0);
    let H = normalize(L + V);
    var s = pow(max(dot(n, H), 0.0), fr.shade.y) * select(1.0, 0.0, diff <= 0.0);
    if (fr.shade.z > 1.5) { s = step(0.55, s); }
    let lit = toonLit(diff);
    col = base.rgb * (fr.light.w + (1.0 - fr.light.w) * lit) + vec3f(fr.shade.x * s);
  }
  col = clamp(col, vec3f(0.0), vec3f(1.0));
  return vec4f(col * base.a, base.a);
}
@fragment fn fsWire() -> @location(0) vec4f { return vec4f(fr.wire.rgb * fr.wire.a, fr.wire.a); }
`;

function getPipelines(device: GPUDevice): Promise<Pipelines> {
  let p = pipelines.get(device);
  if (!p) {
    p = (async () => {
      const module = device.createShaderModule({ label: 'model-3d', code: SHADER });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) throw new Error(`model-3d shader failed to compile: ${errors.map((e) => `line ${e.lineNum}: ${e.message}`).join('; ')}`);
      const frameLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
      });
      const matLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        ],
      });
      const layout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, matLayout] });
      const buffers: GPUVertexBufferLayout[] = [
        {
          arrayStride: 36,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x2' },
            { shaderLocation: 3, offset: 32, format: 'unorm8x4' },
          ],
        },
      ];
      const depthStencil: GPUDepthStencilState = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' };
      const make = (cull: GPUCullMode, wire: boolean) =>
        device.createRenderPipeline({
          label: wire ? 'model-3d wire' : `model-3d ${cull}`,
          layout,
          vertex: { module, entryPoint: wire ? 'vsWire' : 'vs', buffers },
          fragment: { module, entryPoint: wire ? 'fsWire' : 'fs', targets: [{ format: 'rgba8unorm' }] },
          primitive: { topology: wire ? 'line-list' : 'triangle-list', frontFace: 'ccw', cullMode: wire ? 'none' : cull },
          depthStencil: wire ? { ...depthStencil, depthWriteEnabled: false } : depthStencil,
          multisample: { count: 4 },
        });
      const white = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
      return {
        cull: make('back', false),
        both: make('none', false),
        wire: make('none', true),
        frameLayout,
        matLayout,
        white,
        nearest: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'repeat', addressModeV: 'repeat' }),
        linear: device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' }),
      };
    })();
    pipelines.set(device, p);
    p.catch(() => pipelines.delete(device));
  }
  return p;
}

function uploadModel(device: GPUDevice, key: ArrayBuffer, m: ParsedModel, wantWire: boolean): GpuModel {
  let perDevice = gpuData.get(key);
  if (!perDevice) gpuData.set(key, (perDevice = new WeakMap()));
  let g = perDevice.get(device);
  if (!g) {
    const vBytes = m.vertexCount * 36;
    const iBytes = m.indices.length * 4;
    if (vBytes > device.limits.maxBufferSize || iBytes > device.limits.maxBufferSize) {
      throw new Error(`This model needs ${Math.round(Math.max(vBytes, iBytes) / 1048576)} MB in one GPU buffer, more than this graphics card allows. Reduce its size in your 3D tool.`);
    }
    const vertex = device.createBuffer({ label: 'model-3d vertices', size: vBytes, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
    const f = new Float32Array(vertex.getMappedRange());
    const u = new Uint32Array(f.buffer);
    for (let i = 0; i < m.vertexCount; i++) {
      const o = i * 9;
      f[o] = m.positions[i * 3];
      f[o + 1] = m.positions[i * 3 + 1];
      f[o + 2] = m.positions[i * 3 + 2];
      f[o + 3] = m.normals[i * 3];
      f[o + 4] = m.normals[i * 3 + 1];
      f[o + 5] = m.normals[i * 3 + 2];
      f[o + 6] = m.uvs[i * 2];
      f[o + 7] = m.uvs[i * 2 + 1];
      u[o + 8] = (m.colors[i * 4] | (m.colors[i * 4 + 1] << 8) | (m.colors[i * 4 + 2] << 16) | (m.colors[i * 4 + 3] << 24)) >>> 0;
    }
    vertex.unmap();
    const index = device.createBuffer({ label: 'model-3d indices', size: Math.max(16, iBytes), usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
    new Uint32Array(index.getMappedRange()).set(m.indices);
    index.unmap();
    g = { vertex, index, wire: null };
    perDevice.set(device, g);
  }
  if (wantWire && !g.wire) {
    if (m.triangleCount > MAX_WIRE_TRIANGLES) {
      throw new Error(`Wireframe is limited to ${MAX_WIRE_TRIANGLES.toLocaleString('en-US')} triangles; this model has ${m.triangleCount.toLocaleString('en-US')}. Turn Wireframe off.`);
    }
    const edges = new Uint32Array(m.indices.length * 2);
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
      edges.set([a, b, b, c, c, a], t * 2);
    }
    const wire = device.createBuffer({ label: 'model-3d wire', size: edges.byteLength, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
    new Uint32Array(wire.getMappedRange()).set(edges);
    wire.unmap();
    g.wire = wire;
  }
  return g;
}

function mat4(m: number[][]): number[] {
  // column-major from rows
  const o: number[] = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o.push(m[r][c]);
  return o;
}

export default defineNode({
  id: 'model-3d',
  title: '3D Model',
  category: 'generate',
  description:
    'Renders an imported 3D model (.glb, self-contained .gltf, or .obj) with the same cameras and lighting as the 3D Object node. Up to 2 million triangles; Draco/meshopt-compressed and multi-file .gltf are not supported (export as .glb). Skins and animations are ignored.',
  keywords: ['glb', 'gltf', 'obj', 'mesh', 'import', 'model', '3d', 'low poly', 'render', 'wavefront'],
  inputs: {
    size: { type: 'image', label: 'Size from' },
    camera: { type: 'camera', label: 'Camera' },
    texture: { type: 'image', label: 'Texture' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    model: { type: 'assets', default: [], accept: 'model', label: '3D model', hint: 'A .glb, .gltf or .obj file. With several files, each batch item uses its own.' },
    autoFit: { type: 'bool', default: true, label: 'Fit to view', hint: 'Centre the model and scale it to fill the same space as the 3D Object shapes.', group: 'Object' },
    posX: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, label: 'Move X', group: 'Object', hint: 'Scene units.' },
    posY: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, label: 'Move Y (up)', group: 'Object' },
    posZ: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, label: 'Move Z (away)', group: 'Object' },
    objectScale: { type: 'number', default: 1, min: 0.01, max: 20, step: 0.01, label: 'Model scale', group: 'Object' },
    rotX: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate X (tilt)', group: 'Rotation' },
    rotY: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate Y (turn)', group: 'Rotation' },
    rotZ: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate Z (roll)', group: 'Rotation' },
    spinX: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin X (turns per loop)', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
    spinY: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin Y (turns per loop)', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
    spinZ: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin Z (turns per loop)', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
    shading: {
      type: 'enum',
      default: 'smooth',
      label: 'Shading',
      group: 'Look',
      options: [
        { value: 'smooth', label: 'Smooth' },
        { value: 'flat', label: 'Flat (faceted, low-poly look)' },
        { value: 'unlit', label: 'Unlit (colours only)' },
      ],
    },
    colorMode: {
      type: 'enum',
      default: 'model',
      label: 'Colour',
      group: 'Look',
      options: [
        { value: 'model', label: 'As in the file' },
        { value: 'tint', label: 'Tint the file’s colours' },
        { value: 'override', label: 'One flat colour' },
      ],
    },
    baseColor: { type: 'color', default: [0.8, 0.8, 0.85, 1], label: 'Tint / colour', group: 'Look', visibleIf: (p) => p.colorMode !== 'model' },
    nearestTexture: { type: 'bool', default: false, label: 'Crisp texture (no smoothing)', group: 'Look', hint: 'Nearest-neighbour texture sampling, for pixel-art textures.' },
    backFaces: { type: 'bool', default: false, label: 'Show back faces', group: 'Look', hint: 'Draw both sides of every triangle, not only the ones the file marks double-sided.' },
    wireframe: { type: 'bool', default: false, label: 'Wireframe overlay', group: 'Look', hint: 'Limited to 300,000 triangles.' },
    wireColor: { type: 'color', default: [0, 0, 0, 0.6], label: 'Wireframe colour', group: 'Look', visibleIf: (p) => p.wireframe === true },
    cameraType: {
      type: 'enum',
      default: 'perspective',
      label: 'Built-in camera',
      group: 'Built-in camera',
      options: [
        { value: 'perspective', label: 'Perspective' },
        { value: 'orthographic', label: 'Orthographic (flat)' },
      ],
    },
    fov: { type: 'number', default: 30, min: 5, max: 90, step: 1, unit: 'deg', label: 'Perspective strength', group: 'Built-in camera', visibleIf: (p) => p.cameraType === 'perspective' },
    x: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Frame position X (built-in camera)', group: 'Built-in camera', hint: 'Ignored when a Camera is wired in.' },
    y: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Frame position Y (built-in camera)', group: 'Built-in camera' },
    scale: { type: 'number', default: 0.6, min: 0.02, max: 3, step: 0.005, unit: 'norm', label: 'Size in frame (built-in camera)', group: 'Built-in camera', hint: 'Fraction of the frame’s shorter side. Ignored when a Camera is wired in.' },
    lightAzimuth: { type: 'number', default: -35, min: -180, max: 180, step: 1, unit: 'deg', label: 'Light from (left/right)', group: 'Lighting' },
    lightElevation: { type: 'number', default: 40, min: -90, max: 90, step: 1, unit: 'deg', label: 'Light height', group: 'Lighting' },
    ambient: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Ambient light', group: 'Lighting' },
    specular: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Shininess', group: 'Lighting' },
    gloss: { type: 'number', default: 32, min: 2, max: 256, step: 1, label: 'Highlight tightness', group: 'Lighting' },
    cel: { type: 'bool', default: false, label: 'Flat (cel) shading', group: 'Lighting', hint: 'Posterises the light into a few flat bands. Great for pixel art.' },
    celSteps: { type: 'number', default: 3, min: 2, max: 8, step: 1, integer: true, label: 'Shading bands', group: 'Lighting', visibleIf: (p) => p.cel === true },
  },
  summary: (p) => (p.model.length === 0 ? 'no model chosen' : `${p.model.length === 1 ? '1 model' : `${p.model.length} models`} · ${p.shading}${p.cel ? ` · ${p.celSteps}-band cel` : ''}`),
  async render(ctx) {
    const p = ctx.params;
    const size = ctx.in.size ?? ctx.canvas;
    const out = ctx.gpu.alloc(size.width, size.height, size.unit ?? 1);
    const device = ctx.gpu.device;
    const W = out.width;
    const H = out.height;

    const clearOnly = () => {
      const enc = device.createCommandEncoder();
      enc.beginRenderPass({ colorAttachments: [{ view: out.texture.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end();
      device.queue.submit([enc.finish()]);
      return { image: out };
    };
    if (!p.model.length) return clearOnly();
    const assetId = p.model[ctx.item.index % p.model.length];
    if (!ctx.host.assetBytes) throw new Error('This app build cannot load 3D model files (the host has no assetBytes).');
    const bytes = await ctx.host.assetBytes(assetId);
    if (!bytes) throw new Error('The 3D model file is missing. Choose it again in the 3D Model node.');

    let model = parsed.get(bytes);
    if (!model) {
      try {
        model = parseModelBytes(bytes);
      } catch (e) {
        model = { error: e instanceof ModelError ? e.message : `Could not read this 3D model: ${e instanceof Error ? e.message : String(e)}` };
      }
      parsed.set(bytes, model);
    }
    if ('error' in model) throw new Error(model.error);

    if (W > device.limits.maxTextureDimension2D || H > device.limits.maxTextureDimension2D || W * H * 4 * 8 > MAX_MSAA_BYTES) {
      throw new Error(`The output (${W}x${H}) is too large to render a 3D model with anti-aliasing. Use a smaller frame.`);
    }

    // --- transforms -----------------------------------------------------
    const spinning = p.spinX !== 0 || p.spinY !== 0 || p.spinZ !== 0;
    const phase = spinning ? ctx.time.phase : 0;
    const R = rotationZYX(p.rotX + 360 * p.spinX * phase, p.rotY + 360 * p.spinY * phase, p.rotZ + 360 * p.spinZ * phase);
    const { min, max } = model.bounds;
    const bc = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = 0.5 * Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
    const fit = p.autoFit ? 0.95 / radius : 1;
    const s = fit * p.objectScale;
    const c = p.autoFit ? bc : [0, 0, 0];
    // world = T(pos) * R * S(s) * T(-c)
    const rows = [0, 1, 2].map((r) => [R[r * 3] * s, R[r * 3 + 1] * s, R[r * 3 + 2] * s]);
    const t = [0, 1, 2].map((r) => [p.posX, p.posY, p.posZ][r] - (rows[r][0] * c[0] + rows[r][1] * c[1] + rows[r][2] * c[2]));
    const modelM = mat4([[...rows[0], t[0]], [...rows[1], t[1]], [...rows[2], t[2]], [0, 0, 0, 1]]);
    const rotM = mat4([[R[0], R[1], R[2], 0], [R[3], R[4], R[5], 0], [R[6], R[7], R[8], 0], [0, 0, 0, 1]]);
    const centerW = [0, 1, 2].map((r) => [p.posX, p.posY, p.posZ][r] + rows[r][0] * (bc[0] - c[0]) + rows[r][1] * (bc[1] - c[1]) + rows[r][2] * (bc[2] - c[2]));
    const radiusW = radius * s;

    // --- camera ---------------------------------------------------------
    const cam = ctx.in.camera ?? simpleCamera({ ortho: p.cameraType === 'orthographic', fovDeg: p.fov, frameSize: p.scale, x: p.x, y: p.y, width: W, height: H });
    const basis = cameraBasis(cam);
    const dist = Math.hypot(basis.position[0] - centerW[0], basis.position[1] - centerW[1], basis.position[2] - centerW[2]);
    const reach = radiusW * 1.15;
    const exotic = cam.projection !== 'perspective' && cam.projection !== 'orthographic';
    const near = cam.projection === 'perspective' ? Math.max(dist - reach, dist * 0.002, 1e-4) : exotic ? Math.max(dist - reach, 0) : dist - reach;
    const far = Math.max(dist + reach, near + 1e-3);
    const short = Math.min(W, H);
    const az = (p.lightAzimuth * Math.PI) / 180;
    const el = (p.lightElevation * Math.PI) / 180;
    const light = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
    const mode = { model: 0, tint: 1, override: 2 }[p.colorMode as 'model'] ?? 0;
    const frame = new Float32Array([
      ...modelM,
      ...rotM,
      ...basis.position, PROJECTION_ID[cam.projection] ?? 1,
      ...basis.right, Math.tan((Math.min(cam.projection === 'fisheye' ? 359 : 179, Math.max(1, cam.fov)) * Math.PI) / 360),
      ...basis.up, (Math.min(360, Math.max(1, cam.fov)) * Math.PI) / 180,
      ...basis.forward, Math.max(0.001, cam.orthoSize) / 2,
      short / W, short / H, cam.shift[0] * 2, cam.shift[1] * 2,
      near, far, 0.0004, 0,
      ...light, p.ambient,
      p.specular, p.gloss, p.cel ? Math.max(2, Math.round(p.celSteps)) : 0, { smooth: 0, flat: 1, unlit: 2 }[p.shading as 'smooth'] ?? 0,
      ...rgba(p.baseColor),
      mode, p.nearestTexture ? 1 : 0, 0, 0,
      ...rgba(p.wireColor),
    ]);

    // --- GPU resources ----------------------------------------------------
    const pl = await getPipelines(device);
    const gm = uploadModel(device, bytes, model, p.wireframe);
    const frameBuf = device.createBuffer({ size: frame.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(frameBuf, 0, frame);
    const frameBind = device.createBindGroup({
      layout: pl.frameLayout,
      entries: [
        { binding: 0, resource: { buffer: frameBuf } },
        { binding: 1, resource: pl.nearest },
        { binding: 2, resource: pl.linear },
      ],
    });
    const override = ctx.in.texture as ImageValue | null;
    const temp: GPUBuffer[] = [frameBuf];
    const matBinds: GPUBindGroup[] = [];
    for (const mat of model.materials) {
      let tex: GPUTexture | null = override ? override.texture : null;
      if (!tex && mat.texture && ctx.host.decodeImageBytes) {
        // the host caches decoded textures per ArrayBuffer object (stable slice kept in the parsed model)
        tex = (await ctx.host.decodeImageBytes(mat.texture.data, mat.texture.mime))?.texture ?? null;
      }
      const ub = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(ub, 0, new Float32Array([...mat.baseColor, mat.alphaMode === 'opaque' ? 0 : 1, mat.alphaCutoff, tex ? 1 : 0, 0]));
      temp.push(ub);
      matBinds.push(
        device.createBindGroup({
          layout: pl.matLayout,
          entries: [
            { binding: 0, resource: { buffer: ub } },
            { binding: 1, resource: (tex ?? pl.white).createView() },
          ],
        }),
      );
    }

    const msaa = device.createTexture({ size: [W, H], format: 'rgba8unorm', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const depth = device.createTexture({ size: [W, H], format: 'depth24plus', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const enc = device.createCommandEncoder({ label: 'model-3d' });
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: msaa.createView(), resolveTarget: out.texture.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 0] }],
      depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    rp.setBindGroup(0, frameBind);
    rp.setVertexBuffer(0, gm.vertex);
    rp.setIndexBuffer(gm.index, 'uint32');
    for (const g of model.groups) {
      const mat = model.materials[g.material];
      rp.setPipeline(mat.doubleSided || p.backFaces ? pl.both : pl.cull);
      rp.setBindGroup(1, matBinds[g.material]);
      rp.drawIndexed(g.count, 1, g.start);
    }
    if (p.wireframe && gm.wire) {
      rp.setPipeline(pl.wire);
      rp.setBindGroup(1, matBinds[0]);
      rp.setIndexBuffer(gm.wire, 'uint32');
      rp.drawIndexed(model.indices.length * 2);
    }
    rp.end();
    device.queue.submit([enc.finish()]);
    msaa.destroy();
    depth.destroy();
    for (const b of temp) b.destroy();
    return { image: out };
  },
});
