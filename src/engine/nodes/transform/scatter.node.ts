import { defineNode } from '../../define';
import { COPY_COMMON_WGSL, rad } from '../../lib/copy-wgsl';

/**
 * Scatter: copies of a picture dropped where a mask is bright (density driven) or on tracked regions.
 *
 * Mask / whole-frame mode is analytic and one pass: the frame is cut into a jittered grid of candidate points (one deterministic point
 * per cell, hashed from the cell and the seed: evenly spread, never clumped, blue-noise-like), a point survives when a hash is below the
 * mask density at that point, and each output pixel only looks at the few cells that can reach it. Cost does not depend on how many
 * copies survive. Regions mode loops over the (capped) tracked regions per pixel; its cost grows with the region count.
 */
const MAX_COUNT = 200_000;
const MAX_REGIONS = 256;
const MAX_WINDOW = 4;

const wgsl = (hasMask: boolean, regionsMode: boolean) => /* wgsl */ `
${COPY_COMMON_WGSL}
fn drawCopy(p: vec2f, c: vec2f, rot: f32, s: f32, key: vec2i, boost: f32) -> vec4f {
  let d = p - c;
  let l = unrot(d, cos(rot), sin(rot)) / s;
  let hs = u.srcSize * 0.5;
  let e = (hs - abs(l)) * s;
  let cov = saturate(e.x + 0.5) * saturate(e.y + 0.5);
  if (cov <= 0.0) { return vec4f(0.0); }
  let t = unpremul(sampleCopy(src, (l + hs) / u.srcSize, 1.0 / s));
  let r2 = rnd4(key.x, key.y, i32(u.seed) + 104729);
  var rgb = hueShift(t.rgb, (r2.x - 0.5) * 2.0 * u.hueVar);
  rgb = rgb * max(0.0, 1.0 + (r2.y - 0.5) * 2.0 * u.brightVar);
  let a = t.a * cov * boost;
  return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)) * a, a);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var acc = vec4f(0.0);
  ${
    regionsMode
      ? `
  let n = i32(u.regionCount + 0.5);
  for (var i = 0; i < ${MAX_REGIONS}; i++) {
    if (i >= n) { break; }
    let b = textureLoad(rgn, vec2i(i, 0), 0);
    let rv = rnd4(i, 7, i32(u.seed));
    let r2 = rnd4(i, 9, i32(u.seed));
    let c = vec2f(b.x + b.z, b.y + b.w) * 0.5 * u.size;
    let boxSide = max((b.z - b.x) * u.size.x, (b.w - b.y) * u.size.y);
    var s = select(u.baseScale, u.regionFill * boxSide / max(u.srcSize.x, u.srcSize.y), u.fitRegions > 0.5);
    s = max(s * (1.0 + (rv.x - 0.5) * 2.0 * u.scaleVar), 0.0001);
    let rot = (r2.z - 0.5) * 2.0 * u.rotVar;
    let l = drawCopy(px, c, rot, s, vec2i(i, 7), 1.0);
    acc = l + acc * (1.0 - l.a);
  }`
      : `
  let g = u.cellPx;
  let ci = vec2i(floor(px / g));
  let R = i32(u.win + 0.5);
  for (var dy = -${MAX_WINDOW}; dy <= ${MAX_WINDOW}; dy++) {
    if (dy < -R || dy > R) { continue; }
    for (var dx = -${MAX_WINDOW}; dx <= ${MAX_WINDOW}; dx++) {
      if (dx < -R || dx > R) { continue; }
      let cell = ci + vec2i(dx, dy);
      let rv = rnd4(cell.x, cell.y, i32(u.seed));
      let pt = (vec2f(cell) + 0.5 + (rv.xy - 0.5) * u.jitter) * g;
      if (pt.x < 0.0 || pt.y < 0.0 || pt.x >= u.size.x || pt.y >= u.size.y) { continue; }
      var dens = 1.0;
      ${hasMask ? 'dens = textureSampleLevel(msk, smp, pt / u.size, 0.0).r;' : ''}
      if (rv.z >= dens * u.density) { continue; }
      let r2 = rnd4(cell.x, cell.y, i32(u.seed) + 1);
      var s = u.baseScale * (1.0 + (rv.w - 0.5) * 2.0 * u.scaleVar);
      if (u.sizeByMask > 0.5) { s = s * (0.25 + 0.75 * dens); }
      let rot = (r2.w - 0.5) * 2.0 * u.rotVar;
      let l = drawCopy(px, pt, rot, max(s, 0.0001), cell, 1.0);
      acc = l + acc * (1.0 - l.a);
    }
  }`
  }
  return acc;
}`;

export default defineNode({
  id: 'scatter',
  title: 'Scatter',
  category: 'transform',
  description:
    'Drops copies of a picture over the frame: where a mask is bright (the brighter, the denser), over the whole frame when no mask is wired, or onto tracked regions when Regions is wired. Placement is deterministic from the seed and evenly spread. Each copy can vary in size, turn, hue and brightness.',
  keywords: ['scatter', 'distribute', 'sprinkle', 'confetti', 'stars', 'instances', 'duplicate', 'copies', 'clone', 'on mask', 'on regions', 'tracked', 'points', 'random', 'foliage', 'stamp'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    mask: { type: 'mask', label: 'Where (mask)' },
    regions: { type: 'regions', label: 'Regions' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    outputSize: {
      type: 'enum',
      default: 'canvas',
      label: 'Output size',
      options: [
        { value: 'canvas', label: 'Project canvas' },
        { value: 'input', label: 'Same as input' },
      ],
    },
    count: { type: 'number', default: 200, min: 1, max: MAX_COUNT, softMax: 5000, step: 1, integer: true, label: 'Points', hint: 'Candidate positions at full density. A mask keeps only the share its brightness allows.' },
    size: { type: 'number', default: 0.08, min: 0.002, max: 2, step: 0.002, unit: 'norm', label: 'Copy size', hint: 'Longest side of a copy as a fraction of the frame’s shorter side.' },
    density: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Density', hint: 'Overall share of the points that get a copy (multiplies the mask).' },
    spread: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Looseness', hint: '0 = a tidy grid, 1 = as random as an even spread allows.' },
    sizeByMask: { type: 'bool', default: false, label: 'Size by mask', hint: 'Smaller where the mask is dim.' },
    fitRegions: { type: 'bool', default: true, label: 'Fit to regions', hint: 'Regions: size each copy to its region’s box. Off = every copy has Copy size.' },
    regionFill: { type: 'number', default: 1, min: 0.1, max: 4, step: 0.05, label: 'Region fill', hint: 'Share of the region’s longest side a copy covers.', visibleIf: (p) => p.fitRegions === true },
    scaleVar: { type: 'number', default: 0.3, min: 0, max: 0.95, step: 0.01, label: 'Random size', group: 'Variation' },
    rotVar: { type: 'number', default: 180, min: 0, max: 180, step: 1, unit: 'deg', label: 'Rotation var', hint: 'Random rotation, plus or minus.', group: 'Variation' },
    hueVar: { type: 'number', default: 0, min: 0, max: 180, step: 1, unit: 'deg', label: 'Hue variation', hint: 'Random hue, plus or minus.', group: 'Variation' },
    brightVar: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Random brightness', group: 'Variation' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', group: 'Variation' },
  },
  summary: (p, wired) => (wired?.has('regions') ? 'on regions' : wired?.has('mask') ? `on mask · ${p.count} points` : `${p.count} points`),
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const mask = ctx.in.mask;
    const regions = ctx.in.regions;
    const out = p.outputSize === 'input' ? src : ctx.canvas;
    const W = out.width;
    const H = out.height;
    if (p.count > MAX_COUNT) throw new Error(`Scatter: at most ${MAX_COUNT.toLocaleString('en-US')} points (asked for ${p.count.toLocaleString('en-US')}).`);
    const srcLong = Math.max(src.width, src.height);
    const copyPx = p.size * Math.min(W, H);
    const baseScale = copyPx / srcLong;
    const useRegions = !!regions && regions.items.length > 0;
    const regionsWired = !!regions;

    let rgnTex: { texture: GPUTexture } | null = null;
    let regionCount = 0;
    if (regionsWired) {
      if (regions.items.length > MAX_REGIONS) throw new Error(`Scatter: ${regions.items.length} regions is more than the ${MAX_REGIONS} it can place copies on. Filter the regions first (Region Filter).`);
      regionCount = regions.items.length;
      if (regionCount) {
        const data = new Float32Array(regionCount * 4);
        regions.items.forEach((r, i) => data.set(r.box, i * 4));
        rgnTex = ctx.gpu.dataTexture(data, regionCount, 1);
      }
    }
    // Regions wired but empty: nothing to scatter on.
    if (regionsWired && !useRegions) return { image: ctx.gpu.pass({ label: 'scatter-empty', size: out, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0); }' }) };

    const cellPx = Math.sqrt((W * H) / p.count);
    const reach = (Math.hypot(src.width, src.height) / 2) * baseScale * (1 + p.scaleVar);
    const win = Math.ceil(reach / cellPx + p.spread / 2);
    if (!useRegions && win > MAX_WINDOW) {
      throw new Error(`Scatter: copies this large (${Math.round(copyPx)} px) overlap more than ${MAX_WINDOW} points deep with ${p.count} points. Lower Copy size or Points over the frame.`);
    }
    const image = ctx.gpu.pass({
      label: useRegions ? 'scatter-regions' : mask ? 'scatter-mask' : 'scatter',
      size: out,
      textures: { src, msk: useRegions ? null : (mask ?? null), rgn: useRegions ? rgnTex : null },
      uniforms: {
        srcSize: [src.width, src.height],
        cellPx,
        win: Math.max(1, win),
        jitter: p.spread,
        density: p.density,
        sizeByMask: p.sizeByMask,
        baseScale,
        scaleVar: p.scaleVar,
        rotVar: rad(p.rotVar),
        hueVar: p.hueVar / 360,
        brightVar: p.brightVar,
        seed: p.seed,
        smoothTex: 0,
        regionCount,
        fitRegions: p.fitRegions,
        regionFill: p.regionFill,
      },
      wgsl: wgsl(!!mask, useRegions),
    });
    return { image };
  },
});
