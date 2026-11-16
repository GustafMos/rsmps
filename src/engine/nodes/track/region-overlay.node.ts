import { defineNode } from '../../define';
import { formatLabel, HUD_PALETTE, paletteColor, validRegions } from '../../lib/track-core';
import { MAX_REGIONS, REGION_WGSL, regionTable } from '../../lib/track-gpu';
import { gaussianBlur } from '../filter/blur.node';

const STYLES = [
  { value: 'box', label: 'Box' },
  { value: 'rounded', label: 'Rounded box' },
  { value: 'brackets', label: 'Corner brackets' },
  { value: 'ellipse', label: 'Ellipse' },
  { value: 'crosshair', label: 'Crosshair' },
] as const;

const MAX_LABELS = 32;

export default defineNode({
  id: 'region-overlay',
  title: 'Region Overlay',
  category: 'track',
  description:
    'Draws a detection HUD over the image: boxes, rounded boxes, corner brackets, ellipses or crosshairs, with optional glow, fill, centre dot and text labels. Turn on "Overlay only" to get just the HUD on transparent so it can be exported with alpha.',
  keywords: ['hud', 'box', 'brackets', 'label', 'glow', 'detection', 'overlay', 'bounding', 'draw', 'stardetect', 'crosshair'],
  inputs: {
    image: { type: 'image', required: true, label: 'Image' },
    regions: { type: 'regions', required: true, label: 'Regions' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: false,
  params: {
    style: { type: 'enum', default: 'brackets', options: STYLES, label: 'Style' },
    lineWidth: { type: 'number', default: 3, min: 0.5, max: 100, step: 0.5, unit: 'px', label: 'Line width' },
    color: { type: 'color', default: [0.25, 0.95, 0.85, 1], label: 'Color' },
    perId: { type: 'bool', default: false, label: 'Color per id', hint: 'Colours come from the palette, picked by the region id (use Track for steady ids).' },
    palette: { type: 'palette', default: HUD_PALETTE, label: 'Palette', visibleIf: (p) => p.perId === true },
    cornerLength: { type: 'number', default: 0.25, min: 0.02, max: 1, step: 0.01, label: 'Bracket length', hint: 'Fraction of the box\'s shorter side.', visibleIf: (p) => p.style === 'brackets' },
    cornerRadius: { type: 'number', default: 16, min: 0, max: 500, step: 1, unit: 'px', label: 'Corner radius', visibleIf: (p) => p.style === 'rounded' },
    fillOpacity: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Fill' },
    glowRadius: { type: 'number', default: 12, min: 0, max: 200, step: 1, unit: 'px', label: 'Glow radius' },
    glowStrength: { type: 'number', default: 0, min: 0, max: 4, step: 0.05, label: 'Glow strength', hint: '0 = no glow.' },
    centerDot: { type: 'bool', default: false, label: 'Center dot' },
    dotSize: { type: 'number', default: 4, min: 0.5, max: 100, step: 0.5, unit: 'px', label: 'Dot size', visibleIf: (p) => p.centerDot === true },
    showLabel: { type: 'bool', default: true, label: 'Text label', hint: 'Needs the app (text drawing is not available in headless runs).' },
    labelTemplate: { type: 'string', default: '{label} #{id}', label: 'Label text', hint: 'Tokens: {label} {id} {score} {index}', visibleIf: (p) => p.showLabel === true },
    labelSize: { type: 'number', default: 16, min: 6, max: 120, step: 1, unit: 'px', label: 'Label size', visibleIf: (p) => p.showLabel === true },
    overlayOnly: { type: 'bool', default: false, label: 'Overlay only', hint: 'Transparent background.' },
  },
  summary: (p) => `${p.style}${p.glowStrength > 0 ? ' · glow' : ''}${p.overlayOnly ? ' · overlay only' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const img = ctx.in.image;
    const items = validRegions(ctx.in.regions.items).slice(0, MAX_REGIONS);
    const n = items.length;

    // Colours per region.
    const colors = items.map((r) => {
      const c = p.perId ? paletteColor(p.palette, r.id) : ([p.color[0], p.color[1], p.color[2]] as [number, number, number]);
      return [c[0], c[1], c[2], p.color[3]];
    });

    // Label atlas (needs a text rasteriser from the host; absent in headless runs).
    const raster = ctx.host.rasterizeText ? ctx.host.rasterizeText.bind(ctx.host) : undefined; // bound: the host method uses 'this'
    let atlas: { texture: GPUTexture } | null = null;
    const labelInfo: number[][] = items.map(() => [0, 0, 0, 0]);
    let cellH = 1;
    if (p.showLabel && raster && n > 0 && p.labelTemplate.trim()) {
      const pad = Math.max(2, Math.round(p.labelSize * 0.25));
      const slots = new Map<string, number>();
      const bitmaps: { data: Uint8ClampedArray; width: number; height: number }[] = [];
      items.forEach((r, i) => {
        const text = formatLabel(p.labelTemplate, r, i);
        if (!text.trim()) return;
        let slot = slots.get(text);
        if (slot === undefined) {
          if (slots.size >= MAX_LABELS) return;
          const bmp = raster({ text, font: 'sans-serif', sizePx: p.labelSize, weight: 600, italic: false, align: 'left', lineHeight: 1.2, maxWidthPx: Math.max(64, img.width) });
          if (!bmp || bmp.width < 1 || bmp.height < 1) return;
          slot = bitmaps.length;
          slots.set(text, slot);
          bitmaps.push(bmp);
        }
        const bmp = bitmaps[slot];
        labelInfo[i] = [Math.min(2000, bmp.width + pad * 2), Math.min(2000, bmp.height + pad * 2), slot, 1];
      });
      if (bitmaps.length) {
        const cellW = Math.max(...bitmaps.map((b) => b.width)) + pad * 2;
        cellH = Math.max(...bitmaps.map((b) => b.height)) + pad * 2;
        const data = new Uint8ClampedArray(cellW * cellH * bitmaps.length * 4);
        bitmaps.forEach((b, s) => {
          for (let y = 0; y < b.height; y++) {
            data.set(b.data.subarray(y * b.width * 4, (y + 1) * b.width * 4), ((s * cellH + y + pad) * cellW + pad) * 4);
          }
        });
        atlas = ctx.gpu.upload(data, cellW, cellH * bitmaps.length, 1, true);
      }
    }

    const regs = regionTable(ctx.gpu, items.map((r) => r.box), [colors, labelInfo]);
    const styleIndex = STYLES.findIndex((s) => s.value === p.style);

    const shapes = ctx.gpu.pass({
      label: 'region-overlay-shapes',
      size: img,
      textures: { regs },
      uniforms: {
        n,
        style: styleIndex,
        lw: p.lineWidth,
        corner: p.cornerRadius,
        cornerLen: p.cornerLength,
        fillOp: p.fillOpacity,
        dot: p.centerDot,
        dotR: p.dotSize,
      },
      format: 'rgba8unorm',
      wgsl: /* wgsl */ `
${REGION_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var acc = vec4f(0.0);
  let count = i32(u.n);
  for (var i = 0; i < count; i++) {
    let b = regBox(i) * vec4f(u.size, u.size);
    let cc = regExtra(i, 0);
    let col = cc.rgb;
    let c = (b.xy + b.zw) * 0.5;
    let hs = max((b.zw - b.xy) * 0.5, vec2f(1.0));
    let p = px - c;
    let lw = u.lw;
    var line = 0.0;
    var fill = 0.0;
    if (u.style < 0.5) {
      let d = sdBox(p, hs);
      line = cov(abs(d) - lw * 0.5);
      fill = cov(d);
    } else if (u.style < 1.5) {
      let d = sdRoundBox(p, hs, u.corner);
      line = cov(abs(d) - lw * 0.5);
      fill = cov(d);
    } else if (u.style < 2.5) {
      let L = min(hs.x, hs.y) * 2.0 * u.cornerLen;
      let q = abs(p);
      let d1 = sdBox(q - vec2f(hs.x - L * 0.5, hs.y), vec2f(L * 0.5 + lw * 0.5, lw * 0.5));
      let d2 = sdBox(q - vec2f(hs.x, hs.y - L * 0.5), vec2f(lw * 0.5, L * 0.5 + lw * 0.5));
      line = cov(min(d1, d2));
      fill = cov(sdBox(p, hs));
    } else if (u.style < 3.5) {
      let d = sdEllipse(p, hs);
      line = cov(abs(d) - lw * 0.5);
      fill = cov(d);
    } else {
      let gap = min(hs.x, hs.y) * 0.25;
      let dv = sdBox(p, vec2f(lw * 0.5, hs.y));
      let dh = sdBox(p, vec2f(hs.x, lw * 0.5));
      let hole = sdBox(p, vec2f(gap, gap));
      line = cov(max(min(dv, dh), -hole));
      fill = cov(sdBox(p, hs));
    }
    if (u.dot > 0.5) { line = max(line, cov(length(p) - u.dotR)); }
    let strokeL = vec4f(col, 1.0) * (line * cc.a);
    let fillL = vec4f(col, 1.0) * (fill * u.fillOp * cc.a);
    acc = over(over(strokeL, fillL), acc);
  }
  return acc;
}`,
    });

    const glow = p.glowStrength > 0 && p.glowRadius > 0.05 ? gaussianBlur(ctx.gpu, shapes, p.glowRadius) : null;
    const hasLabels = atlas !== null;

    const image = ctx.gpu.pass({
      label: 'region-overlay-compose',
      size: img,
      textures: { base: img, shapes, glow, regs, atlas },
      uniforms: { n, gk: p.glowStrength, only: p.overlayOnly, cellH, gap: Math.max(2, p.labelSize * 0.25) },
      wgsl: /* wgsl */ `
${REGION_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var ov = textureSampleLevel(shapes, smpNearest, uv, 0.0);
  ${glow ? 'ov = over(ov, min(textureSampleLevel(glow, smp, uv, 0.0) * u.gk, vec4f(1.0)));' : ''}
  ${
    hasLabels
      ? /* wgsl */ `
  let count = i32(u.n);
  for (var i = 0; i < count; i++) {
    let info = regExtra(i, 1);
    if (info.w < 0.5) { continue; }
    let b = regBox(i) * vec4f(u.size, u.size);
    var o = vec2f(b.x, b.y - info.y - u.gap);
    if (o.y < 0.0) { o.y = b.y + u.gap; }
    o = floor(o + vec2f(0.5));
    let l = vec2i(floor(px - o));
    if (l.x >= 0 && l.y >= 0 && l.x < i32(info.x) && l.y < i32(info.y)) {
      let t = textureLoad(atlas, vec2i(l.x, l.y + i32(info.z) * i32(u.cellH)), 0);
      let cc = regExtra(i, 0);
      let plate = vec4f(0.0, 0.0, 0.0, 0.6);
      let text = vec4f(cc.rgb * t.a, t.a);
      ov = over(over(text, plate), ov);
    }
  }`
      : ''
  }
  if (u.only > 0.5) { return ov; }
  return over(ov, textureSampleLevel(base, smpNearest, uv, 0.0));
}`,
    });
    return { image };
  },
});
