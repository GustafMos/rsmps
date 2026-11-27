import { defineNode } from '../../define';
import { rapierBackend } from '../../lib/physics/rapier';
import { drawPhysics, fitCamera } from '../../lib/physics/debug-view';
import { MAX_RUN_FRAMES, getRun, normalizeBodies, runSignature } from '../../lib/physics/sim';
import type { FrameInputs, WorldSpec } from '../../lib/physics/types';
import { MAX_BODIES } from '../../lib/physics/types';
import type { Vec3 } from '../../lib/physics/rotation';
import type { CameraValue, InputDef, MotionValue, OutputDef } from '../../types';

/**
 * Physics: a small real-time physics world. Bodies (balls, boxes, capsules, cylinders) fall, bounce, slide and pile up on a floor, and
 * the node hands out where each one is as Position and Rotation vectors, to wire into the Move XYZ and Rotate XYZ of 3D nodes and SDF shapes.
 *
 * Time: the sim starts at "Start at" and steps once per project frame with a fixed step (lib/physics/sim.ts keeps every simulated frame,
 * so scrubbing and exporting always show the same numbers; with Loop on it starts again from the start pose every loop).
 * The engine (Rapier, deterministic build) is loaded lazily on the first render and is not part of the main app bundle.
 *
 * Units: scene units and seconds, like the 3D nodes. Up is +Y; the floor is the horizontal plane at "Floor height". In the World AR
 * Camera's object frame the real surface is the plane y = -Lift (default Lift 1 puts it at y = -1, where a default 3D Object stands).
 */

export const PHYSICS_SLOTS = 8;
const KIN_SLOTS = 4;

const slot = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

const bodyCount = (p: Record<string, unknown>): number => normalizeBodies(p.bodies).length;
const bodyAt = (p: Record<string, unknown>, i: number) => normalizeBodies(p.bodies)[i - 1];
const advOut = (p: Record<string, unknown>): boolean => p.advOut === true;
const advIn = (p: Record<string, unknown>): boolean => p.advIn === true;

/** The ports of body `i` (1-based) that carry its motion: one wire holds position and rotation together. */
export const motionOut = (i: number): string => `motion${i}`;
export const motionIn = (i: number): string => `drive${i}`;

// One Motion output per body, shown only for the bodies that exist (or are wired). The older Position / Rotation vectors, Moving, Hits and
// Preview stay (saved projects use them) but are hidden until wired or until "Advanced outputs" is on.
const outputs: Record<string, OutputDef> = {};
for (const i of slot(MAX_BODIES)) outputs[motionOut(i)] = { type: 'motion', label: `Body ${i}`, visibleIf: (p) => bodyCount(p) >= i };
outputs.image = { type: 'image', label: 'Preview', visibleIf: advOut };
outputs.moving = { type: 'number', label: 'Moving', visibleIf: advOut };
outputs.hits = { type: 'number', label: 'Hits', visibleIf: advOut };
for (const i of slot(PHYSICS_SLOTS)) {
  outputs[`pos${i}`] = { type: 'vector', label: `Position ${i}`, visibleIf: advOut };
  outputs[`rot${i}`] = { type: 'vector', label: `Rotation ${i}`, visibleIf: advOut };
}
outputs.posExtra = { type: 'vector', label: 'Position of extra body', visibleIf: advOut };
outputs.rotExtra = { type: 'vector', label: 'Rotation of extra body', visibleIf: advOut };

const inputs: Record<string, InputDef> = {};
// one Motion input per body, only for bodies that are "Moved by wires"
for (const i of slot(MAX_BODIES)) inputs[motionIn(i)] = { type: 'motion', label: `Body ${i} follows`, visibleIf: (p) => bodyAt(p, i)?.kind === 'kinematic', };
inputs.gravityVec = { type: 'vector', label: 'Gravity XYZ', visibleIf: advIn };
inputs.push = { type: 'vector', label: 'Push', visibleIf: advIn };
inputs.pushNow = { type: 'number', label: 'Push now', visibleIf: advIn };
inputs.camera = { type: 'camera', label: 'AR camera' };
for (const i of slot(KIN_SLOTS)) {
  inputs[`move${i}`] = { type: 'vector', label: `Move body ${i}`, visibleIf: advIn };
  inputs[`turn${i}`] = { type: 'vector', label: `Turn body ${i}`, visibleIf: advIn };
}

const DOWN: Record<string, Vec3> = { down: [0, -1, 0], up: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0], away: [0, 0, 1], toward: [0, 0, -1] };

const asVec = (v: unknown): Vec3 | null => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] : null);

export default defineNode({
  id: 'physics',
  title: 'Physics',
  category: 'generate',
  description:
    'Makes objects fall, bounce and pile up on a floor. The easy way: select a 3D object or an SDF shape and choose Falls under Physics in its settings. Each object gets one wire from this node. It starts again from the start pose every loop and gives the same result every time you scrub or export.',
  keywords: ['physics', 'gravity', 'fall', 'bounce', 'collide', 'collision', 'rigid body', 'simulation', 'drop', 'ragdoll', 'jolt', 'rapier', 'floor', 'ar', 'pile', 'rolling'],
  guide: {
    does: 'Makes objects fall and bounce. Wire the World AR Camera into this node and they land on the real floor.',
    steps: [
      'Select a 3D object or SDF shape and choose Falls under Physics in its settings. That adds this node and wires it for you.',
      'In the AR view, wire the World AR Camera into the AR camera socket: the objects use the real floor and stand where you placed them.',
      'Press play. It starts again from the start pose every loop.',
    ],
    seeAlso: ['world-ar', 'object-3d'],
  },
  inputs,
  outputs,
  optionalOutputs: ['image'],
  previewOutput: 'image',
  defaultPins: [],
  portLabel: (dir, port, p) => {
    if (dir === 'out') {
      const m = /^motion(\d+)$/.exec(port);
      const b = m ? bodyAt(p, Number(m[1])) : undefined;
      return b ? `Body ${m![1]} · ${b.shape}` : null;
    }
    return null;
  },
  cpu: true,
  params: {
    bodies: { type: 'json', default: [{ shape: 'sphere', size: [0.5, 1, 1], pos: [0, 2, 0] }], label: 'Bodies', visibleIf: () => false },
    gravity: { type: 'number', default: 9.81, min: 0, max: 100, softMax: 30, step: 0.01, label: 'Gravity', group: 'World', hint: 'How strongly things fall, in scene units per second squared. 9.81 is Earth when one unit is a metre.' },
    gravDir: {
      type: 'enum',
      default: 'down',
      label: 'Gravity points',
      group: 'World',
      hint: 'Which way things fall. For any other way wire a vector into Gravity XYZ.',
      options: [
        { value: 'down', label: 'Down' },
        { value: 'up', label: 'Up' },
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
        { value: 'away', label: 'Away from the camera' },
        { value: 'toward', label: 'Toward the camera' },
      ],
    },
    drag: { type: 'number', default: 0, min: 0, max: 20, softMax: 3, step: 0.05, label: 'Air drag', group: 'World', hint: 'Slows moving and spinning bodies, like air and rolling resistance. 0 lets a ball roll for ever.' },
    floor: {
      type: 'enum',
      default: 'auto',
      absent: 'custom',
      legacy: (v) => (v === true ? 'custom' : v === false ? 'off' : v),
      label: 'Floor',
      group: 'World',
      hint: 'Automatic uses the floor of the connected camera (the AR camera knows where the real floor is), or -1 when there is none. Custom height uses the number below. Off lets things fall for ever. Things fall toward the real down of the placed object. If the real floor moves by more than 1 mm, the fall starts over.',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'custom', label: 'Custom height' },
        { value: 'off', label: 'Off' },
      ],
    },
    floorHeight: { type: 'number', default: -1, min: -50, max: 50, step: 0.01, scrubSpan: 8, label: 'Floor height', group: 'World', visibleIf: (p) => p.floor === 'custom', hint: 'Up is positive. The default -1 is the bottom of a default 3D Object (2 units tall) and the surface the World AR Camera stands objects on.' },
    floorBounce: { type: 'number', default: 0.3, min: 0, max: 1.5, step: 0.01, label: 'Floor bounce', group: 'World', hint: 'How much the floor and walls bounce things back. It is averaged with each body\'s own Bounciness.' },
    floorGrip: { type: 'number', default: 0.6, min: 0, max: 5, step: 0.01, label: 'Floor grip', group: 'World', hint: 'Friction of the floor and walls. 0 is ice.' },
    walls: { type: 'bool', default: false, label: 'Walls', group: 'World', hint: 'Four walls around the floor so things stay in a box.' },
    roomWidth: { type: 'number', default: 8, min: 0.5, max: 100, step: 0.1, label: 'Room width', group: 'World', visibleIf: (p) => p.walls === true },
    roomDepth: { type: 'number', default: 8, min: 0.5, max: 100, step: 0.1, label: 'Room depth', group: 'World', visibleIf: (p) => p.walls === true },
    timeScale: { type: 'number', default: 1, min: 0.05, max: 4, step: 0.05, label: 'Speed', group: 'World', hint: '1 is real time. 0.25 is slow motion.' },
    substeps: { type: 'number', default: 1, min: 1, max: 8, step: 1, integer: true, label: 'Substeps', group: 'Advanced', hint: 'Smaller steps inside each frame: steadier stacks and fast bodies, a little slower.' },
    startAt: {
      type: 'number',
      default: 0,
      min: 0,
      max: 600,
      softMax: 20,
      step: 0.01,
      unit: 's',
      label: 'Start at',
      group: 'Advanced',
      hint: 'When the simulation begins, in seconds. Before this the bodies wait at their start poses. Every loop starts again from there: the simulation cannot carry on across the loop point, because every frame has to look the same each time you play, scrub or export.',
    },
    pushWho: { type: 'number', default: 0, min: 0, max: 16, step: 1, integer: true, label: 'Push who', group: 'Advanced', hint: '0 pushes every falling body, 1 to 16 only that body.' },
    hitLimit: { type: 'number', default: 1.5, min: 0, max: 50, softMax: 10, step: 0.1, label: 'Hit limit', group: 'Advanced', hint: 'Hits only reports knocks that change a body\'s speed by more than this (units per second).' },
    extraBody: { type: 'number', default: 9, min: 1, max: 16, step: 1, integer: true, label: 'Extra body', group: 'Advanced', hint: 'Which body Position of extra body and Rotation of extra body report. The outputs 1 to 8 are fixed.' },
    viewTurn: { type: 'number', default: 25, min: -180, max: 180, step: 1, unit: 'deg', label: 'View turn', group: 'Preview', hint: 'Where the preview looks from (used when no Camera is wired).' },
    viewTilt: { type: 'number', default: 20, min: -80, max: 80, step: 1, unit: 'deg', label: 'View tilt', group: 'Preview' },
    viewDistance: { type: 'number', default: 9, min: 1, max: 100, softMax: 30, step: 0.1, label: 'View distance', group: 'Preview', visibleIf: () => false, hint: 'Not used any more: the preview frames the bodies by itself.' },
    advIn: { type: 'bool', default: false, label: 'Advanced inputs', group: 'Advanced', hint: 'Shows the Gravity, Push and old Move / Turn sockets on the node.' },
    advOut: { type: 'bool', default: false, label: 'Advanced outputs', group: 'Advanced', hint: 'Shows Preview, Moving, Hits and the plain Position / Rotation numbers on the node.' },
  },
  summary: (p) => {
    const n = normalizeBodies(p.bodies).length;
    return `${n} ${n === 1 ? 'object' : 'objects'}${p.floor === 'off' ? ' · no floor' : p.floor === 'auto' ? ' · automatic floor' : ' · floor on'}`;
  },
  async render(ctx) {
    const p = ctx.params;
    const bodies = normalizeBodies(p.bodies);
    const fps = ctx.time.fps;
    const dir = DOWN[p.gravDir as string] ?? DOWN.down;
    // The floor: Automatic takes the real floor of the wired camera (the World AR Camera's `ground`), else the old default -1. It is rounded
    // to 1 mm so that noise in the value does not start the run over every frame; a change beyond that is a different run (see runSignature).
    const cam = (ctx.in.camera as CameraValue | null) ?? null;
    const floorAt = p.floor === 'auto' ? (typeof cam?.ground === 'number' && Number.isFinite(cam.ground) ? Math.round(cam.ground * 1000) / 1000 : -1) : p.floorHeight;
    const world: WorldSpec = {
      gravity: [dir[0] * p.gravity, dir[1] * p.gravity, dir[2] * p.gravity],
      damping: p.drag,
      floor: p.floor !== 'off',
      floorHeight: floorAt,
      floorBounce: p.floorBounce,
      floorFriction: p.floorGrip,
      walls: p.walls,
      roomWidth: p.roomWidth,
      roomDepth: p.roomDepth,
      timeScale: p.timeScale,
      substeps: Math.max(1, Math.round(p.substeps)),
      fps,
    };
    const wired = ['gravityVec', 'push', 'pushNow', ...slot(KIN_SLOTS).flatMap((i) => [`move${i}`, `turn${i}`]), ...slot(bodies.length).map(motionIn)].map((n) => `${n}=${ctx.inputSignature(n as never)}`).join('|');
    const sig = runSignature(bodies, world, `${wired}|${p.pushWho}`);
    const startFrame = Math.round(p.startAt * fps);
    // with Loop on the clock may run past the loop's end (an export, a scrub): every loop is the same, so wrap and start again
    const total = Math.max(1, Math.round(ctx.time.duration * fps));
    const frame = ctx.time.loop ? ((ctx.time.frame % total) + total) % total : ctx.time.frame;
    const k = Math.min(MAX_RUN_FRAMES, Math.max(0, frame - startFrame));

    const backend = await rapierBackend();
    const run = getRun(sig, bodies, world, backend, p.pushWho);

    // the values on the wires of simulated frame j: the current frame's come in as inputs, earlier ones are asked for at their own time
    const asMotion = (v: unknown): MotionValue | null => {
      const m = v as MotionValue | null;
      return m && typeof m === 'object' && asVec(m.pos) ? m : null;
    };
    // a Motion wire on a body moves and turns it; the older Move / Turn vector wires still work and win nothing over it
    const current = (): FrameInputs => ({
      gravityDir: asVec(ctx.in.gravityVec),
      push: asVec(ctx.in.push),
      pushNow: typeof ctx.in.pushNow === 'number' ? ctx.in.pushNow : 0,
      move: slot(bodies.length).map((i) => asVec(asMotion((ctx.in as Record<string, unknown>)[motionIn(i)])?.pos) ?? (i <= KIN_SLOTS ? asVec((ctx.in as Record<string, unknown>)[`move${i}`]) : null)),
      turn: slot(bodies.length).map((i) => asVec(asMotion((ctx.in as Record<string, unknown>)[motionIn(i)])?.rot) ?? (i <= KIN_SLOTS ? asVec((ctx.in as Record<string, unknown>)[`turn${i}`]) : null)),
    } as FrameInputs);
    const wiredNames = new Set(Object.keys(inputs).filter((n) => n !== 'camera' && ctx.inputSignature(n as never) !== ''));
    const inputsAt = async (j: number): Promise<FrameInputs> => {
      if (j === k) return current();
      const at = { seconds: (startFrame + j) / fps };
      // (a pulled time inside the loop: j never exceeds the wrapped frame)
      const get = async (n: string): Promise<unknown> => (wiredNames.has(n) ? ctx.pull(n as never, at) : null);
      const num = await get('pushNow');
      return {
        gravityDir: asVec(await get('gravityVec')),
        push: asVec(await get('push')),
        pushNow: typeof num === 'number' ? num : 0,
        move: await Promise.all(slot(bodies.length).map(async (i) => asVec(asMotion(await get(motionIn(i)))?.pos) ?? (i <= KIN_SLOTS ? asVec(await get(`move${i}`)) : null))),
        turn: await Promise.all(slot(bodies.length).map(async (i) => asVec(asMotion(await get(motionIn(i)))?.rot) ?? (i <= KIN_SLOTS ? asVec(await get(`turn${i}`)) : null))),
      };
    };
    const at = await run.ensure(k, inputsAt);

    const out: Record<string, unknown> = {};
    for (const i of slot(MAX_BODIES)) {
      const b = i <= bodies.length ? run.body(at, i - 1) : null;
      out[motionOut(i)] = b ? ({ kind: 'motion', pos: b.pos, rot: b.rot, ...(cam ? { camera: cam } : {}) } satisfies MotionValue) : null;
    }
    for (const i of slot(PHYSICS_SLOTS)) {
      const b = run.body(at, i - 1);
      out[`pos${i}`] = b ? b.pos : null;
      out[`rot${i}`] = b ? b.rot : null;
    }
    const ex = run.body(at, Math.round(p.extraBody) - 1);
    out.posExtra = ex ? ex.pos : null;
    out.rotExtra = ex ? ex.rot : null;
    out.moving = run.moving(at);
    const impact = run.impact[Math.min(at, run.impact.length - 1)] ?? 0;
    out.hits = at > 0 && impact >= Math.max(0.0001, p.hitLimit) ? impact : 0;

    if (ctx.wants('image')) {
      const scale = Math.min(1, 1024 / Math.max(ctx.canvas.width, ctx.canvas.height));
      const w = Math.max(16, Math.round(ctx.canvas.width * scale));
      const h = Math.max(16, Math.round(ctx.canvas.height * scale));
      const view = cam ?? fitCamera(bodies, world, { turn: p.viewTurn, tilt: p.viewTilt, aspect: w / h });
      const draw = bodies.map((spec, i) => {
        const b = run.body(at, i)!;
        return { spec, pos: b.pos, rot: b.rot, asleep: b.asleep };
      });
      const px = drawPhysics(draw, world, view, w, h);
      out.image = ctx.gpu.upload(px, w, h, ctx.unitFor(w, h), false);
    }
    return out as never;
  },
});
