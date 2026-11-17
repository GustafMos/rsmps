import { defineNode } from '../../define';
import { COPY_COMMON_WGSL, MAX_SLICES, rad, rgba4 } from '../../lib/copy-wgsl';
import { snapMultiple, snapNote, wholeCycles } from '../../lib/loop-snap';
import { wrapSeconds } from '../../lib/util-time';
import type { ImageValue } from '../../types';

/**
 * Array: many copies of one picture in ONE fragment pass.
 *
 * Every output pixel is inverse-mapped into the copies that can reach it (the cell it falls in plus a small neighbourhood, composited
 * back to front), so 10,000 copies cost the same as 4. The neighbourhood is a uniform (`win`), never part of the shader text, so the
 * pipeline depends only on `timed` (1 or 8 bound textures): dragging any number never compiles anything.
 *
 * Where analytic inversion is impossible (a finite grid / line / ring with per-copy offset, rotation or scale steps) and the array is
 * small (<= 25 copies per axis) the neighbourhood is the whole array (exact). Larger arrays with big steps use the local neighbourhood.
 *
 * One-click looping (Loop on, scrolling): see `arrayLoop`. A scrolled finite Grid wraps inside its own box (a conveyor), so a copy that leaves
 * one side comes in on the other; per-copy colour steps blend toward the colour of the cell the copy ends the loop in (the colour index moves
 * linearly, so nothing pops); a brick offset with an odd vertical scroll slides alternate rows sideways, an odd horizontal scroll with mirroring
 * turns the copies over like cards; whatever is picked per copy (jitter, sprite sheet cell, time slice) cannot be blended, so the scroll is
 * rounded to whole tiles instead. With Loop off nothing changes.
 */
const MODES = { grid: 0, linear: 1, radial: 2, infinite: 3 } as const;
const MAX_WIN = 25;

export interface ArrayLoop {
  sx: number;
  sy: number;
  /** The loop switch is on and the array scrolls: the loop closing code runs. */
  on: boolean;
  notes: string[];
}

/** Effective scroll for the project clock. Pure (summary and render share it). */
export function arrayLoop(
  p: { mode: string; scrollX: number; scrollY: number; columns: number; rows: number; sheetColumns: number; sheetRows: number; timeSlices: number; jitterPos: number; jitterRotate: number; jitterScale: number },
  loop: boolean,
): ArrayLoop {
  const scrolling = (p.mode === 'grid' || p.mode === 'infinite') && (p.scrollX !== 0 || p.scrollY !== 0);
  if (!loop || !scrolling) return { sx: p.scrollX, sy: p.scrollY, on: false, notes: [] };
  let sx = wholeCycles(p.scrollX);
  let sy = wholeCycles(p.scrollY);
  const discrete = p.sheetColumns * p.sheetRows > 1 || p.timeSlices > 1 || p.jitterPos > 0 || p.jitterRotate > 0 || p.jitterScale > 0;
  if (discrete) {
    sx = snapMultiple(sx, Math.round(p.columns));
    sy = snapMultiple(sy, Math.round(p.rows));
  }
  const notes = [snapNote('scroll X', p.scrollX, sx), snapNote('scroll Y', p.scrollY, sy)].filter(Boolean);
  return { sx, sy, on: true, notes };
}

const wgsl = (timed: boolean) => /* wgsl */ `
${COPY_COMMON_WGSL}
${
  timed
    ? `fn srcAt(sl: i32, uv: vec2f, tpp: f32) -> vec4f {
  switch (sl) {
${Array.from({ length: MAX_SLICES }, (_, k) => `    case ${k}: { return sampleCopy(s${k}, uv, tpp); }`).join('\n')}
    default: { return sampleCopy(s0, uv, tpp); }
  }
}`
    : `fn srcAt(sl: i32, uv: vec2f, tpp: f32) -> vec4f { return sampleCopy(s0, uv, tpp); }`
}

fn evalCopy(p: vec2f, c0: vec2f, rot0: f32, s0v: f32, fl: vec2f, nc: f32, key: vec2i, total: f32) -> vec4f {
  var c = c0; var rot = rot0; var s = s0v;
  let hasJ = u.jPos > 0.0 || u.jRot > 0.0 || u.jScale > 0.0;
  if (hasJ) {
    let rv = rnd4(key.x, key.y, i32(u.seed));
    c += (rv.xy - 0.5) * 2.0 * u.jPos;
    rot += (rv.z - 0.5) * 2.0 * u.jRot;
    s *= 1.0 + (rv.w - 0.5) * 2.0 * u.jScale;
  }
  s = max(s, 0.0001);
  let d = p - c;
  var l = unrot(d, cos(rot), sin(rot)) / s;
  // A copy that turns over (loop closing of an odd scroll with mirroring) passes through zero width; at +-1 this is exactly the old multiply.
  l = l / vec2f(select(fl.x, 0.001, abs(fl.x) < 0.001), select(fl.y, 0.001, abs(fl.y) < 0.001));
  let hf = u.cell * 0.5;
  let e = (hf - abs(l)) * s;
  let cov = saturate(e.x + 0.5) * saturate(e.y + 0.5);
  if (cov <= 0.0) { return vec4f(0.0); }
  var cellIdx = 0;
  let nsheet = i32(u.sheet.x * u.sheet.y + 0.5);
  if (nsheet > 1) {
    if (u.vary > 1.5) { cellIdx = i32(floor(rnd4(key.x, key.y, i32(u.seed) + 7919).x * f32(nsheet))); }
    else if (u.vary > 0.5) { cellIdx = pmodi(i32(nc + 0.5), nsheet); }
    cellIdx = min(cellIdx, nsheet - 1);
  }
  let shx = i32(u.sheet.x + 0.5);
  let cxy = vec2f(f32(cellIdx % shx), f32(cellIdx / shx));
  let uv = (cxy + clamp((l + hf) / u.cell, vec2f(0.0), vec2f(1.0))) / u.sheet;
  var sl = 0;
  if (u.slices > 1.5) { sl = pmodi(i32(nc + 0.5), i32(u.slices + 0.5)); }
  let t = unpremul(srcAt(sl, uv, 1.0 / s));
  // Colour steps ride on the copy index. With a closing scroll the index moves toward the cell the copy ends the loop in (linear, no pop).
  var ncc = nc;
  if (u.lw > 0.5) {
    let icl = max(i32(u.cols + 0.5), 1);
    let irw = max(i32(u.rows + 0.5), 1);
    let nci = i32(nc + 0.5);
    let tgt = f32(pmodi(pmodi(nci, icl) + i32(u.sc.x), icl) + icl * pmodi(nci / icl + i32(u.sc.y), irw));
    ncc = mix(nc, tgt, smoothstep(0.6667, 1.0, u.ph));
  }
  var rgb = hueShift(t.rgb, u.hueStep * ncc);
  rgb = rgb * max(0.0, 1.0 + u.brightStep * ncc);
  let g = select(0.0, ncc / (total - 1.0), total > 1.0);
  let grad = mix(u.tintA.rgb, u.tintB.rgb, saturate(g));
  if (u.tintMode > 1.5) { rgb = grad; } else if (u.tintMode > 0.5) { rgb = rgb * grad; }
  let fadeK = select(1.0, pow(max(u.fade, 0.0), ncc), ncc > 0.0);
  let a = t.a * cov * fadeK;
  return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)) * a, a);
}

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var acc = vec4f(0.0);
  let m = i32(u.mode + 0.5);
  let ft = u.firstTop > 0.5;
  let mi = i32(u.mirror + 0.5);
  if (m == 0 || m == 3) {
    let wg = u.wg > 0.5;
    if (wg) {
      let dd = abs(px - u.ctr);
      if (dd.x > u.clip.x || dd.y > u.clip.y) { return vec4f(0.0); }
    }
    let fin = (m == 0) && !wg;
    let icols = i32(u.cols + 0.5);
    let irows = i32(u.rows + 0.5);
    let c0 = u.ctr + u.scroll * u.pitch;
    let q = px - c0;
    let midc = select(0.0, (u.cols - 1.0) * 0.5, m == 0);
    let midr = select(0.0, (u.rows - 1.0) * 0.5, m == 0);
    let jc = i32(round(q.y / u.pitch.y + midr));
    let ic = i32(round(q.x / u.pitch.x + midc));
    let wx = i32(u.win.x + 0.5);
    let wy = i32(u.win.y + 0.5);
    var j0 = jc - (wy - 1) / 2;
    var i0 = ic - (wx - 1) / 2;
    if (u.full > 0.5) { j0 = 0; i0 = 0; }
    for (var a = 0; a < ${MAX_WIN}; a++) {
      if (a >= wy) { break; }
      let j = j0 + select(a, wy - 1 - a, ft);
      if (fin && (j < 0 || j >= irows)) { continue; }
      for (var b = 0; b < ${MAX_WIN}; b++) {
        if (b >= wx) { break; }
        let i = i0 + select(b, wx - 1 - b, ft);
        if (fin && (i < 0 || i >= icols)) { continue; }
        var nc = 0.0;
        var nst = 0.0;
        if (fin) { nc = f32(j * icols + i); nst = nc; } else { nc = f32(pmodi(i, icols) + icols * pmodi(j, irows)); }
        var c = c0 + vec2f((f32(i) - midc) * u.pitch.x, (f32(j) - midr) * u.pitch.y);
        if (pmodi(j, 2) == 1) { c.x += u.stagger * u.pitch.x; }
        // an odd vertical scroll swaps which rows are offset: alternate rows slide sideways so the brick wall ends the loop where it began
        if (u.lw > 0.5 && abs(i32(u.sc.y)) % 2 == 1) { c.x += u.stagger * u.pitch.x * u.ph * (1.0 - 2.0 * f32(pmodi(j, 2))); }
        c += nst * u.stepOff;
        let rot = nst * u.stepRot;
        let s = u.base * pow(u.stepScale, nst);
        var fl = vec2f(1.0);
        if ((mi == 1 || mi == 3) && pmodi(i, 2) == 1) { fl.x = -1.0; }
        if ((mi == 2 || mi == 3) && pmodi(j, 2) == 1) { fl.y = -1.0; }
        // an odd horizontal / vertical scroll with mirroring: the copies turn over once during the loop
        if (u.lw > 0.5 && (mi == 1 || mi == 3) && abs(i32(u.sc.x)) % 2 == 1) { fl.x = fl.x * cos(PI * u.ph); }
        if (u.lw > 0.5 && (mi == 2 || mi == 3) && abs(i32(u.sc.y)) % 2 == 1) { fl.y = fl.y * cos(PI * u.ph); }
        let key = select(vec2i(i, j), vec2i(pmodi(i, icols), pmodi(j, irows)), u.lw > 0.5);
        let l = evalCopy(px, c, rot, s, fl, nc, key, u.total);
        acc = l + acc * (1.0 - l.a);
      }
    }
  } else if (m == 1) {
    let n = i32(u.count + 0.5);
    let sv = u.stepVec;
    var kc = n / 2;
    let sl2 = dot(sv, sv);
    if (sl2 > 0.000001) { kc = i32(round(dot(px - u.ctr, sv) / sl2 + u.cshift)); }
    let wx = i32(u.win.x + 0.5);
    var k0 = kc - (wx - 1) / 2;
    if (u.full > 0.5) { k0 = 0; }
    for (var b = 0; b < ${MAX_WIN}; b++) {
      if (b >= wx) { break; }
      let k = k0 + select(b, wx - 1 - b, ft);
      if (k < 0 || k >= n) { continue; }
      let fk = f32(k);
      let c = u.ctr + (fk - u.cshift) * sv;
      let l = evalCopy(px, c, fk * u.stepRot, u.base * pow(u.stepScale, fk), vec2f(1.0), fk, vec2i(k, 0), f32(n));
      acc = l + acc * (1.0 - l.a);
    }
  } else {
    let n = i32(u.count + 0.5);
    let d = px - u.ctr;
    let stepA = TAU / f32(n);
    let kc = i32(round((atan2(d.x, -d.y) - u.startAng) / stepA));
    let wx = min(i32(u.win.x + 0.5), n);
    var k0 = kc - (wx - 1) / 2;
    if (u.full > 0.5) { k0 = 0; }
    for (var b = 0; b < ${MAX_WIN}; b++) {
      if (b >= wx) { break; }
      let k = pmodi(k0 + select(b, wx - 1 - b, ft), n);
      let fk = f32(k);
      let ang = u.startAng + stepA * fk;
      let c = u.ctr + u.radius * vec2f(sin(ang), -cos(ang));
      let rot = select(0.0, ang, u.face > 0.5) + fk * u.stepRot;
      let l = evalCopy(px, c, rot, u.base * pow(u.stepScale, fk), vec2f(1.0), fk, vec2i(k, 0), f32(n));
      acc = l + acc * (1.0 - l.a);
    }
  }
  return acc;
}`;

export default defineNode({
  id: 'array',
  title: 'Array',
  category: 'transform',
  description:
    'Duplicates a picture: a grid, a line, a ring, or an endless grid that tiles in every direction so scrolling it never shows an edge. Each copy can be offset, rotated, scaled, mirrored, faded and recolored by its position in the array. Computed in one pass, so thousands of copies cost the same as a few.',
  keywords: ['duplicate', 'repeat', 'tile', 'clone', 'grid', 'instances', 'copies', 'cloner', 'pattern', 'brick', 'radial', 'circle', 'ring', 'infinite', 'wallpaper', 'scroll', 'sprite sheet', 'tile preview', 'seamless', 'tileable', 'texture repeat'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'grid',
      label: 'Mode',
      options: [
        { value: 'grid', label: 'Grid' },
        { value: 'linear', label: 'Line' },
        { value: 'radial', label: 'Ring' },
        { value: 'infinite', label: 'Infinite grid' },
      ],
    },
    outputSize: {
      type: 'enum',
      default: 'canvas',
      label: 'Output size',
      options: [
        { value: 'canvas', label: 'Project canvas' },
        { value: 'input', label: 'Same as input' },
      ],
    },
    filter: {
      type: 'enum',
      default: 'crisp',
      label: 'Enlarging',
      options: [
        { value: 'crisp', label: 'Sharp' },
        { value: 'smooth', label: 'Smooth' },
      ],
    },
    fit: { type: 'bool', default: true, label: 'Fit to frame', hint: 'Grid and Infinite: the whole grid (or one period) fills the frame at Size 1. Line and Ring: the first copy starts at about a third of the frame. Off = copies keep the input’s own pixel size × Size.' },
    scale: { type: 'number', default: 1, min: 0.01, max: 20, step: 0.01, label: 'Size', hint: 'Size of every copy (multiplies the fitted size).' },
    columns: { type: 'number', default: 3, min: 1, max: 1000, softMax: 100, step: 1, integer: true, label: 'Columns', hint: 'Infinite grid: the pattern repeats every Columns × Rows copies (color steps, sprite order, time offset).', visibleIf: (p) => p.mode === 'grid' || p.mode === 'infinite' },
    rows: { type: 'number', default: 3, min: 1, max: 1000, softMax: 100, step: 1, integer: true, label: 'Rows', visibleIf: (p) => p.mode === 'grid' || p.mode === 'infinite' },
    count: { type: 'number', default: 6, min: 1, max: 100000, softMax: 256, step: 1, integer: true, label: 'Copies', visibleIf: (p) => p.mode === 'linear' || p.mode === 'radial' },
    spacing: { type: 'vec2', default: [10, 10], unit: '%', min: -90, max: 1000, step: 1, label: 'Gap', hint: 'Space between copies as a percentage of a copy. Negative overlaps them.', visibleIf: (p) => p.mode === 'grid' || p.mode === 'infinite' },
    stagger: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Brick offset', hint: 'Shifts every other row sideways by this fraction of a copy (0.5 = bricks).', visibleIf: (p) => p.mode === 'grid' || p.mode === 'infinite', group: 'Grid' },
    mirror: {
      type: 'enum',
      default: 'none',
      label: 'Mirror alternate',
      options: [
        { value: 'none', label: 'Off' },
        { value: 'x', label: 'Flip every other column' },
        { value: 'y', label: 'Flip every other row' },
        { value: 'both', label: 'Flip both' },
      ],
      visibleIf: (p) => p.mode === 'grid' || p.mode === 'infinite',
      group: 'Grid',
    },
    distance: { type: 'vec2', default: [50, 0], unit: '%', min: -1000, max: 1000, step: 1, label: 'Step', hint: 'Percentage of a copy’s size, per copy.', visibleIf: (p) => p.mode === 'linear' },
    centreRun: { type: 'bool', default: true, label: 'Center the line', visibleIf: (p) => p.mode === 'linear' },
    radius: { type: 'number', default: 0.3, min: 0, max: 2, step: 0.005, unit: 'norm', label: 'Ring radius', hint: 'Fraction of the frame’s shorter side.', visibleIf: (p) => p.mode === 'radial' },
    faceCentre: { type: 'bool', default: true, label: 'Face outward', visibleIf: (p) => p.mode === 'radial' },
    startAngle: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Start angle', hint: 'Clockwise from the top.', visibleIf: (p) => p.mode === 'radial' },
    stepOffset: { type: 'vec2', default: [0, 0], unit: '%', min: -100, max: 100, step: 0.5, label: 'Step offset', hint: 'Added for every copy in turn (copy number × this), as a percentage of a copy.', visibleIf: (p) => p.mode === 'grid', group: 'Per-copy change' },
    stepRotate: { type: 'number', default: 0, min: -360, max: 360, step: 0.5, unit: 'deg', label: 'Rotate per copy', group: 'Per-copy change', visibleIf: (p) => p.mode !== 'infinite' },
    stepScale: { type: 'number', default: 1, min: 0.5, max: 2, step: 0.005, label: 'Scale per copy', hint: 'Each copy is this many times the size of the one before.', group: 'Per-copy change', visibleIf: (p) => p.mode !== 'infinite' },
    firstOnTop: { type: 'bool', default: false, label: 'First copy on top', hint: 'By default later copies are drawn over earlier ones.', group: 'Per-copy change' },
    offset: { type: 'vec2', default: [0, 0], unit: 'norm', min: -2, max: 2, step: 0.005, label: 'Move the array', hint: 'Fraction of the frame. Copies beyond the frame edge are real, so moving shows them instead of cutting off.', group: 'Move' },
    scrollX: { type: 'number', default: 0, min: -32, max: 32, step: 1, integer: true, unit: 'cycles', label: 'Scroll X', hint: 'Whole copies traveled per loop. Loops seamlessly in Infinite mode (with color steps, use a multiple of Columns).', group: 'Move', visibleIf: (p) => p.mode === 'grid' || p.mode === 'infinite' },
    scrollY: { type: 'number', default: 0, min: -32, max: 32, step: 1, integer: true, unit: 'cycles', label: 'Scroll Y', hint: 'With a brick offset use an even number to loop seamlessly.', group: 'Move', visibleIf: (p) => p.mode === 'grid' || p.mode === 'infinite' },
    jitterPos: { type: 'number', default: 0, min: 0, max: 100, step: 1, unit: '%', label: 'Random position', hint: 'Percentage of a copy.', group: 'Random' },
    jitterRotate: { type: 'number', default: 0, min: 0, max: 180, step: 1, unit: 'deg', label: 'Random rotation', group: 'Random' },
    jitterScale: { type: 'number', default: 0, min: 0, max: 0.95, step: 0.01, label: 'Random size', group: 'Random' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', group: 'Random' },
    hueStep: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Hue shift per copy', group: 'Color per copy' },
    brightnessStep: { type: 'number', default: 0, min: -0.5, max: 0.5, step: 0.005, label: 'Copy brightness', hint: 'Added to the brightness multiplier for each copy in turn (negative darkens).', group: 'Color per copy' },
    fade: { type: 'number', default: 1, min: 0, max: 1, step: 0.005, label: 'Opacity falloff', hint: 'Each copy is this fraction as opaque as the one before. 1 = no fade.', group: 'Color per copy' },
    tintMode: {
      type: 'enum',
      default: 'off',
      label: 'Color gradient',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'multiply', label: 'Multiply' },
        { value: 'fill', label: 'Fill' },
      ],
      group: 'Color per copy',
    },
    tintA: { type: 'color', default: [1, 0.3, 0.2, 1], label: 'First copy color', group: 'Color per copy', visibleIf: (p) => p.tintMode !== 'off' },
    tintB: { type: 'color', default: [0.2, 0.5, 1, 1], label: 'Last copy color', group: 'Color per copy', visibleIf: (p) => p.tintMode !== 'off' },
    sheetColumns: { type: 'number', default: 1, min: 1, max: 64, step: 1, integer: true, label: 'Sheet columns', hint: 'The input is a sheet of equal sprites: each copy shows one of them.', group: 'Sprite sheet' },
    sheetRows: { type: 'number', default: 1, min: 1, max: 64, step: 1, integer: true, label: 'Sprite sheet rows', group: 'Sprite sheet' },
    vary: {
      type: 'enum',
      default: 'sequence',
      label: 'Sprite pick', hint: 'Which sprite each copy shows.',
      options: [
        { value: 'sequence', label: 'In order' },
        { value: 'random', label: 'Random' },
      ],
      group: 'Sprite sheet',
      visibleIf: (p) => (p.sheetColumns as number) * (p.sheetRows as number) > 1,
    },
    timeSlices: { type: 'number', default: 1, min: 1, max: MAX_SLICES, softMax: MAX_SLICES, step: 1, integer: true, label: 'Time slices', hint: '1 = every copy shows the same moment. More: copies cycle through that many different moments of the clip (copy 0 now, copy 1 a little earlier, ...). Costs one extra evaluation of the input per slice, not per copy.', group: 'Time offset' },
    timeStep: { type: 'number', default: 4, min: -240, max: 240, step: 1, integer: true, label: 'Slice spacing', hint: 'In frames.', group: 'Time offset', visibleIf: (p) => (p.timeSlices as number) > 1 },
  },
  summary: (p, _wired, clock) => {
    const a = arrayLoop(p, !!clock?.loop);
    const base = p.mode === 'grid' ? `grid ${p.columns}×${p.rows}` : p.mode === 'infinite' ? `infinite ${p.columns}×${p.rows} period` : `${p.mode} × ${p.count}`;
    return a.notes.length ? `${base} · ${a.notes.join(', ')}` : base;
  },
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const out = p.outputSize === 'input' ? src : ctx.canvas;
    const mode = p.mode as keyof typeof MODES;
    const slices = Math.max(1, Math.min(MAX_SLICES, Math.round(p.timeSlices)));
    const scrolling = (mode === 'grid' || mode === 'infinite') && (p.scrollX !== 0 || p.scrollY !== 0);
    const phase = scrolling ? ctx.time.phase : 0;
    const al = arrayLoop(p, scrolling && ctx.time.loop);

    const sheetC = Math.max(1, Math.round(p.sheetColumns));
    const sheetR = Math.max(1, Math.round(p.sheetRows));
    const cellW = src.width / sheetC;
    const cellH = src.height / sheetR;
    const Ow = out.width;
    const Oh = out.height;
    const cols = Math.max(1, Math.round(p.columns));
    const rows = Math.max(1, Math.round(p.rows));
    const count = Math.max(1, Math.round(p.count));
    const gridLike = mode === 'grid' || mode === 'infinite';
    const [spx, spy] = gridLike ? p.spacing : [0, 0];

    let base = p.scale;
    if (p.fit) {
      if (gridLike) base *= Math.min(Ow / (cols * (1 + spx / 100) * cellW), Oh / (rows * (1 + spy / 100) * cellH));
      else base *= 0.3 * Math.min(Ow / cellW, Oh / cellH);
    }
    const pitchX = Math.max(1e-3, cellW * base * (1 + spx / 100));
    const pitchY = Math.max(1e-3, cellH * base * (1 + spy / 100));
    const stepOff: [number, number] = [(p.stepOffset[0] / 100) * cellW * base, (p.stepOffset[1] / 100) * cellH * base];
    const stepVec: [number, number] = [(p.distance[0] / 100) * cellW * base, (p.distance[1] / 100) * cellH * base];
    const stepLen = Math.hypot(stepVec[0], stepVec[1]);
    const rotating = p.stepRotate !== 0 || p.jitterRotate > 0 || (mode === 'radial' && p.faceCentre);
    const halfW = rotating ? Math.hypot(cellW, cellH) / 2 : cellW / 2;
    const halfH = rotating ? Math.hypot(cellW, cellH) / 2 : cellH / 2;
    const jPosPx = (p.jitterPos / 100) * cellW * base;
    const stepped = p.stepRotate !== 0 || p.stepScale !== 1 || (mode === 'grid' && (stepOff[0] !== 0 || stepOff[1] !== 0));
    const scaleMax = Math.min(4, (1 + p.jitterScale) * Math.max(1, p.stepScale));
    const clampR = (v: number) => Math.max(1, Math.min(12, Math.ceil(v)));

    // Neighbourhood (see header). `win` counts copies per axis, always odd unless `full`.
    let winX = 3;
    let winY = 3;
    let full = false;
    if (gridLike) {
      winX = 2 * clampR((halfW * base * scaleMax + jPosPx) / pitchX - 0.5 + Math.ceil(Math.abs(p.stagger))) + 1;
      winY = 2 * clampR((halfH * base * scaleMax + jPosPx) / pitchY - 0.5) + 1;
      if (mode === 'grid' && stepped && cols <= MAX_WIN && rows <= MAX_WIN) {
        full = true;
        winX = cols;
        winY = rows;
      }
    } else if (mode === 'linear') {
      const reach = Math.hypot(halfW, halfH) * base * scaleMax;
      winX = stepLen < 1e-3 ? MAX_WIN : 2 * clampR(reach / stepLen) + 1;
      if (count <= MAX_WIN && (stepped || stepLen < 1e-3 || winX >= count)) {
        full = true;
        winX = count;
      }
    } else {
      const radius = p.radius * Math.min(Ow, Oh);
      const arc = (2 * Math.PI * radius) / count;
      const reach = Math.hypot(halfW, halfH) * base * scaleMax;
      winX = arc < 1e-3 ? MAX_WIN : 2 * clampR(reach / arc) + 1;
      if (count <= MAX_WIN && (stepped || winX >= count)) {
        full = true;
        winX = count;
      }
    }
    // Loop on + scrolled finite grid: it wraps inside its own box, copies are indexed like the infinite grid (local neighbourhood).
    const wrapGrid = al.on && mode === 'grid';
    if (wrapGrid) full = false;
    winX = Math.min(winX, MAX_WIN);
    winY = Math.min(winY, MAX_WIN);

    // Time slices: one pull per extra slice (never per copy).
    const timed = slices > 1;
    const textures: Record<string, ImageValue> = { s0: src };
    if (timed) {
      const { fps, duration, loop, seconds } = ctx.time;
      const frames: ImageValue[] = [src];
      for (let k = 1; k < slices; k++) {
        const target = seconds - (k * p.timeStep) / fps;
        const at = loop ? wrapSeconds(target, duration, fps) : Math.max(0, target);
        frames.push((await ctx.pull('image', { seconds: at })) ?? src);
      }
      for (let k = 0; k < MAX_SLICES; k++) textures[`s${k}`] = frames[Math.min(k, slices - 1)];
    }

    const total = gridLike ? cols * rows : count;
    const tintMode = p.tintMode === 'fill' ? 2 : p.tintMode === 'multiply' ? 1 : 0;
    const image = ctx.gpu.pass({
      label: timed ? 'array-timed' : 'array',
      size: out,
      textures,
      uniforms: {
        mode: MODES[mode],
        cell: [cellW, cellH],
        sheet: [sheetC, sheetR],
        vary: p.vary === 'random' ? 2 : sheetC * sheetR > 1 ? 1 : 0,
        ctr: [Ow / 2 + p.offset[0] * Ow, Oh / 2 + p.offset[1] * Oh],
        scroll: [al.sx * phase, al.sy * phase],
        lw: al.on,
        wg: wrapGrid,
        sc: [al.sx, al.sy],
        ph: phase,
        clip: wrapGrid ? [(cols * pitchX) / 2, (rows * pitchY) / 2] : [0, 0],
        pitch: [pitchX, pitchY],
        cols,
        rows,
        stagger: p.stagger,
        mirror: p.mirror === 'x' ? 1 : p.mirror === 'y' ? 2 : p.mirror === 'both' ? 3 : 0,
        base,
        stepOff,
        stepRot: rad(p.stepRotate),
        stepScale: p.stepScale,
        stepVec,
        count,
        cshift: p.centreRun ? (count - 1) / 2 : 0,
        radius: p.radius * Math.min(Ow, Oh),
        face: p.faceCentre,
        startAng: rad(p.startAngle),
        win: [winX, winY],
        full,
        firstTop: p.firstOnTop,
        jPos: jPosPx,
        jRot: rad(p.jitterRotate),
        jScale: p.jitterScale,
        seed: p.seed,
        hueStep: p.hueStep / 360,
        brightStep: p.brightnessStep,
        tintMode,
        tintA: rgba4(p.tintA),
        tintB: rgba4(p.tintB),
        fade: p.fade,
        total,
        slices,
        smoothTex: p.filter === 'smooth',
      },
      wgsl: wgsl(timed),
    });
    return { image };
  },
});
