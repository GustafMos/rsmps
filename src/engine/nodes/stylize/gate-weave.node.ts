import { defineNode } from '../../define';
import { SHAKE_EDGES, SHAKE_WGSL, coverZoom, hash2, poseVec, shakeEdgeIndex, wander, type Pose } from '../../lib/shake';

/**
 * Gate weave: film is held in the gate by pins and pressure, never in exactly the same place twice. What you see is
 *   - a slow drift, mostly along the length of the film (up and down), as the loop of film above the gate tightens and slackens,
 *   - a small jump from frame to frame (the play of the pins in the perforations),
 *   - a trace of tilt,
 * all of it once per film frame, never in between, and on worn machines now and then a frame that slips out of
 * registration and shows the frame line. The lamp and a hand-cranked or tired motor change the exposure too.
 * This is the movement of the film in the machine. The movement of the camera itself is Camera Shake.
 */
export interface WeaveLook {
  label: string;
  /** Slow drift, percent of the width. */
  drift: number;
  /** Frame-to-frame jump, percent of the width. */
  jump: number;
  /** Tilt, degrees. */
  tilt: number;
  /** Chance per film frame of a slip out of registration. */
  slips: number;
  /** Exposure swing (0..1). */
  exposure: number;
}

export const WEAVE_LOOKS: Record<string, WeaveLook> = {
  camera35: { label: '35mm camera', drift: 0.02, jump: 0.012, tilt: 0.004, slips: 0, exposure: 0.004 },
  projector35: { label: '35mm projector', drift: 0.07, jump: 0.035, tilt: 0.012, slips: 0, exposure: 0.02 },
  film16: { label: '16mm', drift: 0.14, jump: 0.07, tilt: 0.03, slips: 0, exposure: 0.03 },
  super8: { label: 'Super 8', drift: 0.3, jump: 0.16, tilt: 0.07, slips: 0.002, exposure: 0.06 },
  worn: { label: 'Worn projector', drift: 0.6, jump: 0.35, tilt: 0.15, slips: 0.03, exposure: 0.12 },
  crank: { label: 'Hand cranked', drift: 0.5, jump: 0.3, tilt: 0.1, slips: 0.008, exposure: 0.3 },
  broken: { label: 'Losing the loop', drift: 1.2, jump: 0.8, tilt: 0.3, slips: 0.18, exposure: 0.25 },
};

export interface WeaveFrame {
  pose: Pose;
  /** How far the frame has slipped down, in frame heights (0 = in registration). */
  slip: number;
  gain: number;
}

/** The state of film frame `f` (a whole number). */
export function weaveFrame(look: WeaveLook, f: number, seed: number, loopFrames: number): WeaveFrame {
  // the drift is slow: a few seconds per swing at 24 frames a second
  const drift = (k: number, hz: number) => wander(f, hz, 0.5, seed + k, loopFrames);
  const jump = (k: number) => hash2(f + 0.5, seed + k) * 2 - 1;
  const x = (look.drift * 0.35 * drift(1, 0.021) + look.jump * 0.4 * jump(1)) / 100;
  const y = (look.drift * drift(2, 0.016) + look.jump * jump(2)) / 100;
  const rot = ((look.tilt * Math.PI) / 180) * (0.6 * drift(3, 0.019) + 0.4 * jump(3));
  // a slip lasts one to three frames and is rarely a whole frame
  let slip = 0;
  for (let back = 0; back < 3; back++) {
    const g = f - back;
    if (hash2(g + 0.25, seed + 7) < look.slips && back <= Math.floor(hash2(g, seed + 8) * 3)) slip = (0.08 + 0.5 * hash2(g, seed + 9)) * (hash2(g, seed + 10) < 0.5 ? -1 : 1);
  }
  const gain = 1 + look.exposure * (0.6 * drift(4, 0.05) + 0.4 * jump(4));
  return { pose: { x, y, rot, zoom: 1 }, slip, gain };
}

const custom = (p: Record<string, unknown>): boolean => p.look === 'custom';

export default defineNode({
  id: 'gate-weave',
  title: 'Gate Weave',
  category: 'stylize',
  description: 'The unsteadiness of film in a camera or projector: slow drift along the film, a small jump every frame, a trace of tilt, exposure that wavers, and on worn machines a frame that slips and shows the frame line. Moves once per film frame, as film does.',
  keywords: ['film', 'weave', 'gate', 'jitter', 'unsteady', 'registration', 'projector', 'super 8', '16mm', '35mm', 'film look', 'frame line', 'slip', 'flicker', 'hand cranked', 'vintage', 'old film', 'wobble', 'telecine'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    look: { type: 'enum', default: 'film16', options: [...Object.entries(WEAVE_LOOKS).map(([value, v]) => ({ value, label: v.label })), { value: 'custom', label: 'Custom' }], label: 'Look', hint: 'A good 35mm camera is almost steady; the smaller the film and the older the machine, the more it moves. Custom shows every control.' },
    strength: { type: 'number', default: 1, min: 0, max: 6, step: 0.01, label: 'Strength', hint: 'Multiplies the movement.' },
    drift: { type: 'number', default: 0.14, min: 0, max: 4, step: 0.005, label: 'Drift %', visibleIf: custom, hint: 'Slow wander, percent of the picture width. Mostly up and down.' },
    jump: { type: 'number', default: 0.07, min: 0, max: 4, step: 0.005, label: 'Frame jump %', visibleIf: custom, hint: 'How far each frame lands from the last one.' },
    tilt: { type: 'number', default: 0.03, min: 0, max: 3, step: 0.005, unit: 'deg', label: 'Tilt', visibleIf: custom },
    slips: { type: 'number', default: 0, min: 0, max: 0.5, step: 0.001, label: 'Slips', visibleIf: custom, hint: 'Chance per frame that the film slips out of place and the frame line shows.' },
    exposure: { type: 'number', default: 0.03, min: 0, max: 1, step: 0.005, label: 'Exposure swing', visibleIf: custom },
    rate: {
      type: 'enum',
      default: 'project',
      options: [
        { value: 'project', label: 'Project frame rate' },
        { value: '24', label: '24 frames a second' },
        { value: '18', label: '18 frames a second' },
        { value: '16', label: '16 frames a second' },
        { value: '12', label: '12 frames a second' },
      ],
      label: 'Film speed',
      hint: 'The film moves once per film frame. Super 8 runs at 18, silent film at about 16.',
    },
    edge: { type: 'enum', default: 'fill', options: SHAKE_EDGES, label: 'Edges', hint: 'What happens where the moved picture does not reach the frame.' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed' },
  },
  summary: (p) => `${WEAVE_LOOKS[p.look as string]?.label ?? 'custom'}${p.strength !== 1 ? ` × ${p.strength}` : ''}`,
  render(ctx) {
    const raw = ctx.params;
    const src = ctx.in.image;
    if (!src || raw.strength <= 0) return { image: src };
    const base: WeaveLook = WEAVE_LOOKS[raw.look as string] ?? { label: 'Custom', drift: raw.drift, jump: raw.jump, tilt: raw.tilt, slips: raw.slips, exposure: raw.exposure };
    const k = raw.strength;
    const look: WeaveLook = { ...base, drift: base.drift * k, jump: base.jump * k, tilt: base.tilt * k, exposure: Math.min(1, base.exposure * k) };
    const time = ctx.time;
    const fps = raw.rate === 'project' ? time.fps : Number(raw.rate);
    const f = Math.floor(time.seconds * fps + 1e-6);
    const loopFrames = time.loop ? Math.max(1, Math.round(time.duration * fps)) : 0;
    const w = weaveFrame(look, loopFrames > 0 ? f % loopFrames : f, raw.seed, loopFrames);
    const reachX = (look.drift * 0.35 + look.jump * 0.4) / 100;
    const reachY = (look.drift + look.jump) / 100;
    const fill = raw.edge === 'fill' ? coverZoom(reachX, reachY, (look.tilt * Math.PI) / 180, src.width / src.height) : 1;
    const image = ctx.gpu.pass({
      label: 'gate-weave',
      size: src,
      textures: { src },
      uniforms: { pose: poseVec(w.pose, fill), edge: shakeEdgeIndex(raw.edge), slip: w.slip, gain: w.gain },
      wgsl: /* wgsl */ `${SHAKE_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var c = shakeSample(uv, u.pose);
  if (abs(u.slip) > 0.0) {
    // out of registration: the frame is too high or too low, the next frame shows on the other side of the frame line
    let y = uv.y - u.slip;
    let wrapped = fract(y);
    c = shakeSample(vec2f(uv.x, wrapped), u.pose);
    let line = min(wrapped, 1.0 - wrapped);
    c = vec4f(c.rgb * smoothstep(0.012, 0.03, line), max(c.a, 1.0 - smoothstep(0.012, 0.03, line)));
  }
  return vec4f(clamp(c.rgb * u.gain, vec3f(0.0), vec3f(c.a)), c.a);
}`,
    });
    return { image };
  },
});
