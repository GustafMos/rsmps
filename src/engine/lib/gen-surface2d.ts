/**
 * The height field of a flat picture as slopes, shared by Material 2D (lighting) and Normal Map (writes the normals).
 *
 * `surfSlope(uv)` = (dh/dx, dh/dy with y UP, height 0..1, 0). Height sources, in texels:
 *   0 bevel       distance inside the silhouette (jump flooding, lib/gen-sdf2d.ts) through a profile (round, chisel, pillow, flat with edge)
 *   1 brightness  the picture's brightness, smoothed
 *   2 flat        none
 *   3 height      a wired height picture (brightness), smoothed
 * plus optional fine relief from the picture's own brightness (`detail`), a wired normal map added as slopes, and tileable lookups.
 *
 * Uniforms read: size, shapeMode, profile, widthPx, hScale, smoothR, detail, nStrength, flipY, cellTex, tile.
 * Textures read: src, fld (hasField), hgt (hasHeight), nrm (hasNormal). Every number is a uniform; the text depends on the structure only.
 */
import { gridFor, occupancy, signedField } from './gen-sdf2d';
import type { ImageValue, NodeGpu } from '../types';

export interface Material2dStructure {
  hasField: boolean;
  hasHeight: boolean;
  hasNormal: boolean;
}

export const SHAPE_ID = { bevel: 0, luma: 1, flat: 2, height: 3 } as const;
export const PROFILE_ID = { round: 0, chisel: 1, pillow: 2, rim: 3 } as const;
/** Height of each profile at full width, as a multiple of the bevel width. */
export const PROFILE_HEIGHT = { round: 1, chisel: 1, pillow: 2.5, rim: 0.5 } as const;
export const FIELD_CAP = { draft: 256, normal: 512, high: 1024 } as const;

/** The silhouette distance field of `art` (r = signed distance in grid cells, negative inside) and the texels per grid cell. Give both textures back with `gpu.recycle`. */
export function silhouetteField(gpu: NodeGpu, art: ImageValue, cap: number, blocky: boolean): { fld: ImageValue; occ: ImageValue; cellTex: number } {
  const g = gridFor(art, 0, cap);
  const occ = occupancy(gpu, art, g, { threshold: 0.5, fromBrightness: false, nearest: blocky });
  const fld = signedField(gpu, occ, !blocky);
  return { fld, occ, cellTex: art.width / g.gw };
}

export function surfaceWgsl(s: Material2dStructure): string {
  const hsrc = s.hasHeight ? 'hgt' : 'src';
  const field = s.hasField
    ? `fn insideD(uv: vec2f) -> f32 { return max(-textureSampleLevel(fld, smp, uv, 0.0).r * u.cellTex, 0.0); }
// profile in 0..1 from the distance inside the silhouette (texels)
fn prof01(d: f32) -> f32 {
  let w = max(u.widthPx, 0.5);
  let k = i32(u.profile + 0.5);
  if (k == 0) { let t = clamp(d / w, 0.0, 1.0); return sqrt(t * (2.0 - t)); }
  if (k == 1) { return clamp(d / w, 0.0, 1.0); }
  if (k == 2) { return sin(clamp(d / (w * 2.5), 0.0, 1.0) * PI * 0.5); }
  let t = clamp(d / (w * 0.5), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
fn shapeH(uv: vec2f) -> f32 { return prof01(insideD(uv)) * u.hScale; }`
    : '';
  const bevel = s.hasField
    ? `if (mode == 0) {
    let e = max(u.cellTex * 0.75, 1.0);
    let ex = ex1 * e;
    let ey = ey1 * e;
    sx = (shapeH(uv + ex) - shapeH(uv - ex)) / (2.0 * e);
    sy = -(shapeH(uv + ey) - shapeH(uv - ey)) / (2.0 * e);
    hn = prof01(insideD(uv));
  }`
    : '';
  const normal = s.hasNormal
    ? `{
    let tn = unpremul(textureSampleLevel(nrm, smp, uv, 0.0)).rgb * 2.0 - 1.0;
    let tz = max(tn.z, 0.25);
    sx += -tn.x / tz * u.nStrength;
    sy += -(tn.y * u.flipY) / tz * u.nStrength;
  }`
    : '';
  return /* wgsl */ `
fn lumaPm(t: texture_2d<f32>, uv0: vec2f) -> f32 {
  let uv = select(uv0, fract(uv0), u.tile > 0.5);
  return luma(textureSampleLevel(t, smp, uv, 0.0).rgb);
}
${field}
fn surfSlope(uv: vec2f) -> vec4f {
  let ex1 = vec2f(1.0 / u.size.x, 0.0);
  let ey1 = vec2f(0.0, 1.0 / u.size.y);
  var sx = 0.0;
  var sy = 0.0;
  var hn = 0.0;
  let mode = i32(u.shapeMode + 0.5);
  ${bevel}
  if (mode == 1 || mode == 3) {
    let r = max(u.smoothR, 1.0);
    let e1 = r * 0.5;
    let e2 = r;
    let gx = 0.5 * ((lumaPm(${hsrc}, uv + ex1 * e1) - lumaPm(${hsrc}, uv - ex1 * e1)) / (2.0 * e1) + (lumaPm(${hsrc}, uv + ex1 * e2) - lumaPm(${hsrc}, uv - ex1 * e2)) / (2.0 * e2));
    let gy = 0.5 * ((lumaPm(${hsrc}, uv + ey1 * e1) - lumaPm(${hsrc}, uv - ey1 * e1)) / (2.0 * e1) + (lumaPm(${hsrc}, uv + ey1 * e2) - lumaPm(${hsrc}, uv - ey1 * e2)) / (2.0 * e2));
    sx = gx * u.hScale;
    sy = -gy * u.hScale;
    hn = lumaPm(${hsrc}, uv);
  }
  if (u.detail > 0.0) {
    let gx = (lumaPm(src, uv + ex1) - lumaPm(src, uv - ex1)) * 0.5;
    let gy = (lumaPm(src, uv + ey1) - lumaPm(src, uv - ey1)) * 0.5;
    sx += gx * u.detail * 3.0;
    sy -= gy * u.detail * 3.0;
  }
  ${normal}
  return vec4f(sx, sy, hn, 0.0);
}
`;
}
