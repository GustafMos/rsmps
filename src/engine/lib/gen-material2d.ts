/**
 * Material 2D: the Material node's look on a flat picture. ONE lighting pass (+ the silhouette distance field when the shape is a bevel).
 *
 * The shading is the SAME `matShade` the 3D family and the rasterised users call (lib/gen-material.ts, `lightArgs` variant: the light
 * and the ambient arrive as arguments so a second light costs one more call, not a second shader). Here the "scene" is a height
 * field seen from the front: the camera looks along +z with x right and y up, so a surface that faces the viewer has the world
 * normal (0, 0, -1) (the 3D family's convention: lights come from -z) and a tangent-space normal map value (nx, ny, nz) becomes
 * (nx, ny, -nz). Normal maps are OpenGL style (green = up) unless `flipY`.
 *
 * Height field, in texels (all lengths arrive in texels of the picture; the art-grid rule hands this code the small art image, so
 * "texel" is then one art pixel):
 *   bevel  distance inside the silhouette (jump flooding, lib/gen-sdf2d.ts) through a profile (round, chisel, pillow, flat with edge)
 *   luma   the picture's brightness, smoothed
 *   flat   none
 *   map    a wired height picture (replaces the shape)
 * plus optional fine relief from the picture's own luminance (`detail`) and a wired normal map (added as slopes).
 *
 * Every number is a uniform. The shader text depends only on the material MODEL (and its flags / wired pictures) and on which of
 * field / height / normal exist, so moving a slider never compiles anything.
 */
import { materialWgsl } from './gen-material';
import { surfaceWgsl, type Material2dStructure } from './gen-surface2d';
import type { MaterialValue } from '../types';

/** A glossy plastic: what Material 2D uses while no Material is wired. */
export function defaultMaterial2d(): MaterialValue {
  return {
    kind: 'material',
    model: 'pbr',
    flags: { clay: false, triplanar: false, emission: false, rim: false, sky: true, envAmbient: false },
    base: [1, 1, 1],
    a: [0.3, 0, 0.6, 1],
    b: [1, 0.8, 0.4, 0],
    c: [0.7, 0.9, 1, 0],
    d: [0.5, 0, 0, 0],
    e: [3, 0.25, 10, 0],
    f: [3, 0.12, 1, 0],
    skyTop: [0.55, 0.7, 0.95],
    skyHorizon: [0.85, 0.88, 0.92],
    skyBottom: [0.25, 0.22, 0.2],
    maps: { colorMap: null, normalMap: null, roughnessMap: null, emissionMap: null, matcap: null, environment: null, background: null },
  };
}

/** Light direction toward the light in the 3D family's frame. `angle` is clockwise from the top of the picture (90 = from the right), `height` 90 = straight at the viewer. */
export function lightDir2d(angleDeg: number, heightDeg: number): [number, number, number] {
  const a = (angleDeg * Math.PI) / 180;
  const e = (heightDeg * Math.PI) / 180;
  return [Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), -Math.sin(e)];
}


/** The Material 2D pass shader. `m` fixes the model and the wired pictures; `s` says which helper pictures exist. */
export function material2dWgsl(m: MaterialValue, s: Material2dStructure): string {
  const wire = m.model === 'wire';
  return /* wgsl */ `
${materialWgsl(m, { lightArgs: true })}
${surfaceWgsl(s)}

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smp, uv, 0.0);
  let a0 = c.a;
  if (u.outMode < 0.5 && a0 < 0.002 && u.shadowAmt <= 0.0) { return vec4f(0.0); }
  let ss = surfSlope(uv);
  let hn = ss.z;
  let nt = normalize(vec3f(-ss.x, -ss.y, 1.0));
  if (u.outMode > 1.5) { return vec4f(hn, hn, hn, 1.0); }
  if (u.outMode > 0.5) { return vec4f(nt.x * 0.5 + 0.5, nt.y * 0.5 + 0.5, nt.z * 0.5 + 0.5, 1.0); }

  // ---- lighting ----
  let nW = vec3f(nt.x, nt.y, -nt.z);
  let img = unpremul(c).rgb;
  let base = mix(vec3f(1.0), img, u.useImg);
  let pl = ${wire ? 'vec3f(hn - 0.5 / max(u.mE.z, 1.0))' : 'vec3f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0)'};
  let rd = vec3f(0.0, 0.0, 1.0);
  let nl = vec3f(0.0, 0.0, 1.0);
  var res = matShadeL(base, nW, rd, 1.0, 1.0, pl, nl, uv, u.light, u.ambient);
  var rgb = res.rgb;
  if (u.extra > 0.5) {
    // the light's own contribution (lit minus unlit) is tinted and scaled; the fill light adds a second one
    let away = normalize(vec3f(0.0, 0.001, 1.0));
    let amb = matShadeL(base, nW, rd, 1.0, 1.0, pl, nl, uv, away, u.ambient);
    rgb = amb.rgb + (res.rgb - amb.rgb) * u.keyCol.rgb;
    if (u.fillCol.a > 0.0) {
      let fl = matShadeL(base, nW, rd, 1.0, 1.0, pl, nl, uv, u.fillL, u.ambient);
      rgb += (fl.rgb - amb.rgb) * u.fillCol.rgb;
    }
  }
  var alpha = a0 * res.a;
  if (u.glassSolid > 0.5) { alpha = a0; }
  var obj = vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)) * alpha, alpha);

  // ---- drop / contact shadow: the blurred silhouette, offset away from the light ----
  if (u.shadowAmt > 0.0) {
    var sa = 0.0;
    for (var i = 0; i < 12; i++) {
      let fi = f32(i) + 0.5;
      let ang = fi * 2.399963;
      let rr = sqrt(fi / 12.0) * u.shadowBlur;
      let o = u.shadowOff + vec2f(cos(ang), sin(ang)) * rr;
      sa += textureSampleLevel(src, smp, uv - o / u.size, 0.0).a;
    }
    sa = sa / 12.0 * u.shadowAmt * u.shadowCol.a;
    obj = obj + vec4f(u.shadowCol.rgb * sa, sa) * (1.0 - obj.a);
  }
  return obj;
}
`;
}
