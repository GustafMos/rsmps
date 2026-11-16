import { defineNode } from '../../define';

/**
 * A real baseline-JPEG round trip on the GPU: RGB to YCbCr, 4:2:0 chroma subsampling (optional), an exact 8x8
 * forward DCT, quantisation with the standard JPEG tables scaled by the quality setting, the exact inverse DCT and
 * back to RGB. Only the entropy coding is skipped (it is lossless). Repeating it `generations` times at the same
 * block grid is what makes the damage grow like a picture saved again and again.
 * Chroma blocks cover 16x16 pixels (8x8 chroma samples), like real JPEG.
 */
const TABLES = /* wgsl */ `
const QY = array<f32, 64>(
  16.0, 11.0, 10.0, 16.0, 24.0, 40.0, 51.0, 61.0,
  12.0, 12.0, 14.0, 19.0, 26.0, 58.0, 60.0, 55.0,
  14.0, 13.0, 16.0, 24.0, 40.0, 57.0, 69.0, 56.0,
  14.0, 17.0, 22.0, 29.0, 51.0, 87.0, 80.0, 62.0,
  18.0, 22.0, 37.0, 56.0, 68.0, 109.0, 103.0, 77.0,
  24.0, 35.0, 55.0, 64.0, 81.0, 104.0, 113.0, 92.0,
  49.0, 64.0, 78.0, 87.0, 103.0, 121.0, 120.0, 101.0,
  72.0, 92.0, 95.0, 98.0, 112.0, 100.0, 103.0, 99.0);
const QC = array<f32, 64>(
  17.0, 18.0, 24.0, 47.0, 99.0, 99.0, 99.0, 99.0,
  18.0, 21.0, 26.0, 66.0, 99.0, 99.0, 99.0, 99.0,
  24.0, 26.0, 56.0, 99.0, 99.0, 99.0, 99.0, 99.0,
  47.0, 66.0, 99.0, 99.0, 99.0, 99.0, 99.0, 99.0,
  99.0, 99.0, 99.0, 99.0, 99.0, 99.0, 99.0, 99.0,
  99.0, 99.0, 99.0, 99.0, 99.0, 99.0, 99.0, 99.0,
  99.0, 99.0, 99.0, 99.0, 99.0, 99.0, 99.0, 99.0,
  99.0, 99.0, 99.0, 99.0, 99.0, 99.0, 99.0, 99.0);
fn qscale() -> f32 { return select(200.0 - 2.0 * u.quality, 5000.0 / u.quality, u.quality < 50.0); }
fn quant(t: f32, idx: i32, chroma: bool) -> f32 {
  var ty = QY;
  var tc = QC;
  let base = select(ty[idx], tc[idx], chroma);
  return clamp(floor((base * qscale() + 50.0) / 100.0), 1.0, 255.0);
}
fn cu(k: i32) -> f32 { return select(0.5, 0.353553391, k == 0); }
`;

export default defineNode({
  id: 'compression-artifacts',
  title: 'Compression Artifacts',
  category: 'filter',
  description:
    'Heavy JPEG-style damage: visible 8x8 blocks, ringing around edges and smeared colour. Runs a real DCT / quantise / inverse DCT round trip with the standard JPEG tables, optionally with 4:2:0 chroma subsampling, and can repeat it to mimic a picture saved over and over.',
  keywords: ['jpeg', 'compression', 'blocky', 'dct', 'artifacts', 'low quality', 'macroblock', 'degrade', 'ringing', 'deep fried', 'generation loss', 'chroma subsampling'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    quality: { type: 'number', default: 12, min: 1, max: 100, step: 1, integer: true, label: 'Quality', hint: 'JPEG quality: 100 = almost lossless, 10 = very blocky, 1 = destroyed.' },
    generations: { type: 'number', default: 1, min: 1, max: 12, softMax: 4, step: 1, integer: true, label: 'Generations', hint: 'How many times the picture is saved again. Each one costs three passes over the picture.' },
    shiftGrid: { type: 'bool', default: true, label: 'Shift the block grid each generation', hint: 'Like a picture cropped or resized between saves: the blocks of each generation fall in different places, so the damage piles up instead of settling.', visibleIf: (p) => (p.generations as number) > 1 },
    chroma: { type: 'bool', default: true, label: '4:2:0 colour smear', hint: 'Colour is stored at half resolution (16 x 16 pixel blocks), which smears and bleeds colour like a real JPEG.' },
  },
  summary: (p) => `quality ${p.quality}${p.generations > 1 ? ` × ${p.generations}` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const uniforms = { quality: Math.max(1, Math.min(100, p.quality)), sub: p.chroma };
    const shift = (image: typeof src, dx: number, dy: number) =>
      gpu.pass({
        label: 'jpeg-shift',
        size: src,
        textures: { src: image },
        uniforms: { d: [dx, dy] },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smpNearest, fract(uv - u.d / u.size), 0.0); }',
      });
    let img = src;
    let moved = [0, 0];
    for (let g = 0; g < Math.max(1, p.generations); g++) {
      if (g > 0 && p.shiftGrid) {
        img = shift(img, 3, 5);
        moved = [moved[0] + 3, moved[1] + 5];
      }
      // 1. RGB -> YCbCr, centred on zero (-128..127)
      const ycc = gpu.pass({
        label: 'jpeg-ycc',
        size: src,
        format: 'rgba16float',
        textures: { src: img },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = unpremul(textureSampleLevel(src, smpNearest, uv, 0.0));
  let c = s.rgb * 255.0;
  return vec4f(0.299 * c.r + 0.587 * c.g + 0.114 * c.b - 128.0, -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b, 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b, s.a);
}`,
      });
      // 2. forward DCT + quantise: texel (x, y) holds luma coefficient (x%8, y%8) and chroma coefficient (x%16, y%16) when < 8
      const coef = gpu.pass({
        label: 'jpeg-dct',
        size: src,
        format: 'rgba16float',
        textures: { ycc },
        uniforms,
        wgsl: /* wgsl */ `${TABLES}
fn pix(p: vec2i) -> vec4f { return textureLoad(ycc, clamp(p, vec2i(0), vec2i(textureDimensions(ycc)) - vec2i(1)), 0); }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let p = vec2i(floor(px));
  var out = vec3f(0.0);
  // luma
  {
    let o = vec2i(p.x & ~7, p.y & ~7);
    let k = vec2i(p.x & 7, p.y & 7);
    var sum = 0.0;
    for (var j = 0; j < 8; j++) { for (var i = 0; i < 8; i++) {
      sum += pix(o + vec2i(i, j)).x * cos(f32(2 * i + 1) * f32(k.x) * 0.19634954) * cos(f32(2 * j + 1) * f32(k.y) * 0.19634954);
    } }
    let f = sum * cu(k.x) * cu(k.y);
    let q = quant(0.0, k.y * 8 + k.x, false);
    out.x = round(f / q) * q;
  }
  // chroma
  let sub = u.sub > 0.5;
  let span = select(8, 16, sub);
  let o2 = vec2i((p.x / span) * span, (p.y / span) * span);
  let k2 = p - o2;
  if (k2.x < 8 && k2.y < 8) {
    var sumB = 0.0; var sumR = 0.0;
    for (var j = 0; j < 8; j++) { for (var i = 0; i < 8; i++) {
      var s = vec2f(0.0);
      if (sub) {
        let b = o2 + vec2i(i * 2, j * 2);
        s = (pix(b).yz + pix(b + vec2i(1, 0)).yz + pix(b + vec2i(0, 1)).yz + pix(b + vec2i(1, 1)).yz) * 0.25;
      } else { s = pix(o2 + vec2i(i, j)).yz; }
      let w = cos(f32(2 * i + 1) * f32(k2.x) * 0.19634954) * cos(f32(2 * j + 1) * f32(k2.y) * 0.19634954);
      sumB += s.x * w; sumR += s.y * w;
    } }
    let q = quant(0.0, k2.y * 8 + k2.x, true);
    let sc = cu(k2.x) * cu(k2.y);
    out.y = round(sumB * sc / q) * q;
    out.z = round(sumR * sc / q) * q;
  }
  return vec4f(out, 1.0);
}`,
      });
      // 3. inverse DCT, upsample chroma, back to RGB
      img = gpu.pass({
        label: 'jpeg-idct',
        size: src,
        textures: { coef, ycc },
        uniforms,
        wgsl: /* wgsl */ `${TABLES}
fn cf(p: vec2i) -> vec3f { return textureLoad(coef, clamp(p, vec2i(0), vec2i(textureDimensions(coef)) - vec2i(1)), 0).xyz; }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let p = vec2i(floor(px));
  let a = textureLoad(ycc, clamp(p, vec2i(0), vec2i(textureDimensions(ycc)) - vec2i(1)), 0).a;
  let o = vec2i(p.x & ~7, p.y & ~7);
  let l = p - o;
  var y = 0.0;
  var cx = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  var cy = array<f32, 8>(0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
  for (var k = 0; k < 8; k++) {
    cx[k] = cu(k) * cos(f32(2 * l.x + 1) * f32(k) * 0.19634954);
    cy[k] = cu(k) * cos(f32(2 * l.y + 1) * f32(k) * 0.19634954);
  }
  for (var v = 0; v < 8; v++) { for (var w = 0; w < 8; w++) { y += cf(o + vec2i(w, v)).x * cx[w] * cy[v]; } }
  let sub = u.sub > 0.5;
  let span = select(8, 16, sub);
  let o2 = vec2i((p.x / span) * span, (p.y / span) * span);
  var l2 = p - o2;
  if (sub) { l2 = l2 / 2; }
  var cb = 0.0; var cr = 0.0;
  for (var k = 0; k < 8; k++) {
    cx[k] = cu(k) * cos(f32(2 * l2.x + 1) * f32(k) * 0.19634954);
    cy[k] = cu(k) * cos(f32(2 * l2.y + 1) * f32(k) * 0.19634954);
  }
  for (var v = 0; v < 8; v++) { for (var w = 0; w < 8; w++) {
    let f = cf(o2 + vec2i(w, v));
    let m = cx[w] * cy[v];
    cb += f.y * m; cr += f.z * m;
  } }
  let yy = y + 128.0;
  let rgb = vec3f(yy + 1.402 * cr, yy - 0.344136 * cb - 0.714136 * cr, yy + 1.772 * cb) / 255.0;
  return premul(vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), a));
}`,
      });
    }
    if (moved[0] || moved[1]) img = shift(img, -moved[0], -moved[1]);
    return { image: img };
  },
});
