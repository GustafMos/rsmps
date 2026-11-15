import { defineNode } from '../../define';
import { rgba, rotationZYX } from '../../lib/gen-common';

const SHAPES = { cube: 0, sphere: 1, cylinder: 2, cone: 3, torus: 4, pyramid: 5, capsule: 6, octahedron: 7 } as const;

export default defineNode({
  id: 'object-3d',
  title: '3D Object',
  category: 'generate',
  description: 'A lit 3D primitive (cube, sphere, cylinder, cone, torus, pyramid, capsule, octahedron) that can spin in a perfect loop. Transparent background.',
  keywords: ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'donut', 'pyramid', 'capsule', 'octahedron', '3d', 'model', 'spin', 'rotate', 'raymarch', 'cel', 'toon'],
  inputs: { size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
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
        { value: 'torus', label: 'Torus (donut)' },
        { value: 'pyramid', label: 'Pyramid' },
        { value: 'capsule', label: 'Capsule' },
        { value: 'octahedron', label: 'Octahedron' },
      ],
    },
    baseColor: { type: 'color', default: [0.35, 0.6, 0.95, 1], label: 'Colour' },
    x: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Position X', group: 'Placement' },
    y: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Position Y', group: 'Placement' },
    scale: { type: 'number', default: 0.6, min: 0.02, max: 3, step: 0.005, unit: 'norm', label: 'Size', group: 'Placement', hint: 'Fraction of the frame’s shorter side.' },
    camera: {
      type: 'enum',
      default: 'perspective',
      label: 'Camera',
      group: 'Placement',
      options: [
        { value: 'perspective', label: 'Perspective' },
        { value: 'orthographic', label: 'Orthographic (flat)' },
      ],
    },
    fov: { type: 'number', default: 30, min: 5, max: 90, step: 1, unit: 'deg', label: 'Perspective strength', group: 'Placement', hint: 'Higher = camera closer, stronger perspective.', visibleIf: (p) => p.camera === 'perspective' },
    rotX: { type: 'number', default: 25, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate X (tilt)', group: 'Rotation' },
    rotY: { type: 'number', default: 35, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate Y (turn)', group: 'Rotation' },
    rotZ: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate Z (roll)', group: 'Rotation' },
    spinX: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin X (turns per loop)', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
    spinY: { type: 'number', default: 1, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin Y (turns per loop)', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
    spinZ: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin Z (turns per loop)', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
    lightAzimuth: { type: 'number', default: -35, min: -180, max: 180, step: 1, unit: 'deg', label: 'Light from (left/right)', group: 'Lighting' },
    lightElevation: { type: 'number', default: 40, min: -90, max: 90, step: 1, unit: 'deg', label: 'Light height', group: 'Lighting' },
    ambient: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Ambient light', group: 'Lighting' },
    specular: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Shininess', group: 'Lighting' },
    gloss: { type: 'number', default: 32, min: 2, max: 256, step: 1, label: 'Highlight tightness', group: 'Lighting' },
    cel: { type: 'bool', default: false, label: 'Flat (cel) shading', group: 'Lighting', hint: 'Posterises the light into a few flat bands. Great for pixel art.' },
    celSteps: { type: 'number', default: 3, min: 2, max: 8, step: 1, integer: true, label: 'Shading bands', group: 'Lighting', visibleIf: (p) => p.cel === true },
  },
  summary: (p) => `${p.shape} · ${p.camera}${p.cel ? ` · ${p.celSteps}-band cel` : ''}${p.spinX || p.spinY || p.spinZ ? ' · spinning' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const size = ctx.in.size ?? ctx.canvas;
    const spinning = p.spinX !== 0 || p.spinY !== 0 || p.spinZ !== 0;
    const phase = spinning ? ctx.time.phase : 0;
    const R = rotationZYX(p.rotX + 360 * p.spinX * phase, p.rotY + 360 * p.spinY * phase, p.rotZ + 360 * p.spinZ * phase);
    const az = (p.lightAzimuth * Math.PI) / 180;
    const el = (p.lightElevation * Math.PI) / 180;
    const light = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
    const ortho = p.camera === 'orthographic';
    const camDist = 1 / Math.sin((Math.min(90, Math.max(5, p.fov)) * Math.PI) / 360);
    const image = ctx.gpu.pass({
      label: 'object-3d',
      size,
      uniforms: {
        shape: SHAPES[p.shape as keyof typeof SHAPES] ?? 0,
        ortho,
        camDist,
        pos: [p.x, p.y],
        scale: Math.max(0.001, p.scale),
        t0: [R[0], R[3], R[6]],
        t1: [R[1], R[4], R[7]],
        t2: [R[2], R[5], R[8]],
        base: rgba(p.baseColor),
        light,
        ambient: p.ambient,
        spec: p.specular,
        gloss: p.gloss,
        cel: p.cel,
        steps: Math.max(2, Math.round(p.celSteps)),
      },
      wgsl: /* wgsl */ `
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
fn sdPyramid(pin: vec3f, h: f32) -> f32 {
  let m2 = h * h + 0.25;
  var p = pin;
  p = vec3f(abs(p.x), p.y, abs(p.z));
  if (p.z > p.x) { p = vec3f(p.z, p.y, p.x); }
  p = vec3f(p.x - 0.5, p.y, p.z - 0.5);
  let q = vec3f(p.z, h * p.y - 0.5 * p.x, h * p.x + 0.5 * p.y);
  let s = max(-q.x, 0.0);
  let t = clamp((q.y - 0.5 * p.z) / (m2 + 0.25), 0.0, 1.0);
  let a = m2 * (q.x + s) * (q.x + s) + q.y * q.y;
  let b = m2 * (q.x + 0.5 * t) * (q.x + 0.5 * t) + (q.y - m2 * t) * (q.y - m2 * t);
  var d2 = min(a, b);
  if (min(q.y, -q.x * m2 - q.y * 0.5) > 0.0) { d2 = 0.0; }
  return sqrt((d2 + q.z * q.z) / m2) * sign(max(q.z, -p.y));
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

fn map(pw: vec3f) -> f32 {
  let p = vec3f(dot(u.t0, pw), dot(u.t1, pw), dot(u.t2, pw));
  let k = i32(u.shape);
  if (k == 0) { return sdBox(p, vec3f(0.55), 0.04); }
  if (k == 1) { return length(p) - 0.95; }
  if (k == 2) {
    let d = vec2f(length(p.xz) - 0.7, abs(p.y) - 0.7) + vec2f(0.04);
    return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0))) - 0.04;
  }
  if (k == 3) { return sdCone(p - vec3f(0.0, 0.8, 0.0), vec2f(0.4472136, 0.8944272), 1.6); }
  if (k == 4) { return length(vec2f(length(p.xz) - 0.68, p.y)) - 0.28; }
  if (k == 5) { return sdPyramid((p + vec3f(0.0, 0.55, 0.0)) / 1.2, 1.0) * 1.2; }
  if (k == 6) { return length(vec3f(p.x, p.y - clamp(p.y, -0.45, 0.45), p.z)) - 0.5; }
  return sdOcta(p, 1.0);
}
fn calcNormal(p: vec3f) -> vec3f {
  let e = vec2f(1.0, -1.0) * 0.0008;
  return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}

fn shade(xn: f32, yn: f32) -> vec4f {
  var ro = vec3f(xn, yn, -4.0);
  var rd = vec3f(0.0, 0.0, 1.0);
  var tmax = 8.0;
  var t = 0.0;
  if (u.ortho < 0.5) {
    let tanH = 1.0 / sqrt(u.camDist * u.camDist - 1.0);
    ro = vec3f(0.0, 0.0, -u.camDist);
    rd = normalize(vec3f(xn * tanH, yn * tanH, 1.0));
    t = max(0.0, u.camDist - 1.4);
    tmax = u.camDist + 1.4;
  } else {
    t = 2.6;
    tmax = 5.4;
  }
  var hit = false;
  for (var i = 0; i < 96; i++) {
    let h = map(ro + rd * t);
    if (h < 0.0007) { hit = true; break; }
    t += h * 0.9;
    if (t > tmax) { break; }
  }
  if (!hit) { return vec4f(0.0); }
  let pos = ro + rd * t;
  let n = calcNormal(pos);
  let L = normalize(u.light);
  let diff = max(dot(n, L), 0.0);
  let V = -rd;
  let H = normalize(L + V);
  var s = pow(max(dot(n, H), 0.0), u.gloss) * select(1.0, 0.0, diff <= 0.0);
  var lit = diff;
  if (u.cel > 0.5) {
    let st = u.steps;
    lit = min(floor(diff * st), st - 1.0) / (st - 1.0);
    s = step(0.55, s);
  }
  let col = u.base.rgb * (u.ambient + (1.0 - u.ambient) * lit) + vec3f(u.spec * s);
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let short = min(u.size.x, u.size.y);
  let R = max(u.scale * short * 0.5, 0.5);
  let c = u.pos * u.size;
  // 4 rotated-grid samples per pixel: antialiased silhouette
  let s0 = shade((px.x - 0.375 - c.x) / R, -(px.y - 0.125 - c.y) / R);
  let s1 = shade((px.x + 0.125 - c.x) / R, -(px.y - 0.375 - c.y) / R);
  let s2 = shade((px.x + 0.375 - c.x) / R, -(px.y + 0.125 - c.y) / R);
  let s3 = shade((px.x - 0.125 - c.x) / R, -(px.y + 0.375 - c.y) / R);
  let sum = s0 + s1 + s2 + s3;
  let cov = sum.a * 0.25;
  if (sum.a < 0.5) { return vec4f(0.0); }
  var col = sum.rgb / sum.a;
  if (u.cel > 0.5) {
    // keep the shading bands crisp: one sample's colour, only the silhouette is blended
    col = select(select(select(s3.rgb, s2.rgb, s2.a > 0.5), s1.rgb, s1.a > 0.5), s0.rgb, s0.a > 0.5);
  }
  let a = cov * u.base.a;
  return vec4f(col * a, a);
}`,
    });
    return { image };
  },
});
