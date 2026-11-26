import { defineNode } from '../../define';
import { cameraBasis, PROJECTION_ID, simpleCamera } from '../../lib/gen-camera';
import { RAY_WGSL } from '../../lib/gen-3d';
import { materialKey, materialTextures, materialUniforms, materialWgsl } from '../../lib/gen-material';
import { DEFORM_PARAMS, deformAnimated, deformFeatures, deformGrow, deformUniforms, deformWgsl, deformStepScale, deformAny, type DeformP } from '../../lib/gen-deform';
import { SPIN_AROUND_PARAM, spunRotation, rgba, rotationZYX } from '../../lib/gen-common';
import { modelFilesSummary, renderModel } from '../../lib/model-render';
import type { CameraValue } from '../../types';

const SHAPES = { cube: 0, sphere: 1, cylinder: 2, cone: 3, torus: 4, pyramid: 5, capsule: 6, octahedron: 7 } as const;

export default defineNode({
  id: 'object-3d',
  title: '3D Object',
  category: 'generate',
  description:
    'A lit 3D object that can spin in a perfect loop: a primitive (cube, sphere, cylinder, cone, torus, pyramid, capsule, octahedron) or your own model (choose "Custom model…" in Shape, then add a .glb, .gltf or .obj file). Transparent background.',
  keywords: ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'donut', 'pyramid', 'capsule', 'octahedron', '3d', 'model', 'spin', 'rotate', 'raymarch', 'cel', 'toon', 'glb', 'gltf', 'obj', 'mesh', 'import', 'upload', 'custom', 'wavefront', 'low poly', 'displace 3d', 'morph', 'melt', 'wobble', 'deform', 'twist', 'bend', 'explode', 'depth', 'material'],
  inputs: { size: { type: 'image', label: 'Size from' }, camera: { type: 'camera', label: 'Camera' }, displaceMap: { type: 'image', label: 'Displace map' }, material: { type: 'material', label: 'Material' } },
  outputs: { image: { type: 'image', label: 'Image' }, depth: { type: 'image', label: 'Depth' } },
  optionalOutputs: ['depth'],
  params: {
    shape: {
      type: 'enum',
      default: 'cube',
      label: 'Shape',
      options: [
        { value: 'cube', label: 'Cube' },
        { value: 'sphere', label: 'Sphere' },
        { value: 'cylinder', label: 'Cylinder' },
        { value: 'cone', label: 'Cone' },
        { value: 'torus', label: 'Torus' },
        { value: 'pyramid', label: 'Pyramid' },
        { value: 'capsule', label: 'Capsule' },
        { value: 'octahedron', label: 'Octahedron' },
        { value: 'custom', label: 'Custom model…' },
      ],
    },
    model: {
      type: 'assets',
      default: [],
      accept: 'model',
      label: '3D model',
      hint: 'A .glb, .gltf or .obj file (up to 2 million triangles; not Draco/meshopt-compressed, not multi-file .gltf). With several files, each batch item uses its own.',
      visibleIf: (p) => p.shape === 'custom',
    },
    baseColor: { type: 'color', default: [0.35, 0.6, 0.95, 1], label: 'Color', visibleIf: (p) => p.shape !== 'custom' || p.colorMode !== 'model' },
    colorMode: {
      type: 'enum',
      default: 'model',
      label: 'Model color',
      group: 'Custom model',
      visibleIf: (p) => p.shape === 'custom',
      options: [
        { value: 'model', label: 'As in the file' },
        { value: 'tint', label: 'Tint file colors' },
        { value: 'override', label: 'One flat color' },
      ],
    },
    autoFit: { type: 'bool', default: true, label: 'Fit to view', group: 'Custom model', hint: 'Center the model and scale it to fill the same space as the primitives.', visibleIf: (p) => p.shape === 'custom' },
    shading: {
      type: 'enum',
      default: 'smooth',
      label: 'Model shading',
      group: 'Custom model',
      visibleIf: (p) => p.shape === 'custom',
      options: [
        { value: 'smooth', label: 'Smooth' },
        { value: 'flat', label: 'Flat' },
        { value: 'unlit', label: 'Unlit' },
      ],
    },
    nearestTexture: { type: 'bool', default: false, label: 'Crisp texture', group: 'Custom model', hint: 'Nearest-neighbor texture sampling, for pixel-art textures.', visibleIf: (p) => p.shape === 'custom' },
    backFaces: { type: 'bool', default: false, label: 'Show back faces', group: 'Custom model', hint: 'Draw both sides of every triangle, not only the ones the file marks double-sided.', visibleIf: (p) => p.shape === 'custom' },
    wireframe: { type: 'bool', default: false, label: 'Wireframe overlay', group: 'Custom model', hint: 'Limited to 300,000 triangles.', visibleIf: (p) => p.shape === 'custom' },
    wireColor: { type: 'color', default: [0, 0, 0, 0.6], label: 'Wireframe color', group: 'Custom model', visibleIf: (p) => p.shape === 'custom' && p.wireframe === true },
    posX: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, label: 'Move X', group: 'Object', hint: 'Scene units (the object is about 2 wide). Wire a number here to move it.' },
    posY: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, label: 'Move Y', hint: 'Up is positive.', group: 'Object' },
    posZ: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, label: 'Move Z', hint: 'Away from the camera is positive.', group: 'Object' },
    objectScale: { type: 'number', default: 1, min: 0.01, max: 20, step: 0.01, label: 'Object scale', group: 'Object' },
    x: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Frame X', group: 'Built-in camera', hint: 'Ignored when a Camera is wired in.' },
    y: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Frame Y', hint: 'Position in the frame (built-in camera only).', group: 'Built-in camera' },
    scale: { type: 'number', default: 0.6, min: 0.02, max: 3, step: 0.005, unit: 'norm', label: 'Frame size', group: 'Built-in camera', hint: 'Fraction of the frame’s shorter side. Ignored when a Camera is wired in.' },
    cameraType: {
      type: 'enum',
      default: 'perspective',
      label: 'Built-in camera',
      group: 'Built-in camera',
      options: [
        { value: 'perspective', label: 'Perspective' },
        { value: 'orthographic', label: 'Orthographic' },
      ],
    },
    fov: { type: 'number', default: 30, min: 5, max: 90, step: 1, unit: 'deg', label: 'Perspective', group: 'Built-in camera', hint: 'Higher = camera closer, stronger perspective.', visibleIf: (p) => p.cameraType === 'perspective' },
    rotX: { type: 'number', default: 25, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate X', hint: 'Tilt.', group: 'Rotation' },
    rotY: { type: 'number', default: 35, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate Y', hint: 'Turn.', group: 'Rotation' },
    rotZ: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate Z', hint: 'Roll.', group: 'Rotation' },
    spinX: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin X', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
    spinY: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin Y', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
    spinZ: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin Z', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
    spinAround: SPIN_AROUND_PARAM,
    bevel: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Edge bevel', group: 'Object', hint: '0 = perfectly sharp edges and corners. About 0.07 gives the slightly soft edge older versions had; 1 rounds the shape right off. Applies to cube, cylinder, cone, pyramid and octahedron.', visibleIf: (p) => p.shape !== 'custom' },
    lightAzimuth: { type: 'number', default: -35, min: -180, max: 180, step: 1, unit: 'deg', label: 'Light azimuth', hint: 'Left to right.', group: 'Lighting' },
    lightElevation: { type: 'number', default: 40, min: -90, max: 90, step: 1, unit: 'deg', label: 'Light height', group: 'Lighting' },
    ambient: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Ambient light', group: 'Lighting' },
    specular: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Shininess', group: 'Lighting' },
    gloss: { type: 'number', default: 32, min: 2, max: 256, step: 1, label: 'Highlight focus', group: 'Lighting' },
    cel: { type: 'bool', default: false, label: 'Cel shading', group: 'Lighting', hint: 'Posterises the light into a few flat bands. Great for pixel art.' },
    celSteps: { type: 'number', default: 3, min: 2, max: 8, step: 1, integer: true, label: 'Shading bands', group: 'Lighting', visibleIf: (p) => p.cel === true },
    ...DEFORM_PARAMS,
  },
  summary: (p) => `${p.shape === 'custom' ? modelFilesSummary(p) : p.shape} · ${p.cameraType}${p.cel ? ` · ${p.celSteps}-band cel` : ''}${p.spinX || p.spinY || p.spinZ ? ' · spinning' : ''}`,
  async render(ctx) {
    const p = ctx.params;
    const size = ctx.in.size ?? ctx.canvas;
    const mat = ctx.in.material;
    const dp = p as unknown as DeformP;
    const feat = deformFeatures(dp, !!ctx.in.displaceMap);
    const hasDf = deformAny(feat);
    if (p.shape === 'custom') {
      // Same renderer as the legacy 3D Model node (lib/model-render.ts): imported mesh, same camera and lighting params.
      // Deform runs in its vertex shader. The depth output is not produced for custom models (rasterised, no ray distance).
      // A wired Material is applied in the rasteriser's fragment stage (the model's own UVs when it has them, triplanar otherwise).
      return { image: await renderModel(ctx, p, size, ctx.in.camera, null, hasDf ? { p: dp, map: feat.map ? ctx.in.displaceMap : null } : null, mat), depth: null };
    }
    const spinning = p.spinX !== 0 || p.spinY !== 0 || p.spinZ !== 0;
    const phase = spinning || deformAnimated(dp) ? ctx.time.phase : 0;
    const R = spunRotation(p, phase);
    const az = (p.lightAzimuth * Math.PI) / 180;
    const el = (p.lightElevation * Math.PI) / 180;
    const light = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];

    // The wired camera wins; otherwise build the equivalent of the simple built-in camera.
    let cam: CameraValue | null = ctx.in.camera;
    if (!cam) cam = simpleCamera({ ortho: p.cameraType === 'orthographic', fovDeg: p.fov, frameSize: p.scale, x: p.x, y: p.y, width: size.width, height: size.height });
    const basis = cameraBasis(cam);
    const uniforms = {
      ...(mat ? materialUniforms(mat) : {}),
      ...(hasDf ? { ...deformUniforms(dp, phase), dfGrow: deformGrow(dp), dfStepK: (deformStepScale(dp) * 0.8) / 0.9 } : {}),
        shape: SHAPES[p.shape as keyof typeof SHAPES] ?? 0,
        proj: PROJECTION_ID[cam.projection] ?? 1,
        camPos: basis.position,
        camRight: basis.right,
        camUp: basis.up,
        camFwd: basis.forward,
        fovTan: Math.tan((Math.min(cam.projection === 'fisheye' ? 359 : 179, Math.max(1, cam.fov)) * Math.PI) / 360),
        fovRad: (Math.min(360, Math.max(1, cam.fov)) * Math.PI) / 180,
        orthoHalf: Math.max(0.001, cam.orthoSize) / 2,
        shift: cam.shift,
        objPos: [p.posX, p.posY, p.posZ],
        objScale: Math.max(0.001, p.objectScale),
        t0: [R[0], R[3], R[6]],
        t1: [R[1], R[4], R[7]],
        t2: [R[2], R[5], R[8]],
        base: rgba(p.baseColor),
        light,
        ambient: p.ambient,
        spec: p.specular,
        gloss: p.gloss,
        bevel: p.bevel * 0.55,
        cel: p.cel,
        steps: Math.max(2, Math.round(p.celSteps)),
    };
    const wgsl = /* wgsl */ `
fn sdBox(p: vec3f, b: vec3f, r: f32) -> f32 {
  let q = abs(p) - b + vec3f(r);
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
fn sdCone(p: vec3f, c: vec2f, h: f32) -> f32 {
  let q = h * vec2f(c.x / c.y, -1.0);
  let w = vec2f(length(p.xz), p.y);
  let a = w - q * clamp(dot(w, q) / dot(q, q), 0.0, 1.0);
  let b = w - q * vec2f(clamp(w.x / q.x, 0.0, 1.0), 1.0);
  let k = sign(q.y);
  let d = min(dot(a, a), dot(b, b));
  let s = max(k * (w.x * q.y - w.y * q.x), k * (w.y - q.y));
  return sqrt(d) * sign(s);
}
// square pyramid (base at y=-0.55, apex at y=0.65) from 3 plane distances; with r > 0 the planes are inset by r and the
// positive parts are combined with a length(), which rounds edges and corners (exact for the base edges, close elsewhere)
fn sdPyramid(p: vec3f, r: f32) -> f32 {
  let side = vec2f(0.8944272, 0.4472136);
  let v = vec3f(-p.y - 0.55, side.x * abs(p.x) + side.y * p.y - 0.2906841, side.x * abs(p.z) + side.y * p.y - 0.2906841) + vec3f(r);
  return length(max(v, vec3f(0.0))) + min(max(v.x, max(v.y, v.z)), 0.0) - r;
}
fn sdOcta(pin: vec3f, s: f32) -> f32 {
  let p = abs(pin);
  let m = p.x + p.y + p.z - s;
  var q = vec3f(0.0);
  if (3.0 * p.x < m) { q = p; }
  else if (3.0 * p.y < m) { q = p.yzx; }
  else if (3.0 * p.z < m) { q = p.zxy; }
  else { return m * 0.57735027; }
  let k = clamp(0.5 * (q.z - q.y + s), 0.0, s);
  return length(vec3f(q.x, q.y - s + k, q.z - k));
}

fn mapObj(p: vec3f) -> f32 {
  let k = i32(u.shape);
  if (k == 0) { return sdBox(p, vec3f(0.55), min(u.bevel, 0.55)); }
  if (k == 1) { return length(p) - 0.95; }
  if (k == 2) {
    let r = min(u.bevel, 0.69);
    let d = vec2f(length(p.xz) - 0.7, abs(p.y) - 0.7) + vec2f(r);
    return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0))) - r;
  }
  if (k == 3) {
    // rounding = the cone inset by r, then offset by r (tip drops 2.236 r, base rises r)
    let r = min(u.bevel, 0.45);
    return sdCone(p - vec3f(0.0, 0.8 - 2.236 * r, 0.0), vec2f(0.4472136, 0.8944272), 1.6 - 3.236 * r) - r;
  }
  if (k == 4) { return length(vec2f(length(p.xz) - 0.68, p.y)) - 0.28; }
  if (k == 5) { return sdPyramid(p, min(u.bevel, 0.3)); }
  if (k == 6) { return length(vec3f(p.x, p.y - clamp(p.y, -0.45, 0.45), p.z)) - 0.5; }
  let r = min(u.bevel, 0.5);
  return sdOcta(p, 1.0 - 1.7320508 * r) - r;
}
${hasDf ? deformWgsl(feat) : ''}
fn map(pw: vec3f) -> f32 {
  let q = pw - u.objPos;
  ${hasDf ? `let p0 = vec3f(dot(u.t0, q), dot(u.t1, q), dot(u.t2, q)) / u.objScale;
  let p1 = dfPoint(p0);
  return dfDist(p0, p1, mapObj(p1)) * u.objScale;` : 'return mapObj(vec3f(dot(u.t0, q), dot(u.t1, q), dot(u.t2, q)) / u.objScale) * u.objScale;'}
}
fn calcNormal(p: vec3f) -> vec3f {
  let e = vec2f(1.0, -1.0) * 0.0008;
  return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}

${RAY_WGSL}
${mat ? `${materialWgsl(mat)}
var<private> gScr: vec2f;
var<private> gA: f32;` : ''}
// Distance along the ray to the surface, or -1. (Shared by the picture and the depth output.)
fn trace(ro: vec3f, rd: vec3f) -> f32 {
  // bounding sphere around the object: cheap reject, and a tight start/end for the march
  let bc = u.objPos - ro;
  let br = ${hasDf ? '(1.2 + u.dfGrow) * u.objScale' : '1.2 * u.objScale'};
  let tca = dot(bc, rd);
  let d2 = dot(bc, bc) - tca * tca;
  if (d2 > br * br) { return -1.0; }
  let thc = sqrt(br * br - d2);
  var t = max(0.0, tca - thc);
  let tmax = tca + thc;
  if (tmax < 0.0) { return -1.0; }
  var hit = false;
  var h = 1.0;
  var iters = 0;
  for (var i = 0; i < 128; i++) {
    iters = i;
    h = map(ro + rd * t);
    if (h < 0.0007 * u.objScale) { hit = true; break; }
    t += h * ${hasDf ? 'u.dfStepK' : '0.8'};
    if (t > tmax) { break; }
  }
  // grazing rays along a flat face can run out of steps while skimming the surface: count them as hits
  if (!hit && iters == 127 && h < 0.01 * u.objScale) { hit = true; }
  if (!hit) { return -1.0; }
  return t;
}

fn shade(uf: vec2f, ff: vec2f) -> vec4f {
  var ro = vec3f(0.0);
  var rd = vec3f(0.0, 0.0, 1.0);
  if (!makeRay(uf, ff, &ro, &rd)) { return vec4f(0.0); }
  let t = trace(ro, rd);
  if (t < 0.0) { return vec4f(0.0); }
  let pos = ro + rd * t;
  let n = calcNormal(pos);
  let L = normalize(u.light); // world space: the light does not follow the camera
  let diff = max(dot(n, L), 0.0);
  let H = normalize(L - rd);
  var s = pow(max(dot(n, H), 0.0), u.gloss) * select(1.0, 0.0, diff <= 0.0);
  var lit = diff;
  if (u.cel > 0.5) {
    let st = u.steps;
    lit = min(floor(diff * st), st - 1.0) / (st - 1.0);
    s = step(0.55, s);
  }
${mat ? `let q0 = pos - u.objPos;
  let pl = vec3f(dot(u.t0, q0), dot(u.t1, q0), dot(u.t2, q0)) / u.objScale;
  let nl = vec3f(dot(u.t0, n), dot(u.t1, n), dot(u.t2, n));
  let mc = matShade(vec3f(1.0), n, rd, 1.0, 1.0, pl, nl, gScr);
  gA = mc.a;
  return vec4f(mc.rgb, 1.0);` : `let col = u.base.rgb * (u.ambient + (1.0 - u.ambient) * lit) + vec3f(u.spec * s);
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);`}
}

fn frameUV(px: vec2f) -> vec4f {
  let short = min(u.size.x, u.size.y);
  let c = u.size * 0.5;
  let p = vec2f(px.x - c.x, -(px.y - c.y));
  return vec4f(p / (short * 0.5) - u.shift * 2.0, vec2f(p.x / c.x, p.y / c.y) - vec2f(u.shift.x * 2.0 * short / u.size.x, u.shift.y * 2.0 * short / u.size.y));
}

fn sampleAt(px: vec2f) -> vec4f {
  let f = frameUV(px);
  return shade(f.xy, f.zw);
}

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  // 4 rotated-grid samples per pixel: antialiased silhouette
  ${mat ? 'gScr = px / u.size; gA = 1.0;' : ''}
  let s0 = sampleAt(px + vec2f(-0.375, -0.125));
  ${mat ? 'let a0 = gA;' : ''}
  let s1 = sampleAt(px + vec2f(0.125, -0.375));
  ${mat ? 'let a1 = gA;' : ''}
  let s2 = sampleAt(px + vec2f(0.375, 0.125));
  ${mat ? 'let a2 = gA;' : ''}
  let s3 = sampleAt(px + vec2f(-0.125, 0.375));
  ${mat ? 'let a3 = gA;' : ''}
  let sum = s0 + s1 + s2 + s3;
  if (sum.a < 0.5) { return vec4f(0.0); }
  let cov = sum.a * 0.25;
  var col = sum.rgb / sum.a;
  if (u.cel > 0.5) {
    // keep the shading bands crisp: one sample's colour, only the silhouette is blended
    col = select(select(select(s3.rgb, s2.rgb, s2.a > 0.5), s1.rgb, s1.a > 0.5), s0.rgb, s0.a > 0.5);
  }
  ${mat ? 'let a = cov * u.base.a * (a0 * s0.a + a1 * s1.a + a2 * s2.a + a3 * s3.a) / sum.a;' : 'let a = cov * u.base.a;'}
  return vec4f(col * a, a);
}`;
    const depthFx = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let f = frameUV(px);
  var ro = vec3f(0.0);
  var rd = vec3f(0.0, 0.0, 1.0);
  if (!makeRay(f.xy, f.zw, &ro, &rd)) { return vec4f(0.0); }
  let t = trace(ro, rd);
  if (t < 0.0) { return vec4f(0.0); }
  return vec4f(t, t, t, 1.0);
}`;
    const textures = mat ? materialTextures(mat) : undefined;
    const image = ctx.gpu.pass({ label: mat ? `object-3d ${materialKey(mat)}` : 'object-3d', size, uniforms, textures, wgsl });
    // depth: rgba16float, r = g = b = distance from the camera along the ray (scene units), a = 1 on a hit (see lib/gen-3d.ts)
    const depth = ctx.wants('depth') ? ctx.gpu.pass({ label: 'object-3d depth', size, uniforms, textures, wgsl: wgsl.slice(0, wgsl.indexOf('fn fx(uv: vec2f, px: vec2f)')) + depthFx, format: 'rgba16float' }) : null;
    return { image, depth };
  },
});
