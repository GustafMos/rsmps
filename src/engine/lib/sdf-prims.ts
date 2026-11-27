/**
 * Distance functions, combine operators and the object-space frame shared by SDF 3D and the SDF Scene renderer (lib/sdf-render.ts).
 * Every function takes the point in the shape's own frame and a vec4 of half sizes `s` (a = radius or half width, b = half height or tube
 * radius, c = half depth). The WGSL text is exactly what SDF 3D always generated: sharing it must not change a pixel.
 */
import { gridFor, occupancy, signedField } from './gen-sdf2d';
import { materialWgsl } from './gen-material';
import type { ImageValue, MaterialValue, NodeGpu, SdfShapeKind, UniformValue } from '../types';

export const SD_FUNCS: Record<string, string> = {
  sphere: 'fn sdSphere(q: vec3f, s: vec4f) -> f32 { return length(q) - s.x; }',
  box: 'fn sdBoxS(q: vec3f, s: vec4f) -> f32 { let d = abs(q) - s.xyz; return length(max(d, vec3f(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0); }',
  rbox: 'fn sdRBox(q: vec3f, s: vec4f) -> f32 { let r = 0.25 * min(s.x, min(s.y, s.z)); let d = abs(q) - s.xyz + vec3f(r); return length(max(d, vec3f(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0) - r; }',
  torus: 'fn sdTorus(q: vec3f, s: vec4f) -> f32 { return length(vec2f(length(q.xz) - s.x, q.y)) - s.y; }',
  capsule: 'fn sdCapsule(q: vec3f, s: vec4f) -> f32 { return length(vec3f(q.x, q.y - clamp(q.y, -s.y, s.y), q.z)) - s.x; }',
  cylinder: 'fn sdCyl(q: vec3f, s: vec4f) -> f32 { let d = vec2f(length(q.xz) - s.x, abs(q.y) - s.y); return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0))); }',
  cone: `fn sdConeS(pin: vec3f, s: vec4f) -> f32 {
  let h = 2.0 * s.y;
  let c = normalize(vec2f(s.x, h));
  let p = pin - vec3f(0.0, s.y, 0.0);
  let q = h * vec2f(c.x / c.y, -1.0);
  let w = vec2f(length(p.xz), p.y);
  let a = w - q * clamp(dot(w, q) / dot(q, q), 0.0, 1.0);
  let b = w - q * vec2f(clamp(w.x / q.x, 0.0, 1.0), 1.0);
  let k = sign(q.y);
  let d = min(dot(a, a), dot(b, b));
  let sg = max(k * (w.x * q.y - w.y * q.x), k * (w.y - q.y));
  return sqrt(d) * sign(sg);
}`,
  plane: 'fn sdPlaneS(q: vec3f, s: vec4f) -> f32 { return q.y; }',
  octa: `fn sdOctaS(pin: vec3f, s: vec4f) -> f32 {
  let p = abs(pin);
  let m = p.x + p.y + p.z - s.x;
  var q = vec3f(0.0);
  if (3.0 * p.x < m) { q = p; }
  else if (3.0 * p.y < m) { q = p.yzx; }
  else if (3.0 * p.z < m) { q = p.zxy; }
  else { return m * 0.57735027; }
  let k = clamp(0.5 * (q.z - q.y + s.x), 0.0, s.x);
  return length(vec3f(q.x, q.y - s.x + k, q.z - k));
}`,
  image2d: `fn sdPic(q: vec3f, s: vec4f) -> f32 {
  let pc = vec2f(q.x / (2.0 * u.pic.x * s.x) + 0.5, 0.5 - q.y / (2.0 * u.pic.y * s.x)) * u.grid;
  let w = vec2f(sd2(pc) * u.cellW * s.x, abs(q.z) - s.y);
  return min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0)));
}`,
};
export const SD_CALL: Record<string, string> = { sphere: 'sdSphere', box: 'sdBoxS', rbox: 'sdRBox', torus: 'sdTorus', capsule: 'sdCapsule', cylinder: 'sdCyl', cone: 'sdConeS', plane: 'sdPlaneS', octa: 'sdOctaS', image2d: 'sdPic' };


/** Bounding radius of a shape of this type about its own position (Infinity: unbounded). */
export function shapeExtent(type: string, size: readonly number[]): number {
  const [a, b, c] = size;
  switch (type) {
    case 'sphere':
    case 'octa':
      return a;
    case 'box':
    case 'rbox':
      return Math.hypot(a, b, c);
    case 'torus':
    case 'capsule':
      return a + b;
    case 'cylinder':
    case 'cone':
      return Math.hypot(a, b);
    case 'image2d':
      return Math.hypot(1.0 * a * 1.42, b);
    default:
      return Infinity;
  }
}

/** `struct Sd` (distance + colour) and the three combine operators with colour blending. */
export const SD_OPS_WGSL = /* wgsl */ `
struct Sd { d: f32, c: vec3f };
fn opUnion(a: Sd, b: Sd, k: f32) -> Sd {
  let h = max(k - abs(a.d - b.d), 0.0) / k;
  return Sd(min(a.d, b.d) - h * h * k * 0.25, mix(a.c, b.c, clamp(0.5 + 0.5 * (a.d - b.d) / k, 0.0, 1.0)));
}
fn opSub(a: Sd, b: Sd, k: f32) -> Sd {
  let nb = -b.d;
  let h = max(k - abs(a.d - nb), 0.0) / k;
  return Sd(max(a.d, nb) + h * h * k * 0.25, mix(a.c, b.c, clamp(0.5 + 0.5 * (nb - a.d) / k, 0.0, 1.0)));
}
fn opInter(a: Sd, b: Sd, k: f32) -> Sd {
  let h = max(k - abs(a.d - b.d), 0.0) / k;
  return Sd(max(a.d, b.d) + h * h * k * 0.25, mix(a.c, b.c, clamp(0.5 + 0.5 * (b.d - a.d) / k, 0.0, 1.0)));
}
`;

/** World to object space (`toLocal`): the object's position, scale and rotation rows `t0..t2` (see `objectUniforms` of the nodes). */
export const TO_LOCAL_WGSL = /* wgsl */ `
fn toLocal(pw: vec3f) -> vec3f {
  let q = pw - u.objPos;
  return vec3f(dot(u.t0, q), dot(u.t1, q), dot(u.t2, q)) / u.objScale;
}
`;

/** The shade function both nodes use when a Material is wired: the BRDF of lib/gen-material.ts in the object's own frame. */
export const materialShadeWgsl = (mat: MaterialValue): string => `${materialWgsl(mat)}
fn shadeSurf(base: vec3f, n: vec3f, rd: vec3f, ao: f32, sh: f32, p: vec3f) -> vec4f {
  let pl = toLocal(p);
  gFoot = pixAt(length(p - u.camPos)) / u.objScale / max(1.0, sqrt(u.aa));
  let nl = vec3f(dot(u.t0, n), dot(u.t1, n), dot(u.t2, n));
  return matShade(base, n, rd, ao, sh, pl, nl, gScr);
}`;

/** The picture of Extruded picture shapes as a small signed field (jump flooding), made once per render. Recycle both with `gpu.recycle`. */
export function preparePicture(gpu: NodeGpu, pic: ImageValue, o: { from: 'alpha' | 'brightness'; threshold: number }): { occ: ImageValue; fld: ImageValue; uniforms: Record<string, UniformValue> } {
  const grid = gridFor(pic, 0, 192);
  const occ = occupancy(gpu, pic, grid, { threshold: Math.max(0.001, o.threshold), fromBrightness: o.from === 'brightness', nearest: false });
  const fld = signedField(gpu, occ, true);
  const long = Math.max(pic.width, pic.height);
  return { occ, fld, uniforms: { grid: [grid.gw, grid.gh], cellW: 2 / Math.max(grid.gw, grid.gh), pic: [pic.width / long, pic.height / long] } };
}

export const SHAPE_KINDS: readonly SdfShapeKind[] = ['sphere', 'box', 'rbox', 'torus', 'capsule', 'cylinder', 'cone', 'plane', 'octa', 'image2d'];
