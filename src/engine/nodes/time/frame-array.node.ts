import { defineNode } from '../../define';
import { MAX_PANES, backToFront, dot, fitDistance, layoutCounts, layoutPanes, layoutRadius, len, mul, orbitCamera, paneFrame, sub, timing, type FrameFlow, type FrameLayout, type LayoutOptions } from '../../lib/frame-array';
import { pullFrames } from '../../lib/fx-video';
import { wander } from '../../lib/shake';
import type { ImageValue, UniformValue } from '../../types';

/**
 * A clip is a block of three things: width, height and time. This node shows the third one as space: many frames of the
 * clip at once, as flat panes standing in a 3D scene.
 *
 * How it is drawn: the frames are pulled from the input at their own times, the panes are sorted farthest first, and
 * they are painted over each other four at a time (a pass can read several pictures, and fewer passes is faster). There
 * is no geometry: for every pixel the shader asks where the line of sight through that pixel meets each pane, and reads
 * the frame there. The same question asked for the neighbouring pixels says how large a pixel is on the pane, which gives
 * soft pane edges and keeps small, far panes from sparkling.
 */
const PER_PASS = 4;

/** `n` panes in this pass; `first` = nothing has been painted yet, start from the background. */
function frameArrayWgsl(n: number, first: boolean): string {
  let panes = '';
  for (let j = 0; j < n; j++) panes += `  acc = paint(acc, t${j}, u.c${j}, u.r${j}, u.u${j}, u.m${j}, o, d0, dx, dy);\n`;
  return /* wgsl */ `
// Where a line of sight meets the pane, in pane coordinates (-1..1 both ways). z = 0 when it misses the pane's plane.
fn meet(o: vec3f, d: vec3f, c: vec3f, r: vec3f, up: vec3f, nrm: vec3f) -> vec3f {
  let den = dot(d, nrm);
  if (abs(den) < 1.0e-7) { return vec3f(0.0); }
  let t = dot(c - o, nrm) / den;
  if (t <= 0.0) { return vec3f(0.0); }
  let h = o + d * t - c;
  return vec3f(dot(h, r), dot(h, up), 1.0);
}
fn paint(acc: vec4f, tex: texture_2d<f32>, c: vec3f, r: vec3f, up: vec3f, m: vec4f, o: vec3f, d0: vec3f, dx: vec3f, dy: vec3f) -> vec4f {
  if (m.x <= 0.0) { return acc; }
  let nrm = cross(r, up);
  let q0 = meet(o, d0, c, r, up, nrm);
  let qx = meet(o, dx, c, r, up, nrm);
  let qy = meet(o, dy, c, r, up, nrm);
  if (q0.z * qx.z * qy.z == 0.0) { return acc; }
  // how far one pixel reaches on the pane, sideways and upward
  let ax = qx.xy - q0.xy;
  let ay = qy.xy - q0.xy;
  let foot = max(abs(ax) + abs(ay), vec2f(1.0e-6));
  // the share of the pixel that lies on the pane. Seen edge-on a pixel is far larger than the pane: next to nothing then
  let span = max(min(q0.xy + 0.5 * foot, vec2f(1.0)) - max(q0.xy - 0.5 * foot, vec2f(-1.0)), vec2f(0.0)) / foot;
  let cover = span.x * span.y;
  if (cover <= 0.0) { return acc; }
  // nine readings spread over the pixel's footprint: a far pane is averaged instead of sparkling
  let uv = vec2f(0.5 + 0.5 * q0.x, 0.5 - 0.5 * q0.y);
  var sx = vec2f(ax.x, -ax.y) * 0.5;
  var sy = vec2f(ay.x, -ay.y) * 0.5;
  // seen almost edge-on the footprint is endless: cap it
  sx *= min(1.0, 0.12 / max(length(sx), 1.0e-6));
  sy *= min(1.0, 0.12 / max(length(sy), 1.0e-6));
  var s = vec4f(0.0);
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      s += textureSampleLevel(tex, smp, clamp(uv + sx * (f32(i) / 3.0) + sy * (f32(j) / 3.0), vec2f(0.0), vec2f(1.0)), 0.0);
    }
  }
  s = s / 9.0;
  s = vec4f(s.rgb * m.y, s.a);
  // the border: a band just inside the edge
  if (u.border.x > 0.0) {
    let band = (1.0 - abs(q0.xy) - u.border) / foot;
    let on = clamp(0.5 - min(band.x, band.y), 0.0, 1.0);
    let bc = mix(u.borderColor, u.nowColor, m.z);
    s = mix(s, vec4f(bc.rgb * bc.a, bc.a), on);
  }
  let k = cover * m.x;
  if (u.additive > 0.5) { return vec4f(acc.rgb + s.rgb * k, acc.a + s.a * k * (1.0 - acc.a)); }
  return s * k + acc * (1.0 - s.a * k);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var acc = ${first ? 'vec4f(u.bg.rgb * u.bg.a, u.bg.a)' : 'textureSampleLevel(acc0, smpNearest, uv, 0.0)'};
  let o = u.camPos;
  // the line of sight through this pixel, and through the pixels to its right and below
  let d0 = u.camFwd + u.camRight * (uv.x * 2.0 - 1.0) + u.camUp * (1.0 - uv.y * 2.0);
  let dx = d0 + u.camRight * (2.0 / u.size.x);
  let dy = d0 - u.camUp * (2.0 / u.size.y);
${panes}  return min(acc, vec4f(1.0));
}`;
}

const LAYOUTS: { value: FrameLayout; label: string }[] = [
  { value: 'stack', label: 'Stack' },
  { value: 'row', label: 'Row' },
  { value: 'ring', label: 'Ring' },
  { value: 'helix', label: 'Helix' },
  { value: 'grid', label: 'Grid 3D' },
  { value: 'tunnel', label: 'Tunnel' },
];
const FLOWS: { value: FrameFlow; label: string }[] = [
  { value: 'flow', label: 'Frames flow past' },
  { value: 'play', label: 'Every pane plays' },
  { value: 'sheet', label: 'Still frames, playhead' },
  { value: 'custom', label: 'Custom travel' },
];

const isGrid = (p: Record<string, unknown>) => p.layout === 'grid';
const curved = (p: Record<string, unknown>) => p.layout === 'ring' || p.layout === 'helix';

export default defineNode({
  id: 'frame-array',
  title: 'Frame Array',
  category: 'time',
  description: 'Shows many frames of a clip at once as panes standing in 3D space, so time becomes a direction you can look along: a stack, a row, a ring, a spiral staircase, a block or a corridor of frames, with a camera that swings or orbits around it.',
  keywords: ['4d', 'time', 'frames', '3d', 'stack', 'deck', 'cards', 'filmstrip', 'contact sheet', 'space-time', 'spacetime', 'volume', 'video cube', 'helix', 'tunnel', 'carousel', 'orbit', 'camera', 'panes', 'slices', 'timeline'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    layout: { type: 'enum', default: 'stack', options: LAYOUTS, label: 'Layout', hint: 'Stack: one behind the other, time runs into the screen. Grid 3D: a block of panes. Tunnel: the four walls of a corridor.' },
    count: { type: 'number', default: 10, min: 2, max: MAX_PANES, step: 1, integer: true, label: 'Panes', hint: 'Every pane makes whatever feeds this node render one more time per frame, so a heavy chain gets slow quickly. A still picture costs nothing extra.', visibleIf: (p) => !isGrid(p) },
    gridX: { type: 'number', default: 3, min: 1, max: 8, step: 1, integer: true, label: 'Columns', visibleIf: isGrid },
    gridY: { type: 'number', default: 2, min: 1, max: 8, step: 1, integer: true, label: 'Rows', visibleIf: isGrid },
    gridZ: { type: 'number', default: 3, min: 1, max: 8, step: 1, integer: true, label: 'Layers', hint: `Columns x rows x layers panes, ${MAX_PANES} at most: every pane makes whatever feeds this node render one more time per frame.`, visibleIf: isGrid },
    spacing: { type: 'number', default: 1, min: 0.2, max: 4, step: 0.01, label: 'Spacing', hint: '1 = the usual distance between panes for this layout.' },
    arc: { type: 'number', default: 360, min: 10, max: 1440, step: 1, unit: 'deg', label: 'Arc', hint: 'How far around the panes go. 360 = once around; more winds the helix further.', visibleIf: curved },
    fan: { type: 'vec2', default: [0.1, 0.06], min: -1, max: 1, step: 0.005, label: 'Fan out', hint: 'Shifts each pane sideways and upward from the one in front, like a fanned deck of cards. In pane heights.', visibleIf: (p) => p.layout === 'stack' },
    flow: { type: 'enum', default: 'flow', options: FLOWS, label: 'Time', hint: 'Frames flow past: each pane holds one frame and the panes travel, so the clip plays at one fixed spot. Every pane plays: panes stay put and play one after the other. Still frames, playhead: nothing moves but the highlight.', group: 'Time' },
    span: { type: 'number', default: 1, min: -1, max: 1, step: 0.01, label: 'Time span', hint: 'Share of the loop the panes cover between them. Negative = earlier moments instead of later ones. With "Frames flow past" it is rounded so the loop joins up.', group: 'Time' },
    now: { type: 'enum', default: 'first', options: [{ value: 'first', label: 'First pane' }, { value: 'middle', label: 'Middle pane' }], label: 'Present moment at', hint: 'Which place shows the frame that is playing right now.', group: 'Time', visibleIf: (p) => p.flow !== 'sheet' },
    travel: { type: 'number', default: 1, min: -16, max: 16, step: 1, integer: true, label: 'Travel', hint: 'Whole steps the panes move along the layout per loop.', group: 'Time', visibleIf: (p) => p.flow === 'custom' },
    yaw: { type: 'number', default: -34, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'View from side', hint: '0 = straight from the front.', group: 'Camera' },
    tilt: { type: 'number', default: 14, min: -89, max: 89, step: 0.5, unit: 'deg', label: 'View from above', group: 'Camera' },
    distance: { type: 'number', default: 0.85, min: 0.05, max: 4, step: 0.01, label: 'Distance', hint: '1 = far enough to see the whole layout from any side. Small values go inside it.', group: 'Camera' },
    fov: { type: 'number', default: 30, min: 10, max: 120, step: 1, unit: 'deg', label: 'Field of view', hint: 'Wide = strong perspective.', group: 'Camera' },
    orbit: { type: 'number', default: 0, min: -8, max: 8, step: 1, integer: true, label: 'Orbit', hint: 'Whole trips of the camera around the layout per loop.', group: 'Camera' },
    swing: { type: 'number', default: 18, min: 0, max: 180, step: 0.5, unit: 'deg', label: 'Swing', hint: 'The camera swings this far to each side and back.', group: 'Camera' },
    swingCycles: { type: 'number', default: 1, min: 0, max: 8, step: 1, integer: true, label: 'Swings per loop', group: 'Camera', visibleIf: (p) => (p.swing as number) > 0 },
    sway: { type: 'number', default: 0, min: 0, max: 30, step: 0.5, unit: 'deg', label: 'Hand sway', hint: 'The camera wanders by up to this much, as if held in the hand.', group: 'Camera' },
    opacity: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Pane opacity', hint: 'Below 1 you see the frames behind through the ones in front.', group: 'Look' },
    fade: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Fade with distance', hint: 'Panes far from the camera are fainter.', group: 'Look' },
    dim: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Dim other panes', hint: 'Darkens every pane except the one showing the present moment, so that one is the brightest.', group: 'Look' },
    border: { type: 'number', default: 0.012, min: 0, max: 0.1, step: 0.001, label: 'Border', hint: 'Width of the frame around each pane, as a share of its height.', group: 'Look' },
    borderColor: { type: 'color', default: [0.85, 0.88, 0.95, 0.7], label: 'Border color', group: 'Look', visibleIf: (p) => (p.border as number) > 0 },
    nowColor: { type: 'color', default: [1, 0.85, 0.3, 1], label: 'Present border', hint: 'Border of the pane showing the present moment.', group: 'Look', visibleIf: (p) => (p.border as number) > 0 },
    blend: { type: 'enum', default: 'normal', options: [{ value: 'normal', label: 'Normal' }, { value: 'add', label: 'Add' }], label: 'Blend', hint: 'Add: panes are light on light, like projections on glass.', group: 'Look' },
    background: { type: 'color', default: [0.03, 0.03, 0.05, 1], label: 'Background', hint: 'Lower its alpha to 0 to put the panes over another picture.', group: 'Look' },
  },
  summary: (p) => `${LAYOUTS.find((l) => l.value === p.layout)?.label ?? p.layout} · ${FLOWS.find((f) => f.value === p.flow)?.label ?? p.flow}`,
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const time = ctx.time;
    const ph = time.phase;
    const TAU = Math.PI * 2;
    const total = Math.max(1, Math.round(time.duration * time.fps));

    const layout: LayoutOptions = {
      layout: p.layout as FrameLayout,
      count: p.count,
      aspect: src.width / Math.max(1, src.height),
      spacing: p.spacing,
      arc: p.arc,
      fan: p.fan as [number, number],
      grid: [p.gridX, p.gridY, p.gridZ],
    };
    const counts = layoutCounts(layout);
    const flow = p.flow as FrameFlow;
    const topts = { flow, span: p.span, travel: p.travel, nowSlot: p.now === 'middle' ? Math.floor((counts.steps - 1) / 2) * counts.stride : 0, totalFrames: total };
    const tm = timing(topts, counts);
    // A closed ring whose frames cover exactly the loop has no ends: the pane that leaves is the pane that arrives.
    const endless = layout.layout === 'ring' && layout.arc >= 359.999 && tm.still && Math.abs(tm.framesPerSlot * counts.count) === total;
    const panes = layoutPanes(layout, tm.travelSteps * ph, !endless);

    // camera: whole orbits and whole swings per loop, so the last frame joins the first
    const loop = time.loop ? time.duration : 0;
    const sway = (k: number) => (p.sway > 0 ? p.sway * wander(time.seconds, 0.25, 0.45, 23 + k, loop) : 0);
    const yaw = p.yaw + 360 * (((Math.round(p.orbit) * ph) % 1) + 1) + p.swing * Math.sin(TAU * Math.round(p.swingCycles) * ph) + sway(0);
    const cam = orbitCamera(yaw, p.tilt + sway(1), p.distance * fitDistance(layoutRadius(layout), p.fov), p.fov);

    // the frames: one pull per different moment; a still input is the same at every moment
    const moving = ctx.inputVaries('image');
    const frame = Math.round(ph * total);
    const pulled = new Map<number, ImageValue>([[0, src]]);
    const shown: { pane: (typeof panes)[number]; tex: ImageValue; now: number; dist: number }[] = [];
    let near = Infinity;
    let far = 0;
    for (const pane of backToFront(panes, cam)) {
      const f = paneFrame(pane, tm, topts, frame, time.loop);
      const key = moving ? (time.loop ? ((f.offset % total) + total) % total : f.offset) : 0;
      let tex = pulled.get(key);
      if (!tex) {
        tex = (await pullFrames(ctx as never, 'image', f.offset)) ?? src;
        pulled.set(key, tex);
      }
      const dist = len(sub(pane.center, cam.pos));
      near = Math.min(near, dist);
      far = Math.max(far, dist);
      shown.push({ pane, tex, now: f.now, dist });
    }

    const outAspect = src.width / Math.max(1, src.height);
    const common: Record<string, UniformValue> = {
      camPos: cam.pos,
      camFwd: cam.forward,
      camRight: mul(cam.right, cam.tanHalf * outAspect),
      camUp: mul(cam.up, cam.tanHalf),
      // the border in pane coordinates, which run -1..1 across the width and across the height
      border: [(2 * p.border) / layout.aspect, 2 * p.border],
      borderColor: p.borderColor,
      nowColor: p.nowColor,
      additive: p.blend === 'add',
      bg: p.background,
    };
    let acc: ImageValue | null = null;
    for (let i = 0; i < shown.length; i += PER_PASS) {
      const group = shown.slice(i, i + PER_PASS);
      const uniforms: Record<string, UniformValue> = { ...common };
      const textures: Record<string, ImageValue> = acc ? { acc0: acc } : {};
      group.forEach((g, j) => {
        const { right, up, center } = g.pane;
        const depth = far - near > 1e-6 ? (g.dist - near) / (far - near) : 0;
        textures[`t${j}`] = g.tex;
        uniforms[`c${j}`] = center;
        // divided by their own length squared, so one multiplication gives the place on the pane as -1..1
        uniforms[`r${j}`] = mul(right, 1 / dot(right, right));
        uniforms[`u${j}`] = mul(up, 1 / dot(up, up));
        uniforms[`m${j}`] = [p.opacity * g.pane.fade * (1 - p.fade * depth), 1 - p.dim * (1 - g.now), g.now, 0];
      });
      const prev: ImageValue | null = acc;
      acc = ctx.gpu.pass({ label: 'frame-array', size: src, textures, uniforms, wgsl: frameArrayWgsl(group.length, !prev) });
      if (prev) ctx.gpu.recycle(prev);
    }
    return { image: acc ?? src };
  },
});

