/**
 * Where the panes of a Frame Array stand, which moment of the clip each one shows, and the camera that looks at them.
 * No drawing here, so all of it can be tested with plain numbers.
 *
 * Lengths are in pane heights: a pane is 1 high and `aspect` wide. x runs right, y up, z toward the viewer.
 * A pane has a place in the row of time called its slot: slot 0 is the first pane, slot 1 the next, and so on. Panes can
 * travel along the layout, so a slot is not always a whole number.
 */

export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => mul(a, 1 / Math.max(1e-12, len(a)));
const mod = (a: number, n: number) => ((a % n) + n) % n;

export type FrameLayout = 'stack' | 'row' | 'ring' | 'helix' | 'grid' | 'tunnel';

export interface LayoutOptions {
  layout: FrameLayout;
  /** Number of panes (ignored by the grid, which has columns x rows x layers). */
  count: number;
  /** Width of a pane divided by its height. */
  aspect: number;
  /** 1 = the usual distance between panes for the layout. */
  spacing: number;
  /** Ring and helix: the angle the whole run of panes covers, in degrees. */
  arc: number;
  /** Stack: how far each pane is shifted sideways and upward from the one before, in pane heights. */
  fan: [number, number];
  /** Grid: columns, rows, layers. */
  grid: [number, number, number];
}

export interface Pane {
  /** Which pane this is, 0 .. count - 1. */
  index: number;
  /** Its place in the row of time right now. */
  slot: number;
  /** 1 = fully there; lower while it fades out at one end of the layout and back in at the other. */
  fade: number;
  center: V3;
  /** From the centre to the middle of the right edge, and to the middle of the top edge. */
  right: V3;
  up: V3;
}

/** The most panes a layout may have: every pane is one more evaluation of whatever feeds the node. */
export const MAX_PANES = 32;

/** Columns, rows and layers of the grid, cut down so their product stays within the limit. */
export function gridShape(grid: [number, number, number]): [number, number, number] {
  let [nx, ny, nz] = grid.map((v) => Math.max(1, Math.round(v)));
  while (nx * ny * nz > MAX_PANES) {
    if (nz > 1) nz--;
    else if (ny > 1) ny--;
    else nx--;
  }
  return [nx, ny, nz];
}

/** How the panes are counted: `count` in all, moving `stride` slots for one step of travel, with `steps` steps from one end to the other. */
export function layoutCounts(o: LayoutOptions): { count: number; stride: number; steps: number } {
  if (o.layout === 'grid') {
    const [nx, ny, nz] = gridShape(o.grid);
    return { count: nx * ny * nz, stride: nx * ny, steps: nz };
  }
  const count = Math.min(MAX_PANES, Math.max(1, Math.round(o.count)));
  // the tunnel travels a whole ring of four walls at a time
  if (o.layout === 'tunnel') return { count, stride: 4, steps: Math.ceil(count / 4) };
  return { count, stride: 1, steps: count };
}

/** Where a pane at a (possibly fractional) place stands, before the layout is centred. `step` is its place along the direction of travel, `cell` its place within one step. */
function place(o: LayoutOptions, step: number, cell: number, counts: { count: number; steps: number }): { center: V3; right: V3; up: V3 } {
  const a = o.aspect;
  const sp = o.spacing;
  const mid = (counts.steps - 1) / 2;
  const k = step - mid;
  const flatR: V3 = [a / 2, 0, 0];
  const flatU: V3 = [0, 0.5, 0];
  switch (o.layout) {
    case 'row':
      return { center: [k * a * 1.08 * sp, 0, 0], right: flatR, up: flatU };
    case 'ring':
    case 'helix': {
      // panes stand on a circle facing outward; the circle is as large as it must be for neighbours to sit side by side
      const delta = ((o.arc * Math.PI) / 180 / counts.count) * (o.layout === 'ring' && o.arc >= 359.999 ? 1 : counts.count / Math.max(1, counts.count - 1));
      const pitch = a * 1.08 * sp;
      const radius = Math.abs(delta) < 1e-6 ? 1e6 : pitch / (2 * Math.sin(Math.min(Math.PI, Math.abs(delta)) / 2));
      const th = k * delta;
      const y = o.layout === 'helix' ? -k * 0.3 * sp : 0;
      return { center: [radius * Math.sin(th), y, radius * Math.cos(th) - radius], right: [(a / 2) * Math.cos(th), 0, (-a / 2) * Math.sin(th)], up: flatU };
    }
    case 'grid': {
      const [nx, ny] = gridShape(o.grid);
      const ix = cell % nx;
      const iy = Math.floor(cell / nx);
      return { center: [(ix - (nx - 1) / 2) * a * 1.15 * sp, ((ny - 1) / 2 - iy) * 1.15 * sp, -k * 0.9 * sp], right: flatR, up: flatU };
    }
    case 'tunnel': {
      // four walls of a square corridor, one pane long; each pane faces inward the right way round
      const z = -k * a * 1.04 * sp;
      const along: V3 = [0, 0, -a / 2];
      if (cell === 0) return { center: [-0.5, 0, z], right: along, up: flatU };
      if (cell === 1) return { center: [0, 0.5, z], right: along, up: [0.5, 0, 0] };
      if (cell === 2) return { center: [0.5, 0, z], right: mul(along, -1), up: flatU };
      return { center: [0, -0.5, z], right: along, up: [-0.5, 0, 0] };
    }
    default:
      return { center: [k * o.fan[0], k * o.fan[1], -k * 0.3 * sp], right: flatR, up: flatU };
  }
}

/**
 * All panes for a moment. `travel` is how far the panes have moved along the layout, in steps (a pane for most layouts, a
 * layer for the grid, a ring of four for the tunnel). A pane that leaves one end comes back in at the other; `fadeEnds`
 * lets it fade out and in over the last half step so it does not pop.
 * The layout is centred on the middle of its resting places, so it does not shift when the panes travel.
 */
export function layoutPanes(o: LayoutOptions, travel = 0, fadeEnds = true): Pane[] {
  const counts = layoutCounts(o);
  const { count, stride, steps } = counts;
  let lo: V3 = [Infinity, Infinity, Infinity];
  let hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let j = 0; j < count; j++) {
    const c = place(o, Math.floor(j / stride), j % stride, counts).center;
    lo = [Math.min(lo[0], c[0]), Math.min(lo[1], c[1]), Math.min(lo[2], c[2])];
    hi = [Math.max(hi[0], c[0]), Math.max(hi[1], c[1]), Math.max(hi[2], c[2])];
  }
  const middle = mul(add(lo, hi), 0.5);
  const panes: Pane[] = [];
  for (let j = 0; j < count; j++) {
    const cell = j % stride;
    // -0.5 .. steps - 0.5: a resting pane sits on a whole number, well away from the ends
    const step = mod(Math.floor(j / stride) + travel + 0.5, steps) - 0.5;
    const at = place(o, step, cell, counts);
    const fade = travel !== 0 && fadeEnds ? Math.min(1, Math.max(0, 2 * Math.min(step + 0.5, steps - 0.5 - step))) : 1;
    panes.push({ index: j, slot: step * stride + cell, fade, center: sub(at.center, middle), right: at.right, up: at.up });
  }
  return panes;
}

/** The radius of a ball around the origin that holds every pane at rest: what the camera has to fit. */
export function layoutRadius(o: LayoutOptions): number {
  let r = 0;
  for (const p of layoutPanes(o)) {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) r = Math.max(r, len(add(p.center, add(mul(p.right, sx), mul(p.up, sy)))));
  }
  return r;
}

export type FrameFlow = 'flow' | 'play' | 'sheet' | 'custom';

export interface TimingOptions {
  flow: FrameFlow;
  /** Share of the loop the panes cover between them; negative = earlier moments instead of later ones. */
  span: number;
  /** Custom: whole steps of travel per loop. */
  travel: number;
  /** Slot that shows the present moment (0 = the first pane, or the middle one). */
  nowSlot: number;
  /** Frames in the loop. */
  totalFrames: number;
}

export interface Timing {
  /** Whole steps the panes travel per loop (negative = toward the first slot). */
  travelSteps: number;
  /** Frames of the clip between one slot and the next. */
  framesPerSlot: number;
  /** True when a pane keeps showing the same frame for as long as it is in view. */
  still: boolean;
}

/**
 * How the layout turns time into space.
 *   play:   panes stay where they are and each plays the clip, one after the other in time.
 *   flow:   every pane holds one frame and the panes travel, one slot for every step of time, so the frame that is "now"
 *           is always at the same place. For the loop to join, the travel is a whole number of steps, which fixes the
 *           time between panes: the span asked for is rounded to the nearest that fits.
 *   sheet:  panes stay and hold one frame each; only the mark of the present moment moves.
 *   custom: panes travel by a chosen number of steps while each still shows its place in time.
 */
export function timing(o: TimingOptions, counts: { count: number; stride: number; steps: number }): Timing {
  const T = Math.max(1, o.totalFrames);
  const sign = o.span < 0 ? -1 : 1;
  const span = Math.max(1e-4, Math.abs(o.span));
  if (o.flow === 'flow') {
    const m = Math.max(1, Math.round(counts.steps / span));
    return { travelSteps: -sign * m, framesPerSlot: (sign * T) / (m * counts.stride), still: true };
  }
  const framesPerSlot = (sign * span * T) / counts.count;
  if (o.flow === 'sheet') return { travelSteps: 0, framesPerSlot, still: true };
  return { travelSteps: o.flow === 'custom' ? Math.round(o.travel) : 0, framesPerSlot, still: false };
}

/**
 * The frame a pane shows, counted from the present frame (what `pullFrames` takes), and how much it is "the present one"
 * (1 = exactly now, 0 = a slot or more away).
 * `frame` is the present frame inside the loop. The tiny nudge before rounding keeps a pane that sits exactly between two
 * frames from flickering between them when the arithmetic lands a hair to either side.
 */
export function paneFrame(pane: Pane, t: Timing, o: TimingOptions, frame: number, loop: boolean): { offset: number; now: number } {
  const T = Math.max(1, o.totalFrames);
  if (o.flow === 'sheet') {
    const abs = Math.floor(pane.slot * t.framesPerSlot + 0.5 - 1e-6);
    let offset = abs - frame;
    let away = offset;
    if (loop) {
      offset = mod(offset, T);
      away = mod(offset + T / 2, T) - T / 2;
    }
    return { offset, now: Math.max(0, 1 - Math.abs(away) / Math.max(1e-6, Math.abs(t.framesPerSlot))) };
  }
  const offset = Math.floor((pane.slot - o.nowSlot) * t.framesPerSlot + 0.5 - 1e-6);
  return { offset, now: Math.max(0, 1 - Math.abs(pane.slot - o.nowSlot)) };
}

export interface Camera {
  pos: V3;
  /** Unit vectors: to the right, up, and the way the camera looks. */
  right: V3;
  up: V3;
  forward: V3;
  /** Tangent of half the vertical angle of view. */
  tanHalf: number;
}

/** A camera on a ball around the origin, looking at the origin. Angles in degrees; yaw 0 looks from the front (+z). */
export function orbitCamera(yawDeg: number, tiltDeg: number, distance: number, fovDeg: number): Camera {
  const yaw = (yawDeg * Math.PI) / 180;
  const tilt = (Math.max(-89, Math.min(89, tiltDeg)) * Math.PI) / 180;
  const pos: V3 = [distance * Math.sin(yaw) * Math.cos(tilt), distance * Math.sin(tilt), distance * Math.cos(yaw) * Math.cos(tilt)];
  const forward = norm(mul(pos, -1));
  const right = norm(cross(forward, [0, 1, 0]));
  return { pos, right, up: cross(right, forward), forward, tanHalf: Math.tan((Math.max(1, Math.min(170, fovDeg)) * Math.PI) / 360) };
}

/** The distance at which a ball of the given radius just fits the height of the view. */
export function fitDistance(radius: number, fovDeg: number): number {
  return radius / Math.sin((Math.max(1, Math.min(170, fovDeg)) * Math.PI) / 360);
}

/** Farthest pane first, so nearer panes are painted over farther ones. */
export function backToFront(panes: Pane[], cam: Camera): Pane[] {
  return panes
    .map((p) => ({ p, d: len(sub(p.center, cam.pos)) }))
    .sort((a, b) => b.d - a.d || a.p.index - b.p.index)
    .map((e) => e.p);
}

/**
 * Where the ray through a point of the screen meets a pane. `sx`, `sy` run -1..1 across the screen (y up), `screenAspect`
 * is the width of the screen divided by its height. Returns the place on the pane's picture (0..1, 0..1 from the top
 * left) or null when the ray misses. The shader does the same arithmetic per pixel.
 */
export function rayHit(cam: Camera, sx: number, sy: number, screenAspect: number, pane: Pane): { u: number; v: number; distance: number } | null {
  const d = norm(add(cam.forward, add(mul(cam.right, sx * cam.tanHalf * screenAspect), mul(cam.up, sy * cam.tanHalf))));
  const n = cross(pane.right, pane.up);
  const den = dot(d, n);
  if (Math.abs(den) < 1e-9) return null;
  const t = dot(sub(pane.center, cam.pos), n) / den;
  if (t <= 0) return null;
  const h = sub(add(cam.pos, mul(d, t)), pane.center);
  const x = dot(h, pane.right) / dot(pane.right, pane.right);
  const y = dot(h, pane.up) / dot(pane.up, pane.up);
  if (Math.abs(x) > 1 || Math.abs(y) > 1) return null;
  return { u: 0.5 + 0.5 * x, v: 0.5 - 0.5 * y, distance: t };
}
