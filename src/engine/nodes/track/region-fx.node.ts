import { defineNode } from '../../define';
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

const SHAPES = [
  { value: 'rect', label: 'Box' },
  { value: 'rounded', label: 'Rounded box' },
  { value: 'ellipse', label: 'Ellipse' },
] as const;

const LABEL_HINT = 'Labels or ids, comma separated, e.g. "person, 12". A word matches any label that contains it.';
const byLabel = (p: Record<string, unknown>) => p.give === 'label';

/**
 * WGSL for one variant. `fxIdx` lists the effect pictures that are wired (0..3); `matte` = a shape mask is wired.
 * Regions are drawn largest first, so the smallest region has the last word where regions overlap.
 */
function shader(kind: 'image' | 'mask', fxIdx: number[], matte: boolean): string {
  const first = fxIdx[0];
  const sampleFx = (k: number) => `sampleCrisp(fx${k + 1}, uv, vec2f(textureDimensions(fx${k + 1})) / u.size)`;
  const branches = fxIdx.map((k) => `      if (e == ${k}) { tgt = ${sampleFx(k)}; }`).join('\n');
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
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let org = textureSampleLevel(src, smp, uv, 0.0);
  let n = i32(u.n);
  if (u.inv > 0.5) {
    var un = 0.0;
    for (var i = 0; i < n; i++) { un = max(un, regCov(i, px, uv)); }
    var tgt = org;
    ${first === undefined ? '' : `tgt = ${sampleFx(first)};`}
    return mix(org, tgt, (1.0 - un) * u.amount);
  }
  var col = org;
  for (var i = 0; i < n; i++) {
    let a = regCov(i, px, uv);
    if (a <= 0.0) { continue; }
    let e = i32(regExtra(i, 0).x);
    var tgt = org;
${branches}
    col = mix(col, tgt, a);
  }
  return mix(org, col, u.amount);
}`;
}

export default defineNode({
  id: 'region-fx',
  title: 'Effects On Regions',
  category: 'track',
  description:
    'Shows the original picture, and inside each region shows one of up to four effect pictures. Run the same picture through any effects you like, wire them into Effect A to D, and choose which region gets which one. Where regions overlap, the smallest one wins.',
  keywords: ['regions', 'effects', 'different', 'each', 'tracked', 'apply', 'per region', 'blobs', 'mask', 'censor', 'pixelate'],
  optionalOutputs: ['mask'],
  inputs: {
    image: { type: 'image', required: true, label: 'Original' },
    regions: { type: 'regions', required: true, label: 'Regions' },
    fx1: { type: 'image', label: 'Effect A' },
    fx2: { type: 'image', label: 'Effect B' },
    fx3: { type: 'image', label: 'Effect C' },
    fx4: { type: 'image', label: 'Effect D' },
    matte: { type: 'mask', label: 'Shape mask', hint: 'Optional. The effect shows only where this mask is white AND inside a region box.' },
  },
  outputs: { image: { type: 'image', label: 'Image' }, mask: { type: 'mask', label: 'Affected area' } },
  params: {
    give: { type: 'enum', default: 'all', options: GIVE, label: 'Give effects', hint: 'How regions are shared out between the wired effects. Effects that are not wired are skipped.' },
    labelsA: { type: 'string', default: '', label: 'Effect A gets', hint: LABEL_HINT, visibleIf: byLabel },
    labelsB: { type: 'string', default: '', label: 'Effect B gets', hint: LABEL_HINT, visibleIf: byLabel },
    labelsC: { type: 'string', default: '', label: 'Effect C gets', hint: LABEL_HINT, visibleIf: byLabel },
    labelsD: { type: 'string', default: '', label: 'Effect D gets', hint: LABEL_HINT, visibleIf: byLabel },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', visibleIf: (p) => p.give === 'random' },
    shape: { type: 'enum', default: 'rect', options: SHAPES, label: 'Shape' },
    roundness: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Roundness', visibleIf: (p) => p.shape === 'rounded' },
    grow: { type: 'number', default: 0, min: -90, max: 300, step: 1, label: 'Grow', hint: 'Makes every region bigger (or smaller when negative), in percent of its own size on each side.' },
    feather: { type: 'number', default: 0, min: 0, max: 300, step: 0.5, unit: 'px', label: 'Feather', hint: 'Softens the edge, centered on the box edge.' },
    invert: { type: 'bool', default: false, label: 'Invert', hint: 'The effect shows everywhere EXCEPT inside the regions. Only Effect A (or the first one wired) is used.' },
    amount: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Mix' },
  },
  summary: (p) => `${GIVE.find((g) => g.value === p.give)?.label ?? ''} · ${p.shape}${p.invert ? ' · inverted' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const img = ctx.in.image;
    const fxs = [ctx.in.fx1, ctx.in.fx2, ctx.in.fx3, ctx.in.fx4];
    const wired = fxs.map((f) => !!f) as [boolean, boolean, boolean, boolean];
    const fxIdx = [0, 1, 2, 3].filter((k) => wired[k]);
    const matte = ctx.in.matte ?? null;

    const all = validRegions(ctx.in.regions.items).slice(0, MAX_REGIONS);
    const effects = assignEffects(all, {
      mode: p.give as GiveMode,
      wired,
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
