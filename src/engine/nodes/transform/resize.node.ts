import { defineNode } from '../../define';

export default defineNode({
  id: 'resize',
  title: 'Resize',
  category: 'transform',
  description: 'Change the image resolution by percent, to a given height / width / long side, or to an exact size.',
  keywords: ['scale', 'resolution', 'downscale', 'upscale', 'size', 'dimensions'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'percent',
      options: [
        { value: 'percent', label: 'Scale by percent' },
        { value: 'height', label: 'Fit height' },
        { value: 'width', label: 'Fit width' },
        { value: 'long', label: 'Fit long side' },
        { value: 'exact', label: 'Exact size' },
      ],
      label: 'Resize by',
    },
    percent: { type: 'number', default: 50, min: 1, max: 1000, step: 1, unit: '%', label: 'Scale', visibleIf: (p) => p.mode === 'percent' },
    width: { type: 'number', default: 512, min: 1, max: 16000, integer: true, unit: 'px', label: 'Width', visibleIf: (p) => p.mode === 'width' || p.mode === 'exact' },
    height: { type: 'number', default: 512, min: 1, max: 16000, integer: true, unit: 'px', label: 'Height', visibleIf: (p) => p.mode === 'height' || p.mode === 'exact' },
    longSide: { type: 'number', default: 512, min: 1, max: 16000, integer: true, unit: 'px', label: 'Long side', visibleIf: (p) => p.mode === 'long' },
    filter: {
      type: 'enum',
      default: 'area',
      options: [
        { value: 'area', label: 'Clean (area average)' },
        { value: 'bilinear', label: 'Smooth (bilinear)' },
        { value: 'nearest', label: 'Sharp (nearest, pixel art)' },
      ],
      label: 'Filter',
      hint: 'Clean averages every covered pixel when shrinking, so there is no aliasing. When enlarging it behaves like Smooth.',
    },
  },
  summary: (p) => {
    switch (p.mode) {
      case 'percent':
        return `${p.percent}% · ${p.filter}`;
      case 'height':
        return `height ${p.height}`;
      case 'width':
        return `width ${p.width}`;
      case 'long':
        return `long side ${p.longSide}`;
      default:
        return `${p.width} × ${p.height}`;
    }
  },
  render(ctx) {
    const src = ctx.in.image;
    const p = ctx.params;
    let w = src.width;
    let h = src.height;
    switch (p.mode) {
      case 'percent':
        w = (src.width * p.percent) / 100;
        h = (src.height * p.percent) / 100;
        break;
      case 'height':
        h = p.height;
        w = (src.width * h) / src.height;
        break;
      case 'width':
        w = p.width;
        h = (src.height * w) / src.width;
        break;
      case 'long': {
        const k = p.longSide / Math.max(src.width, src.height);
        w = src.width * k;
        h = src.height * k;
        break;
      }
      default:
        w = p.width;
        h = p.height;
    }
    // 'px' lengths already arrive in texels of the input (see ENGINE.md rule 3), so they are final sizes here.
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === src.width && h === src.height) return { image: src };
    const sx = src.width / w;
    const sy = src.height / h;
    const useArea = p.filter === 'area' && (sx > 1 || sy > 1);
    const image = ctx.gpu.pass({
      label: 'resize',
      size: { width: w, height: h, unit: src.unit * (w / src.width) },
      textures: { src },
      uniforms: { ratio: [sx, sy] },
      wgsl: useArea
        ? /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2f(textureDimensions(src));
  let lo = (px - 0.5) * u.ratio;
  let hi = lo + u.ratio;
  let ilo = vec2i(floor(lo));
  let ihi = vec2i(ceil(hi));
  let n = ihi - ilo;
  let stride = max(vec2i(1), n / 48);
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var j = 0; j < n.y; j += stride.y) {
    let y = ilo.y + j;
    let wy = min(f32(y + 1), hi.y) - max(f32(y), lo.y);
    for (var i = 0; i < n.x; i += stride.x) {
      let x = ilo.x + i;
      let wx = min(f32(x + 1), hi.x) - max(f32(x), lo.x);
      let w = max(wx, 0.0) * max(wy, 0.0);
      acc += textureLoad(src, clamp(vec2i(x, y), vec2i(0), vec2i(dims) - vec2i(1)), 0) * w;
      wsum += w;
    }
  }
  return acc / max(wsum, 1e-6);
}`
        : /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  return textureSampleLevel(src, ${p.filter === 'nearest' ? 'smpNearest' : 'smp'}, uv, 0.0);
}`,
    });
    return { image };
  },
});
