import { defineNode } from '../../define';
import { centerOf, HUD_PALETTE, paletteColor, validRegions, type Box } from '../../lib/track-core';
import { REGION_WGSL, regionTable } from '../../lib/track-gpu';
import { wrapSeconds } from '../../lib/util-time';
import type { Region } from '../../types';

const STYLES = [
  { value: 'path', label: 'Line along the path' },
  { value: 'dots', label: 'Dots' },
  { value: 'boxes', label: 'Ghost boxes' },
] as const;

const MAX_ENTRIES = 400;

export default defineNode({
  id: 'region-trails',
  title: 'Region Trails',
  category: 'track',
  description:
    'Draws motion trails behind tracked regions: a fading line, dots or ghost boxes through where each region was over the last few frames. Use Track first so each object keeps one id and one color. In a looping project the trail wraps around the loop.',
  keywords: ['trail', 'path', 'motion', 'history', 'streak', 'ghost', 'regions', 'follow'],
  guide: {
    does: 'Draws a fading trail behind each tracked region, showing where it has been.',
    steps: [
      'Wire your picture into Picture.',
      'Wire tracked regions (a Detect node, then Track) into Regions (boxes): Track gives each thing one color and one trail.',
      'Set how long the trail is.',
    ],
    needs: [
      { input: 'image', hint: 'The picture to draw the trails on.' },
      { input: 'regions', hint: 'Tracked regions: from a Detect node and Track.' },
    ],
    seeAlso: ['track', 'detect-motion', 'region-overlay'],
  },
  inputs: {
    image: { type: 'image', required: true, label: 'Picture' },
    regions: { type: 'regions', required: true, label: 'Regions (boxes)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: false,
  params: {
    style: { type: 'enum', default: 'path', options: STYLES, label: 'Style' },
    length: { type: 'number', default: 12, min: 1, max: 60, step: 1, integer: true, label: 'Trail length', hint: 'In samples.' },
    step: { type: 'number', default: 1, min: 1, max: 30, step: 1, integer: true, label: 'Sample spacing', hint: 'In frames.' },
    decay: { type: 'number', default: 0.88, min: 0.1, max: 1, step: 0.01, label: 'Fade per sample', hint: 'Each older sample is this much as strong as the one after it.' },
    lineWidth: { type: 'number', default: 4, min: 0.5, max: 100, step: 0.5, unit: 'px', label: 'Line width' },
    color: { type: 'color', default: [1, 0.85, 0.25, 1], label: 'Color' },
    perId: { type: 'bool', default: true, label: 'Color per id' },
    palette: { type: 'palette', default: HUD_PALETTE, label: 'Palette', visibleIf: (p) => p.perId === true },
    overlayOnly: { type: 'bool', default: false, label: 'Overlay only', hint: 'Transparent background.' },
  },
  summary: (p) => `${p.style} · ${p.length} × ${p.step}f`,
  async render(ctx) {
    const p = ctx.params;
    const img = ctx.in.image;
    const { frame, fps, duration, loop } = ctx.time;
    // Regions at the current frame and at `length` earlier samples (newest first).
    const samples: Region[][] = [validRegions(ctx.in.regions.items)];
    for (let k = 1; k <= p.length; k++) {
      const f = frame - k * p.step;
      if (!loop && f < 0) break;
      const seconds = loop ? wrapSeconds(f / fps, duration, fps) : f / fps;
      const v = await ctx.pull('regions', { seconds });
      samples.push(validRegions(v?.items));
    }
    const perSample = Math.max(1, Math.floor(MAX_ENTRIES / samples.length));
    const boxes: Box[] = [];
    const colors: number[][] = [];
    const widths: number[][] = [];
    const colorOf = (r: Region): number[] => {
      const c = p.perId ? paletteColor(p.palette, r.id) : [p.color[0], p.color[1], p.color[2]];
      return [c[0], c[1], c[2]];
    };
    for (let k = 0; k < samples.length && boxes.length < MAX_ENTRIES; k++) {
      const older = samples[k + 1];
      const taper = Math.max(0.25, 1 - k / (samples.length + 1));
      for (const r of samples[k].slice(0, perSample)) {
        const [cx, cy] = centerOf(r.box);
        const fade = Math.pow(p.decay, k) * p.color[3];
        if (p.style === 'boxes') {
          boxes.push(r.box);
        } else if (p.style === 'dots') {
          boxes.push([cx, cy, cx, cy]);
        } else {
          const prev = older?.find((o) => o.id === r.id);
          if (!prev) continue;
          const [px, py] = centerOf(prev.box);
          boxes.push([cx, cy, px, py]);
        }
        colors.push([...colorOf(r), p.style === 'path' ? fade * Math.sqrt(p.decay) : fade]);
        widths.push([taper, 0, 0, 0]);
      }
    }
    const n = boxes.length;
    const regs = regionTable(ctx.gpu, boxes, [colors, widths], MAX_ENTRIES);
    const image = ctx.gpu.pass({
      label: 'region-trails',
      size: img,
      textures: { base: img, regs },
      uniforms: { n, style: p.style === 'path' ? 0 : p.style === 'dots' ? 1 : 2, lw: p.lineWidth, only: p.overlayOnly },
      wgsl: /* wgsl */ `
${REGION_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var acc = vec4f(0.0);
  let count = i32(u.n);
  for (var i = 0; i < count; i++) {
    let b = regBox(i) * vec4f(u.size, u.size);
    let cc = regExtra(i, 0);
    let hw = u.lw * 0.5 * regExtra(i, 1).x;
    var cv = 0.0;
    if (u.style < 1.5) {
      let a = b.xy;
      let ba = b.zw - b.xy;
      let pa = px - a;
      let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      cv = cov(length(pa - ba * h) - hw);
    } else {
      let c = (b.xy + b.zw) * 0.5;
      let d = sdBox(px - c, max((b.zw - b.xy) * 0.5, vec2f(1.0)));
      cv = cov(abs(d) - hw);
    }
    let layer = vec4f(cc.rgb, 1.0) * (cv * cc.a);
    acc = over(acc, layer);
  }
  if (u.only > 0.5) { return acc; }
  return over(acc, textureSampleLevel(base, smpNearest, uv, 0.0));
}`,
    });
    return { image };
  },
});
