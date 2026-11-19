import { defineNode } from '../../define';
import { SHAKE_EDGES, SHAKE_WGSL, coverZoom, poseVec, shakeEdgeIndex, wander, type Pose } from '../../lib/shake';

/**
 * The movement of a camera that is not bolted down. A held camera does not jump at random: it wanders slowly (the arms
 * and the breath), with smaller, quicker tremors on top, it tilts as well as moves, and steps add a bob at the pace of
 * walking. Each look is those parts in different amounts. The blur of the movement during the exposure is drawn too,
 * which is most of what makes shake look photographed instead of added.
 */
export interface ShakeLook {
  label: string;
  /** How far the frame wanders, percent of the width. */
  amount: number;
  /** Tilt, degrees. */
  tilt: number;
  /** Speed of the slow wander, turns per second. */
  speed: number;
  /** Share of quick tremor on top of the slow wander (0 smooth .. 1 rough). */
  rough: number;
  /** Up-and-down bob of steps, percent of the width, and steps per second. */
  bob: number;
  pace: number;
  /** In-and-out drift, percent. */
  breathe: number;
}

export const SHAKE_LOOKS: Record<string, ShakeLook> = {
  tripod: { label: 'Tripod, breathing', amount: 0.04, tilt: 0.02, speed: 0.3, rough: 0.3, bob: 0, pace: 0, breathe: 0.03 },
  calm: { label: 'Handheld, steady', amount: 0.35, tilt: 0.18, speed: 0.45, rough: 0.45, bob: 0, pace: 0, breathe: 0.15 },
  handheld: { label: 'Handheld', amount: 0.8, tilt: 0.45, speed: 0.7, rough: 0.55, bob: 0, pace: 0, breathe: 0.3 },
  shoulder: { label: 'Shoulder camera', amount: 0.5, tilt: 0.25, speed: 0.4, rough: 0.35, bob: 0.25, pace: 1.7, breathe: 0.2 },
  walking: { label: 'Walking', amount: 1.1, tilt: 0.7, speed: 0.8, rough: 0.55, bob: 0.9, pace: 1.8, breathe: 0.4 },
  running: { label: 'Running', amount: 2.2, tilt: 1.6, speed: 1.4, rough: 0.65, bob: 2.4, pace: 2.8, breathe: 0.8 },
  longLens: { label: 'Long lens', amount: 1.2, tilt: 0.08, speed: 1.6, rough: 0.7, bob: 0, pace: 0, breathe: 0.05 },
  vehicle: { label: 'Car ride', amount: 0.5, tilt: 0.2, speed: 3.5, rough: 0.8, bob: 0.35, pace: 6.5, breathe: 0.1 },
  documentary: { label: 'Documentary, nervous', amount: 1.4, tilt: 0.9, speed: 1.1, rough: 0.7, bob: 0.3, pace: 2, breathe: 0.6 },
  earthquake: { label: 'Earthquake', amount: 4, tilt: 3, speed: 5, rough: 0.85, bob: 2, pace: 9, breathe: 1.5 },
};

/** Where the camera is at time `t` (seconds). */
export function shakePose(look: ShakeLook, t: number, seed: number, loop: number): Pose {
  const a = look.amount / 100;
  const x = a * wander(t, look.speed, look.rough, seed + 1, loop);
  let y = a * 0.8 * wander(t, look.speed * 1.07, look.rough, seed + 2, loop);
  let rot = ((look.tilt * Math.PI) / 180) * wander(t, look.speed * 0.8, look.rough, seed + 3, loop);
  if (look.bob > 0 && look.pace > 0) {
    // a step: down fast, up slower, never twice the same height; each second step tilts the other way
    const pace = loop > 0 ? Math.max(1, Math.round(look.pace * loop)) / loop : look.pace;
    const ph = pace * t;
    const size = 0.75 + 0.25 * wander(t, 0.5, 0.4, seed + 5, loop);
    y += (look.bob / 100) * size * (0.5 - Math.abs(Math.sin(Math.PI * ph)));
    rot += ((look.tilt * Math.PI) / 180) * 0.35 * Math.sin(Math.PI * ph);
  }
  const zoom = 1 + (look.breathe / 100) * wander(t, look.speed * 0.5, 0.3, seed + 4, loop);
  return { x, y, rot, zoom };
}

/** The furthest a look can move, for "Zoom in to fill". */
export function shakeReach(look: ShakeLook): Pose {
  return { x: look.amount / 100, y: (look.amount * 0.8 + look.bob * 0.5) / 100, rot: (look.tilt * 1.35 * Math.PI) / 180, zoom: 1 - look.breathe / 100 };
}

const custom = (p: Record<string, unknown>): boolean => p.look === 'custom';
const TAPS = 8;

export default defineNode({
  id: 'camera-shake',
  title: 'Camera Shake',
  category: 'transform',
  description: 'The movement of a camera in real hands: slow wander, quick tremor, tilt and the bob of steps, with the motion blur a real shutter would record. From a breathing tripod to running, a long lens, a car ride or an earthquake.',
  keywords: ['shake', 'handheld', 'hand held', 'wobble', 'jitter', 'camera move', 'shaky cam', 'documentary', 'walking', 'running', 'earthquake', 'vibration', 'tremor', 'film look', 'steadicam', 'tripod', 'motion blur', 'long lens', 'telephoto'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    look: { type: 'enum', default: 'handheld', options: [...Object.entries(SHAKE_LOOKS).map(([value, v]) => ({ value, label: v.label })), { value: 'custom', label: 'Custom' }], label: 'Look', hint: 'Custom shows every control.' },
    strength: { type: 'number', default: 1, min: 0, max: 4, step: 0.01, label: 'Strength', hint: 'Multiplies how far the camera moves and tilts.' },
    amount: { type: 'number', default: 0.8, min: 0, max: 10, step: 0.01, label: 'Move %', visibleIf: custom, hint: 'How far the frame wanders, percent of the picture width.' },
    tilt: { type: 'number', default: 0.45, min: 0, max: 15, step: 0.01, unit: 'deg', label: 'Tilt', visibleIf: custom },
    speed: { type: 'number', default: 0.7, min: 0.05, max: 12, step: 0.05, label: 'Speed', visibleIf: custom, hint: 'Turns per second of the slow wander. Hands: 0.4 to 1. Engines and long lenses: 2 and up.' },
    rough: { type: 'number', default: 0.55, min: 0, max: 0.95, step: 0.01, label: 'Tremor', visibleIf: custom, hint: 'Share of quick, small movement on top of the slow wander.' },
    bob: { type: 'number', default: 0, min: 0, max: 6, step: 0.01, label: 'Step bob %', visibleIf: custom, hint: 'Up and down with every step, percent of the picture width.' },
    pace: { type: 'number', default: 1.8, min: 0.2, max: 12, step: 0.05, label: 'Steps per second', visibleIf: (p) => p.look === 'custom' && (p.bob as number) > 0 },
    breathe: { type: 'number', default: 0.3, min: 0, max: 5, step: 0.01, label: 'In and out %', visibleIf: custom, hint: 'Slow drift toward and away from the subject.' },
    blur: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Motion blur', hint: 'How long the shutter is open, as a share of the frame. 0.5 is the film standard (a 180 degree shutter). 0 = no blur.' },
    edge: { type: 'enum', default: 'fill', options: SHAKE_EDGES, label: 'Edges', hint: 'What happens where the moved picture does not reach the frame.' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', hint: 'Another number, another take.' },
  },
  summary: (p) => `${SHAKE_LOOKS[p.look as string]?.label ?? 'custom'}${p.strength !== 1 ? ` × ${p.strength}` : ''}`,
  render(ctx) {
    const raw = ctx.params;
    const src = ctx.in.image;
    if (!src || raw.strength <= 0) return { image: src };
    const base: ShakeLook = SHAKE_LOOKS[raw.look as string] ?? { label: 'Custom', amount: raw.amount, tilt: raw.tilt, speed: raw.speed, rough: raw.rough, bob: raw.bob, pace: raw.pace, breathe: raw.breathe };
    const k = raw.strength;
    const look: ShakeLook = { ...base, amount: base.amount * k, tilt: base.tilt * k, bob: base.bob * k, breathe: base.breathe * k };
    const time = ctx.time;
    const loop = time.loop ? time.duration : 0;
    const now = shakePose(look, time.seconds, raw.seed, loop);
    // where the camera was when the shutter opened
    const before = raw.blur > 0 ? shakePose(look, time.seconds - raw.blur / Math.max(1, time.fps), raw.seed, loop) : now;
    const reach = shakeReach(look);
    const fill = raw.edge === 'fill' ? coverZoom(reach.x, reach.y, reach.rot, src.width / src.height) / reach.zoom : 1;
    const image = ctx.gpu.pass({
      label: 'camera-shake',
      size: src,
      textures: { src },
      uniforms: { a: poseVec(before, fill), b: poseVec(now, fill), edge: shakeEdgeIndex(raw.edge), taps: raw.blur > 0 ? TAPS : 1 },
      wgsl: /* wgsl */ `${SHAKE_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let n = i32(u.taps);
  if (n <= 1) { return shakeSample(uv, u.b); }
  var acc = vec4f(0.0);
  for (var i = 0; i < n; i++) {
    acc += shakeSample(uv, mix(u.a, u.b, (f32(i) + 0.5) / f32(n)));
  }
  return acc / f32(n);
}`,
    });
    return { image };
  },
});
