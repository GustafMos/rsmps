import { defineNode } from '../../define';
import { HYPERCUBE_MOTIONS, hypercubeEdges, hypercubeFaces, hypercubePoints, loopExtent, planeCycles, quadToUnit, type HypercubePose, type Projected } from '../../lib/hypercube';
import { wander } from '../../lib/shake';

/**
 * A cube of 3 to 6 dimensions as a glowing wireframe.
 *
 * The corners are turned and flattened to the picture in JavaScript (64 corners at most: nothing), and handed to the
 * shader as a small table of line pieces. The shader then asks, for every pixel, how far the nearest line is: that gives
 * lines of any thickness with soft edges and a glow, with no geometry to rasterise. 192 lines per pixel is cheap for a
 * graphics card.
 *
 * Every plane of rotation makes a whole number of turns per loop, so the last frame joins the first.
 * The table has one column per item and these rows:
 *   0      line ends (ax, ay, bx, by), in shares of the picture height from its centre
 *   1, 2   colour and half thickness at each end
 *   3, 4   the four corners of a flat face;  5  its colour and strength
 *   6, 7   the four corners of a face of the cube that carries the picture;  8, 9, 10  the matrix that takes a pixel to
 *          its place on the picture
 */
const ROWS = 11;
/**
 * The table holds 16-bit numbers: about three digits, a quarter of a pixel on a large picture, enough to make a slowly
 * turning line shimmer. So each position is written twice: rounded to 1/64 (which those numbers hold exactly) and, ROWS
 * further down, the small remainder.
 */
const COARSE = 64;
/** The ordinary camera (3 dimensions to 2) is gentler than the steps through the higher dimensions: at full strength the near corner balloons and the nested cubes are hard to make out. */
const CAMERA = 0.6;

const DIMS: Record<string, { n: number; label: string }> = {
  '3': { n: 3, label: '3D cube' },
  '4': { n: 4, label: '4D tesseract' },
  '5': { n: 5, label: '5D penteract' },
  '6': { n: 6, label: '6D hexeract' },
};

/** `pic`: 0 = no picture wired, 1 = picture behind the lines, 2 = picture on the faces of one cube. */
function hypercubeWgsl(pic: number): string {
  return /* wgsl */ `
const FINE: i32 = ${ROWS};
fn row(i: i32, r: i32) -> vec4f { return textureLoad(data, vec2i(i, r), 0); }
// positions are stored as a coarse part and a fine part (see FINE): added together they are exact enough not to wobble
fn rowP(i: i32, r: i32) -> vec4f { return textureLoad(data, vec2i(i, r), 0) + textureLoad(data, vec2i(i, r + FINE), 0); }
// How much of the pixel lies inside a four-cornered shape (corners going around either way).
fn quadCover(p: vec2f, a: vec4f, b: vec4f, aa: f32) -> f32 {
  let c0 = a.xy; let c1 = a.zw; let c2 = b.xy; let c3 = b.zw;
  let e0 = c1 - c0; let e1 = c2 - c1; let e2 = c3 - c2; let e3 = c0 - c3;
  let area = e0.x * e1.y - e0.y * e1.x + e2.x * e3.y - e2.y * e3.x;
  let s = select(-1.0, 1.0, area >= 0.0);
  let d0 = (e0.x * (p.y - c0.y) - e0.y * (p.x - c0.x)) / max(length(e0), 1.0e-9);
  let d1 = (e1.x * (p.y - c1.y) - e1.y * (p.x - c1.x)) / max(length(e1), 1.0e-9);
  let d2 = (e2.x * (p.y - c2.y) - e2.y * (p.x - c2.x)) / max(length(e2), 1.0e-9);
  let d3 = (e3.x * (p.y - c3.y) - e3.y * (p.x - c3.x)) / max(length(e3), 1.0e-9);
  return clamp(min(min(d0 * s, d1 * s), min(d2 * s, d3 * s)) / aa + 0.5, 0.0, 1.0);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let p = (px - 0.5 * u.size) / u.size.y;
  let aa = 1.0 / u.size.y;
  // straight colour and alpha, built up from the back
  var rgb = u.bg.rgb;
  var alpha = u.bg.a;
  ${
    pic === 1
      ? `{
    let s = textureSampleLevel(image, smp, uv, 0.0);
    let k = u.picOpacity;
    rgb = s.rgb * k + rgb * alpha * (1.0 - s.a * k);
    alpha = s.a * k + alpha * (1.0 - s.a * k);
    if (alpha > 0.0001) { rgb /= alpha; }
  }`
      : ''
  }
  ${
    pic === 2
      ? `for (var i = 0; i < i32(u.nPic); i++) {
    let cov = quadCover(p, rowP(i, 6), rowP(i, 7), aa);
    if (cov <= 0.0) { continue; }
    let q = vec3f(dot(rowP(i, 8).xyz, vec3f(p, 1.0)), dot(rowP(i, 9).xyz, vec3f(p, 1.0)), dot(rowP(i, 10).xyz, vec3f(p, 1.0)));
    if (q.z <= 1.0e-6) { continue; }
    let s = textureSampleLevel(image, smp, clamp(q.xy / q.z, vec2f(0.0), vec2f(1.0)), 0.0);
    let k = cov * u.picOpacity;
    rgb = s.rgb * k + rgb * alpha * (1.0 - s.a * k);
    alpha = s.a * k + alpha * (1.0 - s.a * k);
    if (alpha > 0.0001) { rgb /= alpha; }
  }`
      : ''
  }
  // faces: light added on top of light, so the order they are drawn in does not matter
  var light = vec3f(0.0);
  for (var i = 0; i < i32(u.nFace); i++) {
    let c = row(i, 5);
    light += c.rgb * c.a * quadCover(p, rowP(i, 3), rowP(i, 4), aa);
  }
  // lines: the core takes the colour of whichever lines cover the pixel, the glow of every line adds up
  var core = vec3f(0.0);
  var coverSum = 0.0;
  var coverMax = 0.0;
  var glow = vec3f(0.0);
  for (var i = 0; i < i32(u.nSeg); i++) {
    let e = rowP(i, 0);
    let ca = row(i, 1);
    let cb = row(i, 2);
    let pa = p - e.xy;
    let ba = e.zw - e.xy;
    let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1.0e-12), 0.0, 1.0);
    let d = length(pa - ba * h);
    let c = mix(ca, cb, h);
    // a line thinner than a pixel is drawn one pixel wide and fainter instead: it would flicker otherwise
    let w = max(c.a, 0.5 * aa);
    let cov = clamp((w - d) / aa + 0.5, 0.0, 1.0) * min(1.0, c.a / (0.5 * aa));
    core += c.rgb * cov;
    coverSum += cov;
    coverMax = max(coverMax, cov);
    let g = max(d - c.a, 0.0) / (u.glowSize * (0.5 + c.a / max(u.thick, 1.0e-6)));
    glow += c.rgb * (exp(-g) * 0.14 + exp(-g * 4.0) * 0.3);
  }
  // many lights on one spot: roll off toward full brightness, keeping the colour instead of burning out to white
  light += glow * u.glow;
  let peak = max(light.r, max(light.g, light.b));
  let la = 1.0 - exp(-peak);
  light *= la / max(peak, 1.0e-6);
  rgb = rgb * alpha + light;
  alpha = alpha + la * (1.0 - alpha);
  if (coverSum > 0.0) {
    // a little white in the middle of the line makes it read as a light and not as paint
    let lineColor = mix(core / coverSum, vec3f(1.0), u.hot);
    rgb = mix(rgb, lineColor, coverMax);
    alpha = alpha + coverMax * (1.0 - alpha);
  }
  return vec4f(min(rgb, vec3f(alpha)), alpha);
}`;
}

const deg = (d: number) => (d * Math.PI) / 180;
const mix3 = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// The size the shape reaches over a whole loop does not change from frame to frame: remember the last few answers.
const extents = new Map<string, number>();
function extentFor(pose: Omit<HypercubePose, 'phase'>): number {
  const key = `${pose.n}|${pose.cycles.join(',')}|${pose.tilt}|${pose.turn}|${pose.fold}|${pose.depth}|${pose.cameraDepth}`;
  let e = extents.get(key);
  if (e === undefined) {
    e = loopExtent(pose);
    if (extents.size > 64) extents.clear();
    extents.set(key, e);
  }
  return e;
}

const isCustom = (p: Record<string, unknown>) => p.motion === 'custom';
const dimOf = (p: Record<string, unknown>) => DIMS[p.dimensions as string]?.n ?? 5;

export default defineNode({
  id: 'hypercube',
  title: 'Hypercube',
  category: 'generate',
  description: 'A cube of 3, 4, 5 or 6 dimensions (cube, tesseract, penteract, hexeract) as a glowing wireframe, turning in its higher dimensions so it folds through itself. Wire a picture in to put it behind the lines or on the faces of one of its cubes.',
  keywords: ['tesseract', 'hypercube', '4d', '5d', '6d', 'penteract', 'hexeract', 'cube', 'wireframe', 'dimension', 'geometry', 'math', 'neon', 'glow', 'lines', 'polytope', 'visuals', 'vj', 'sci-fi'],
  inputs: { image: { type: 'image', label: 'Picture' }, size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    dimensions: { type: 'enum', default: '5', options: Object.entries(DIMS).map(([value, v]) => ({ value, label: v.label })), label: 'Dimensions', hint: 'Each extra dimension doubles the corners: a 5D cube has 32 corners and 80 edges.' },
    motion: { type: 'enum', default: 'tumble', options: Object.entries(HYPERCUBE_MOTIONS).map(([value, v]) => ({ value, label: v.label })), label: 'Motion', group: 'Motion' },
    speed: { type: 'number', default: 1, min: 0, max: 8, step: 1, integer: true, label: 'Speed', hint: 'Multiplies every turn. Whole numbers only, so the loop joins up. 0 = still.', group: 'Motion' },
    turnCycles: { type: 'number', default: 1, min: -8, max: 8, step: 1, integer: true, label: '3D turn', hint: 'Whole turns per loop, like a cube on a turntable.', group: 'Motion', visibleIf: isCustom },
    tumbleCycles: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: '3D tumble', hint: 'Whole turns per loop, head over heels.', group: 'Motion', visibleIf: isCustom },
    fold4: { type: 'number', default: 1, min: -8, max: 8, step: 1, integer: true, label: '4D fold', hint: 'Whole turns per loop through the fourth dimension: the inner cube swaps places with the outer one.', group: 'Motion', visibleIf: (p) => isCustom(p) && dimOf(p) >= 4 },
    fold5: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: '5D fold', hint: 'Whole turns per loop through the fifth dimension.', group: 'Motion', visibleIf: (p) => isCustom(p) && dimOf(p) >= 5 },
    fold6: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: '6D fold', hint: 'Whole turns per loop through the sixth dimension.', group: 'Motion', visibleIf: (p) => isCustom(p) && dimOf(p) >= 6 },
    tilt: { type: 'number', default: 18, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Tilt', hint: 'Leaning toward or away from you.', group: 'Pose' },
    turn: { type: 'number', default: 24, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Turn', hint: 'Turned left or right.', group: 'Pose' },
    fold: { type: 'number', default: 20, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Fold angle', hint: 'A fixed turn into the higher dimensions. At 0 the higher cubes sit exactly inside each other.', group: 'Pose', visibleIf: (p) => dimOf(p) >= 4 },
    sway: { type: 'number', default: 0, min: 0, max: 45, step: 0.5, unit: 'deg', label: 'Hand sway', hint: 'The shape wanders by up to this much, as if held in the hand.', group: 'Pose' },
    swaySpeed: { type: 'number', default: 0.3, min: 0.02, max: 4, step: 0.01, label: 'Sway speed', group: 'Pose', visibleIf: (p) => (p.sway as number) > 0 },
    depth: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.01, label: 'Depth', hint: 'How strong the perspective is each time a dimension is flattened. 0 = none (the cubes overlap exactly), 1 = extreme.' },
    scale: { type: 'number', default: 0.92, min: 0.05, max: 3, step: 0.01, label: 'Size', hint: 'Share of the picture height the shape fills at its largest moment in the loop.' },
    center: { type: 'vec2', default: [0, 0], min: -1, max: 1, step: 0.005, label: 'Position', hint: 'From the middle, in shares of the picture height.' },
    thickness: { type: 'number', default: 0.005, min: 0.0005, max: 0.05, step: 0.0005, label: 'Line thickness', hint: 'Share of the picture height.', group: 'Lines' },
    nearFat: { type: 'number', default: 0.6, min: 0, max: 1.5, step: 0.01, label: 'Near lines fatter', hint: 'Lines near the eye are drawn thicker and brighter, far ones thinner. 0 = all the same.', group: 'Lines' },
    dots: { type: 'number', default: 2, min: 0, max: 8, step: 0.1, label: 'Corner dots', hint: 'Size of the dot on every corner, in line thicknesses. 0 = none.', group: 'Lines' },
    glow: { type: 'number', default: 0.7, min: 0, max: 3, step: 0.01, label: 'Glow', group: 'Lines' },
    glowSize: { type: 'number', default: 0.02, min: 0.002, max: 0.2, step: 0.001, label: 'Glow size', hint: 'Share of the picture height.', group: 'Lines' },
    faces: { type: 'number', default: 0.12, min: 0, max: 1, step: 0.01, label: 'Faces', hint: 'Fills every square face with a little light. Where many overlap it gets brighter, like stacked glass.', group: 'Lines' },
    colorBy: {
      type: 'enum',
      default: 'dimension',
      options: [
        { value: 'dimension', label: 'By dimension' },
        { value: 'depth', label: 'By depth' },
        { value: 'single', label: 'One color' },
      ],
      label: 'Color',
      hint: 'By dimension: edges that run along the fourth, fifth and sixth direction get their own colour, so the eye can tell the cubes apart.',
      group: 'Color',
    },
    color: { type: 'color', default: [0.35, 0.85, 1, 1], label: 'Line color', group: 'Color' },
    farColor: { type: 'color', default: [0.75, 0.2, 1, 1], label: 'Far color', group: 'Color', visibleIf: (p) => p.colorBy === 'depth' },
    color4: { type: 'color', default: [1, 0.3, 0.75, 1], label: '4th dimension', group: 'Color', visibleIf: (p) => p.colorBy === 'dimension' && dimOf(p) >= 4 },
    color5: { type: 'color', default: [1, 0.78, 0.25, 1], label: '5th dimension', group: 'Color', visibleIf: (p) => p.colorBy === 'dimension' && dimOf(p) >= 5 },
    color6: { type: 'color', default: [0.45, 1, 0.5, 1], label: '6th dimension', group: 'Color', visibleIf: (p) => p.colorBy === 'dimension' && dimOf(p) >= 6 },
    hot: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: 'White core', hint: 'How white the middle of each line is.', group: 'Color' },
    background: { type: 'color', default: [0.02, 0.02, 0.05, 1], label: 'Background', hint: 'Lower its alpha to 0 to put the shape over another picture.', group: 'Color' },
    picture: {
      type: 'enum',
      default: 'inner',
      options: [
        { value: 'inner', label: 'On the inner cube' },
        { value: 'outer', label: 'On the outer cube' },
        { value: 'behind', label: 'Behind the lines' },
      ],
      label: 'Wired picture',
      hint: 'Where the picture wired into Picture goes. A cube inside the shape carries it on its six faces.',
      group: 'Picture',
    },
    pictureOpacity: { type: 'number', default: 0.85, min: 0, max: 1, step: 0.01, label: 'Picture opacity', group: 'Picture' },
  },
  summary: (p) => `${DIMS[p.dimensions as string]?.label ?? p.dimensions} · ${HYPERCUBE_MOTIONS[p.motion as string]?.label ?? p.motion}`,
  render(ctx) {
    const p = ctx.params;
    const n = dimOf(p);
    const time = ctx.time;
    const cycles = planeCycles(n, { motion: p.motion as string, speed: p.speed, turn: p.turnCycles, tumble: p.tumbleCycles, fold4: p.fold4, fold5: p.fold5, fold6: p.fold6 });
    const base = { n, cycles, tilt: deg(p.tilt), turn: deg(p.turn), fold: deg(p.fold), depth: p.depth, cameraDepth: p.depth * CAMERA };
    // sized by the still pose over the whole loop, so the hand sway moves the shape without making it breathe
    const fit = (p.scale * 0.5) / Math.max(1e-6, extentFor(base));
    const loop = time.loop ? time.duration : 0;
    const sway = (k: number) => (p.sway > 0 ? deg(p.sway) * wander(time.seconds, p.swaySpeed, 0.45, 11 + k, loop) : 0);
    const pts = hypercubePoints({ ...base, phase: time.phase, tilt: base.tilt + sway(0), turn: base.turn + sway(1) });
    const pos = p.center as number[];
    const xy = (q: Projected): [number, number] => [pos[0] + q.x * fit, pos[1] + q.y * fit];

    const palette = [p.color, p.color, p.color, p.color4, p.color5, p.color6] as number[][];
    // 0 far .. 1 near, from how much the flattening enlarged the point (one flattening step spans the whole range)
    const q = p.depth > 0.0001 ? 1 + (1 - p.depth) / p.depth + 0.15 : 0;
    const span = q ? Math.log(q / (q - 1)) : 1;
    const nearness = (s: number) => (q ? Math.min(1, Math.max(0, 0.5 + (0.5 * Math.log(s)) / span)) : 0.5);
    const colorAt = (pt: Projected, axis: number): number[] => {
      const c = p.colorBy === 'dimension' ? palette[axis] : p.colorBy === 'depth' ? mix3(p.farColor as number[], p.color as number[], nearness(pt.scale)) : (p.color as number[]);
      // near lines brighter, far ones dimmer
      const k = Math.min(1.25, Math.max(0.3, Math.pow(pt.scale, p.nearFat * 0.7)));
      return [c[0] * k, c[1] * k, c[2] * k];
    };
    const half = p.thickness * 0.5;
    const widthAt = (pt: Projected) => half * Math.min(2.5, Math.max(0.35, Math.pow(pt.scale, p.nearFat)));

    const edges = hypercubeEdges(n);
    const faces = p.faces > 0 ? hypercubeFaces(n) : [];
    const dots = p.dots > 0 ? pts.length : 0;
    const src = ctx.in.image;
    const size = ctx.in.size ?? src ?? ctx.canvas;
    const pic = !src || p.pictureOpacity <= 0 ? 0 : p.picture === 'behind' ? 1 : 2;
    const width = Math.max(edges.length + dots, faces.length, 6);
    const data = new Float32Array(width * ROWS * 2 * 4);
    const put = (r: number, i: number, v: number[]) => data.set(v, (r * width + i) * 4);
    const putPos = (r: number, i: number, v: number[]) => {
      const coarse = v.map((x) => Math.round(x * COARSE) / COARSE);
      put(r, i, coarse);
      put(r + ROWS, i, v.map((x, k) => x - coarse[k]));
    };

    edges.forEach(([a, b, axis], i) => {
      putPos(0, i, [...xy(pts[a]), ...xy(pts[b])]);
      put(1, i, [...colorAt(pts[a], axis), widthAt(pts[a])]);
      put(2, i, [...colorAt(pts[b], axis), widthAt(pts[b])]);
    });
    // a dot is a line with no length; it takes the colour of the highest direction that meets there
    for (let v = 0; v < dots; v++) {
      const i = edges.length + v;
      const c = [...colorAt(pts[v], n - 1), widthAt(pts[v]) * p.dots];
      putPos(0, i, [...xy(pts[v]), ...xy(pts[v])]);
      put(1, i, c);
      put(2, i, c);
    }

    const aa = 1 / size.height;
    faces.forEach(([c, a, b], i) => {
      const q4 = c.map((v) => xy(pts[v]));
      putPos(3, i, [...q4[0], ...q4[1]]);
      putPos(4, i, [...q4[2], ...q4[3]]);
      // a face seen edge-on is a sliver thinner than a pixel: let it fade out instead of flickering
      let area = 0;
      let longest = 0;
      for (let k = 0; k < 4; k++) {
        const [x0, y0] = q4[k];
        const [x1, y1] = q4[(k + 1) % 4];
        area += x0 * y1 - x1 * y0;
        longest = Math.max(longest, Math.hypot(x1 - x0, y1 - y0));
      }
      const thin = Math.min(1, Math.abs(area) / 2 / Math.max(1e-9, longest) / (2 * aa));
      const scale = (pts[c[0]].scale + pts[c[1]].scale + pts[c[2]].scale + pts[c[3]].scale) / 4;
      const col = p.colorBy === 'dimension' ? mix3(palette[a], palette[b], 0.5) : p.colorBy === 'depth' ? mix3(p.farColor as number[], p.color as number[], nearness(scale)) : (p.color as number[]);
      // more dimensions = more faces over every pixel: keep the total light about the same
      put(5, i, [col[0], col[1], col[2], (p.faces * thin * 1.6) / Math.sqrt(faces.length / 6)]);
    });

    let nPic = 0;
    if (pic === 2) {
      // the cube whose higher coordinates are all on the far side (inner, drawn small) or all on the near side (outer)
      const high = p.picture === 'outer' ? (1 << n) - 8 : 0;
      const quads: { z: number; c: [number, number][] }[] = [];
      for (let a = 0; a < 3; a++) {
        const b = (a + 1) % 3;
        const c = (a + 2) % 3;
        for (let side = 0; side < 2; side++) {
          const at = (sb: number, sc: number) => high | (side << a) | (sb << b) | (sc << c);
          const idx = [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
          quads.push({ z: idx.reduce((s, v) => s + pts[v].z, 0), c: idx.map((v) => xy(pts[v])) });
        }
      }
      // farthest first, so the near faces of the cube cover the far ones
      quads.sort((m, o) => m.z - o.z);
      for (const quad of quads) {
        const m = quadToUnit(quad.c);
        if (!m) continue;
        putPos(6, nPic, [...quad.c[0], ...quad.c[1]]);
        putPos(7, nPic, [...quad.c[2], ...quad.c[3]]);
        putPos(8, nPic, [m[0], m[1], m[2], 0]);
        putPos(9, nPic, [m[3], m[4], m[5], 0]);
        putPos(10, nPic, [m[6], m[7], m[8], 0]);
        nPic++;
      }
    }

    const image = ctx.gpu.pass({
      label: 'hypercube',
      size,
      textures: pic && src ? { data: ctx.gpu.dataTexture(data, width, ROWS * 2), image: src } : { data: ctx.gpu.dataTexture(data, width, ROWS * 2) },
      uniforms: {
        nSeg: edges.length + dots,
        nFace: faces.length,
        nPic,
        thick: half,
        glow: p.glow,
        glowSize: p.glowSize,
        hot: p.hot,
        picOpacity: p.pictureOpacity,
        bg: p.background,
      },
      wgsl: hypercubeWgsl(pic),
    });
    return { image };
  },
});
