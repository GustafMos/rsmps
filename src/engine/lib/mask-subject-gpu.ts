/**
 * The GPU side of automatic subject extraction, shared by `subject-mask` and `depth-estimate` (one heuristic, not two copies).
 *
 *  - `analyseSubject` reads back ONE small thumbnail (<=128 px) and learns the background / subject colour models plus the
 *    region decisions (which islands and holes belong to the subject). It is the only readback; memoise its result per frame if
 *    you call it for video.
 *  - `subjectScore` is pure GPU: scores a picture of any size against the models. With `gate` it also applies the thumbnail's
 *    region decisions (right for a still picture; for a moving subject leave it off: the colour models alone still follow it).
 */
import type { ImageValue, MaskValue, NodeGpu } from '../types';
import { dilateBin, erodeBin, kmeans, LAB_A_MIN, LAB_A_RANGE, MODEL_SLOTS, packModels, selectSubject, type Cluster, type SubjectSelection } from './mask-subject';
import { fitTo } from './mask-util';

const THUMB = 128;

export interface SubjectModels {
  bg: Cluster[];
  fg: Cluster[];
}

export interface SubjectOptions {
  sensitivity: number;
  centerBias: number;
  cleanup: number;
  regions: 'all' | 'subject' | 'largest';
  fillHoles: number;
}

export const SUBJECT_DEFAULTS: SubjectOptions = { sensitivity: 0.65, centerBias: 0.25, cleanup: 0.4, regions: 'subject', fillHoles: 0.5 };

export interface SubjectAnalysis {
  models: SubjectModels;
  sel: SubjectSelection | null;
  tw: number;
  th: number;
  tol: number;
  centerBias: number;
}

/** Score pass: 1 = subject colours, 0 = background colours, at the size of `src`. */
export function scorePass(gpu: NodeGpu, src: ImageValue, m: SubjectModels, tol: number, centreBias: number): MaskValue {
  const models = gpu.dataTexture(packModels(m.bg, m.fg), MODEL_SLOTS, 2);
  return gpu.passMask({
    label: 'subject-score',
    size: src,
    textures: { src, models },
    uniforms: { nb: Math.min(MODEL_SLOTS, m.bg.length), nf: Math.min(MODEL_SLOTS, m.fg.length), tol, cb: centreBias },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = unpremul(textureSampleLevel(src, smp, uv, 0.0));
  let lab = srgbToOklab(c.rgb);
  var dB = 10.0;
  var dF = 10.0;
  for (var i = 0; i < 16; i++) {
    if (f32(i) < u.nb) {
      let m = textureLoad(models, vec2i(i, 0), 0);
      dB = min(dB, length(lab - m.xyz) / (u.tol + min(2.2 * m.w, 0.06)));
    }
    if (f32(i) < u.nf) {
      let m = textureLoad(models, vec2i(i, 1), 0);
      dF = min(dF, length(lab - m.xyz) / (u.tol + min(2.2 * m.w, 0.06)));
    }
  }
  var s = smoothstep(0.8, 1.5, dB);
  if (u.nf > 0.5) {
    let r = dB * dB / (dB * dB + dF * dF + 1e-4);
    s *= clamp(r * 1.4, 0.0, 1.0);
  }
  let e = length((uv - 0.5) * 2.0);
  s *= 1.0 - u.cb * smoothstep(0.7, 1.25, e);
  s *= c.a;
  return vec4f(vec3f(s), 1.0);
}`,
  });
}

/** Learn the colour models and region decisions from a thumbnail of `img` (one small readback). */
export async function analyseSubject(gpu: NodeGpu, img: ImageValue, o: SubjectOptions): Promise<SubjectAnalysis> {
  const tol = 0.12 - 0.09 * o.sensitivity;
  const thumb = fitTo(gpu, img, THUMB);
  // OKLab is computed on the GPU and read back as bytes (L, a, b, alpha): the CPU side only does integer work.
  const labTex = gpu.pass({
    label: 'subject-lab',
    size: thumb,
    textures: { src: thumb },
    uniforms: { amin: LAB_A_MIN, arange: LAB_A_RANGE },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let l = srgbToOklab(c.rgb);
  return vec4f(l.x, (l.y - u.amin) / u.arange, (l.z - u.amin) / u.arange, c.a);
}`,
  });
  const px = await gpu.read(labTex, false);
  const tw = thumb.width;
  const th = thumb.height;
  const n = tw * th;
  const opaque = (i: number) => px[i * 4 + 3] >= 128;
  const ringW = Math.max(1, ((Math.min(tw, th) * 4 + 50) / 100) | 0);
  const gather = (pred: (i: number, x: number, y: number) => boolean): Uint8Array => {
    const out = new Uint8Array(n * 3);
    let m = 0;
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++) {
        const i = y * tw + x;
        if (opaque(i) && pred(i, x, y)) {
          out[m++] = px[i * 4];
          out[m++] = px[i * 4 + 1];
          out[m++] = px[i * 4 + 2];
        }
      }
    return out.subarray(0, m);
  };
  const inRing = (_i: number, x: number, y: number) => x < ringW || y < ringW || x >= tw - ringW || y >= th - ringW;
  const ringPts = gather(inRing);
  const models: SubjectModels = { bg: ringPts.length >= 18 ? kmeans(ringPts, 16, 1.5) : [], fg: [] };

  const selOpts = { minRatio: o.cleanup * 0.3, mode: o.regions, holeFraction: o.fillHoles };
  let sel = null as SubjectSelection | null;
  for (let round = 0; round < 2; round++) {
    const sc = await gpu.read(scorePass(gpu, thumb, models, tol, o.centerBias), false);
    const score = new Uint8Array(n);
    for (let i = 0; i < n; i++) score[i] = sc[i * 4];
    sel = selectSubject(score, tw, th, selOpts);
    if (round === 0) {
      if (sel.area < 6 || sel.area * 100 > 92 * n) break;
      // Learn the subject colours from the confident core (the background model stays the border-only one: re-learning
      // it from far-away pixels lets bright distractors, which often share colours with the subject, swallow it).
      const core = erodeBin(sel.fg, tw, th, sel.area > 150 ? 1 : 0);
      const fgPts = gather((i) => core[i] === 1 || sel!.holes[i] === 1);
      if (fgPts.length >= 18) models.fg = kmeans(fgPts, 10, 2, 11);
    }
  }
  return { models, sel, tw, th, tol, centerBias: o.centerBias };
}

/** Subject score at the size of `work`, optionally gated by the thumbnail's region decisions (`gate`: use for stills). */
export function subjectScore(gpu: NodeGpu, work: ImageValue, a: SubjectAnalysis, gate: boolean): MaskValue {
  const raw = scorePass(gpu, work, a.models, a.tol, a.centerBias);
  const sel = a.sel;
  if (!gate || !sel) return raw;
  if (sel.area === 0) return gpu.passMask({ label: 'subject-empty', size: raw, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0, 0.0, 0.0, 1.0); }' });
  const { tw, th } = a;
  const n = tw * th;
  const roi = dilateBin(sel.fg, tw, th, 2);
  const fill = dilateBin(sel.holes, tw, th, 1);
  const zone = dilateBin(sel.fg, tw, th, 1);
  const bytes = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) bytes.set([roi[i] ? 255 : 0, fill[i] ? 255 : 0, zone[i] ? 255 : 0, 255], i * 4);
  const gateTex = gpu.upload(bytes, tw, th, 1, false);
  return gpu.passMask({
    label: 'subject-gate',
    size: raw,
    textures: { score: raw, gate: gateTex },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let g = textureSampleLevel(gate, smp, uv, 0.0);
  let s = textureSampleLevel(score, smpNearest, uv, 0.0).r;
  let strong = s * smoothstep(0.15, 0.7, g.r);
  let weak = smoothstep(0.15, 0.4, s) * smoothstep(0.3, 0.8, g.b);
  return vec4f(vec3f(max(max(strong, weak), smoothstep(0.3, 0.7, g.g))), 1.0);
}`,
  });
}
