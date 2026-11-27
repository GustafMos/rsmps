import { defineNode } from '../../define';
import type { ParamDef } from '../../types';
import { assignEffects, type GiveMode } from '../../lib/region-fx-assign';
import { areaOf, validRegions } from '../../lib/track-core';
import { MAX_REGIONS, REGION_WGSL, regionTable } from '../../lib/track-gpu';

const GIVE = [
  { value: 'all', label: 'All regions get A' },
  { value: 'cycle', label: 'Take turns by region' },
  { value: 'size', label: 'By size, largest first' },
  { value: 'left', label: 'Left to right' },
  { value: 'top', label: 'Top to bottom' },
  { value: 'label', label: 'By label or id' },
  { value: 'random', label: 'Random per region' },
] as const;
const GIVE_HINTS: Record<(typeof GIVE)[number]['value'], string> = {
  all: 'Every region gets effect A. Example: pixelate everything that moves.',
  cycle: 'Regions take turns A, B, C, D in the order they appeared. Example: every other object is blurred.',
  size: 'The biggest region gets A, the next B, and so on. Example: blur the biggest, pixelate the rest.',
  left: 'The region furthest left gets A, the next B, and so on.',
  top: 'The region highest up gets A, the next B, and so on.',
  label: 'You type which labels or ids get each effect. Example: A gets "person", B gets "car".',
  random: 'Each region gets a random effect that stays the same for that region. Change Seed to reshuffle.',
};

/** Where an effect slot gets its look from. 'wire' / 'off' use only the wired picture; the rest are built in (see BUILTIN_WGSL). */
const FX = [
  { value: 'wire', label: 'From its wire' },
  { value: 'off', label: 'Off' },
  { value: 'pixelate', label: 'Pixelate' },
  { value: 'blur', label: 'Blur' },
  { value: 'invert', label: 'Invert' },
  { value: 'bw', label: 'Black and white' },
  { value: 'tint', label: 'Tint' },
  { value: 'brighten', label: 'Brighten' },
  { value: 'darken', label: 'Darken' },
  { value: 'outline', label: 'Outline' },
  { value: 'hide', label: 'Hide, see through' },
  { value: 'solid', label: 'Solid color' },
] as const;
type FxKind = (typeof FX)[number]['value'];
/** Index of a built-in in the shader (0 = none). */
const BUILTIN_ID: Record<string, number> = { pixelate: 1, blur: 2, invert: 3, bw: 4, tint: 5, brighten: 6, darken: 7, outline: 8, hide: 9, solid: 10 };
const FX_HINT = 'Built-in effects need no wiring. To use your own effect instead, wire a picture into the matching Effect picture socket.';
const FX_OPTION_HINTS: Partial<Record<FxKind, string>> = {
  wire: 'Uses the picture wired into this effect. Nothing happens until you wire one.',
  off: 'Not used. A picture wired into this effect picture socket is still used.',
  pixelate: 'Big blocky pixels, for example to hide faces.',
  blur: 'Soft focus, for example to hide a number plate.',
  invert: 'Flips the colors to a negative.',
  bw: 'Removes the color.',
  tint: 'Colors the area with the color below.',
  brighten: 'Makes the area lighter or glowing.',
  darken: 'Makes the area darker.',
  outline: 'Turns the area into a line drawing.',
  hide: 'Makes the area see through, so what is behind shows.',
  solid: 'Covers the area with the color below, like a censor bar.',
};
const COLOR_FX = (k: unknown) => k === 'tint' || k === 'solid';
const EFFECTS = ['A', 'B', 'C', 'D'] as const;

const SHAPES = [
  { value: 'rect', label: 'Box' },
  { value: 'rounded', label: 'Rounded box' },
  { value: 'ellipse', label: 'Ellipse' },
] as const;

const LABEL_HINT = 'Labels or ids, comma separated, e.g. "person, 12". A word matches any label that contains it.';
const byLabel = (p: Record<string, unknown>) => p.give === 'label';

/** The built-in effects, chosen by uniforms (bk = kind per effect, ba = amount, bc0..bc3 = color) so switching them never compiles a new shader. */
const BUILTIN_WGSL = /* wgsl */ `
fn bfxLuma(p: vec2f) -> f32 { return luma(textureSampleLevel(src, smp, p / u.size, 0.0).rgb); }
fn builtinFx(kind: i32, amt: f32, col: vec4f, org: vec4f, uv: vec2f, px: vec2f) -> vec4f {
  let m = min(u.size.x, u.size.y);
  let a = org.a;
  let c = select(vec3f(0.0), org.rgb / max(a, 0.0001), a > 0.0001);
  var o = c;
  if (kind == 1) {
    let cell = amt * 0.06 * m;
    if (cell < 1.5) { return org; }
    let ctr = (floor(px / cell) + vec2f(0.5)) * cell;
    let q = cell * 0.25;
    let t = textureSampleLevel(src, smp, (ctr + vec2f(-q, -q)) / u.size, 0.0) + textureSampleLevel(src, smp, (ctr + vec2f(q, -q)) / u.size, 0.0)
          + textureSampleLevel(src, smp, (ctr + vec2f(-q, q)) / u.size, 0.0) + textureSampleLevel(src, smp, (ctr + vec2f(q, q)) / u.size, 0.0);
    return t * 0.25;
  }
  if (kind == 2) {
    let r = amt * 0.03 * m;
    if (r < 0.5) { return org; }
    var acc = vec4f(0.0);
    for (var j = 0; j < 24; j++) {
      let fj = f32(j);
      let rr = sqrt((fj + 0.5) / 24.0);
      let th = fj * 2.39996323;
      acc += textureSampleLevel(src, smp, (px + vec2f(cos(th), sin(th)) * rr * r) / u.size, 0.0);
    }
    return acc / 24.0;
  }
  if (kind == 3) { o = mix(c, vec3f(1.0) - c, amt); }
  else if (kind == 4) { o = mix(c, vec3f(luma(c)), amt); }
  else if (kind == 5) { o = mix(c, clamp(col.rgb * (0.2 + 1.1 * luma(c)), vec3f(0.0), vec3f(1.0)), amt); }
  else if (kind == 6) { o = clamp(c * (1.0 + amt) + vec3f(amt * 0.1), vec3f(0.0), vec3f(1.0)); }
  else if (kind == 7) { o = c * (1.0 - 0.9 * amt); }
  else if (kind == 8) {
    let d = max(1.0, m * 0.002);
    let gx = bfxLuma(px + vec2f(d, 0.0)) - bfxLuma(px - vec2f(d, 0.0));
    let gy = bfxLuma(px + vec2f(0.0, d)) - bfxLuma(px - vec2f(0.0, d));
    o = mix(c, vec3f(clamp(length(vec2f(gx, gy)) * 4.0, 0.0, 1.0)), amt);
  }
  else if (kind == 9) { return org * (1.0 - amt); }
  else if (kind == 10) { return mix(org, vec4f(col.rgb * col.a, col.a), amt); }
  return vec4f(o * a, a);
}
`;

/**
 * WGSL for one variant. `fxIdx` lists the effect pictures that are wired (0..3); `matte` = a shape mask is wired.
 * Regions are drawn largest first, so the smallest region has the last word where regions overlap.
 */
function shader(kind: 'image' | 'mask', fxIdx: number[], matte: boolean): string {
  const sampleFx = (k: number) => `sampleCrisp(fx${k + 1}, uv, vec2f(textureDimensions(fx${k + 1})) / u.size)`;
  const L = ['x', 'y', 'z', 'w'];
  const branches = [0, 1, 2, 3]
    .map((k) => `  if (k == ${k}) { return ${fxIdx.includes(k) ? sampleFx(k) : `builtinFx(i32(u.bk.${L[k]}), u.ba.${L[k]}, u.bc${k}, org, uv, px)`}; }`)
    .join('\n');
  const head = /* wgsl */ `
${REGION_WGSL}
fn regCov(i: i32, px: vec2f, uv: vec2f) -> f32 {
  let b = regBox(i) * vec4f(u.size, u.size);
  let c = (b.xy + b.zw) * 0.5;
  let full = max(b.zw - b.xy, vec2f(0.0));
  let hs = max(full * (0.5 + u.grow * 0.01), vec2f(0.5));
  let p = px - c;
  var d = 0.0;
  if (u.shape < 0.5) { d = sdBox(p, hs); }
  else if (u.shape < 1.5) { d = sdRoundBox(p, hs, u.round * min(hs.x, hs.y)); }
  else { d = sdEllipse(p, hs); }
  var a = clamp(0.5 - d / u.feather, 0.0, 1.0);
  ${matte ? 'a = a * textureSampleLevel(matte, smp, uv, 0.0).r;' : ''}
  return a;
}`;
  if (kind === 'mask') {
    return /* wgsl */ `${head}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let n = i32(u.n);
  var cov = 0.0;
  for (var i = 0; i < n; i++) {
    let a = regCov(i, px, uv);
    if (u.inv > 0.5) { cov = max(cov, a); continue; }
    if (a <= 0.0) { continue; }
    let e = i32(regExtra(i, 0).x);
    cov = mix(cov, select(0.0, 1.0, e >= 0), a);
  }
  if (u.inv > 0.5) { cov = 1.0 - cov; }
  return vec4f(cov, cov, cov, 1.0);
}`;
  }
  return /* wgsl */ `${head}
${BUILTIN_WGSL}
fn effectOf(k: i32, org: vec4f, uv: vec2f, px: vec2f) -> vec4f {
${branches}
  return org;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let org = textureSampleLevel(src, smp, uv, 0.0);
  let n = i32(u.n);
  if (u.inv > 0.5) {
    var un = 0.0;
    for (var i = 0; i < n; i++) { un = max(un, regCov(i, px, uv)); }
    var tgt = org;
    if (u.first >= 0.0) { tgt = effectOf(i32(u.first), org, uv, px); }
    return mix(org, tgt, (1.0 - un) * u.amount);
  }
  var col = org;
  for (var i = 0; i < n; i++) {
    let a = regCov(i, px, uv);
    if (a <= 0.0) { continue; }
    let e = i32(regExtra(i, 0).x);
    var tgt = org;
    if (e >= 0) { tgt = effectOf(e, org, uv, px); }
    col = mix(col, tgt, a);
  }
  return mix(org, col, u.amount);
}`;
}

/** Effect `k` (0..3) as the node sees it: its built-in kind (0 = none) from the params, `wire` marks that a picture is wired into it. */
function builtinOf(params: Record<string, unknown>, k: number): number {
  return BUILTIN_ID[String(params[`fx${EFFECTS[k]}`])] ?? 0;
}

/** Params of effect slots B..D: the row is shown once the effect before it is in use (an old node, with no value stored, shows all of them). */
function slotParams(): Record<string, ParamDef> {
  const out: Record<string, ParamDef> = {};
  EFFECTS.forEach((L, k) => {
    const prev = k > 0 ? `fx${EFFECTS[k - 1]}` : null;
    const shown = (p: Record<string, unknown>) => (prev === null ? true : p[prev] !== 'off' || (p[`fx${L}`] !== undefined && p[`fx${L}`] !== 'off'));
    out[`fx${L}`] = {
      type: 'enum',
      default: k === 0 ? 'pixelate' : 'off',
      absent: 'wire',
      options: FX,
      optionHints: FX_OPTION_HINTS,
      label: `Effect ${L}`,
      ...(k === 0 ? { hint: FX_HINT } : {}),
      visibleIf: shown,
    } as ParamDef;
    out[`amt${L}`] = {
      type: 'number',
      default: 1,
      min: 0,
      max: 1,
      step: 0.01,
      label: `${L} amount`,
      ...(k === 0 ? { hint: 'How strong the built-in effect is. For Pixelate and Blur, how big the blocks and the blur are.' } : {}),
      visibleIf: (p) => shown(p) && !!BUILTIN_ID[String(p[`fx${L}`])],
    } as ParamDef;
    out[`col${L}`] = {
      type: 'color',
      default: [1, 0.45, 0.15, 1],
      label: `${L} color`,
      visibleIf: (p) => shown(p) && COLOR_FX(p[`fx${L}`]),
    } as ParamDef;
  });
  return out;
}

/** The one-line state shown on the node and in the phone list. */
export function regionFxSummary(p: Record<string, unknown>, wired?: ReadonlySet<string>): string {
  if (wired && !wired.has('image')) return 'Needs a picture: wire one into Picture';
  if (wired && !wired.has('regions')) return 'No regions yet: wire a Detect node into Regions';
  const names: string[] = [];
  EFFECTS.forEach((L, k) => {
    const w = !!wired?.has(`fx${k + 1}`);
    const kind = String(p[`fx${L}`] ?? 'wire');
    const b = BUILTIN_ID[kind] ? FX.find((f) => f.value === kind)!.label.toLowerCase() : '';
    const what = w ? 'your picture' : b;
    if (what) names.push(`${L} ${what}`);
  });
  const give = names.length > 1 ? ` · ${GIVE.find((g) => g.value === p.give)?.label.toLowerCase() ?? ''}` : '';
  if (!names.length) return 'No effect chosen: pick one for Effect A';
  return `${names.join(', ')}${give}${p.invert ? ' · everything except the regions' : ''}`;
}

export default defineNode({
  id: 'region-fx',
  title: 'Effects On Regions',
  category: 'track',
  description:
    'Applies an effect only inside the regions (boxes) found by a Detect node: pixelate or blur the moving things, invert the bright ones, and so on. Pick a built-in effect for Effect A and it just works. For anything fancier, build your own effect branch from the same picture and wire it into an Effect picture socket. With several effects, choose which region gets which. Where regions overlap, the smallest one wins.',
  keywords: ['regions', 'effects', 'different', 'each', 'tracked', 'apply', 'per region', 'blobs', 'mask', 'censor', 'pixelate', 'blur', 'hide', 'moving'],
  guide: {
    does: 'Applies an effect only to the things a Detect node found, such as pixelating everything that moves.',
    steps: [
      'Wire your picture into Picture.',
      'Wire the regions of a Detect node (through Track) into Regions (boxes).',
      'Pick an effect for Effect A. To use your own effect instead, wire it into Effect A picture.',
    ],
    needs: [
      { input: 'image', hint: 'The picture to change.' },
      { input: 'regions', hint: 'The boxes to change: they come from a Detect node.' },
    ],
    seeAlso: ['detect-motion', 'detect-blobs', 'track', 'region-overlay'],
  },
  optionalOutputs: ['mask'],
  inputs: {
    image: { type: 'image', required: true, label: 'Picture' },
    regions: { type: 'regions', required: true, label: 'Regions (boxes)' },
    fx1: { type: 'image', label: 'Effect A picture' },
    fx2: { type: 'image', label: 'Effect B picture' },
    fx3: { type: 'image', label: 'Effect C picture' },
    fx4: { type: 'image', label: 'Effect D picture' },
    matte: { type: 'mask', label: 'Shape mask', hint: 'Optional. The effect shows only where this mask is white AND inside a region box.' },
  },
  outputs: { image: { type: 'image', label: 'Image' }, mask: { type: 'mask', label: 'Area' } },
  params: {
    ...slotParams(),
    give: {
      type: 'enum',
      default: 'all',
      options: GIVE,
      optionHints: GIVE_HINTS,
      label: 'Give effects',
      hint: 'How regions are shared out between the effects that are in use. Effects that are not in use are skipped.',
      visibleIf: (p) => p.fxB !== 'off' || p.fxC !== 'off' || p.fxD !== 'off',
    },
    labelsA: { type: 'string', default: '', label: 'Effect A gets', hint: LABEL_HINT, visibleIf: byLabel },
    labelsB: { type: 'string', default: '', label: 'Effect B gets', hint: LABEL_HINT, visibleIf: byLabel },
    labelsC: { type: 'string', default: '', label: 'Effect C gets', hint: LABEL_HINT, visibleIf: byLabel },
    labelsD: { type: 'string', default: '', label: 'Effect D gets', hint: LABEL_HINT, visibleIf: byLabel },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', visibleIf: (p) => p.give === 'random' },
    shape: { type: 'enum', default: 'rect', options: SHAPES, label: 'Shape' },
    roundness: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Roundness', visibleIf: (p) => p.shape === 'rounded' },
    grow: { type: 'number', default: 0, min: -90, max: 300, step: 1, label: 'Grow', hint: 'Makes every region bigger (or smaller when negative), in percent of its own size on each side.' },
    feather: { type: 'number', default: 0, min: 0, max: 300, step: 0.5, unit: 'px', label: 'Feather', hint: 'Softens the edge, centered on the box edge.' },
    invert: { type: 'bool', default: false, label: 'Invert', hint: 'The effect shows everywhere EXCEPT inside the regions. Only Effect A (or the first one in use) is used.' },
    amount: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Mix' },
  },
  summary: (p, wired) => regionFxSummary(p as Record<string, unknown>, wired),
  render(ctx) {
    const p = ctx.params as Record<string, unknown> & typeof ctx.params;
    const img = ctx.in.image;
    const fxs = [ctx.in.fx1, ctx.in.fx2, ctx.in.fx3, ctx.in.fx4];
    const wiredPic = fxs.map((f) => !!f);
    // An effect is in use when a picture is wired into it (that always wins) or it has a built-in effect.
    const builtin = [0, 1, 2, 3].map((k) => (wiredPic[k] ? 0 : builtinOf(p, k)));
    const active = [0, 1, 2, 3].map((k) => wiredPic[k] || builtin[k] > 0) as [boolean, boolean, boolean, boolean];
    const fxIdx = [0, 1, 2, 3].filter((k) => wiredPic[k]);
    const matte = ctx.in.matte ?? null;

    const all = validRegions(ctx.in.regions.items).slice(0, MAX_REGIONS);
    const effects = assignEffects(all, {
      mode: p.give as GiveMode,
      wired: active,
      labels: [p.labelsA, p.labelsB, p.labelsC, p.labelsD],
      seed: p.seed,
    });
    // Largest first, so a small region drawn later keeps its own effect inside a big one.
    const order = all.map((_, i) => i).sort((a, b) => areaOf(all[b].box) - areaOf(all[a].box) || all[a].id - all[b].id || a - b);
    const regs = regionTable(ctx.gpu, order.map((i) => all[i].box), [order.map((i) => [effects[i], 0, 0, 0])]);

    const uniforms = {
      n: all.length,
      shape: p.shape === 'rect' ? 0 : p.shape === 'rounded' ? 1 : 2,
      round: p.roundness,
      grow: p.grow,
      feather: Math.max(p.feather, 1),
      inv: p.invert,
      amount: p.amount,
      first: active.indexOf(true),
      bk: builtin as [number, number, number, number],
      ba: [p.amtA, p.amtB, p.amtC, p.amtD] as [number, number, number, number],
      bc0: p.colA as [number, number, number, number],
      bc1: p.colB as [number, number, number, number],
      bc2: p.colC as [number, number, number, number],
      bc3: p.colD as [number, number, number, number],
    };
    const matteTex = matte ? { matte } : {};
    const fxTex: Record<string, typeof img> = {};
    for (const k of fxIdx) fxTex[`fx${k + 1}`] = fxs[k]!;

    const image = ctx.gpu.pass({
      label: 'region-fx',
      size: img,
      textures: { src: img, regs, ...fxTex, ...matteTex },
      uniforms,
      wgsl: shader('image', fxIdx, !!matte),
    });
    const out: Record<string, unknown> = { image };
    if (ctx.wants('mask')) {
      out.mask = ctx.gpu.passMask({
        label: 'region-fx-mask',
        size: img,
        textures: { regs, ...matteTex },
        uniforms,
        wgsl: shader('mask', [], !!matte),
      });
    }
    return out;
  },
});
