import { cameraBasis, PROJECTION_ID, simpleCamera } from './gen-camera';
import { rgba, rotationZYX } from './gen-common';
import { ModelError, type ParsedModel } from './gen-model';
import { parseModelBytes } from './gen-model-load';
import { PRELUDE } from '../gpu/prelude';
import { deformUniforms, type DeformFeat, type DeformP, deformFeatures } from './gen-deform';
import { materialKey, materialRasterData, materialRasterGroup, materialRasterLayout, materialRasterWgsl, MATERIAL_RASTER_BYTES } from './gen-material';
import type { CameraValue, Host, ImageValue, MaterialValue, NodeGpu, TimeInfo } from '../types';

/**
 * 3D Model: renders an imported glTF (.glb / self-contained .gltf) or .obj mesh with the same camera system and lighting
 * as `object-3d`. A real rasteriser (vertex + index buffers, 4x MSAA, depth buffer) runs through `ctx.gpu.device`.
 *
 * LIMITS (mentioned in the description too): up to 2,000,000 triangles / 4,000,000 vertices.
 *
 * CACHING. The engine caches node RESULTS, not buffers, and a node must stay stateless (rule 9). Parsing a model and
 * uploading it to the GPU are expensive and the inputs never change between frames, so two WeakMaps hold DERIVED,
 * IMMUTABLE data:
 *   parsed:  ArrayBuffer returned by Host.assetBytes  ->  ParsedModel (or the error it produced)   (WeakMap: CPU memory only)
 *   gpuData: same ArrayBuffer -> vertex/index buffers (a small LRU of at most MAX_GPU_MODELS models / MAX_GPU_MODEL_BYTES)
 * This is safe because (a) both are pure functions of the file bytes (same bytes, same result, so the cache can never
 * change what a render produces) and (b) the host returns the SAME ArrayBuffer object for an asset until it is removed or
 * replaced (assumption stated by the host contract), so a changed file is a new key. GPU buffers are created through
 * ctx.gpu.createBuffer (counted in gpu.stats()) and DESTROYED when a model falls out of the LRU or its device is replaced:
 * nothing waits for garbage collection (Firefox frees the GPU memory behind a dropped wrapper only when it collects it).
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
interface CachedModel extends GpuModel {
  device: GPUDevice;
  gpu: NodeGpu;
  bytes: number;
}
const gpuData = new Map<ArrayBuffer, CachedModel>();
const MAX_GPU_MODELS = 3;
const MAX_GPU_MODEL_BYTES = 384 * 1024 * 1024;

function destroyModel(m: CachedModel): void {
  for (const b of [m.vertex, m.index, m.wire]) if (b) m.gpu.destroyBuffer(b);
}

/** Drop the least recently used models until the cache fits (never keep). */
function trimModels(keep: ArrayBuffer | null): void {
  let total = 0;
  for (const m of gpuData.values()) total += m.bytes;
  for (const [k, m] of [...gpuData]) {
    if (gpuData.size <= MAX_GPU_MODELS && total <= MAX_GPU_MODEL_BYTES) break;
    if (k === keep) continue;
    total -= m.bytes;
    destroyModel(m);
    gpuData.delete(k);
  }
}

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
${PRELUDE}
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
  dfOrg: vec4f,     // deform: object position, object scale
  dfFit: vec4f,     // deform: model centre, fit scale
  dfA: vec4f,       // noise amount, noise scale, noise angle, picture amount
  dfB: vec4f,       // inflate, twist (rad per unit), bend, taper
  dfC: vec4f,       // morph, melt, explode, low-fi grid (cells across the screen, 0 = off)
  dfFlags: vec4f,   // bit set of the compiled-in features (0 = no deform at all)
  objc: vec4f,      // object centre in the world (xyz) and object scale (w): the object-space frame of materials
};
struct Mat { color: vec4f, info: vec4f };  // info: alphaMode (0 opaque, 1 cutout), cutoff, hasTexture, has UV coordinates
@group(0) @binding(0) var<uniform> fr: Frame;
@group(0) @binding(1) var smpNearest: sampler;
@group(0) @binding(2) var smpLinear: sampler;
@group(0) @binding(3) var dmap: texture_2d<f32>;
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

// ---- Deform (the shared Deform group, see lib/gen-deform.ts). Forward version of what the raymarched nodes do to the domain.
fn hasF(bit: u32) -> bool { return (u32(fr.dfFlags.x) & bit) != 0u; }
fn dfLocal(p0: vec3f, n: vec3f) -> vec3f {
  var q = p0;
  var disp = 0.0;
  if (hasF(1u)) {
    let s = q * fr.dfA.y;
    let o = vec3f(cos(fr.dfA.z), sin(fr.dfA.z), 0.0) * 0.9;
    let nz = vnoise3(s + o) * 0.65 + vnoise3(s * 2.07 + o.yxz * 1.3 + vec3f(5.2, 1.3, 9.1)) * 0.35;
    disp += fr.dfA.x * (nz * 2.0 - 1.0) * 1.4;
  }
  if (hasF(2u)) {
    var m = 0.0;
    if (hasF(4u)) {
      m = luma(textureSampleLevel(dmap, smpLinear, vec2f(atan2(q.x, q.z) / TAU + 0.5, 0.5 - q.y * 0.5), 0.0).rgb);
    } else {
      let w = pow(abs(normalize(q + vec3f(1e-5))), vec3f(4.0));
      let ww = w / (w.x + w.y + w.z);
      m = luma(textureSampleLevel(dmap, smpLinear, q.yz * 0.5 + 0.5, 0.0).rgb) * ww.x + luma(textureSampleLevel(dmap, smpLinear, q.xz * 0.5 + 0.5, 0.0).rgb) * ww.y + luma(textureSampleLevel(dmap, smpLinear, q.xy * 0.5 + 0.5, 0.0).rgb) * ww.z;
    }
    disp += fr.dfA.w * (m - 0.5) * 2.0;
  }
  if (hasF(8u)) { disp += fr.dfB.x; }
  q = q + n * disp;
  if (hasF(128u)) { q = mix(q, normalize(q + vec3f(1e-6)) * 0.9, fr.dfC.x); }
  if (hasF(32u)) { let a = -fr.dfB.z * q.x; let c = cos(a); let s = sin(a); q = vec3f(c * q.x - s * q.y, s * q.x + c * q.y, q.z); }
  if (hasF(16u)) { let a = -fr.dfB.y * q.y; let c = cos(a); let s = sin(a); q = vec3f(c * q.x - s * q.z, q.y, s * q.x + c * q.z); }
  if (hasF(64u)) { let s = max(1.0 - fr.dfB.w * q.y * 0.5, 0.15); q = vec3f(q.x * s, q.y, q.z * s); }
  if (hasF(512u)) {
    let ctr = (floor(p0 / 0.5) + 0.5) * 0.5;
    q = q + normalize(ctr + vec3f(0.0013, 0.0021, 0.0017)) * fr.dfC.z * 0.8;
  }
  if (hasF(256u)) {
    let m = fr.dfC.y;
    let low = smoothstep(0.4, -1.0, q.y);
    q = vec3f(q.x * (1.0 + 0.7 * m * low), q.y - (m * 0.75 * smoothstep(-1.0, 1.0, q.y) + m * 0.2), q.z * (1.0 + 0.7 * m * low));
  }
  return q;
}
fn deformVertex(pos: vec3f, nrm: vec3f, wp: ptr<function, vec3f>, wn: ptr<function, vec3f>) {
  let p0 = (pos - fr.dfFit.xyz) * fr.dfFit.w;
  let n = normalize(nrm);
  let q = dfLocal(p0, n);
  // normals from the displaced neighbours (finite differences on the tangent plane)
  var axis = vec3f(0.0, 1.0, 0.0);
  if (abs(n.y) > 0.9) { axis = vec3f(1.0, 0.0, 0.0); }
  let t1 = normalize(cross(n, axis));
  let t2 = cross(n, t1);
  let e = 0.02;
  var nn = normalize(cross(dfLocal(p0 + t1 * e, n) - q, dfLocal(p0 + t2 * e, n) - q));
  if (dot(nn, n) < 0.0) { nn = -nn; }
  *wp = fr.dfOrg.xyz + (fr.rot * vec4f(q * fr.dfOrg.w, 0.0)).xyz;
  *wn = normalize((fr.rot * vec4f(nn, 0.0)).xyz);
}

fn transform(i: VIn) -> VOut {
  var o: VOut;
  var wp = (fr.model * vec4f(i.pos, 1.0)).xyz;
  var wn = normalize((fr.rot * vec4f(i.nrm, 0.0)).xyz);
  if (fr.dfFlags.x > 0.5) { deformVertex(i.pos, i.nrm, &wp, &wn); }
  o.wpos = wp;
  o.wnrm = wn;
  o.uv = i.uv;
  o.col = i.col;
  o.clip = project(wp);
  if (fr.dfC.w > 0.5) {
    // low-fi: snap the projected vertex to a coarse screen grid
    o.clip = vec4f(floor(o.clip.xy / o.clip.w * fr.dfC.w + 0.5) / fr.dfC.w * o.clip.w, o.clip.zw);
  }
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

function getPipelines(device: GPUDevice, gpu: NodeGpu): Promise<Pipelines> {
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
          { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 3, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'float' } },
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
      // Lives as long as the pipelines (one per device); created through the Gpu so it is counted.
      const white = gpu.scratchTexture({ width: 1, height: 1, format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, label: 'model-3d white' });
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

/** Fragment stage of a model with a Material: the base colour / texture logic of `fs`, then the family's `matShade` (lib/gen-material.ts). */
const FS_MATERIAL = /* wgsl */ `
@fragment fn fsMat(i: VOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
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
  base.a = select(1.0, fr.tint.a, mode != 0);
  var V = normalize(fr.camPos.xyz - i.wpos);
  if (i32(fr.camPos.w) == 0) { V = -fr.camFwd.xyz; }
  var n = normalize(i.wnrm);
  if (i32(fr.shade.w) == 1) {
    n = normalize(cross(dpdx(i.wpos), dpdy(i.wpos)));
    if (dot(n, V) < 0.0) { n = -n; }
  } else if (!front) {
    n = -n;
  }
  let t0 = fr.rot[0].xyz; let t1 = fr.rot[1].xyz; let t2 = fr.rot[2].xyz;
  let wl = (i.wpos - fr.objc.xyz) / max(fr.objc.w, 1e-4);
  let pl = vec3f(dot(t0, wl), dot(t1, wl), dot(t2, wl));
  let nl = vec3f(dot(t0, n), dot(t1, n), dot(t2, n));
  gMeshUv = vec3f(i.uv.x * 2.0 - 1.0, 1.0 - i.uv.y * 2.0, mt.info.w);
  let dp1 = dpdx(i.wpos); let dp2 = dpdy(i.wpos); let du1 = dpdx(i.uv); let du2 = dpdy(i.uv);
  let r1 = cross(dp2, n); let r2 = cross(n, dp1);
  let tt = r1 * du1.x + r2 * du2.x;
  let bb = -(r1 * du1.y + r2 * du2.y);
  gMeshT = select(vec3f(0.0), tt / length(tt), length(tt) > 1e-12);
  gMeshB = select(vec3f(0.0), bb / length(bb), length(bb) > 1e-12);
  matSetup(fr.camRight.xyz, fr.camUp.xyz, fr.camFwd.xyz, t0, t1, t2);
  let s = matShade(base.rgb, n, -V, 1.0, 1.0, pl, nl, i.clip.xy / mb.v[11].zw);
  let a = clamp(base.a * s.a, 0.0, 1.0);
  return vec4f(clamp(s.rgb, vec3f(0.0), vec3f(1.0)) * a, a);
}
`;

interface MaterialPipes {
  cull: GPURenderPipeline;
  both: GPURenderPipeline;
  layout: GPUBindGroupLayout;
}
const materialPipes = new WeakMap<GPUDevice, Map<string, Promise<MaterialPipes>>>();
const MAX_MATERIAL_PIPES = 12;
/** Number of material pipelines created so far (tests: a slider must not add one). */
export const modelMaterialDebug = { pipelines: 0 };

/** One pipeline pair per material STRUCTURE (model + wired pictures + flags): every slider is a uniform, so moving one compiles nothing. */
function getMaterialPipelines(device: GPUDevice, m: MaterialValue, base: Pipelines): Promise<MaterialPipes> {
  let byKey = materialPipes.get(device);
  if (!byKey) materialPipes.set(device, (byKey = new Map()));
  const key = materialKey(m);
  let p = byKey.get(key);
  if (p) {
    byKey.delete(key); // refresh LRU position
    byKey.set(key, p);
    return p;
  }
  p = (async () => {
    modelMaterialDebug.pipelines++;
    const module = device.createShaderModule({ label: 'model-3d material ' + key, code: SHADER + materialRasterWgsl(m, 2, true) + FS_MATERIAL });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((e) => e.type === 'error');
    if (errors.length) throw new Error('model-3d material shader failed to compile: ' + errors.map((e) => 'line ' + e.lineNum + ': ' + e.message).join('; '));
    const layout = materialRasterLayout(device, m);
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [base.frameLayout, base.matLayout, layout] });
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
    const make = (cull: GPUCullMode) =>
      device.createRenderPipeline({
        label: 'model-3d material ' + cull,
        layout: pipelineLayout,
        vertex: { module, entryPoint: 'vs', buffers },
        fragment: { module, entryPoint: 'fsMat', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: cull },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
        multisample: { count: 4 },
      });
    return { cull: make('back'), both: make('none'), layout };
  })();
  byKey.set(key, p);
  const entry = p;
  p.catch(() => {
    if (byKey!.get(key) === entry) byKey!.delete(key);
  });
  while (byKey.size > MAX_MATERIAL_PIPES) byKey.delete(byKey.keys().next().value as string);
  return p;
}

function uploadModel(gpu: NodeGpu, key: ArrayBuffer, m: ParsedModel, wantWire: boolean): GpuModel {
  const device = gpu.device;
  let g = gpuData.get(key);
  if (g && g.device !== device) {
    // A device was replaced after a loss: the old buffers went with it.
    destroyModel(g);
    gpuData.delete(key);
    g = undefined;
  }
  if (g) {
    gpuData.delete(key); // refresh LRU position
    gpuData.set(key, g);
  } else {
    const vBytes = m.vertexCount * 36;
    const iBytes = m.indices.length * 4;
    if (vBytes > device.limits.maxBufferSize || iBytes > device.limits.maxBufferSize) {
      throw new Error(`This model needs ${Math.round(Math.max(vBytes, iBytes) / 1048576)} MB in one GPU buffer, more than this graphics card allows. Reduce its size in your 3D tool.`);
    }
    const vertex = gpu.createBuffer({ label: 'model-3d vertices', size: vBytes, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true }, 'vertex-buffer');
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
    const index = gpu.createBuffer({ label: 'model-3d indices', size: Math.max(16, iBytes), usage: GPUBufferUsage.INDEX, mappedAtCreation: true }, 'index-buffer');
    new Uint32Array(index.getMappedRange()).set(m.indices);
    index.unmap();
    g = { vertex, index, wire: null, device, gpu, bytes: vBytes + iBytes };
    gpuData.set(key, g);
    trimModels(key);
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
    const wire = gpu.createBuffer({ label: 'model-3d wire', size: edges.byteLength, usage: GPUBufferUsage.INDEX, mappedAtCreation: true }, 'index-buffer');
    new Uint32Array(wire.getMappedRange()).set(edges);
    wire.unmap();
    g.wire = wire;
    g.bytes += edges.byteLength;
  }
  return g;
}

function mat4(m: number[][]): number[] {
  // column-major from rows
  const o: number[] = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o.push(m[r][c]);
  return o;
}

/** The params both `object-3d` (shape "Custom model…") and the legacy `model-3d` node feed to `renderModel`. */
export interface ModelRenderParams {
  model: string[];
  autoFit: boolean;
  posX: number;
  posY: number;
  posZ: number;
  objectScale: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  spinX: number;
  spinY: number;
  spinZ: number;
  shading: string;
  colorMode: string;
  baseColor: readonly number[];
  nearestTexture: boolean;
  backFaces: boolean;
  wireframe: boolean;
  wireColor: readonly number[];
  cameraType: string;
  fov: number;
  x: number;
  y: number;
  scale: number;
  lightAzimuth: number;
  lightElevation: number;
  ambient: number;
  specular: number;
  gloss: number;
  cel: boolean;
  celSteps: number;
}

/** The slice of the node's RenderCtx that `renderModel` needs (pass the ctx itself so time/item reads stay lazy). */
export interface ModelRenderCtx {
  readonly gpu: NodeGpu;
  readonly host: Host;
  readonly time: TimeInfo;
  readonly item: { readonly index: number; readonly count: number };
}

const FLAG: Record<keyof DeformFeat, number> = { noise: 1, map: 2, cyl: 4, inflate: 8, twist: 16, bend: 32, taper: 64, morph: 128, melt: 256, explode: 512, lowfi: 1024 };

/** The 24 floats appended to the frame uniform: deform state (all zero = no deform, the vertex shader takes its original path). */
function deformFrame(deform: { p: DeformP; map: ImageValue | null } | null, p: ModelRenderParams, fit: number, c: number[], ctx: ModelRenderCtx): number[] {
  if (!deform) return new Array(24).fill(0);
  const f = deformFeatures(deform.p, !!deform.map);
  let flags = 0;
  for (const k of Object.keys(f) as (keyof DeformFeat)[]) if (f[k]) flags |= FLAG[k];
  if (flags === 0 || (flags & ~(FLAG.lowfi | FLAG.cyl)) === 0) flags &= FLAG.lowfi; // low-fi alone only snaps the screen grid
  const animated = (deform.p.dNoise !== 0 && deform.p.dNoiseCycles > 0) || (deform.p.dExplode !== 0 && deform.p.dExplodeCycles > 0);
  const du = deformUniforms(deform.p, animated ? ctx.time.phase : 0) as Record<string, number[]>;
  const geo = flags & ~FLAG.lowfi & ~FLAG.cyl ? flags : 0;
  const dfC = [...du.dfC];
  dfC[3] = f.lowfi ? Math.round(deform.p.dLowFi) * 4 : 0;
  return [p.posX, p.posY, p.posZ, p.objectScale, c[0], c[1], c[2], fit, ...du.dfA, ...du.dfB, ...dfC, geo, 0, 0, 0];
}

/** One-line description of the chosen model files, for node summaries. */
export const modelFilesSummary = (p: { model: string[] }): string => (p.model.length === 0 ? 'no model chosen' : p.model.length === 1 ? '1 model' : `${p.model.length} models`);

/**
 * Render the chosen model file into a fresh image. No file chosen = a clear (transparent) frame.
 * Throws readable errors (missing file, unsupported file, frame too large) that the engine shows on the node.
 */
export async function renderModel(
  ctx: ModelRenderCtx,
  p: ModelRenderParams,
  size: { width: number; height: number; unit?: number },
  camera: CameraValue | null,
  textureOverride: ImageValue | null,
  deform: { p: DeformP; map: ImageValue | null } | null = null,
  material: MaterialValue | null = null,
): Promise<ImageValue> {
  const out = ctx.gpu.alloc(size.width, size.height, size.unit ?? 1);
  const device = ctx.gpu.device;
  const W = out.width;
  const H = out.height;

  const clearOnly = () => {
    const enc = device.createCommandEncoder();
    enc.beginRenderPass({ colorAttachments: [{ view: ctx.gpu.view(out.texture), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end();
    device.queue.submit([enc.finish()]);
    return out;
  };
  if (!p.model.length) return clearOnly();
  const assetId = p.model[ctx.item.index % p.model.length];
  if (!ctx.host.assetBytes) throw new Error('This app build cannot load 3D model files (the host has no assetBytes).');
  const bytes = await ctx.host.assetBytes(assetId);
  if (!bytes) throw new Error('The 3D model file is missing. Choose it again in the node.');

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
  const cam = camera ?? simpleCamera({ ortho: p.cameraType === 'orthographic', fovDeg: p.fov, frameSize: p.scale, x: p.x, y: p.y, width: W, height: H });
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
    ...deformFrame(deform, p, fit, c, ctx),
    p.posX, p.posY, p.posZ, p.objectScale,
  ]);

  // --- GPU resources ----------------------------------------------------
  const gpu = ctx.gpu;
  const pl = await getPipelines(device, gpu);
  const gm = uploadModel(gpu, bytes, model, p.wireframe);
  const frameBuf = gpu.scratch(frame.byteLength, GPUBufferUsage.UNIFORM, 'model-3d frame');
  device.queue.writeBuffer(frameBuf, 0, frame);
  const frameBind = device.createBindGroup({
    layout: pl.frameLayout,
    entries: [
      { binding: 0, resource: { buffer: frameBuf, size: frame.byteLength } },
      { binding: 1, resource: pl.nearest },
      { binding: 2, resource: pl.linear },
      { binding: 3, resource: gpu.view(deform?.map?.texture ?? pl.white) },
    ],
  });
  const temp: GPUBuffer[] = [frameBuf];
  const matBinds: GPUBindGroup[] = [];
  const mp = material ? await getMaterialPipelines(device, material, pl) : null;
  let materialBind: GPUBindGroup | null = null;
  if (material && mp) {
    const mbuf = gpu.scratch(MATERIAL_RASTER_BYTES, GPUBufferUsage.UNIFORM, 'model-3d material frame');
    device.queue.writeBuffer(mbuf, 0, materialRasterData(material, { light, ambient: p.ambient, cel: p.cel, steps: p.celSteps, width: W, height: H }));
    temp.push(mbuf);
    materialBind = materialRasterGroup(device, mp.layout, material, mbuf, pl.linear, (t) => gpu.view(t));
  }
  for (const mat of model.materials) {
    let tex: GPUTexture | null = textureOverride ? textureOverride.texture : null;
    if (!tex && mat.texture && ctx.host.decodeImageBytes) {
      // the host caches decoded textures per ArrayBuffer object (stable slice kept in the parsed model)
      tex = (await ctx.host.decodeImageBytes(mat.texture.data, mat.texture.mime))?.texture ?? null;
    }
    const ub = gpu.scratch(32, GPUBufferUsage.UNIFORM, 'model-3d material');
    device.queue.writeBuffer(ub, 0, new Float32Array([...mat.baseColor, mat.alphaMode === 'opaque' ? 0 : 1, mat.alphaCutoff, tex ? 1 : 0, model.hasUVs ? 1 : 0]));
    temp.push(ub);
    matBinds.push(
      device.createBindGroup({
        layout: pl.matLayout,
        entries: [
          { binding: 0, resource: { buffer: ub, size: 32 } },
          { binding: 1, resource: gpu.view(tex ?? pl.white) },
        ],
      }),
    );
  }

  // Multisampled colour + depth are 8x the frame in memory: pooled and reused instead of created and destroyed every render.
  const msaa = gpu.scratchTexture({ width: W, height: H, format: 'rgba8unorm', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT, label: 'model-3d msaa' });
  const depth = gpu.scratchTexture({ width: W, height: H, format: 'depth24plus', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT, label: 'model-3d depth' });
  const enc = device.createCommandEncoder({ label: 'model-3d' });
  const rp = enc.beginRenderPass({
    colorAttachments: [{ view: gpu.view(msaa), resolveTarget: gpu.view(out.texture), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 0] }],
    depthStencilAttachment: { view: gpu.view(depth), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
  });
  rp.setBindGroup(0, frameBind);
  rp.setVertexBuffer(0, gm.vertex);
  rp.setIndexBuffer(gm.index, 'uint32');
  for (const g of model.groups) {
    const mat = model.materials[g.material];
    const dbl = mat.doubleSided || p.backFaces;
    rp.setPipeline(mp ? (dbl ? mp.both : mp.cull) : dbl ? pl.both : pl.cull);
    rp.setBindGroup(1, matBinds[g.material]);
    if (materialBind) rp.setBindGroup(2, materialBind);
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
  gpu.releaseScratchTexture(msaa);
  gpu.releaseScratchTexture(depth);
  for (const b of temp) gpu.releaseScratch(b);
  return out;
}
