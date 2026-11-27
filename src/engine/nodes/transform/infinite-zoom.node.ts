import { defineNode } from '../../define';
import type { ImageValue } from '../../types';
import { COPY_COMMON_WGSL, rad } from '../../lib/copy-wgsl';
import { genPaletteTexture } from '../../lib/gen-common';
import { pullSliceFrames, SLICE_GROUP } from '../../lib/time-slices';
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
 *
 * Scale up to 1: the layer map is computed without the fixed point so it stays finite when the copies are the same size. With
 * eps = 1 - q, layer depth kd sits at p + G (p - c - q (p - h)), G = (q^-kd - 1) / eps (a complex number). G has the finite limit kd as q
 * tends to 1 (a pure shift by (c - h) per level), and below |eps| = 0.002 a three-term series is used so there is no cancellation.
 *
 * Delay per level: copy kd shows the input as it was round(kd * delay) frames ago (the current picture for kd <= 0). The older pictures are
 * pulled like Slit Scan does (one pull per distinct frame, none when the input is still), and since the shader has no texture arrays the
 * layers are drawn in groups of SLICE_GROUP distinct frames, one pass per group, each group composited behind the previous one. Layers are
 * ordered front to back by depth and a deeper layer is never newer, so the groups keep the order. Stored frames are capped (MAX_HISTORY).
 */
const MAX_LEVELS = 64;
/** Most frames of history a delayed zoom may reach back: levels x delay is cut down to this. */
export const MAX_HISTORY = 64;

/** Frames per level actually used: the typed delay, cut so that the deepest copy reaches back at most MAX_HISTORY frames. */
export function effectiveDelay(delay: number, levels: number): number {
  const d = Math.max(0, Math.round(delay));
  if (d === 0) return 0;
  return Math.max(1, Math.min(d, Math.floor(MAX_HISTORY / Math.max(1, levels + 1))));
}

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

const SLOT_NEAREST = Array.from({ length: SLICE_GROUP }, (_, j) => {
  const v = j < 4 ? `u.mv0.${'xyzw'[j]}` : `u.mv1.${'xyzw'[j - 4]}`;
  return `  { let d = abs(${v} - m); if (d < bd) { bd = d; best = ${j}; } }`;
}).join('\n');

const wgsl = (hasInner: boolean, usePal: boolean, delayed: boolean, hasAcc: boolean) => /* wgsl */ `
${COPY_COMMON_WGSL}
fn palAtK(i: i32) -> vec3f { ${usePal ? 'return textureLoad(pal, vec2i(pmodi(i, i32(u.palN + 0.5)), 0), 0).rgb;' : 'return vec3f(1.0);'} }
fn palFlow(x: f32) -> vec3f {
  let i = i32(floor(x));
  return mix(palAtK(i), palAtK(i + 1), smoothstep(0.0, 1.0, fract(x)));
}
fn cmul(a: vec2f, b: vec2f) -> vec2f { return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
fn cdiv(a: vec2f, b: vec2f) -> vec2f { return cmul(a, vec2f(b.x, -b.y)) / max(dot(b, b), 1e-20); }
/** G(kd) = (q^-kd - 1) / (1 - q): finite for q = 1 (then kd). */
fn gAt(kd: f32, sc: f32) -> vec2f {
  if (length(u.eps) < 0.002) {
    let e = u.eps;
    return vec2f(kd, 0.0) + e * (kd * (kd + 1.0) * 0.5) + cmul(e, e) * (kd * (kd + 1.0) * (kd + 2.0) / 6.0);
  }
  let th = -u.rho * kd;
  return cdiv(sc * vec2f(cos(th), sin(th)) - vec2f(1.0, 0.0), u.eps);
}
${delayed ? `fn sampleSlot(i: i32, uv: vec2f, tpp: f32) -> vec4f {
  switch (i) {
${Array.from({ length: SLICE_GROUP }, (_, k) => `    case ${k}: { return sampleCopy(s${k}, uv, tpp); }`).join('\n')}
    default: { return sampleCopy(s0, uv, tpp); }
  }
}` : ''}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var pp = px;
  if (u.spiral != 0.0) {
    var w = px - u.fixedPt;
    let ang = u.spiral * TAU * log(max(length(w), 0.001)) / u.lnS;
    let cs = cos(ang); let sn = sin(ang);
    w = vec2f(w.x * cs - w.y * sn, w.x * sn + w.y * cs);
    pp = u.fixedPt + w;
  }
  let bq = (pp - u.ctr) - cmul(u.qv, pp - u.hmid);
  var acc = ${hasAcc ? 'textureSampleLevel(acc, smpNearest, uv, 0.0)' : 'vec4f(0.0)'};
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
    ${delayed ? `let m = floor(max(kd, 0.0) * u.delayF + 0.5);
    if (m < u.mLo || m >= u.mHi) { continue; }
    var best = 0; var bd = 1e9;
${SLOT_NEAREST}` : ''}
    let pk = pp + cmul(gAt(kd, sc), bq);
    let e = (hS - abs(pk - hS)) / sc;
    let cov = saturate(e.x + 0.5) * saturate(e.y + 0.5);
    if (cov <= 0.0) { continue; }
    let suv = pk / u.srcSize;
    var t = unpremul(${delayed ? 'sampleSlot(best, suv, sc)' : 'sampleCopy(src, suv, sc)'});
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
    'The picture contains a smaller copy of itself, which contains a smaller copy, forever, and the camera falls in (the Droste effect). Put the center on a hole of your logo, set how small each copy is, and let it fall; every level can take the next color of a palette. Loops seamlessly when it travels a whole number of levels.',
  keywords: ['droste', 'tunnel', 'recursive', 'recursion', 'fall into', 'zoom loop', 'fractal', 'infinite', 'mise en abyme', 'zoom', 'logo', 'spiral', 'trippy', 'feedback'],
  guide: {
    does: 'Puts smaller copies of the picture inside the picture, over and over. With a delay, each copy shows an earlier moment, so a moving picture leaves a receding stack of its past: the sound waterfall of an old oscilloscope.',
    steps: [
      'Wire a picture in. For a sound waterfall use an Oscilloscope with a see-through background.',
      'Set Copy scale a little under 1 and move Next center above the middle, so each copy sits further back and higher up.',
      'Turn Delay per level up to 1 or 2 so each copy shows an earlier moment.',
      'Raise Levels shown for a taller stack, and Fade per level to let the old lines sink into the dark.',
    ],
    needs: [{ input: 'image', hint: 'The picture to repeat. For the waterfall, an Oscilloscope with its background made see-through.' }],
    seeAlso: ['oscilloscope', 'echo', 'feedback'],
  },
  inputs: { image: { type: 'image', required: true, label: 'Image' }, inner: { type: 'image', label: 'Inner picture' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    centre: { type: 'vec2', default: [0.5, 0.5], unit: 'norm', min: -1, max: 2, step: 0.005, label: 'Next center', hint: 'Position of the nested copy’s middle, as a fraction of the picture. Put it on a hole or counter of your logo.' },
    scale: { type: 'number', default: 0.35, min: 0.02, max: 1, step: 0.005, label: 'Copy scale', hint: 'Fraction of the one before. A clean tunnel needs the copy to fit inside its hole. 1 = same size, only shifted: a flat stack. A little under 1 = the stack recedes in perspective.' },
    rotatePerLevel: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Turn per level', hint: 'Each nested copy is turned by this much (clockwise).' },
    levels: { type: 'number', default: 8, min: 0, max: MAX_LEVELS, softMax: 24, step: 1, integer: true, label: 'Levels shown', hint: 'How many nested copies are visible. More only costs time where the copies are still large and see-through.' },
    delay: { type: 'number', default: 0, min: 0, max: 30, step: 1, integer: true, label: 'Delay per level', hint: 'Each copy shows the picture from this many frames earlier than the one in front, so a moving picture leaves a receding trail of its past. 0 = all copies show the same moment. At most 64 frames back in total, so a tall stack with a big delay is cut down.' },
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
    const dl = effectiveDelay(p.delay, p.levels);
    return `${p.levels} levels · ×${p.scale}${dl ? ` · ${dl} frame${dl === 1 ? '' : 's'} older per level${dl < p.delay ? ' (cut to fit 64)' : ''}` : ''}${z.travel ? ` · ${z.travel > 0 ? 'falling' : 'rising'} ${Math.abs(z.travel)}/loop` : ''}${z.notes.length ? ` · ${z.notes.join(', ')}` : ''}`;
  },
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const inner = ctx.in.inner;
    const S: [number, number] = [src.width, src.height];
    const sigma = Math.min(1, Math.max(0.02, p.scale));
    const rho = rad(p.rotatePerLevel);
    const q: [number, number] = [sigma * Math.cos(rho), sigma * Math.sin(rho)];
    const h: [number, number] = [S[0] / 2, S[1] / 2];
    const c: [number, number] = [p.centre[0] * S[0], p.centre[1] * S[1]];
    // eps = 1 - q. The fixed point f = (c - q h) / eps is only needed by the twist, which is ignored when the copies are nearly the same size.
    const eps: [number, number] = [1 - q[0], -q[1]];
    const dd = eps[0] * eps[0] + eps[1] * eps[1];
    const num: [number, number] = [c[0] - (q[0] * h[0] - q[1] * h[1]), c[1] - (q[0] * h[1] + q[1] * h[0])];
    const fixedPt: [number, number] = dd > 1e-12 ? [(num[0] * eps[0] + num[1] * eps[1]) / dd, (num[1] * eps[0] - num[0] * eps[1]) / dd] : [0, 0];
    const lnS = Math.log(sigma);
    const fade01 = (x: number) => {
      const u = Math.min(1, Math.max(0, (x - 0.01) / 0.03));
      return u * u * (3 - 2 * u);
    };
    const spiral = p.spiral * fade01(Math.abs(lnS));
    const usePal = p.recolor !== 'off';
    const pal = usePal ? genPaletteTexture(ctx.gpu, p.palette as [number, number, number][]) : null;
    const z = p.speed !== 0 ? zoomLoop(p, { loop: ctx.time.loop }) : zoomLoop(p, undefined);
    const phase = p.speed !== 0 ? ctx.time.phase : 0;
    const t = z.travel !== 0 ? z.travel * phase : 0;
    const k0 = z.loop ? Math.floor(t) - 1 : 0;
    const kEnd = z.loop ? p.levels + 1 + t : p.levels + 1;
    const base = {
      srcSize: S,
      fixedPt,
      lnS,
      rho,
      qv: q,
      eps,
      ctr: c,
      hmid: h,
      t,
      // Loop on: draw every visible depth (also the deep end of a falling travel and the outer layers of a rising one), which is what lets
      // the last frame be followed by the first. Loop off keeps the original range.
      k0,
      kEnd,
      levels: p.levels,
      spiral,
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
    };
    const delay = effectiveDelay(p.delay, p.levels);
    if (delay === 0) {
      const image = ctx.gpu.pass({
        label: 'infinite-zoom',
        size: src,
        textures: { src, inner: inner ?? null, pal: pal ? pal.texture : null },
        uniforms: base,
        wgsl: wgsl(!!inner, usePal, false, false),
      });
      return { image };
    }
    // Which past frames are needed: the distinct m = round(depth * delay) over the layers that can be seen.
    const need = new Set<number>([0]);
    for (let n = 0; n < MAX_LEVELS + 4; n++) {
      const fk = k0 + n;
      if (fk > kEnd) break;
      const kd = fk - t;
      if (p.levels + 1 - kd <= 0 || kd <= -1) continue;
      need.add(Math.floor(Math.max(kd, 0) * delay + 0.5));
    }
    const ms = [...need].sort((a, b) => a - b);
    const frames = await pullSliceFrames(ctx as never, 'image', ms.map((m) => -m));
    const groups = Math.ceil(ms.length / SLICE_GROUP);
    let acc: ImageValue | null = null;
    for (let g = 0; g < groups; g++) {
      const cnt = Math.min(SLICE_GROUP, ms.length - g * SLICE_GROUP);
      const textures: Parameters<typeof ctx.gpu.pass>[0]['textures'] = { acc, inner: inner ?? null, pal: pal ? pal.texture : null };
      const mv = new Array<number>(SLICE_GROUP).fill(1e6);
      for (let j = 0; j < SLICE_GROUP; j++) {
        const idx = g * SLICE_GROUP + Math.min(j, cnt - 1);
        textures[`s${j}`] = frames[idx];
        if (j < cnt) mv[j] = ms[idx];
      }
      const last = g === groups - 1;
      const next: ImageValue = ctx.gpu.pass({
        label: 'infinite-zoom',
        size: src,
        format: last ? undefined : 'rgba16float',
        textures,
        uniforms: {
          ...base,
          delayF: delay,
          mLo: g === 0 ? -1e9 : ms[g * SLICE_GROUP],
          mHi: last ? 1e9 : ms[(g + 1) * SLICE_GROUP],
          mv0: mv.slice(0, 4),
          mv1: mv.slice(4),
        },
        wgsl: wgsl(!!inner, usePal, true, !!acc),
      });
      if (acc) ctx.gpu.recycle(acc);
      acc = next;
    }
    return { image: acc as ImageValue };
  },
});
