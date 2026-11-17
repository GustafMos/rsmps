import { defineNode } from '../../define';
import { rgba } from '../../lib/gen-common';

export default defineNode({
  id: 'text',
  title: 'Text',
  category: 'generate',
  description: 'Draws text on a transparent image, with optional outline. Needs the app to rasterise fonts (empty in headless runs).',
  keywords: ['title', 'caption', 'label', 'font', 'typography', 'type', 'words'],
  inputs: { size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    text: { type: 'string', multiline: true, default: 'Hello', label: 'Text' },
    font: { type: 'string', kind: 'font', default: 'sans-serif', label: 'Font', hint: 'Pick a font, or type the name of any font installed on this computer.' },
    fontSize: { type: 'number', default: 96, min: 1, max: 2000, unit: 'px', label: 'Size' },
    weight: { type: 'number', default: 700, min: 100, max: 900, step: 100, integer: true, label: 'Weight', hint: '400 = regular, 700 = bold.' },
    italic: { type: 'bool', default: false, label: 'Italic' },
    align: {
      type: 'enum',
      default: 'center',
      label: 'Alignment',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'right', label: 'Right' },
      ],
    },
    color: { type: 'color', default: [1, 1, 1, 1], label: 'Color' },
    x: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Position X', group: 'Placement', hint: 'Anchor point; left/center/right alignment decides which side of the text sits here.' },
    y: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Position Y', group: 'Placement', hint: 'Vertical center of the text block.' },
    lineHeight: { type: 'number', default: 1.2, min: 0.5, max: 3, step: 0.05, label: 'Line height', group: 'Placement' },
    outline: { type: 'number', default: 0, min: 0, max: 200, unit: 'px', label: 'Outline width', group: 'Outline' },
    outlineColor: { type: 'color', default: [0, 0, 0, 1], label: 'Outline color', group: 'Outline' },
  },
  summary: (p) => {
    const first = p.text.split('\n')[0] ?? '';
    return `“${first.length > 24 ? `${first.slice(0, 24)}…` : first}” · ${p.font} ${Math.round(p.fontSize)}px`;
  },
  render(ctx) {
    const p = ctx.params;
    const size = ctx.in.size ?? ctx.canvas;
    const blank = () => ctx.gpu.pass({ label: 'text-blank', size, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0); }' });

    // Headless runs (no canvas available) or empty text: nothing to draw.
    if (!p.text.trim() || !ctx.host.rasterizeText) return { image: blank() };
    const bmp = ctx.host.rasterizeText({
      text: p.text,
      font: p.font || 'sans-serif',
      sizePx: Math.max(1, p.fontSize),
      weight: p.weight,
      italic: p.italic,
      align: p.align as 'left' | 'center' | 'right',
      lineHeight: p.lineHeight,
      maxWidthPx: size.width,
    });
    if (!bmp || bmp.width < 1 || bmp.height < 1) return { image: blank() };

    // Pad the bitmap so the outline has room beyond the glyph edges.
    const pad = Math.ceil(Math.max(0, p.outline)) + 2;
    const w = bmp.width + pad * 2;
    const h = bmp.height + pad * 2;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < bmp.height; y++) {
      data.set(bmp.data.subarray(y * bmp.width * 4, (y + 1) * bmp.width * 4), ((y + pad) * w + pad) * 4);
    }
    const tex = ctx.gpu.upload(data, w, h, size.unit ?? 1, true);

    const ax = p.x * size.width;
    const ox = Math.round(p.align === 'left' ? ax - pad : p.align === 'right' ? ax - w + pad : ax - w / 2);
    const oy = Math.round(p.y * size.height - h / 2);
    const ringCount = Math.max(1, Math.min(8, Math.ceil(p.outline)));
    const image = ctx.gpu.pass({
      label: 'text',
      size,
      textures: { tx: tex },
      uniforms: {
        tsize: [w, h],
        origin: [ox, oy],
        outline: Math.max(0, p.outline),
        rings: ringCount,
        c: rgba(p.color),
        oc: rgba(p.outlineColor),
      },
      wgsl: /* wgsl */ `
fn cov(q: vec2f) -> f32 {
  if (q.x < 0.0 || q.y < 0.0 || q.x > u.tsize.x || q.y > u.tsize.y) { return 0.0; }
  return textureSampleLevel(tx, smp, q / u.tsize, 0.0).a;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let q = px - u.origin;
  let ta = cov(q) * u.c.a;
  var out = vec4f(u.c.rgb * ta, ta);
  if (u.outline > 0.0) {
    var o = 0.0;
    for (var k = 1; k <= 8; k++) {
      if (f32(k) > u.rings) { break; }
      let r = u.outline * f32(k) / u.rings;
      for (var i = 0; i < 24; i++) {
        let a = f32(i) * (TAU / 24.0);
        o = max(o, cov(q + r * vec2f(cos(a), sin(a))));
      }
    }
    o = max(o, cov(q));
    let oa = o * u.oc.a;
    out = out + vec4f(u.oc.rgb * oa, oa) * (1.0 - ta);
  }
  return out;
}`,
    });
    return { image };
  },
});
