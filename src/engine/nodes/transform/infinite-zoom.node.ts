import { defineNode } from '../../define';
import { COPY_COMMON_WGSL, rad } from '../../lib/copy-wgsl';
import { genPaletteTexture } from '../../lib/gen-common';

/**
 * Infinite Zoom (Droste): the picture holds a smaller copy of itself, which holds a smaller copy, forever, and the camera falls in.
 *
 * Maths (all in source pixels, complex numbers): the nested copy is the map T(x) = c + q (x - h) with q = scale * e^(i rotate), h = the
 * picture's middle and c = `centre`. T has one fixed point f; layer k of the picture is seen through w -> w * q^-(k - t) around f, where
 * t = speed * phase is the (fractional) depth travelled. Because every layer depends on (k - t) only, frame t + 1 is frame t with the layers
 * renumbered, which is why a whole number of levels per loop is seamless for any picture. The outermost layer dissolves over one level of
 * travel so nothing pops when it leaves; layers deeper than `levels` fade in the same way. Colours attached to a copy (palette index = k)
 * loop when speed is a multiple of the palette length; colours fixed to the screen depth (index = k - t) loop at any speed.
 * One fragment pass, a bounded loop over levels, front to back, stops when opaque.
 */
const MAX_LEVELS = 64;

const wgsl = (hasInner: boolean, usePal: boolean) => /* wgsl */ `
${COPY_COMMON_WGSL}
fn palAtK(i: i32) -> vec3f { ${usePal ? 'return textureLoad(pal, vec2i(pmodi(i, i32(u.palN + 0.5)), 0), 0).rgb;' : 'return vec3f(1.0);'} }
fn palFlow(x: f32) -> vec3f {
  let i = i32(floor(x));
  return mix(palAtK(i), palAtK(i + 1), smoothstep(0.0, 1.0, fract(x)));
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var w = px - u.fixedPt;
  if (u.spiral != 0.0) {
    let ang = u.spiral * TAU * log(max(length(w), 0.001)) / u.lnS;
    let cs = cos(ang); let sn = sin(ang);
    w = vec2f(w.x * cs - w.y * sn, w.x * sn + w.y * cs);
  }
  var acc = vec4f(0.0);
  let lv = u.levels;
  let hS = u.srcSize * 0.5;
  for (var k = 0; k < ${MAX_LEVELS + 2}; k++) {
    let fk = f32(k);
    if (fk > lv + 1.0) { break; }
    let kd = fk - u.t;
    var wt = saturate(lv + 1.0 - kd);
    if (kd < 0.0) { wt = wt * smoothstep(0.0, 1.0, saturate((kd + 1.0) / max(u.dissolve, 0.001))); }
    if (wt <= 0.0) { continue; }
    let sc = exp(-kd * u.lnS);
    let th = -u.rho * kd;
    let cs = cos(th); let sn = sin(th);
    let ws = w * sc;
    let pk = u.fixedPt + vec2f(ws.x * cs - ws.y * sn, ws.x * sn + ws.y * cs);
    let e = (hS - abs(pk - hS)) / sc;
    let cov = saturate(e.x + 0.5) * saturate(e.y + 0.5);
    if (cov <= 0.0) { continue; }
    let suv = pk / u.srcSize;
    var t = unpremul(sampleCopy(src, suv, sc));
    ${hasInner ? 'if (kd > 0.0) { let ti = unpremul(sampleCopy(inner, suv, sc)); t = mix(t, ti, saturate(kd)); }' : ''}
    let idx = select(kd, fk, u.attached > 0.5);
    var rgb = t.rgb;
    if (u.recolor > 0.5) {
      var col = vec3f(1.0);
      ${usePal ? 'col = select(palFlow(idx), palAtK(i32(fk)), u.attached > 0.5);' : ''}
      rgb = select(rgb * col, col, u.recolor > 1.5);
    }
    rgb = hueShift(rgb, u.hueStep * idx);
    let a = t.a * cov * wt * pow(max(1.0 - u.fade, 0.0), max(kd, 0.0));
    let layer = vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)) * a, a);
    acc = acc + layer * (1.0 - acc.a);
    if (acc.a > 0.996) { break; }
  }
  return acc;
}`;

export default defineNode({
  id: 'infinite-zoom',
  title: 'Infinite Zoom',
  category: 'transform',
  description:
    'The picture contains a smaller copy of itself, which contains a smaller copy, forever, and the camera falls in (the Droste effect). Put the centre on a hole of your logo, set how small each copy is, and let it fall; every level can take the next colour of a palette. Loops seamlessly when it travels a whole number of levels.',
  keywords: ['droste', 'tunnel', 'recursive', 'recursion', 'fall into', 'zoom loop', 'fractal', 'infinite', 'mise en abyme', 'zoom', 'logo', 'spiral', 'trippy', 'feedback'],
  inputs: { image: { type: 'image', required: true, label: 'Image' }, inner: { type: 'image', label: 'Inner picture' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    centre: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: -1, max: 2, step: 0.005, label: 'Next center', hint: 'Position of the nested copy’s middle, as a fraction of the picture. Put it on a hole or counter of your logo.' },
    scale: { type: 'number', default: 0.35, min: 0.02, max: 0.95, step: 0.005, label: 'Copy scale', hint: 'Fraction of the one before. For a perfectly clean tunnel the copy should fit inside the hole it sits in.' },
    rotatePerLevel: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Turn per level', hint: 'Each nested copy is turned by this much (clockwise).' },
    levels: { type: 'number', default: 8, min: 0, max: MAX_LEVELS, softMax: 24, step: 1, integer: true, label: 'Levels shown', hint: 'How many nested copies are visible. More only costs time where the copies are still large and see-through.' },
    speed: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Levels per loop', hint: 'Whole levels travelled each loop; 0 = still. Positive falls in.' },
    spiral: { type: 'number', default: 0, min: -4, max: 4, step: 0.05, label: 'Spiral twist', hint: 'Twists the picture continuously with depth (log-polar). 1 = a full extra turn per level.' },
    dissolve: { type: 'number', default: 0.25, min: 0.02, max: 1, step: 0.01, label: 'Outer dissolve', hint: 'How much of a level’s travel the outermost copy takes to dissolve as it leaves the frame (keeps the loop clean for any picture).', group: 'Depth' },
    fade: { type: 'number', default: 0, min: 0, max: 0.9, step: 0.01, label: 'Fade per level', hint: 'Share of opacity lost at each level of depth.', group: 'Depth' },
    recolor: {
      type: 'enum',
      default: 'off',
      label: 'Recolor each level',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'fill', label: 'Fill next color' },
        { value: 'multiply', label: 'Tint next color' },
      ],
      group: 'Color',
    },
    filter: {
      type: 'enum',
      default: 'smooth',
      label: 'Enlarging',
      hint: 'Copies grow by fractional amounts while falling, so Smooth is the default; Sharp keeps pixel art square.',
      options: [
        { value: 'smooth', label: 'Smooth' },
        { value: 'crisp', label: 'Sharp' },
      ],
      group: 'Depth',
    },
    palette: { type: 'palette', default: [[1, 0.3, 0.2], [0.2, 0.55, 1]], label: 'Level colors', hint: 'Level 1 takes the first colour, level 2 the second, and so on, round and round.', group: 'Color', visibleIf: (p) => p.recolor !== 'off' },
    attached: { type: 'bool', default: true, label: 'Colors attached', hint: 'On: a copy keeps its colour as it grows (loops when Levels fallen is a multiple of the palette length). Off: colours belong to the depth on screen, so they flow and always loop.', group: 'Color', visibleIf: (p) => p.recolor !== 'off' || p.hueStep !== 0 },
    hueStep: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Hue step', hint: 'Hue shift per level.', group: 'Color' },
  },
  summary: (p) => `${p.levels} levels · ×${p.scale}${p.speed ? ` · ${p.speed > 0 ? 'falling' : 'rising'} ${Math.abs(p.speed)}/loop` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const inner = ctx.in.inner;
    const S: [number, number] = [src.width, src.height];
    const sigma = Math.min(0.97, Math.max(0.02, p.scale));
    const rho = rad(p.rotatePerLevel);
    const q: [number, number] = [sigma * Math.cos(rho), sigma * Math.sin(rho)];
    const h: [number, number] = [S[0] / 2, S[1] / 2];
    const c: [number, number] = [p.centre[0] * S[0], p.centre[1] * S[1]];
    // f = (c - q h) / (1 - q), complex
    const num: [number, number] = [c[0] - (q[0] * h[0] - q[1] * h[1]), c[1] - (q[0] * h[1] + q[1] * h[0])];
    const den: [number, number] = [1 - q[0], -q[1]];
    const dd = den[0] * den[0] + den[1] * den[1];
    const fixedPt: [number, number] = [(num[0] * den[0] + num[1] * den[1]) / dd, (num[1] * den[0] - num[0] * den[1]) / dd];
    const usePal = p.recolor !== 'off';
    const pal = usePal ? genPaletteTexture(ctx.gpu, p.palette as [number, number, number][]) : null;
    const t = p.speed !== 0 ? p.speed * ctx.time.phase : 0;
    const image = ctx.gpu.pass({
      label: 'infinite-zoom',
      size: src,
      textures: { src, inner: inner ?? null, pal: pal ? pal.texture : null },
      uniforms: {
        srcSize: S,
        fixedPt,
        lnS: Math.log(sigma),
        rho,
        t,
        levels: p.levels,
        spiral: p.spiral,
        dissolve: p.dissolve,
        fade: p.fade,
        recolor: p.recolor === 'fill' ? 2 : p.recolor === 'multiply' ? 1 : 0,
        palN: pal ? pal.count : 1,
        attached: p.attached,
        hueStep: p.hueStep / 360,
        smoothTex: p.filter === 'smooth',
      },
      wgsl: wgsl(!!inner, usePal),
    });
    return { image };
  },
});
