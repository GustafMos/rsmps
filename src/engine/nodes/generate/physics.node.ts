import { defineNode } from '../../define';
import { rapierBackend } from '../../lib/physics/rapier';
import { defaultCamera, drawPhysics } from '../../lib/physics/debug-view';
import { MAX_RUN_FRAMES, getRun, normalizeBodies, runSignature } from '../../lib/physics/sim';
import type { FrameInputs, WorldSpec } from '../../lib/physics/types';
import type { Vec3 } from '../../lib/physics/rotation';
import type { CameraValue, OutputDef } from '../../types';

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

const outputs: Record<string, OutputDef> = {};
for (const i of slot(PHYSICS_SLOTS)) {
  outputs[`pos${i}`] = { type: 'vector', label: `Position ${i}` };
  outputs[`rot${i}`] = { type: 'vector', label: `Rotation ${i}` };
}
outputs.posExtra = { type: 'vector', label: 'Position of extra body' };
outputs.rotExtra = { type: 'vector', label: 'Rotation of extra body' };
outputs.moving = { type: 'number', label: 'Moving' };
outputs.hits = { type: 'number', label: 'Hits' };
outputs.image = { type: 'image', label: 'Preview' };

const inputs: Record<string, { type: 'vector' | 'number' | 'camera'; label: string; hint?: string }> = {
  gravityVec: { type: 'vector', label: 'Gravity XYZ', hint: 'Which way is down, as a vector (its length does not matter, Gravity sets the strength). Wire a tilt here to make things slide with the phone.' },
  push: { type: 'vector', label: 'Push', hint: 'How hard and which way to kick. Applied when Push now rises above 0.' },
  pushNow: { type: 'number', label: 'Push now', hint: 'Kicks the bodies by Push at the moment this rises above 0. Wire a tap, a jolt or a beat here.' },
  camera: { type: 'camera', label: 'Camera' },
};
for (const i of slot(KIN_SLOTS)) {
  inputs[`move${i}`] = { type: 'vector', label: `Move body ${i}`, hint: `Where body ${i} is, when its Kind is "Moved by wires". Anything it touches is shoved.` };
  inputs[`turn${i}`] = { type: 'vector', label: `Turn body ${i}`, hint: `How body ${i} is turned (degrees), when its Kind is "Moved by wires".` };
}

const DOWN: Record<string, Vec3> = { down: [0, -1, 0], up: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0], away: [0, 0, 1], toward: [0, 0, -1] };

const asVec = (v: unknown): Vec3 | null => (Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n)) ? [v[0], v[1], v[2]] : null);

export default defineNode({
  id: 'physics',
  title: 'Physics',
  category: 'generate',
  description:
    'Things that fall, bounce and pile up. Add balls, boxes, capsules and cylinders, give them a floor and a push, and wire each one\'s Position and Rotation into the Move XYZ and Rotate XYZ of a 3D node or an SDF shape inside an SDF Scene. It starts again from the start pose every loop and gives the same result every time you scrub or export.',
  keywords: ['physics', 'gravity', 'fall', 'bounce', 'collide', 'collision', 'rigid body', 'simulation', 'drop', 'ragdoll', 'jolt', 'rapier', 'floor', 'ar', 'pile', 'rolling'],
  inputs,
  outputs,
  optionalOutputs: ['image'],
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
    floor: { type: 'bool', default: true, label: 'Floor', group: 'World', hint: 'A flat floor that bodies land on. In the AR view the real floor or table is at height minus Lift of the World AR Camera (default 1 gives -1), so set Floor height to that and things land on it.' },
    floorHeight: { type: 'number', default: -1, min: -50, max: 50, step: 0.01, scrubSpan: 8, label: 'Floor height', group: 'World', hint: 'Up is positive. The default -1 is the bottom of a default 3D Object (2 units tall) and the surface the World AR Camera stands objects on.' },
    floorBounce: { type: 'number', default: 0.3, min: 0, max: 1.5, step: 0.01, label: 'Floor bounce', group: 'World', hint: 'How much the floor and walls bounce things back. It is averaged with each body\'s own Bounciness.' },
    floorGrip: { type: 'number', default: 0.6, min: 0, max: 5, step: 0.01, label: 'Floor grip', group: 'World', hint: 'Friction of the floor and walls. 0 is ice.' },
    walls: { type: 'bool', default: false, label: 'Walls', group: 'World', hint: 'Four walls around the floor so things stay in a box.' },
    roomWidth: { type: 'number', default: 8, min: 0.5, max: 100, step: 0.1, label: 'Room width', group: 'World', visibleIf: (p) => p.walls === true },
    roomDepth: { type: 'number', default: 8, min: 0.5, max: 100, step: 0.1, label: 'Room depth', group: 'World', visibleIf: (p) => p.walls === true },
    timeScale: { type: 'number', default: 1, min: 0.05, max: 4, step: 0.05, label: 'Time scale', group: 'Time', hint: '1 is real time. 0.25 is slow motion.' },
    substeps: { type: 'number', default: 1, min: 1, max: 8, step: 1, integer: true, label: 'Substeps', group: 'Time', hint: 'Smaller steps inside each frame: steadier stacks and fast bodies, a little slower.' },
    startAt: {
      type: 'number',
      default: 0,
      min: 0,
      max: 600,
      softMax: 20,
      step: 0.01,
      unit: 's',
      label: 'Start at',
      group: 'Time',
      hint: 'When the simulation begins, in seconds. Before this the bodies wait at their start poses. Every loop starts again from there: the simulation cannot carry on across the loop point, because every frame has to look the same each time you play, scrub or export.',
    },
    pushWho: { type: 'number', default: 0, min: 0, max: 16, step: 1, integer: true, label: 'Push who', group: 'Time', hint: '0 pushes every falling body, 1 to 16 only that body.' },
    hitLimit: { type: 'number', default: 1.5, min: 0, max: 50, softMax: 10, step: 0.1, label: 'Hit limit', group: 'Time', hint: 'Hits only reports knocks that change a body\'s speed by more than this (units per second).' },
    extraBody: { type: 'number', default: 9, min: 1, max: 16, step: 1, integer: true, label: 'Extra body', group: 'Outputs', hint: 'Which body Position of extra body and Rotation of extra body report. The outputs 1 to 8 are fixed.' },
    viewTurn: { type: 'number', default: 25, min: -180, max: 180, step: 1, unit: 'deg', label: 'View turn', group: 'Preview', hint: 'Where the preview looks from (used when no Camera is wired).' },
    viewTilt: { type: 'number', default: 20, min: -80, max: 80, step: 1, unit: 'deg', label: 'View tilt', group: 'Preview' },
    viewDistance: { type: 'number', default: 9, min: 1, max: 100, softMax: 30, step: 0.1, label: 'View distance', group: 'Preview' },
  },
  summary: (p) => {
    const n = normalizeBodies(p.bodies).length;
    return `${n} ${n === 1 ? 'body' : 'bodies'}${p.floor ? ' · floor' : ''}`;
  },
  async render(ctx) {
    const p = ctx.params;
    const bodies = normalizeBodies(p.bodies);
    const fps = ctx.time.fps;
    const dir = DOWN[p.gravDir as string] ?? DOWN.down;
    const world: WorldSpec = {
      gravity: [dir[0] * p.gravity, dir[1] * p.gravity, dir[2] * p.gravity],
      damping: p.drag,
      floor: p.floor,
      floorHeight: p.floorHeight,
      floorBounce: p.floorBounce,
      floorFriction: p.floorGrip,
      walls: p.walls,
      roomWidth: p.roomWidth,
      roomDepth: p.roomDepth,
      timeScale: p.timeScale,
      substeps: Math.max(1, Math.round(p.substeps)),
      fps,
    };
    const wired = ['gravityVec', 'push', 'pushNow', ...slot(KIN_SLOTS).flatMap((i) => [`move${i}`, `turn${i}`])].map((n) => `${n}=${ctx.inputSignature(n as never)}`).join('|');
    const sig = runSignature(bodies, world, `${wired}|${p.pushWho}`);
    const startFrame = Math.round(p.startAt * fps);
    // with Loop on the clock may run past the loop's end (an export, a scrub): every loop is the same, so wrap and start again
    const total = Math.max(1, Math.round(ctx.time.duration * fps));
    const frame = ctx.time.loop ? ((ctx.time.frame % total) + total) % total : ctx.time.frame;
    const k = Math.min(MAX_RUN_FRAMES, Math.max(0, frame - startFrame));

    const backend = await rapierBackend();
    const run = getRun(sig, bodies, world, backend, p.pushWho);

    // the values on the wires of simulated frame j: the current frame's come in as inputs, earlier ones are asked for at their own time
    const current = (): FrameInputs => ({
      gravityDir: asVec(ctx.in.gravityVec),
      push: asVec(ctx.in.push),
      pushNow: typeof ctx.in.pushNow === 'number' ? ctx.in.pushNow : 0,
      move: slot(bodies.length).map((i) => (i <= KIN_SLOTS ? asVec((ctx.in as Record<string, unknown>)[`move${i}`]) : null)),
      turn: slot(bodies.length).map((i) => (i <= KIN_SLOTS ? asVec((ctx.in as Record<string, unknown>)[`turn${i}`]) : null)),
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
        move: await Promise.all(slot(bodies.length).map(async (i) => (i <= KIN_SLOTS ? asVec(await get(`move${i}`)) : null))),
        turn: await Promise.all(slot(bodies.length).map(async (i) => (i <= KIN_SLOTS ? asVec(await get(`turn${i}`)) : null))),
      };
    };
    const at = await run.ensure(k, inputsAt);

    const out: Record<string, unknown> = {};
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
      const cam = (ctx.in.camera as CameraValue | null) ?? defaultCamera({ turn: p.viewTurn, tilt: p.viewTilt, distance: p.viewDistance });
      const draw = bodies.map((spec, i) => {
        const b = run.body(at, i)!;
        return { spec, pos: b.pos, rot: b.rot, asleep: b.asleep };
      });
      const px = drawPhysics(draw, world, cam, w, h);
      out.image = ctx.gpu.upload(px, w, h, ctx.unitFor(w, h), false);
    }
    return out as never;
  },
});
