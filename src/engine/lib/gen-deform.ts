/**
 * The shared "Deform" group of the 3D family: displace by animated noise or by a picture, inflate, twist, bend, taper, morph towards
 * a sphere, melt, explode into shards and a retro "Low-fi vertices" snap. Used by 3D Object (primitives: as a change of the
 * distance function; custom models: in the vertex shader, see model-render.ts), Image to 3D and SDF 3D.
 *
 * Why no standalone "Displace 3D" node: nodes pass pictures and cameras, never meshes, so there is nothing for such a node to
 * deform. The deformation has to live where the geometry lives; this group is that, and the 3D nodes carry the keywords
 * "displace 3d, morph, melt, wobble".
 *
 * STRUCTURE. A feature is compiled in only when its amount is non-zero (`deformFeatures`), so an untouched object pays nothing and a
 * slider moving between two non-zero values never recompiles. Numbers travel in the uniforms dfA..dfD.
 *
 * Raymarched shapes: `dfPoint` bends the DOMAIN (twist, bend, taper, melt, explode, lowfi), `dfDist` changes the DISTANCE (noise,
 * picture, inflate, morph). Both are cheap lower bounds only when the step is shortened: `deformStepScale` does that.
 */
import type { ParamSchema, UniformValue } from '../types';

export const DEFORM_PARAMS = {
  dNoise: { type: 'number', default: 0, min: -1, max: 1, step: 0.005, label: 'Noise displace', group: 'Deform', hint: 'Pushes the surface in and out with 3D noise. Deform amounts are in scene units.' },
  dNoiseScale: { type: 'number', default: 1.5, min: 0.1, max: 10, step: 0.05, softMax: 6, label: 'Noise scale', group: 'Deform', visibleIf: (p: Record<string, unknown>) => p.dNoise !== 0 },
  dNoiseCycles: { type: 'number', default: 0, min: 0, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Noise cycles', group: 'Deform', hint: '0 = still. Whole cycles per loop, so it loops exactly.', visibleIf: (p: Record<string, unknown>) => p.dNoise !== 0 },
  dMap: { type: 'number', default: 0, min: -1, max: 1, step: 0.005, label: 'Displace map', group: 'Deform', hint: 'Wire a picture into Displace map: bright pushes out, dark pulls in.' },
  dMapMode: {
    type: 'enum',
    default: 'triplanar',
    label: 'Picture mapping',
    group: 'Deform',
    visibleIf: (p: Record<string, unknown>) => p.dMap !== 0,
    options: [
      { value: 'triplanar', label: 'Triplanar' },
      { value: 'cylindrical', label: 'Cylindrical' },
    ],
  },
  dInflate: { type: 'number', default: 0, min: -1, max: 1, step: 0.005, label: 'Inflate', group: 'Deform', hint: 'Grows or shrinks the whole surface.' },
  dTwist: { type: 'number', default: 0, min: -720, max: 720, step: 1, unit: 'deg', label: 'Twist', hint: 'Degrees per unit of height.', group: 'Deform' },
  dBend: { type: 'number', default: 0, min: -2, max: 2, step: 0.01, label: 'Bend', group: 'Deform', hint: 'Curls the object around the Z axis.' },
  dTaper: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Taper', group: 'Deform', hint: 'Narrower at the top (positive) or at the bottom (negative).' },
  dMorph: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Morph to sphere', group: 'Deform' },
  dMelt: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Melt', hint: 'Sags downward.', group: 'Deform' },
  dExplode: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Explode', group: 'Deform', hint: 'Splits the object into blocks that move apart.' },
  dExplodeCycles: { type: 'number', default: 0, min: 0, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Explode cycles', group: 'Deform', hint: '0 = the amount above stays. 1 or more = it swells from 0 to the amount and back each cycle.', visibleIf: (p: Record<string, unknown>) => p.dExplode !== 0 },
  dLowFi: { type: 'number', default: 0, min: 0, max: 64, step: 1, softMax: 48, label: 'Low-fi snap', group: 'Deform', hint: 'Snaps the geometry to a coarse grid, like early 3D consoles. 0 = off. Models also get the classic screen-space wobble.' },
} satisfies ParamSchema;

export interface DeformP {
  dNoise: number;
  dNoiseScale: number;
  dNoiseCycles: number;
  dMap: number;
  dMapMode: string;
  dInflate: number;
  dTwist: number;
  dBend: number;
  dTaper: number;
  dMorph: number;
  dMelt: number;
  dExplode: number;
  dExplodeCycles: number;
  dLowFi: number;
}

export interface DeformFeat {
  noise: boolean;
  map: boolean;
  cyl: boolean;
  inflate: boolean;
  twist: boolean;
  bend: boolean;
  taper: boolean;
  morph: boolean;
  melt: boolean;
  explode: boolean;
  lowfi: boolean;
}

/** Which features are compiled in. `hasMap` = the Displace map input is wired. */
export function deformFeatures(p: DeformP, hasMap: boolean): DeformFeat {
  return {
    noise: p.dNoise !== 0,
    map: p.dMap !== 0 && hasMap,
    cyl: p.dMapMode === 'cylindrical',
    inflate: p.dInflate !== 0,
    twist: p.dTwist !== 0,
    bend: p.dBend !== 0,
    taper: p.dTaper !== 0,
    morph: p.dMorph !== 0,
    melt: p.dMelt !== 0,
    explode: p.dExplode !== 0,
    lowfi: p.dLowFi >= 1,
  };
}

export const deformAny = (f: DeformFeat): boolean => Object.entries(f).some(([k, v]) => k !== 'cyl' && v);
export const deformKey = (f: DeformFeat): string => Object.entries(f).map(([k, v]) => (v ? k[0] + k[1] : '')).join('');

/** Does the deform read the clock (animated noise or explode cycles)? Reading `ctx.time` makes the node re-render per frame. */
export const deformAnimated = (p: DeformP): boolean => (p.dNoise !== 0 && p.dNoiseCycles > 0) || (p.dExplode !== 0 && p.dExplodeCycles > 0);

/** Uniforms dfA..dfC (+ `dfStep`, the safe step factor). `phase` = ctx.time.phase when `deformAnimated`, else 0. */
export function deformUniforms(p: DeformP, phase: number): Record<string, UniformValue> {
  const env = p.dExplodeCycles > 0 ? 0.5 - 0.5 * Math.cos(2 * Math.PI * p.dExplodeCycles * phase) : 1;
  return {
    dfA: [p.dNoise, p.dNoiseScale, 2 * Math.PI * p.dNoiseCycles * phase, p.dMap],
    dfB: [p.dInflate, (p.dTwist * Math.PI) / 180, p.dBend, p.dTaper],
    dfC: [p.dMorph, p.dMelt, p.dExplode * env, p.dLowFi >= 1 ? 2 / Math.round(p.dLowFi) : 0],
    dfStep: deformStepScale(p),
  };
}

/** Shorter steps for a bent or displaced domain (the distance is no longer exact). */
export function deformStepScale(p: DeformP): number {
  const k =
    1 +
    Math.abs(p.dNoise) * p.dNoiseScale * 1.2 +
    Math.abs(p.dMap) * 1.5 +
    Math.abs((p.dTwist * Math.PI) / 180) * 0.9 +
    Math.abs(p.dBend) * 0.7 +
    Math.abs(p.dTaper) * 0.6 +
    p.dMelt * 0.8 +
    p.dExplode * 0.6 +
    (p.dLowFi >= 1 ? 0.3 : 0);
  return Math.min(1, 0.9 / k);
}

/** How far the deform can push the surface outward, for bounding volumes (scene units, before object scale). */
export function deformGrow(p: DeformP): number {
  const bend = Math.abs(p.dBend) > 0 || Math.abs(p.dTwist) > 0 || Math.abs(p.dTaper) > 0 || p.dMelt > 0 || p.dExplode > 0 || p.dMorph > 0;
  return Math.abs(p.dNoise) + Math.abs(p.dMap) * 0.5 + Math.max(0, p.dInflate) + (bend ? 1.2 : 0) + (p.dLowFi >= 1 ? 0.5 : 0);
}

/**
 * WGSL: `dfPoint(p)`, `dfDist(p0, p1, d)`. p0 = the point before the domain deform, p1 = after, d = distance of the undeformed
 * object at p1. A picture is bound as `dmap` when `f.map`. Needs vnoise3 (prelude).
 */
export function deformWgsl(f: DeformFeat): string {
  const dom: string[] = [];
  if (f.lowfi) dom.push('let g = u.dfC.w; p = floor(p / g + 0.5) * g;');
  if (f.melt) dom.push(`{
    let m = u.dfC.y;
    let low = smoothstep(0.4, -1.0, p.y);
    p = vec3f(p.x / (1.0 + m * 0.7 * low), p.y, p.z / (1.0 + m * 0.7 * low));
    p.y += m * 0.75 * smoothstep(-1.0, 1.0, p.y) + m * 0.2;
  }`);
  if (f.explode) dom.push(`{
    let cs = 0.5;
    let ctr = (floor(p / cs) + 0.5) * cs;
    let dir = normalize(ctr + vec3f(0.0013, 0.0021, 0.0017));
    p -= dir * u.dfC.z * cs * 1.6;
  }`);
  if (f.taper) dom.push('{ let s = max(1.0 - u.dfB.w * p.y * 0.5, 0.15); p = vec3f(p.x / s, p.y, p.z / s); }');
  if (f.twist) dom.push(`{ let a = u.dfB.y * p.y; let c = cos(a); let s = sin(a); p = vec3f(c * p.x - s * p.z, p.y, s * p.x + c * p.z); }`);
  if (f.bend) dom.push(`{ let a = u.dfB.z * p.x; let c = cos(a); let s = sin(a); p = vec3f(c * p.x - s * p.y, s * p.x + c * p.y, p.z); }`);
  const dist: string[] = [];
  if (f.noise) {
    dist.push(`{
    let amt = u.dfA.x;
    if (abs(d) < abs(amt) * 1.6 + 0.25) {
      let q = p1 * u.dfA.y;
      let o = vec3f(cos(u.dfA.z), sin(u.dfA.z), 0.0) * 0.9;
      let n = vnoise3(q + o) * 0.65 + vnoise3(q * 2.07 + o.yxz * 1.3 + vec3f(5.2, 1.3, 9.1)) * 0.35;
      d -= amt * (n * 2.0 - 1.0) * 1.4;
    } else { d -= abs(amt) * 1.4; }
  }`);
  }
  if (f.map) {
    const sample = f.cyl
      ? 'let m = luma(textureSampleLevel(dmap, smp, vec2f(atan2(p1.x, p1.z) / TAU + 0.5, 0.5 - p1.y * 0.5), 0.0).rgb);'
      : `let w = pow(abs(normalize(p1 + vec3f(1e-5))), vec3f(4.0));
      let ww = w / (w.x + w.y + w.z);
      let m = luma(textureSampleLevel(dmap, smp, p1.yz * 0.5 + 0.5, 0.0).rgb) * ww.x + luma(textureSampleLevel(dmap, smp, p1.xz * 0.5 + 0.5, 0.0).rgb) * ww.y + luma(textureSampleLevel(dmap, smp, p1.xy * 0.5 + 0.5, 0.0).rgb) * ww.z;`;
    dist.push(`{
    let amt = u.dfA.w;
    if (abs(d) < abs(amt) + 0.25) {
      ${sample}
      d -= amt * (m - 0.5) * 2.0;
    } else { d -= abs(amt); }
  }`);
  }
  if (f.inflate) dist.push('d -= u.dfB.x;');
  if (f.morph) dist.push('d = mix(d, length(p1) - 0.9, u.dfC.x);');
  if (f.explode) dist.push(`{
    let cs = 0.5;
    let ctr = (floor(p0 / cs) + 0.5) * cs;
    let q = abs(p0 - ctr) - vec3f(cs * 0.5 - u.dfC.z * cs * 0.3);
    d = max(d, length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0));
  }`);
  return /* wgsl */ `
fn dfPoint(pin: vec3f) -> vec3f {
  var p = pin;
  ${dom.join('\n  ')}
  return p;
}
fn dfDist(p0: vec3f, p1: vec3f, din: f32) -> f32 {
  var d = din;
  ${dist.join('\n  ')}
  return d;
}`;
}
