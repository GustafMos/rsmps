import { gridFor, occupancy, signedField } from './gen-sdf2d';
import { analyseSubject, subjectScore, SUBJECT_DEFAULTS, type SubjectAnalysis } from './mask-subject-gpu';
import { asImage, fitTo } from './mask-util';
import type { ImageValue, MaskValue, NodeGpu, ParamSchema } from '../types';

/**
 * Depth from Picture: an instant, no-download GUESS of how far away every part of a picture is, built from cheap visual cues.
 * Output convention (lib/depth.ts): white = near, black = far, r = g = b in 0..1, rgba16float. Not a measurement: a layered
 * depth that makes Picture to Splats / Lens Blur / Depth Slice / Image to 3D relief look plausible. An AI depth model, when added, plugs
 * into the same sockets.
 *
 * Pipeline, all on the GPU at a reduced "work" size (quarter / half / full of the picture):
 *   guide (box downsample) -> feat (sharpness, gradient, saturation, blueness) -> blur (2, at reduced size) -> combine (cues, subject dome,
 *   sky) -> cross-bilateral smoothing (2 x 2 separable passes guided by the picture) -> final (joint-bilateral upsample to picture size,
 *   detail, levels, contrast, gamma, range, invert, paint corrections).
 * Nothing is normalised per frame: every cue maps a fixed range to 0..1, so video does not flicker. "Stabilize" can stretch the result
 * to the full range using a range measured ONCE at a chosen moment (a memo, like automatic white balance).
 */

const QUALITY: Record<string, number> = { draft: 0.25, normal: 0.5, full: 1 };

/** A preset overrides the controls it lists. */
const PRESETS: Record<string, Record<string, number>> = {
  portrait: { ground: 0.25, horizon: 0.4, curve: 1, room: 0, sky: 0, focus: 0.45, subject: 1, pull: 0.55, roundness: 0.8, domeSize: 0.12, haze: 0.1, brightness: 0, color: 0, motion: 0, smooth: 0.5, detail: 0.15 },
  landscape: { ground: 1, horizon: 0.4, curve: 1.2, room: 0, sky: 0.7, focus: 0.15, subject: 0, haze: 0.7, brightness: 0, color: 0, motion: 0, smooth: 0.7, detail: 0.2 },
  room: { ground: 0.6, horizon: 0.45, curve: 1, room: 0.7, sky: 0, focus: 0.25, subject: 0.4, pull: 0.4, roundness: 0.6, domeSize: 0.1, haze: 0.15, brightness: 0, color: 0, motion: 0, smooth: 0.6, detail: 0.2 },
  graphic: { ground: 0, room: 0, sky: 0, focus: 0, subject: 0.8, pull: 0.6, roundness: 0.5, domeSize: 0.1, haze: 0, brightness: 0.4, color: 0, motion: 0, smooth: 0.3, detail: 0.5, edge: 1 },
  moving: { ground: 0.3, horizon: 0.4, curve: 1, room: 0, sky: 0.2, focus: 0.2, subject: 0.3, pull: 0.4, haze: 0.1, brightness: 0, color: 0, motion: 1, smooth: 0.6, detail: 0.2 },
  flat: { ground: 0, room: 0, sky: 0, focus: 0, subject: 1, pull: 0.6, roundness: 0.7, domeSize: 0.12, haze: 0, brightness: 0, color: 0, motion: 0, smooth: 0.5, detail: 0.1 },
};

export interface DepthHeuristicParams {
  preset: string;
  quality: string;
  ground: number;
  horizon: number;
  curve: number;
  room: number;
  sky: number;
  focus: number;
  focusSpread: number;
  haze: number;
  brightness: number;
  color: number;
  pickColor: number[];
  subject: number;
  pull: number;
  roundness: number;
  domeSize: number;
  motion: number;
  motionScale: number;
  smooth: number;
  edge: number;
  detail: number;
  contrast: number;
  gamma: number;
  nearLevel: number;
  farLevel: number;
  invert: boolean;
  paint: number;
  stabilize: boolean;
  analysisAt: number;
}

/** Frozen estimates: pure memos of pure functions of (node, upstream structure, moment, settings). */
const analysisMemo = new Map<string, SubjectAnalysis>();
const levelsMemo = new Map<string, [number, number]>();
const remember = <V>(m: Map<string, V>, key: string, v: V): V => {
  m.set(key, v);
  while (m.size > 64) m.delete(m.keys().next().value as string);
  return v;
};

/** Separable gaussian on rgba16float data at reduced size: sigma in texels of `src`; the result is src / down in each direction. */
const BLUR_WGSL = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let sd = vec2f(textureDimensions(src));
  let stepUv = u.dir * u.stride / sd;
  let box = u.dir * u.stride * 0.25 / sd;
  let n = i32(u.n);
  var acc = vec4f(0.0);
  var tot = 0.0;
  for (var i = -12; i <= 12; i++) {
    if (i < -n || i > n) { continue; }
    let w = exp(-0.5 * f32(i * i) / (u.sigma * u.sigma));
    let q = uv + stepUv * f32(i);
    var s = textureSampleLevel(src, smp, q, 0.0);
    if (u.stride > 1.5) { s = 0.5 * (textureSampleLevel(src, smp, q + box, 0.0) + textureSampleLevel(src, smp, q - box, 0.0)); }
    acc += s * w;
    tot += w;
  }
  return acc / tot;
}`;

function blurDown(gpu: NodeGpu, src: ImageValue, sigmaTexels: number): ImageValue {
  const sigma = Math.max(0.8, sigmaTexels);
  const down = Math.max(1, Math.ceil(sigma / 3.5));
  const so = sigma / down;
  const n = Math.min(12, Math.ceil(so * 3));
  const w = Math.max(1, Math.round(src.width / down));
  const h = Math.max(1, Math.round(src.height / down));
  const common = { sigma: so, n, stride: down };
  const hz = gpu.pass({ label: 'depth blur-h', size: { width: w, height: src.height, unit: src.unit / down }, format: 'rgba16float', textures: { src }, uniforms: { ...common, dir: [1, 0] }, wgsl: BLUR_WGSL });
  const vt = gpu.pass({ label: 'depth blur-v', size: { width: w, height: h, unit: src.unit / down }, format: 'rgba16float', textures: { src: hz }, uniforms: { ...common, dir: [0, 1] }, wgsl: BLUR_WGSL });
  gpu.recycle(hz);
  return vt;
}

const FEAT_WGSL = /* wgsl */ `
fn lum(uv: vec2f) -> f32 { return luma(unpremul(textureSampleLevel(src, smp, uv, 0.0)).rgb); }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let t = 1.0 / u.size;
  let l0 = lum(uv);
  let xp = lum(uv + vec2f(t.x, 0.0)); let xm = lum(uv - vec2f(t.x, 0.0));
  let yp = lum(uv + vec2f(0.0, t.y)); let ym = lum(uv - vec2f(0.0, t.y));
  let xp2 = lum(uv + vec2f(2.0 * t.x, 0.0)); let xm2 = lum(uv - vec2f(2.0 * t.x, 0.0));
  let yp2 = lum(uv + vec2f(0.0, 2.0 * t.y)); let ym2 = lum(uv - vec2f(0.0, 2.0 * t.y));
  let lap1 = abs(4.0 * l0 - (xp + xm + yp + ym)) * 0.25;
  let lap2 = abs(4.0 * l0 - (xp2 + xm2 + yp2 + ym2)) * 0.25;
  let grad = (abs(xp - xm) + abs(yp - ym)) * 0.5;
  let c = unpremul(textureSampleLevel(src, smp, uv, 0.0));
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let sat = select(0.0, (mx - mn) / mx, mx > 0.02);
  let blue = clamp((c.b - c.r) * 0.5 + 0.5, 0.0, 1.0);
  return vec4f(lap1 * 0.7 + lap2 * 0.3, grad, sat, blue);
}`;

interface Rough {
  /** work-size picture used as the guide */
  guide: ImageValue;
  /** cue blend (and subject, sky), before smoothing */
  d0: ImageValue;
  /** edge-aware smoothed */
  ds: ImageValue;
}

interface RoughIn {
  image: ImageValue;
  subject: ImageValue | MaskValue | null;
  flow: ImageValue | null;
  analysis: SubjectAnalysis | null;
  gate: boolean;
}

function rough(gpu: NodeGpu, p: DepthHeuristicParams, inp: RoughIn, quality: number): Rough {
  const src = inp.image;
  const ww = Math.max(1, Math.round(src.width * quality));
  const wh = Math.max(1, Math.round(src.height * quality));
  const work = { width: ww, height: wh, unit: src.unit * (ww / src.width) };
  const long = Math.max(ww, wh);

  // 1. guide
  const guide =
    quality >= 0.999
      ? src
      : gpu.pass({
          label: 'depth guide',
          size: work,
          textures: { src },
          uniforms: { off: Math.max(0.25, (src.width / ww) * 0.25) },
          wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let t = u.off / vec2f(textureDimensions(src));
  return 0.25 * (textureSampleLevel(src, smp, uv + vec2f(t.x, t.y), 0.0) + textureSampleLevel(src, smp, uv + vec2f(-t.x, t.y), 0.0) + textureSampleLevel(src, smp, uv + vec2f(t.x, -t.y), 0.0) + textureSampleLevel(src, smp, uv + vec2f(-t.x, -t.y), 0.0));
}`,
        });

  // 2. features and their regional average (normalised convolution: sharpness is hf energy relative to gradient energy)
  const feat = gpu.pass({ label: 'depth feat', size: work, format: 'rgba16float', textures: { src: guide }, wgsl: FEAT_WGSL });
  const featB = blurDown(gpu, feat, Math.max(0.8, p.focusSpread * long));
  gpu.recycle(feat);

  // 3. subject mask (wired or internal) at work size, and its dome field
  let subj: ImageValue | MaskValue | null = inp.subject;
  if (!subj && p.subject > 0 && inp.analysis) subj = subjectScore(gpu, asImage(guide), inp.analysis, inp.gate);
  let field: ImageValue | null = null;
  let domeCells = 1;
  if (subj && p.subject > 0 && p.roundness > 0) {
    const grid = gridFor(work, 0.5, 128);
    domeCells = Math.max(1, p.domeSize * Math.max(grid.gw, grid.gh));
    const occ = occupancy(gpu, asImage(subj), grid, { threshold: 0.5, fromBrightness: true, nearest: false });
    field = signedField(gpu, occ, true);
    gpu.recycle(occ);
  }
  const flow = p.motion > 0 ? inp.flow : null;

  // 4. combine
  const pick = p.pickColor ?? [1, 0.2, 0.2, 1];
  const d0 = gpu.pass({
    label: `depth combine${subj ? ' subj' : ''}${field ? ' dome' : ''}${flow ? ' flow' : ''}`,
    size: work,
    format: 'rgba16float',
    textures: { guide, feat: featB, subj: subj ?? null, field: field ?? null, flow: flow ?? null },
    uniforms: {
      wGround: p.ground,
      horizon: p.horizon,
      curve: p.curve,
      wRoom: p.room,
      sky: p.sky,
      wFocus: p.focus,
      wHaze: p.haze,
      brightness: p.brightness,
      color: p.color,
      pick: [pick[0] ?? 1, pick[1] ?? 0, pick[2] ?? 0],
      wMotion: p.motion,
      motionScale: Math.max(0.01, p.motionScale),
      srcSize: [src.width, src.height],
      subject: p.subject,
      pull: p.pull,
      roundness: p.roundness,
      domeCells,
    },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = unpremul(textureSampleLevel(guide, smp, uv, 0.0));
  let L = luma(c.rgb);
  let f = textureSampleLevel(feat, smp, uv, 0.0);
  let hfB = f.x; let gradB = f.y; let satB = f.z; let blueB = f.w;
  var sum = 0.0;
  var wsum = 0.0;
  // ground: lower in the frame = nearer
  if (u.wGround > 0.0) {
    let tg = clamp((uv.y - u.horizon) / max(1.0 - u.horizon, 0.05), 0.0, 1.0);
    sum += u.wGround * pow(tg, u.curve); wsum += u.wGround;
  }
  // room: centre far, edges near
  if (u.wRoom > 0.0) {
    let r = length((uv - 0.5) * 2.0) * 0.7071;
    sum += u.wRoom * smoothstep(0.2, 0.95, r); wsum += u.wRoom;
  }
  // focus: sharp edges relative to the gradient energy
  if (u.wFocus > 0.0) {
    let ratio = hfB / (gradB + 0.012);
    sum += u.wFocus * clamp(ratio * 2.2 - 0.1, 0.0, 1.0); wsum += u.wFocus;
  }
  // haze: low contrast, low saturation, bluish = far
  if (u.wHaze > 0.0) {
    let h = 0.4 * clamp(gradB * 8.0, 0.0, 1.0) + 0.35 * clamp(satB * 1.6, 0.0, 1.0) + 0.25 * (1.0 - smoothstep(0.4, 0.8, blueB));
    sum += u.wHaze * h; wsum += u.wHaze;
  }
  if (u.brightness != 0.0) {
    sum += abs(u.brightness) * select(1.0 - L, L, u.brightness > 0.0); wsum += abs(u.brightness);
  }
  if (u.color != 0.0) {
    let dl = length(srgbToOklab(c.rgb) - srgbToOklab(u.pick));
    let m = 1.0 - smoothstep(0.05, 0.3, dl);
    sum += abs(u.color) * select(1.0 - m, m, u.color > 0.0); wsum += abs(u.color);
  }
  ${
    flow
      ? `if (u.wMotion > 0.0) {
    let mv = textureSampleLevel(flow, smp, uv, 0.0).rg * u.srcSize;
    sum += u.wMotion * clamp(length(mv) / u.motionScale, 0.0, 1.0); wsum += u.wMotion;
  }`
      : ''
  }
  var d = select(0.3, sum / max(wsum, 1e-5), wsum > 0.0);
  // sky: smooth areas above the horizon are far
  if (u.sky > 0.0) {
    let above = 1.0 - smoothstep(u.horizon - 0.15, u.horizon + 0.05, uv.y);
    d = d * (1.0 - u.sky * above * (1.0 - smoothstep(0.02, 0.15, gradB)));
  }
  ${
    subj
      ? `if (u.subject > 0.0) {
    let m = clamp(textureSampleLevel(subj, smp, uv, 0.0).r, 0.0, 1.0);
    var shape = 1.0;
    ${
      field
        ? `let inside = max(0.0, -textureSampleLevel(field, smp, uv, 0.0).r);
    let t = clamp(inside / u.domeCells, 0.0, 1.0);
    let dome = sqrt(max(0.0, 1.0 - (1.0 - t) * (1.0 - t)));
    shape = mix(1.0, 0.35 + 0.65 * dome, u.roundness);`
        : ''
    }
    d = d + (1.0 - d) * u.subject * m * u.pull * shape;
  }`
      : ''
  }
  return vec4f(clamp(d, 0.0, 1.0), 0.0, 0.0, 1.0);
}`,
  });
  gpu.recycle(featB);
  if (field) gpu.recycle(field);

  // 5. edge-aware smoothing guided by the picture: 2 iterations of a separable cross-bilateral filter
  const csig = 0.6 - 0.5 * p.edge;
  const radius0 = 1 + p.smooth * 0.045 * long;
  let cur: ImageValue = d0;
  const iterations = p.smooth > 0.001 ? 2 : 0;
  for (let it = 0; it < iterations; it++) {
    for (const dir of [[1, 0], [0, 1]]) {
      const prev = cur;
      cur = gpu.pass({
        label: 'depth bilateral',
        size: work,
        format: 'rgba16float',
        textures: { val: cur, guide },
        uniforms: { dir, rad: radius0 * (it === 0 ? 1 : 0.55), csig },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let sd = vec2f(textureDimensions(val));
  let stepUv = u.dir * u.rad / 5.0 / sd;
  let gc = textureSampleLevel(guide, smp, uv, 0.0);
  var acc = 0.0;
  var tot = 0.0;
  for (var i = -5; i <= 5; i++) {
    let q = uv + stepUv * f32(i);
    let dc = sqrt(max(textureSampleLevel(guide, smp, q, 0.0), vec4f(0.0))) - sqrt(max(gc, vec4f(0.0)));
    let w = exp(-f32(i * i) * 0.08 - dot(dc, dc) / (u.csig * u.csig));
    acc += w * textureSampleLevel(val, smp, q, 0.0).r;
    tot += w;
  }
  return vec4f(acc / tot, 0.0, 0.0, 1.0);
}`,
      });
      if (prev !== d0) gpu.recycle(prev);
    }
  }
  return { guide, d0, ds: cur };
}

/** Two-percentile range of the smoothed depth of a frame (one tiny readback; call it for the frozen moment only). */
async function measureLevels(gpu: NodeGpu, ds: ImageValue): Promise<[number, number]> {
  const small = fitTo(gpu, ds, 64);
  const px = await gpu.read(small, false);
  const n = small.width * small.height;
  const vals = new Uint8Array(n);
  for (let i = 0; i < n; i++) vals[i] = px[i * 4];
  vals.sort();
  let lo = vals[Math.floor(n * 0.02)] / 255;
  let hi = vals[Math.min(n - 1, Math.floor(n * 0.98))] / 255;
  if (hi - lo < 0.08) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.04;
    hi = mid + 0.04;
  }
  return [lo, hi];
}

/** The parameter schema of Depth from Picture, shared with AI Depth (whose stand-in is this same estimate with these defaults). */
export const DEPTH_PARAMS = {
    preset: {
      type: 'enum',
      default: 'custom',
      label: 'Look',
      hint: 'A preset overrides the cue controls it lists. Choose Custom to use every control as set.',
      options: [
        { value: 'custom', label: 'Custom' },
        { value: 'portrait', label: 'Portrait' },
        { value: 'landscape', label: 'Landscape' },
        { value: 'room', label: 'Room / interior' },
        { value: 'graphic', label: 'Graphic / logo' },
        { value: 'moving', label: 'Moving camera' },
        { value: 'flat', label: 'Flat with subject' },
      ],
    },
    quality: {
      type: 'enum',
      default: 'normal',
      label: 'Work size',
      hint: 'The depth is worked out at this share of the picture size and enlarged along picture edges. Half is plenty for depth.',
      options: [
        { value: 'draft', label: 'Quarter' },
        { value: 'normal', label: 'Half' },
        { value: 'full', label: 'Full' },
      ],
    },
    ground: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Ground', group: 'Position cues', hint: 'Lower in the frame = nearer. All cue strengths are relative weights: 0 turns a cue off.' },
    horizon: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, unit: 'norm', label: 'Horizon', group: 'Position cues', hint: 'Height of the horizon from the top. Everything above it is farthest for the Ground cue.' },
    curve: { type: 'number', default: 1, min: 0.3, max: 3, step: 0.01, label: 'Ground curve', group: 'Position cues', hint: 'Above 1 keeps the middle distance far and only the foreground near.' },
    room: { type: 'number', default: 0.15, min: 0, max: 1, step: 0.01, label: 'Room', group: 'Position cues', hint: 'Interior prior: the middle of the frame is far, the edges are near.' },
    sky: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Sky', group: 'Position cues', hint: 'Smooth areas above the horizon are pushed to far.' },
    focus: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Focus', group: 'Picture cues', hint: 'Sharp, in-focus detail is nearer; soft, blurred areas are farther.' },
    focusSpread: { type: 'number', default: 0.025, min: 0.005, max: 0.25, step: 0.005, unit: 'norm', label: 'Focus spread', group: 'Picture cues', hint: 'How far (share of the long side) sharpness and haze are averaged, so texture does not turn into depth noise.' },
    haze: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Haze', group: 'Picture cues', hint: 'Low contrast, low saturation and bluish = far (landscapes).' },
    brightness: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Brightness', group: 'Picture cues', hint: 'Positive: lighter is nearer. Negative: darker is nearer.' },
    color: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Color', group: 'Picture cues', hint: 'Positive: the picked color is nearer. Negative: it is farther. For graphics and logos.' },
    pickColor: { type: 'color', default: [1, 0.2, 0.2, 1], label: 'Picked color', group: 'Picture cues', visibleIf: (p) => (p.color as number) !== 0 },
    subject: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Subject', group: 'Subject', hint: 'Pulls the subject forward. Uses the wired Subject mask, or finds the subject itself the way Subject Mask does (from the image border colors).' },
    pull: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Pull forward', group: 'Subject', hint: 'Share of the way from the surroundings to the nearest depth.' },
    roundness: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Roundness', group: 'Subject', hint: 'Domes the subject: its middle comes forward, its edges stay back, so it is rounded rather than a flat cut-out.' },
    domeSize: { type: 'number', default: 0.1, min: 0.01, max: 0.5, step: 0.005, unit: 'norm', label: 'Dome size', group: 'Subject', hint: 'How far from the subject edge (share of the long side) the dome rises to full height.' },
    motion: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Motion', group: 'Motion', hint: 'Needs the Flow input (Optical Flow node). Faster-moving parts are nearer. Only meaningful when the CAMERA moves over a still scene; smooth the result with the time nodes.' },
    motionScale: { type: 'number', default: 12, min: 0.5, max: 400, softMax: 100, step: 0.5, unit: 'px', label: 'Motion scale', group: 'Motion', hint: 'Motion per frame that counts as the nearest.' },
    smooth: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Flatten regions', group: 'Smoothing', hint: 'Averages depth inside regions of similar color so regions are flat and depth edges snap to picture edges.' },
    edge: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Edge snap', group: 'Smoothing', hint: 'Higher stops smoothing at smaller color differences.' },
    detail: { type: 'number', default: 0.15, min: 0, max: 1, step: 0.01, label: 'Detail', group: 'Smoothing', hint: 'How much fine structure of the raw cues survives the smoothing.' },
    contrast: { type: 'number', default: 1.5, min: 0.2, max: 3, step: 0.01, label: 'Contrast', group: 'Output' },
    gamma: { type: 'number', default: 1, min: 0.3, max: 3, step: 0.01, label: 'Gamma', group: 'Output', hint: 'Above 1 darkens the middle (more of the scene is far).' },
    nearLevel: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Near level', group: 'Output', hint: 'Output value of the nearest depth. Move both levels toward each other for a shallower scene.' },
    farLevel: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Far level', group: 'Output', hint: 'Output value of the farthest depth.' },
    invert: { type: 'bool', default: false, label: 'Invert', group: 'Output', hint: 'Black = near.' },
    paint: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Paint strength', group: 'Corrections', hint: 'Paint a Paint Mask and wire it to Nearer paint (white pulls nearer) or Farther paint (white pushes farther). The brush softness of the Paint Mask is the falloff. Applied last.' },
    stabilize: { type: 'bool', default: false, label: 'Stabilize', group: 'Video', hint: 'Stretches the depth to the full range using a range measured once at the moment below, so it never flickers. Off = fixed ranges (also flicker-free).' },
    analysisAt: { type: 'number', default: 0, min: 0, max: 3600, softMax: 60, step: 0.05, unit: 's', label: 'Analyze at', group: 'Video', hint: 'Moment used for the frozen measurements (Stabilize, and the automatic subject colors on moving pictures).' },
} satisfies ParamSchema;

/** Every default of `DEPTH_PARAMS`. */
export function depthHeuristicDefaults(): DepthHeuristicParams {
  const out: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(DEPTH_PARAMS as ParamSchema)) out[k] = (def as { default: unknown }).default;
  return out as unknown as DepthHeuristicParams;
}

/** What the estimate needs from a node's render context (a node with only some of the optional inputs passes null for the others). */
export interface DepthHeuristicCtx {
  gpu: NodeGpu;
  nodeId: string;
  item: { readonly index: number };
  inputSignature(input: string): string;
  inputVaries(input: string): boolean;
  pull(input: string, at?: { seconds?: number }): Promise<unknown>;
  wants(output: string): boolean;
  in: { image: ImageValue; subjectMask?: MaskValue | null; nearer?: MaskValue | null; farther?: MaskValue | null; flow?: ImageValue | null };
}

/** The colour overlay of a depth picture on its source (far: blue, near: red-orange). Shared with AI Depth. */
/**
 * A depth map as a MASK (coverage = nearness: white = near), so it can go straight into any mask input: limit an effect to the
 * foreground, fade it with distance. Mask Invert selects the background; Mask Levels narrows it to a band of depth.
 */
export function depthMaskPass(gpu: NodeGpu, depth: ImageValue): MaskValue {
  return gpu.passMask({
    label: 'depth mask',
    size: depth,
    textures: { src: depth },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let m = clamp(textureSampleLevel(src, smpNearest, uv, 0.0).r, 0.0, 1.0);
  return vec4f(m, m, m, 1.0);
}`,
  });
}

export function depthPreviewPass(gpu: NodeGpu, src: ImageValue, depth: ImageValue): ImageValue {
  return gpu.pass({
        label: 'depth preview',
        size: src,
        textures: { src, depth },
        wgsl: /* wgsl */ `
fn ramp(t: f32) -> vec3f {
  // far: deep blue -> teal -> yellow -> near: red-orange
  let a = mix(vec3f(0.10, 0.12, 0.45), vec3f(0.10, 0.60, 0.60), smoothstep(0.0, 0.35, t));
  let b = mix(a, vec3f(0.95, 0.85, 0.25), smoothstep(0.35, 0.7, t));
  return mix(b, vec3f(0.95, 0.30, 0.15), smoothstep(0.7, 1.0, t));
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = unpremul(textureSampleLevel(src, smp, uv, 0.0));
  let d = textureSampleLevel(depth, smp, uv, 0.0).r;
  return premul(vec4f(mix(c.rgb, ramp(d), 0.6), c.a));
}`,
      });
}

/** The whole Depth from Picture render: a depth picture (white = near) and, when wanted, the colour preview. */
export async function renderDepthHeuristic(ctx: DepthHeuristicCtx, params: DepthHeuristicParams): Promise<{ depth: ImageValue; preview: ImageValue | null; mask: MaskValue | null }> {
    const { gpu } = ctx;
    const src = ctx.in.image;
    const p = { ...params };
    if (p.preset !== 'custom') Object.assign(p, PRESETS[p.preset] ?? {});
    const q = QUALITY[p.quality] ?? 0.5;
    const varies = ctx.inputVaries('image');

    // the subject colours are learned once (a moving picture: at `analysisAt`); scoring them is pure GPU every frame
    let analysis: SubjectAnalysis | null = null;
    if (!ctx.in.subjectMask && p.subject > 0) {
      const key = `${ctx.nodeId}|${ctx.inputSignature('image')}|${varies ? p.analysisAt : 'still'}|${ctx.item.index}`;
      analysis = analysisMemo.get(key) ?? null;
      if (!analysis) {
        const at = varies ? (((await ctx.pull('image', { seconds: p.analysisAt })) as ImageValue | null) ?? src) : src;
        analysis = remember(analysisMemo, key, await analyseSubject(gpu, fitTo(gpu, at, 256), SUBJECT_DEFAULTS));
      }
    }
    const inp: RoughIn = { image: src, subject: ctx.in.subjectMask ?? null, flow: ctx.in.flow ?? null, analysis, gate: !varies };
    const r = rough(gpu, p, inp, q);

    // frozen levels
    let lo = 0;
    let hi = 1;
    if (p.stabilize) {
      const key = `${ctx.nodeId}|${ctx.inputSignature('image')}|${p.analysisAt}|${ctx.item.index}|${JSON.stringify([p.quality, p.ground, p.horizon, p.curve, p.room, p.sky, p.focus, p.focusSpread, p.haze, p.brightness, p.color, p.pickColor, p.motion, p.motionScale, p.subject, p.pull, p.roundness, p.domeSize, p.smooth, p.edge, !!ctx.in.subjectMask, !!ctx.in.flow])}`;
      let lv = levelsMemo.get(key);
      if (!lv) {
        let rr = r;
        if (varies) {
          const at = ((await ctx.pull('image', { seconds: p.analysisAt })) as ImageValue | null) ?? src;
          const subjAt = ctx.in.subjectMask && ctx.inputVaries('subjectMask') ? (((await ctx.pull('subjectMask', { seconds: p.analysisAt })) as MaskValue | null) ?? ctx.in.subjectMask) : (ctx.in.subjectMask ?? null);
          const flowAt = ctx.in.flow && ctx.inputVaries('flow') ? (((await ctx.pull('flow', { seconds: p.analysisAt })) as ImageValue | null) ?? ctx.in.flow) : (ctx.in.flow ?? null);
          rr = rough(gpu, p, { image: at, subject: subjAt, flow: flowAt, analysis, gate: false }, q);
        }
        lv = remember(levelsMemo, key, await measureLevels(gpu, rr.ds));
      }
      [lo, hi] = lv;
    }

    // final: joint-bilateral upsample, detail, levels, contrast / gamma / range / invert, then paint
    const csig = 0.6 - 0.5 * p.edge;
    const depth = gpu.pass({
      label: `depth final${ctx.in.nearer ? ' near' : ''}${ctx.in.farther ? ' far' : ''}`,
      size: src,
      format: 'rgba16float',
      textures: { src, glow: r.guide, dsm: r.ds, dzero: r.d0, nearer: ctx.in.nearer ?? null, farther: ctx.in.farther ?? null },
      uniforms: {
        csig,
        detail: p.detail,
        lo,
        hi: Math.max(hi, lo + 0.02),
        contrast: p.contrast,
        gamma: p.gamma,
        nearLevel: p.nearLevel,
        farLevel: p.farLevel,
        inv: p.invert,
        paint: p.paint,
      },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let ld = vec2f(textureDimensions(dsm));
  let pp = uv * ld - 0.5;
  let b = floor(pp + 0.5);
  let gc = textureSampleLevel(src, smp, uv, 0.0);
  var acc = 0.0;
  var tot = 0.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let t = b + vec2f(f32(i), f32(j));
      let tuv = (t + 0.5) / ld;
      let dd = pp - t;
      let ws = exp(-dot(dd, dd) * 1.3);
      let dc = sqrt(max(textureSampleLevel(glow, smpNearest, tuv, 0.0), vec4f(0.0))) - sqrt(max(gc, vec4f(0.0)));
      let w = ws * exp(-dot(dc, dc) / (u.csig * u.csig));
      acc += w * textureSampleLevel(dsm, smpNearest, tuv, 0.0).r;
      tot += w;
    }
  }
  let lin = textureSampleLevel(dsm, smp, uv, 0.0).r;
  var v = mix(lin, acc / max(tot, 1e-6), clamp(tot * 30.0, 0.0, 1.0));
  v = mix(v, textureSampleLevel(dzero, smp, uv, 0.0).r, u.detail);
  v = clamp((v - u.lo) / (u.hi - u.lo), 0.0, 1.0);
  v = clamp((v - 0.5) * u.contrast + 0.5, 0.0, 1.0);
  v = pow(v, u.gamma);
  v = mix(u.farLevel, u.nearLevel, v);
  if (u.inv > 0.5) { v = 1.0 - v; }
  ${ctx.in.nearer ? 'v += u.paint * textureSampleLevel(nearer, smp, uv, 0.0).r;' : ''}
  ${ctx.in.farther ? 'v -= u.paint * textureSampleLevel(farther, smp, uv, 0.0).r;' : ''}
  v = clamp(v, 0.0, 1.0);
  return vec4f(v, v, v, 1.0);
}`,
    });
    gpu.recycle(r.d0);
    gpu.recycle(r.ds);
    if (r.guide !== src) gpu.recycle(r.guide);

    const preview = ctx.wants('preview') ? depthPreviewPass(gpu, src, depth) : null;
    return { depth, preview, mask: ctx.wants('mask') ? depthMaskPass(gpu, depth) : null };
}
