/**
 * Materials for the 3D family. The Material node makes a `MaterialValue` (plain numbers + optional pictures); 3D Object (primitives),
 * Image to 3D and SDF 3D read it through `materialWgsl` / `materialUniforms` / `materialTextures`.
 *
 * Shader per MODEL: the generated `matShade` contains exactly the model's code and the texture lookups of the pictures that are
 * wired, nothing else (a matte material has no specular, a material without maps no texture reads). The structure is `materialKey`;
 * every number is a uniform, so moving a Material slider never compiles anything.
 *
 * Lighting stays the family's lights (`u.light`, `u.ambient`, `u.cel`, `u.steps`). Textures are mapped triplanar (or planar from the
 * front when the Material says so) in OBJECT space, so they stay on the object when it spins. Colours are blended in sRGB like the
 * rest of the family.
 */
import type { ImageValue, MaterialValue, UniformValue } from '../types';

export type MatModel = MaterialValue['model'];

const TEX_NAMES = { colorMap: 'matColor', normalMap: 'matNormal', roughnessMap: 'matRough', emissionMap: 'matEmit', matcap: 'matcapTex', environment: 'matEnvTex', background: 'matBgTex' } as const;

/** Textures to bind for a material (null = absent, `gpu.pass` skips them). */
export function materialTextures(m: MaterialValue | null): Record<string, ImageValue | null> {
  const out: Record<string, ImageValue | null> = {};
  for (const [k, name] of Object.entries(TEX_NAMES)) out[name] = m ? m.maps[k as keyof MaterialValue['maps']] : null;
  return out;
}

/** Structure of the generated shader: what differs here is a different shader, nothing else. */
export function materialKey(m: MaterialValue | null): string {
  if (!m) return 'nomat';
  const f = m.flags;
  const maps = Object.entries(m.maps)
    .map(([k, v]) => (v ? k[0] + k[1] : ''))
    .join('');
  return `${m.model}${f.clay ? '-clay' : ''}${f.triplanar ? '-tri' : ''}${f.emission ? '-em' : ''}${f.rim ? '-rim' : ''}${f.envAmbient ? '-ea' : ''}:${maps}`;
}

/** Uniform values (`phase` is already inside `d`). */
export function materialUniforms(m: MaterialValue): Record<string, UniformValue> {
  return { mBase: [...m.base, 1], mA: m.a, mB: m.b, mC: m.c, mD: m.d, mE: m.e, mF: m.f, skyT: [...m.skyTop, 1], skyH: [...m.skyHorizon, 1], skyB: [...m.skyBottom, 1] };
}

/** The `alpha` multiplier a material contributes (opacity lives in `a.w`; per-pixel opacity is inside the generated shader). */
export function materialWgsl(m: MaterialValue, opts: { mesh?: boolean; lightArgs?: boolean } = {}): string {
  const mesh = !!opts.mesh;
  const lightArgs = !!opts.lightArgs;
  const has = (k: keyof MaterialValue['maps']) => !!m.maps[k];
  const tri = m.flags.triplanar;
  const lines: string[] = [];
  // Mesh mode (rasterised models): `gMeshUv` = (2u - 1, 1 - 2v, has UVs) and the surface's tangent / bitangent (`gMeshT`, `gMeshB`) are
  // set by the caller. A model with UVs reads its maps through them; without UVs everything is the object-space (triplanar) path.
  if (mesh) lines.push('var<private> gMeshUv: vec3f;\nvar<private> gMeshT: vec3f;\nvar<private> gMeshB: vec3f;');

  // --- texture lookups ---------------------------------------------------------------------------------------------
  lines.push(`
fn matTriW(nl: vec3f) -> vec3f {
  let w0 = pow(abs(nl) + vec3f(1e-4), vec3f(4.0));
  return w0 / (w0.x + w0.y + w0.z);
}
fn matUV(q: vec2f) -> vec2f { return q * u.mD.x + vec2f(0.5) + u.mD.yz; }`);
  // gFoot = size of one pixel on the surface in the object's own units (0 = no filtering: rasterised users). Maps that are shown smaller than
  // their pixels are averaged over that footprint (3x3 taps) instead of read at one point, which would shimmer.
  lines.push('var<private> gFoot: f32;');
  const lookup = (key: keyof MaterialValue['maps']): string => {
    const tex = TEX_NAMES[key];
    const s = (uv: string) => `tap_${tex}(matUV(${uv}))`;
    return `fn tri_${tex}(pl: vec3f, nl: vec3f) -> vec4f {
  ${mesh ? `if (gMeshUv.z > 0.5) { return ${s('vec2f(gMeshUv.x, -gMeshUv.y)')}; }` : ''}
  ${tri ? `let w = matTriW(nl);\n  return ${s('vec2f(pl.z, -pl.y)')} * w.x + ${s('vec2f(pl.x, pl.z)')} * w.y + ${s('vec2f(pl.x, -pl.y)')} * w.z;` : `return ${s('vec2f(pl.x, -pl.y)')};`}
}`;
  };
  for (const k of ['colorMap', 'normalMap', 'roughnessMap', 'emissionMap'] as const) {
    if (!has(k)) continue;
    const tex = TEX_NAMES[k];
    lines.push(`fn tap_${tex}(uv: vec2f) -> vec4f {
  let fp = gFoot * u.mD.x;
  let dims = vec2f(textureDimensions(${tex}));
  if (fp * max(dims.x, dims.y) <= 1.0) { return unpremul(textureSampleLevel(${tex}, smp, uv, 0.0)); }
  var acc = vec4f(0.0);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) { acc += unpremul(textureSampleLevel(${tex}, smp, uv + vec2f(f32(i), f32(j)) * (fp * 0.33), 0.0)); }
  }
  return acc / 9.0;
}`);
    lines.push(lookup(k));
  }

  // --- environment -------------------------------------------------------------------------------------------------
  lines.push(
    has('environment')
      ? `fn matEnvAt(dir: vec3f) -> vec3f {
  let uv = vec2f(atan2(dir.x, dir.z) / TAU + 0.5, 0.5 - asin(clamp(dir.y, -1.0, 1.0)) / PI);
  return unpremul(textureSampleLevel(matEnvTex, smp, uv, 0.0)).rgb;
}`
      : `fn matEnvAt(dir: vec3f) -> vec3f {
  return mix(mix(u.skyB.rgb, u.skyH.rgb, smoothstep(-0.6, 0.0, dir.y)), u.skyT.rgb, smoothstep(0.0, 0.8, dir.y));
}`,
  );

  // --- the model -----------------------------------------------------------------------------------------------------
  let normalCode = has('normalMap')
    ? `{
    ${
      tri
        ? `let w = matTriW(nl);
    let tx = tap_matNormal(matUV(vec2f(pl.z, -pl.y))).rgb * 2.0 - 1.0;
    let ty = tap_matNormal(matUV(vec2f(pl.x, pl.z))).rgb * 2.0 - 1.0;
    let tz = tap_matNormal(matUV(vec2f(pl.x, -pl.y))).rgb * 2.0 - 1.0;
    let pert = w.x * vec3f(0.0, tx.y, tx.x) + w.y * vec3f(ty.x, 0.0, ty.y) + w.z * vec3f(tz.x, tz.y, 0.0);`
        : `let tz = tap_matNormal(matUV(vec2f(pl.x, -pl.y))).rgb * 2.0 - 1.0;
    let pert = vec3f(tz.x, tz.y, 0.0);`
    }
    let nl2 = normalize(nl + pert * u.mF.z);
    n = normalize(u.t0 * nl2.x + u.t1 * nl2.y + u.t2 * nl2.z);
  }`
    : '';
  if (mesh && has('normalMap')) {
    // UV path: tangent-space normal from the model's own coordinates, applied on the world tangent / bitangent of the surface.
    normalCode = `if (gMeshUv.z > 0.5) {
    let tm = tap_matNormal(matUV(vec2f(gMeshUv.x, -gMeshUv.y))).rgb * 2.0 - 1.0;
    n = normalize(n + (gMeshT * tm.x + gMeshB * tm.y) * u.mF.z);
  } else ${normalCode}`;
  }
  const ambCol = m.flags.envAmbient ? 'mix(vec3f(1.0), matEnvAt(n) * 1.5, u.mE.w)' : 'vec3f(1.0)';
  const banded = `var lit = diff;
  if (u.cel > 0.5) { lit = min(floor(diff * u.steps), u.steps - 1.0) / (u.steps - 1.0); }`;
  let model = '';
  switch (m.model) {
    case 'lambert':
      model = `${m.flags.clay ? 'let diff2 = clamp(dot(n, L) * 0.7 + 0.3, 0.0, 1.0) * sh;' : 'let diff2 = diff;'}
  var lit = diff2;
  if (u.cel > 0.5) { lit = min(floor(diff2 * u.steps), u.steps - 1.0) / (u.steps - 1.0); }
  col = alb * (u.ambient * ao * ${ambCol} + (1.0 - u.ambient) * lit);`;
      break;
    case 'pbr':
      model = `${banded}
  let H = normalize(L + V);
  let ndh = max(dot(n, H), 0.0);
  let vdh = max(dot(V, H), 0.0);
  let metal = clamp(u.mA.y, 0.0, 1.0);
  let f0 = mix(vec3f(0.04) * (0.25 + u.mA.z), alb, metal);
  let F = f0 + (vec3f(1.0) - f0) * pow(1.0 - vdh, 5.0);
  let a = rough * rough;
  let a2 = min(a * a + gFoot * gFoot * 0.25, 1.0);
  let dd = ndh * ndh * (a2 - 1.0) + 1.0;
  let D = min(a2 / (PI * dd * dd), 40.0);
  var sp = F * (D * 0.25 / max(ndv, 0.25)) * diff;
  if (u.cel > 0.5) { sp = vec3f(step(0.5, max(sp.x, max(sp.y, sp.z)))) * F; }
  let Fe = f0 + (vec3f(1.0) - f0) * pow(1.0 - ndv, 5.0) * (1.0 - rough);
  col = alb * (1.0 - metal) * (u.ambient * ao * ${ambCol} + (1.0 - u.ambient) * lit) + sp * u.mA.z * 4.0 + matEnvAt(reflect(rd, n)) * Fe * (1.0 - rough * 0.7) * ao;`;
      break;
    case 'glass':
      model = `let H = normalize(L + V);
  let F = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
  let off = vec2f(dot(n, u.camRight), -dot(n, u.camUp)) * u.mF.y;
  ${
    has('background')
      ? 'let refr = unpremul(textureSampleLevel(matBgTex, smp, clamp(scr + off, vec2f(0.0), vec2f(1.0)), 0.0)).rgb * alb;'
      : 'let refr = matEnvAt(refract(rd, n, 0.75)) * alb;'
  }
  let gl = pow(max(dot(n, H), 0.0), mix(300.0, 40.0, rough)) * diff;
  col = mix(refr, matEnvAt(reflect(rd, n)), F) + vec3f(gl * (0.4 + u.mA.z));
  alpha = clamp(alpha + F * (1.0 - alpha) + gl, 0.0, 1.0);`;
      break;
    case 'toon':
      model = `let st = max(u.mE.x, 2.0);
  let bw = max(gFoot * 0.9, 1e-4);
  var band = 0.0;
  for (var bi = 1; bi < 8; bi++) {
    if (f32(bi) >= st) { break; }
    band += smoothstep(f32(bi) / st - bw, f32(bi) / st + bw, diff);
  }
  band = band / (st - 1.0);
  let H = normalize(L + V);
  let hl = smoothstep(0.6 - bw, 0.6 + bw, pow(max(dot(n, H), 0.0), 40.0)) * select(0.0, 1.0, diff > 0.0);
  col = alb * (u.ambient * ao * ${ambCol} + (1.0 - u.ambient) * band) + vec3f(hl * u.mA.z);
  if (ndv < u.mE.y) { col = alb * 0.08; }`;
      break;
    case 'emissive':
      model = `${banded}
  col = alb * (0.2 * ao + 0.3 * lit);`;
      break;
    case 'hologram':
      model = `${banded}
  let scanFade = 1.0 - smoothstep(0.25, 0.5, gFoot * u.mE.z);
  let scan = 0.5 + 0.5 * sin(pl.y * u.mE.z * TAU - u.mD.w) * scanFade;
  let fres = pow(1.0 - ndv, u.mF.x);
  col = alb * (0.25 + 0.75 * scan) * (0.55 + 0.45 * lit) + u.mC.rgb * fres * u.mC.w * 1.5;
  alpha = clamp((0.2 + 0.5 * scan + fres) * alpha, 0.0, 1.0);`;
      break;
    case 'matcap':
      model = has('matcap')
        ? `let mc = vec2f(dot(n, u.camRight), -dot(n, u.camUp)) * 0.5 + 0.5;
  col = alb * unpremul(textureSampleLevel(matcapTex, smp, mc, 0.0)).rgb;`
        : `let nv = vec3f(dot(n, u.camRight), dot(n, u.camUp), -dot(n, u.camFwd));
  let lv = normalize(vec3f(-0.5, 0.6, 0.7));
  col = alb * (0.2 + 0.8 * max(dot(nv, lv), 0.0)) + vec3f(pow(max(dot(nv, normalize(lv + vec3f(0.0, 0.0, 1.0))), 0.0), 30.0) * 0.4);`;
      break;
    case 'wire':
      model = `${banded}
  let g = abs(fract(pl * u.mE.z) - 0.5);
  let k = 0.5 - max(g.x, max(g.y, g.z));
  let lw = max(u.mF.y, 0.002);
  let fpc = gFoot * u.mE.z * 1.2;
  let lwe = max(lw, fpc);
  var line = (1.0 - smoothstep(0.0, lwe, k)) * (lw / lwe);
  line = mix(line, clamp(3.0 * lw, 0.0, 1.0), smoothstep(0.3, 0.7, fpc));
  col = alb * (0.55 + 0.45 * lit);
  alpha = alpha * line;`;
      break;
  }
  model = model.replaceAll('u.ambient', 'amb');
  const rimOn = m.flags.rim && m.model !== 'hologram' && m.model !== 'wire' && m.model !== 'matcap';
  lines.push(`
fn ${lightArgs ? 'matShadeL' : 'matShade'}(base: vec3f, n0: vec3f, rd: vec3f, ao: f32, sh: f32, pl: vec3f, nl: vec3f, scr: vec2f${lightArgs ? ', lightIn: vec3f, ambIn: f32' : ''}) -> vec4f {
  let amb = ${lightArgs ? 'ambIn' : 'u.ambient'};
  var alb = base * u.mBase.rgb;
  var n = n0;
  var alpha = u.mA.w;
  var rough = clamp(u.mA.x, 0.03, 1.0);
  ${has('colorMap') ? 'alb = alb * tri_matColor(pl, nl).rgb;' : ''}
  ${has('roughnessMap') ? 'rough = clamp(rough * luma(tri_matRough(pl, nl).rgb) * 2.0, 0.03, 1.0);' : ''}
  ${normalCode}
  let L = normalize(${lightArgs ? 'lightIn' : 'u.light'});
  let V = -rd;
  let ndv = clamp(dot(n, V), 0.0, 1.0);
  let diff = max(dot(n, L), 0.0) * sh;
  var col = vec3f(0.0);
  ${model}
  ${m.flags.emission ? `col += u.mB.rgb * u.mB.w${has('emissionMap') ? ' * tri_matEmit(pl, nl).rgb' : ''};` : ''}
  ${rimOn ? 'col += u.mC.rgb * u.mC.w * pow(1.0 - ndv, u.mF.x);' : ''}
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), alpha);
}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------------------------------------------------------------- */
/* Rasterised users (custom models, 3D Array cards): the SAME `matShade` above, fed from a uniform buffer + texture group.     */
/* ------------------------------------------------------------------------------------------------------------------------- */

/** Binding numbers of the material group of a rasterised shader. */
export const MAT_BINDING = { buffer: 0, colorMap: 1, normalMap: 2, roughnessMap: 3, emissionMap: 4, matcap: 5, environment: 6, background: 7, sampler: 8 } as const;
const MAT_MAP_KEYS = ['colorMap', 'normalMap', 'roughnessMap', 'emissionMap', 'matcap', 'environment', 'background'] as const;
const MAT_BUF_VEC4 = 12;

/**
 * WGSL of a material for a rasteriser: the declarations of its group, the private `u` that `matShade` reads (filled by `matSetup`
 * from the buffer plus the camera and surface frame the caller knows) and `matShade` itself (`materialWgsl`). Needs PRELUDE.
 * `mesh` adds the model-UV path (`gMeshUv`, `gMeshT`, `gMeshB`).
 */
export function materialRasterWgsl(m: MaterialValue, group: number, mesh: boolean): string {
  const decl = MAT_MAP_KEYS.filter((k) => m.maps[k])
    .map((k) => `@group(${group}) @binding(${MAT_BINDING[k]}) var ${TEX_NAMES[k]}: texture_2d<f32>;`)
    .join('\n');
  return /* wgsl */ `
struct MatU {
  light: vec3f, ambient: f32, cel: f32, steps: f32,
  camRight: vec3f, camUp: vec3f, camFwd: vec3f, t0: vec3f, t1: vec3f, t2: vec3f,
  mBase: vec4f, mA: vec4f, mB: vec4f, mC: vec4f, mD: vec4f, mE: vec4f, mF: vec4f, skyT: vec4f, skyH: vec4f, skyB: vec4f,
};
var<private> u: MatU;
struct MatBuf { v: array<vec4f, ${MAT_BUF_VEC4}> };
@group(${group}) @binding(${MAT_BINDING.buffer}) var<uniform> mb: MatBuf;
@group(${group}) @binding(${MAT_BINDING.sampler}) var smp: sampler;
${decl}
fn matSetup(cr: vec3f, cu: vec3f, cf: vec3f, t0: vec3f, t1: vec3f, t2: vec3f) {
  u.mBase = mb.v[0]; u.mA = mb.v[1]; u.mB = mb.v[2]; u.mC = mb.v[3]; u.mD = mb.v[4]; u.mE = mb.v[5]; u.mF = mb.v[6];
  u.skyT = mb.v[7]; u.skyH = mb.v[8]; u.skyB = mb.v[9];
  u.light = mb.v[10].xyz; u.ambient = mb.v[10].w; u.cel = mb.v[11].x; u.steps = mb.v[11].y;
  u.camRight = cr; u.camUp = cu; u.camFwd = cf; u.t0 = t0; u.t1 = t1; u.t2 = t2;
}
${materialWgsl(m, { mesh })}`;
}

/** The uniform buffer contents (48 floats) for `materialRasterWgsl`. `viewSize` = (width, height) of the render target (glass reads the background by screen position). */
export function materialRasterData(m: MaterialValue, o: { light: readonly number[]; ambient: number; cel: boolean; steps: number; width: number; height: number }): Float32Array<ArrayBuffer> {
  const d = new Float32Array(MAT_BUF_VEC4 * 4);
  d.set([...m.base, 1, ...m.a, ...m.b, ...m.c, ...m.d, ...m.e, ...m.f, ...m.skyTop, 1, ...m.skyHorizon, 1, ...m.skyBottom, 1, o.light[0], o.light[1], o.light[2], o.ambient, o.cel ? 1 : 0, Math.max(2, Math.round(o.steps)), o.width, o.height]);
  return d;
}

export const MATERIAL_RASTER_BYTES = MAT_BUF_VEC4 * 16;

/** Bind group layout for one material structure (create it once per pipeline). */
export function materialRasterLayout(device: GPUDevice, m: MaterialValue): GPUBindGroupLayout {
  const entries: GPUBindGroupLayoutEntry[] = [
    { binding: MAT_BINDING.buffer, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: MAT_BINDING.sampler, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ];
  for (const k of MAT_MAP_KEYS) if (m.maps[k]) entries.push({ binding: MAT_BINDING[k], visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } });
  return device.createBindGroupLayout({ entries });
}

/** Bind group for a material's pictures + uniform buffer. `view` is `gpu.view`. */
export function materialRasterGroup(device: GPUDevice, layout: GPUBindGroupLayout, m: MaterialValue, buffer: GPUBuffer, sampler: GPUSampler, view: (t: GPUTexture) => GPUTextureView): GPUBindGroup {
  const entries: GPUBindGroupEntry[] = [
    { binding: MAT_BINDING.buffer, resource: { buffer, size: MATERIAL_RASTER_BYTES } },
    { binding: MAT_BINDING.sampler, resource: sampler },
  ];
  for (const k of MAT_MAP_KEYS) {
    const img = m.maps[k];
    if (img) entries.push({ binding: MAT_BINDING[k], resource: view(img.texture) });
  }
  return device.createBindGroup({ layout, entries });
}

/**
 * How much of a ground shadow a material casts: its opacity, and half of it for the hologram (whose pixels average about half
 * transparent). A solid material casts the full shadow.
 */
export const materialShadowFactor = (m: MaterialValue | null | undefined): number => (m ? Math.min(1, Math.max(0, m.a[3] * (m.model === 'hologram' ? 0.5 : 1))) : 1);
