import { defineNode } from '../../define';
import { COPY_COMMON_WGSL, rad } from '../../lib/copy-wgsl';
import { genPaletteTexture } from '../../lib/gen-common';
import { closeSequence, closingDrift, closingTurns, snapNote, stretchedStep, stretchedTurns, wholeCycles } from '../../lib/loop-snap';

/**
 * Infinite Zoom (Droste): the picture holds a smaller copy of itself, which holds a smaller copy, forever, and the camera falls in.
 *
 * Maths (all in source pixels, complex numbers): the nested copy is the map T(x) = c + q (x - h) with q = scale * e^(i rotate), h = the
 * picture's middle and c = `centre`. T has one fixed point f; layer k of the picture is seen through w -> w * q^-(k - t) around f, where
 * t = speed * phase is the (fractional) depth travelled. Because every layer depends on (k - t) only, frame t + 1 is frame t with the layers
 * renumbered, which is why a whole number of levels per loop is seamless for any picture. The outermost layer dissolves over one level of
 * travel so nothing pops when it leaves; layers deeper than `levels` fade in the same way. Colours attached to a copy (palette index = k)
 * loop when the travel is a multiple of the palette length; colours fixed to the screen depth (index = k - t) loop at any speed.
 * One-click looping (Loop on): the colours of attached copies are closed with the travel by `zoomLoop` below, whatever the speed and the
 * palette length: by default the colour index drifts by the remainder over the loop ("Drift"), or the travel is rounded to a multiple of
 * the palette ("Snap travel"), or the palette is stretched so its period divides the travel ("Stretch palette"). The hue step closes the
 * same way. With Loop off nothing changes.
 * One fragment pass, a bounded loop over levels, front to back, stops when opaque.
 */
const MAX_LEVELS = 64;

export interface ZoomLoop {
  /** Levels travelled per loop (signed; a whole number with Loop on). */
  travel: number;
  /** Palette index of an attached copy k is k * idxStep + palDrift * phase. */
  idxStep: number;
  palDrift: number;
  /** Hue (turns) of an attached copy k is k * hueTurns + hueDrift * phase. */
  hueTurns: number;
  hueDrift: number;
  /** Short notes for the node summary. */
  notes: string[];
  /** The project loops (and the node moves). */
  loop: boolean;
}

/** Effective travel and colour closing for the project clock. Pure. With Loop off (or no clock) everything is as typed. */
export function zoomLoop(p: { speed: number; recolor: string; palette: unknown[]; attached: boolean; hueStep: number; colorLoop?: string }, clock?: { loop: boolean }): ZoomLoop {
  const plain: ZoomLoop = { travel: p.speed, idxStep: 1, palDrift: 0, hueTurns: p.hueStep / 360, hueDrift: 0, notes: [], loop: false };
  if (!clock?.loop || p.speed === 0) return plain;
  let travel = wholeCycles(p.speed, true);
  const notes: string[] = [];
  const usePal = p.recolor !== 'off';
  const hue = p.hueStep / 360;
  if (!p.attached || (!usePal && hue === 0)) {
    const n = snapNote('speed', p.speed, travel);
    return { ...plain, travel, notes: n ? [n] : [], loop: true };
  }
  const len = usePal ? Math.max(1, p.palette.length) : 1;
  const mode = p.colorLoop ?? 'drift';
  let snapped = false;
  if (mode === 'snap' && usePal) {
    const c = closeSequence(travel, len);
    travel = c.travel;
    snapped = c.snapped;
  }
  const n = snapNote('speed', p.speed, travel);
  if (n) notes.push(n);
  let idxStep = 1;
  let palDrift = 0;
  let hueTurns = hue;
  let hueDrift = 0;
  if (usePal && len > 1) {
    if (mode === 'stretch') idxStep = stretchedStep(travel, len);
    else if (!snapped) palDrift = closingDrift(travel, len);
    if (idxStep !== 1) notes.push('palette stretched to loop');
    if (palDrift !== 0) notes.push(`colors drift ${Math.round(palDrift * 100) / 100}/loop to close`);
  }
  if (hue !== 0) {
    if (mode === 'stretch') hueTurns = stretchedTurns(travel, hue);
    else hueDrift = closingTurns(travel, hue);
    if (hueTurns !== hue) notes.push(`hue step ${Math.round(p.hueStep * 10) / 10} → ${Math.round(hueTurns * 3600) / 10}° to loop`);
    if (hueDrift !== 0) notes.push(`hue drifts ${Math.round(hueDrift * 3600) / 10}°/loop`);
  }
  return { travel, idxStep, palDrift, hueTurns, hueDrift, notes, loop: true };
}

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
  // The visible layers are those with depth kd = k - t in (-1, levels + 1): k runs from floor(t) up to levels + 1 + t, so a rising (negative)
  // travel and the deep end of a falling one are drawn too, which is what lets any whole travel close the loop.
  for (var n = 0; n < ${MAX_LEVELS + 4}; n++) {
    let fk = u.k0 + f32(n);
    if (fk > u.kEnd) { break; }
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
      ${usePal ? 'col = select(palFlow(idx), palFlow(fk * u.idxStep + u.palDrift * u.ph), u.attached > 0.5);' : ''}
      rgb = select(rgb * col, col, u.recolor > 1.5);
    }
    rgb = hueShift(rgb, select(u.hueStep * kd, u.hueTurns * fk + u.hueDrift * u.ph, u.attached > 0.5));
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
    speed: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Levels per loop', hint: 'Whole levels traveled each loop; 0 = still. Positive falls in.' },
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
    palette: { type: 'palette', default: [[1, 0.3, 0.2], [0.2, 0.55, 1]], label: 'Level colors', hint: 'Level 1 takes the first color, level 2 the second, and so on, round and round.', group: 'Color', visibleIf: (p) => p.recolor !== 'off' },
    attached: { type: 'bool', default: true, label: 'Colors attached', hint: 'On: a copy keeps its color as it grows. With Loop on the colors are closed for you, whatever the levels per loop and the palette length (see Close colors). Off: colors belong to the depth on screen, so they flow and always loop.', group: 'Color', visibleIf: (p) => p.recolor !== 'off' || p.hueStep !== 0 },
    colorLoop: {
      type: 'enum',
      default: 'drift',
      label: 'Close colors',
      hint: 'How attached colors loop when the levels per loop is not a multiple of the palette length (or the hue step does not come round). Drift lets the colors cycle slowly while falling. Snap travel rounds the levels per loop to a multiple of the palette. Stretch palette changes the color step per level. Only with Loop on.',
      options: [
        { value: 'drift', label: 'Drift' },
        { value: 'snap', label: 'Snap travel' },
        { value: 'stretch', label: 'Stretch palette' },
      ],
      group: 'Color',
      visibleIf: (p) => p.attached === true && (p.recolor !== 'off' || p.hueStep !== 0),
    },
    hueStep: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Hue step', hint: 'Hue shift per level.', group: 'Color' },
  },
  summary: (p, _wired, clock) => {
    const z = zoomLoop(p, clock);
    return `${p.levels} levels · ×${p.scale}${z.travel ? ` · ${z.travel > 0 ? 'falling' : 'rising'} ${Math.abs(z.travel)}/loop` : ''}${z.notes.length ? ` · ${z.notes.join(', ')}` : ''}`;
  },
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
    const z = p.speed !== 0 ? zoomLoop(p, { loop: ctx.time.loop }) : zoomLoop(p, undefined);
    const phase = p.speed !== 0 ? ctx.time.phase : 0;
    const t = z.travel !== 0 ? z.travel * phase : 0;
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
        // Loop on: draw every visible depth (also the deep end of a falling travel and the outer layers of a rising one), which is what lets
        // the last frame be followed by the first. Loop off keeps the original range.
        k0: z.loop ? Math.floor(t) - 1 : 0,
        kEnd: z.loop ? p.levels + 1 + t : p.levels + 1,
        levels: p.levels,
        spiral: p.spiral,
        dissolve: p.dissolve,
        fade: p.fade,
        recolor: p.recolor === 'fill' ? 2 : p.recolor === 'multiply' ? 1 : 0,
        palN: pal ? pal.count : 1,
        attached: p.attached,
        hueStep: p.hueStep / 360,
        hueTurns: z.hueTurns,
        hueDrift: z.hueDrift,
        idxStep: z.idxStep,
        palDrift: z.palDrift,
        ph: phase,
        smoothTex: p.filter === 'smooth',
      },
      wgsl: wgsl(!!inner, usePal),
    });
    return { image };
  },
});
