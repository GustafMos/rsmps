import { defineNode } from '../../define';

const MODE = { rg: 0, gradient: 1, normal: 2, flow: 3 } as const;
const EDGE = { clamp: 0, mirror: 1, wrap: 2, transparent: 3 } as const;

export default defineNode({
  id: 'displace-map',
  title: 'Displace by Map',
  category: 'filter',
  description:
    'Warps one picture with another: the Map picture says where every pixel of the Image moves. Use Red and green for classic displacement maps (mid gray = no move), Brightness slope for refraction through a bump or glass (pixels are pushed along the slope of the map), a Normal map for lens and water looks, or an Optical Flow output to move pixels along the footage motion. Split the color channels for a prism edge, scroll the map for heat haze, and keep pixel art on its art grid. For warping with moving noise instead of a picture, use Noise Displace.',
  keywords: ['displacement map', 'warp', 'distort', 'distort by image', 'refraction', 'heat haze', 'glass', 'lens', 'prism', 'optical flow', 'flow', 'normal map', 'ripple', 'water', 'chromatic'],
  inputs: { image: { type: 'image', required: true, label: 'Image' }, map: { type: 'image', required: true, label: 'Map' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    mode: {
      type: 'enum',
      default: 'rg',
      label: 'Map means',
      hint: 'Red and green: red moves pixels sideways, green up and down, mid gray stays. Brightness slope: pixels are pushed along the slope of the map, like looking through bumpy glass. Normal map: the tilt of each pixel of a normal map. Optical flow: the motion picture of an Optical Flow node.',
      options: [
        { value: 'rg', label: 'Red and green' },
        { value: 'gradient', label: 'Brightness slope' },
        { value: 'normal', label: 'Normal map' },
        { value: 'flow', label: 'Optical flow' },
      ],
    },
    amountX: { type: 'number', default: 20, min: -1000, max: 1000, softMax: 300, step: 0.5, unit: 'px', label: 'Amount X', hint: 'How far the strongest map value moves pixels sideways: content moves toward + (right).', visibleIf: (p) => p.mode !== 'flow' },
    amountY: { type: 'number', default: 20, min: -1000, max: 1000, softMax: 300, step: 0.5, unit: 'px', label: 'Amount Y', hint: 'Content moves toward + (down).', visibleIf: (p) => p.mode !== 'flow' },
    smoothing: { type: 'number', default: 3, min: 0.5, max: 100, softMax: 30, step: 0.1, unit: 'px', label: 'Slope width', hint: 'How far apart the two samples are that measure the slope. Bigger = softer, wider refraction.', visibleIf: (p) => p.mode === 'gradient' },
    flowFrames: { type: 'number', default: 1, min: -16, max: 16, softMax: 8, step: 0.1, label: 'Flow frames', hint: 'How many frames of motion to move the pixels by. 1 = one frame forward along the flow, negative = backward.', visibleIf: (p) => p.mode === 'flow' },
    flipY: { type: 'bool', default: false, label: 'Flip normal Y', hint: 'For DirectX style normal maps (green points down).', visibleIf: (p) => p.mode === 'normal' },
    chroma: { type: 'number', default: 0, min: -2, max: 2, step: 0.01, label: 'Prism split', hint: 'Red moves further and blue less (or the other way with a negative value): colored fringes along the warped edges. 0 = off.' },
    edge: {
      type: 'enum',
      default: 'clamp',
      label: 'Edges',
      hint: 'What pixels pulled from outside the picture show.',
      options: [
        { value: 'clamp', label: 'Stretch' },
        { value: 'mirror', label: 'Mirror' },
        { value: 'wrap', label: 'Wrap' },
        { value: 'transparent', label: 'Transparent' },
      ],
    },
    mapScale: { type: 'number', default: 1, min: 0.05, max: 20, softMax: 8, step: 0.01, label: 'Map scale', group: 'Map', hint: 'Zoom of the map. The map repeats when it is smaller than the picture.' },
    mapOffsetX: { type: 'number', default: 0, min: -1, max: 1, step: 0.005, unit: 'norm', label: 'Map offset X', group: 'Map' },
    mapOffsetY: { type: 'number', default: 0, min: -1, max: 1, step: 0.005, unit: 'norm', label: 'Map offset Y', group: 'Map' },
    scrollX: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Map scroll X', group: 'Map', hint: 'The map slides sideways by this many whole map widths per loop, so it loops exactly. 0 = still.' },
    scrollY: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Map scroll Y', group: 'Map' },
    snap: { type: 'bool', default: true, label: 'Snap to art pixels', group: 'Pixel art', hint: 'On an art-grid picture (Pixelate) every art pixel moves as a whole by whole art pixels, so pixel art stays crisp. Off = smooth warping of the enlarged picture.' },
  },
  summary: (p) => `${p.mode}${p.mode === 'flow' ? '' : ` · ${p.amountX}, ${p.amountY} px`}${p.chroma ? ' · prism' : ''}${p.scrollX || p.scrollY ? ' · scrolling' : ''}`,
  render(ctx) {
    const p = ctx.params;
    const image = ctx.in.image;
    const animated = p.scrollX !== 0 || p.scrollY !== 0;
    const phase = animated ? ctx.time.phase : 0;
    const cell = p.snap && image.cell && image.cell > 1.01 ? image.cell : 0;
    const out = ctx.gpu.pass({
      label: 'displace-map',
      size: image,
      textures: { src: image, mp: ctx.in.map },
      uniforms: {
        mode: MODE[p.mode as keyof typeof MODE],
        amount: [p.amountX, p.amountY],
        smoothR: Math.max(0.5, p.smoothing),
        flowK: p.flowFrames,
        flipY: p.flipY ? -1 : 1,
        chroma: p.chroma,
        edge: EDGE[p.edge as keyof typeof EDGE],
        mapScale: p.mapScale,
        mapOffset: [p.mapOffsetX + p.scrollX * phase, p.mapOffsetY + p.scrollY * phase],
        cell,
      },
      wgsl: /* wgsl */ `
fn edgeUv(uv: vec2f) -> vec2f {
  let e = i32(u.edge + 0.5);
  if (e == 1) { return 1.0 - abs(fract(uv * 0.5) * 2.0 - 1.0); }
  if (e == 2) { return fract(uv); }
  return clamp(uv, vec2f(0.0), vec2f(1.0));
}
fn fetchSrc(uv: vec2f) -> vec4f {
  if (u.edge > 2.5 && (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0)) { return vec4f(0.0); }
  if (u.cell > 0.0) { return textureSampleLevel(src, smpNearest, edgeUv(uv), 0.0); }
  return textureSampleLevel(src, smp, edgeUv(uv), 0.0);
}
// Where the map is read for output position uv: the map repeats, scale zooms about the centre, offset slides it.
fn mapAt(uv: vec2f) -> vec2f { return fract((uv - 0.5) / u.mapScale + 0.5 + u.mapOffset); }
fn lumaMap(q: vec2f) -> f32 { return luma(textureSampleLevel(mp, smp, fract(q), 0.0).rgb); }

// how far the CONTENT moves at this place, in texels (x right, y down)
fn shift(uv: vec2f) -> vec2f {
  let mode = i32(u.mode + 0.5);
  let q = mapAt(uv);
  if (mode == 0) {
    let m = unpremul(textureSampleLevel(mp, smp, q, 0.0)).rgb;
    return (m.rg - vec2f(0.5)) * 2.0 * u.amount;
  }
  if (mode == 1) {
    let ex = vec2f(u.smoothR, 0.0) / u.size / u.mapScale;
    let ey = vec2f(0.0, u.smoothR) / u.size / u.mapScale;
    return vec2f(lumaMap(q + ex) - lumaMap(q - ex), lumaMap(q + ey) - lumaMap(q - ey)) * u.amount;
  }
  if (mode == 2) {
    let n = unpremul(textureSampleLevel(mp, smp, q, 0.0)).rgb * 2.0 - 1.0;
    return vec2f(n.x, -n.y * u.flipY) * u.amount;
  }
  let f = textureSampleLevel(mp, smp, q, 0.0).rg;
  return f * u.size * u.flowK;
}

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var puv = uv;
  var cc = vec2f(0.0);
  if (u.cell > 0.0) {
    cc = floor(px / u.cell);
    puv = (cc + 0.5) * u.cell / u.size;
  }
  let d = shift(puv);
  let k = u.chroma;
  var offs = array<vec2f, 3>(d * (1.0 + k), d, d * (1.0 - k));
  var res = vec4f(0.0);
  if (abs(k) < 0.0001) { offs[0] = d; offs[2] = d; }
  var cols = array<vec4f, 3>(vec4f(0.0), vec4f(0.0), vec4f(0.0));
  for (var i = 0; i < 3; i++) {
    var o = offs[i];
    var at = (px - o) / u.size;
    if (u.cell > 0.0) {
      o = round(o / u.cell) * u.cell;
      at = ((cc + 0.5) * u.cell - o) / u.size;
    }
    cols[i] = fetchSrc(at);
    if (abs(k) < 0.0001) { cols[1] = cols[0]; cols[2] = cols[0]; break; }
  }
  res = vec4f(cols[0].r, cols[1].g, cols[2].b, (cols[0].a + cols[1].a + cols[2].a) / 3.0);
  if (abs(k) < 0.0001) { res = cols[0]; }
  return res;
}`,
    });
    return { image: cell > 0 ? { ...out, cell } : out };
  },
});
