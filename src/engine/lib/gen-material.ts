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
export function materialWgsl(m: MaterialValue): string {
  const has = (k: keyof MaterialValue['maps']) => !!m.maps[k];
  const tri = m.flags.triplanar;
  const lines: string[] = [];

  // --- texture lookups ---------------------------------------------------------------------------------------------
  lines.push(`
fn matTriW(nl: vec3f) -> vec3f {
  let w0 = pow(abs(nl) + vec3f(1e-4), vec3f(4.0));
  return w0 / (w0.x + w0.y + w0.z);
}
fn matUV(q: vec2f) -> vec2f { return q * u.mD.x + vec2f(0.5) + u.mD.yz; }`);
  const lookup = (key: keyof MaterialValue['maps']): string => {
    const tex = TEX_NAMES[key];
    const s = (uv: string) => `unpremul(textureSampleLevel(${tex}, smp, matUV(${uv}), 0.0))`;
    return `fn tri_${tex}(pl: vec3f, nl: vec3f) -> vec4f {
  ${tri ? `let w = matTriW(nl);\n  return ${s('vec2f(pl.z, -pl.y)')} * w.x + ${s('vec2f(pl.x, pl.z)')} * w.y + ${s('vec2f(pl.x, -pl.y)')} * w.z;` : `return ${s('vec2f(pl.x, -pl.y)')};`}
}`;
  };
  for (const k of ['colorMap', 'normalMap', 'roughnessMap', 'emissionMap'] as const) if (has(k)) lines.push(lookup(k));

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
  const normalCode = has('normalMap')
    ? `{
    ${
      tri
        ? `let w = matTriW(nl);
    let tx = unpremul(textureSampleLevel(matNormal, smp, matUV(vec2f(pl.z, -pl.y)), 0.0)).rgb * 2.0 - 1.0;
    let ty = unpremul(textureSampleLevel(matNormal, smp, matUV(vec2f(pl.x, pl.z)), 0.0)).rgb * 2.0 - 1.0;
    let tz = unpremul(textureSampleLevel(matNormal, smp, matUV(vec2f(pl.x, -pl.y)), 0.0)).rgb * 2.0 - 1.0;
    let pert = w.x * vec3f(0.0, tx.y, tx.x) + w.y * vec3f(ty.x, 0.0, ty.y) + w.z * vec3f(tz.x, tz.y, 0.0);`
        : `let tz = unpremul(textureSampleLevel(matNormal, smp, matUV(vec2f(pl.x, -pl.y)), 0.0)).rgb * 2.0 - 1.0;
    let pert = vec3f(tz.x, tz.y, 0.0);`
    }
    let nl2 = normalize(nl + pert * u.mF.z);
    n = normalize(u.t0 * nl2.x + u.t1 * nl2.y + u.t2 * nl2.z);
  }`
    : '';
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
  let a2 = a * a;
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
  let band = min(floor(diff * st), st - 1.0) / (st - 1.0);
  let H = normalize(L + V);
  let hl = step(0.6, pow(max(dot(n, H), 0.0), 40.0)) * select(0.0, 1.0, diff > 0.0);
  col = alb * (u.ambient * ao * ${ambCol} + (1.0 - u.ambient) * band) + vec3f(hl * u.mA.z);
  if (ndv < u.mE.y) { col = alb * 0.08; }`;
      break;
    case 'emissive':
      model = `${banded}
  col = alb * (0.2 * ao + 0.3 * lit);`;
      break;
    case 'hologram':
      model = `${banded}
  let scan = 0.5 + 0.5 * sin(pl.y * u.mE.z * TAU - u.mD.w);
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
  let line = 1.0 - smoothstep(0.0, max(u.mF.y, 0.002), k);
  col = alb * (0.55 + 0.45 * lit);
  alpha = alpha * line;`;
      break;
  }
  const rimOn = m.flags.rim && m.model !== 'hologram' && m.model !== 'wire' && m.model !== 'matcap';
  lines.push(`
fn matShade(base: vec3f, n0: vec3f, rd: vec3f, ao: f32, sh: f32, pl: vec3f, nl: vec3f, scr: vec2f) -> vec4f {
  var alb = base * u.mBase.rgb;
  var n = n0;
  var alpha = u.mA.w;
  var rough = clamp(u.mA.x, 0.03, 1.0);
  ${has('colorMap') ? 'alb = alb * tri_matColor(pl, nl).rgb;' : ''}
  ${has('roughnessMap') ? 'rough = clamp(rough * luma(tri_matRough(pl, nl).rgb) * 2.0, 0.03, 1.0);' : ''}
  ${normalCode}
  let L = normalize(u.light);
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
