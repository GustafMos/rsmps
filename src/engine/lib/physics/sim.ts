/**
 * The simulation driver of the Physics node: a deterministic, per-frame cached run.
 *
 * A node must give the same result for the same frame whenever it is asked, so the run is a pure function of (what the user set, the
 * values on the wires per frame). Frame 0 is the start; frame k is frame k - 1 stepped once with a fixed step (one project frame,
 * cut into `substeps` equal pieces). The result of every frame is kept, so:
 *   - playing forward steps the engine once per frame;
 *   - scrubbing back (or anywhere inside what was already simulated) only looks the frame up, and gives exactly the same numbers;
 *   - jumping ahead steps through the frames in between (their wire values are fetched with `inputsAt`, in order);
 *   - changing anything the sim depends on (a body, the world settings, the structure of what is wired in) is a different signature,
 *     so a different run starts from frame 0. Runs live in a small module-level store (the engine's node cache holds pictures and
 *     small values, not a growing simulation), shared by every node with the same signature, dropped least-recently-used.
 * Wire values are recorded as the run advances (a live Phone Motion wire is therefore a recording of what it said), never re-read for
 * frames that are already done.
 */
import { eulerFromQuat, type Vec3 } from './rotation';
import { MAX_BODIES, type BodySpec, type FrameInputs, type PhysBackend, type PhysWorld, type PushCmd, type WorldSpec } from './types';

/** Frames kept per run (a run longer than this holds its last frame): 16 bodies x 8 numbers x 8 bytes x 12000 = 12 MB. */
export const MAX_RUN_FRAMES = 12000;
const MAX_RUNS = 6;
const SLOT = 8; // px py pz qx qy qz qw asleep

const num = (v: unknown, d: number, lo = -1e6, hi = 1e6): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const vec = (v: unknown, d: Vec3): Vec3 => (Array.isArray(v) ? [num(v[0], d[0]), num(v[1], d[1]), num(v[2], d[2])] : [...d]);

export const DEFAULT_BODY: BodySpec = {
  shape: 'sphere',
  size: [0.5, 1, 1],
  pos: [0, 2, 0],
  rot: [0, 0, 0],
  vel: [0, 0, 0],
  spin: [0, 0, 0],
  mass: 1,
  bounce: 0.5,
  friction: 0.6,
  kind: 'dynamic',
};

/** Clean up the list the inspector stores: unknown fields dropped, numbers clamped, at most `MAX_BODIES` bodies. */
export function normalizeBodies(raw: unknown): BodySpec[] {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_BODIES) : [];
  return list.map((r) => {
    const o = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const shape = o.shape === 'box' || o.shape === 'capsule' || o.shape === 'cylinder' ? o.shape : 'sphere';
    const kind = o.kind === 'fixed' || o.kind === 'kinematic' ? o.kind : 'dynamic';
    const sz = Array.isArray(o.size) ? o.size : [];
    return {
      shape,
      size: [num(sz[0], DEFAULT_BODY.size[0], 0.01, 100), num(sz[1], shape === 'box' ? 1 : 1, 0.01, 100), num(sz[2], 1, 0.01, 100)],
      pos: vec(o.pos, DEFAULT_BODY.pos),
      rot: vec(o.rot, DEFAULT_BODY.rot),
      vel: vec(o.vel, DEFAULT_BODY.vel),
      spin: vec(o.spin, DEFAULT_BODY.spin),
      mass: num(o.mass, 1, 0.001, 100000),
      bounce: num(o.bounce, 0.5, 0, 1.5),
      friction: num(o.friction, 0.6, 0, 5),
      kind,
    } satisfies BodySpec;
  });
}

/** A readable identity of everything the run depends on (the store key). */
export function runSignature(bodies: BodySpec[], world: WorldSpec, wires: string): string {
  return JSON.stringify([bodies, world, wires]);
}

export const noInputs = (bodyCount: number): FrameInputs => ({ gravityDir: null, push: null, pushNow: 0, move: Array(bodyCount).fill(null), turn: Array(bodyCount).fill(null) });

/** One cached simulation. */
export class SimRun {
  /** state of frame k: SLOT numbers per body */
  readonly frames: Float64Array[] = [];
  /** the impact (how hard anything hit) during frame k */
  readonly impact: number[] = [];
  private world: PhysWorld | null;
  private prevPushNow = 0;
  private chain: Promise<unknown> = Promise.resolve();
  lastUse = 0;

  constructor(
    readonly bodies: BodySpec[],
    readonly spec: WorldSpec,
    backend: PhysBackend,
    private pushBody: number,
  ) {
    this.world = backend.create(bodies, spec);
    this.record(0);
  }

  get frontier(): number {
    return this.frames.length - 1;
  }

  private record(impact: number): void {
    const states = this.world ? this.world.read() : [];
    const f = new Float64Array(this.bodies.length * SLOT);
    states.forEach((s, i) => {
      f.set([s.pos[0], s.pos[1], s.pos[2], s.quat[0], s.quat[1], s.quat[2], s.quat[3], s.asleep ? 1 : 0], i * SLOT);
    });
    this.frames.push(f);
    this.impact.push(impact);
  }

  /** Make frame `frame` available (stepping forward as needed). `inputsAt(k)` gives the wire values of frame k; it is asked once per new frame, in order. */
  ensure(frame: number, inputsAt: (k: number) => Promise<FrameInputs> | FrameInputs): Promise<number> {
    const want = Math.max(0, Math.min(MAX_RUN_FRAMES, Math.floor(frame)));
    const job = this.chain.then(async () => {
      while (this.frontier < want && this.world) {
        const k = this.frontier + 1;
        const inp = await inputsAt(k);
        let push: PushCmd | null = null;
        if (inp.pushNow > 0 && this.prevPushNow <= 0 && inp.push) push = { dv: inp.push, body: this.pushBody > 0 ? this.pushBody - 1 : 'all' };
        this.prevPushNow = inp.pushNow;
        this.world.step(inp, push);
        this.record(this.world.lastImpact());
      }
      return Math.min(want, this.frontier);
    });
    this.chain = job.catch(() => undefined);
    return job;
  }

  /** Position, Euler rotation (degrees, the 3D nodes' convention) and sleep flag of body `i` at frame `k` (clamped to what exists). */
  body(k: number, i: number): { pos: Vec3; rot: Vec3; asleep: boolean } | null {
    const f = this.frames[Math.max(0, Math.min(this.frontier, k))];
    if (!f || i < 0 || i >= this.bodies.length) return null;
    const o = i * SLOT;
    return { pos: [f[o], f[o + 1], f[o + 2]], rot: eulerFromQuat([f[o + 3], f[o + 4], f[o + 5], f[o + 6]]), asleep: f[o + 7] === 1 };
  }

  /** How many falling (or moved) bodies are awake at frame `k`. */
  moving(k: number): number {
    const f = this.frames[Math.max(0, Math.min(this.frontier, k))];
    let n = 0;
    this.bodies.forEach((b, i) => {
      if (b.kind !== 'fixed' && f[i * SLOT + 7] !== 1) n++;
    });
    return n;
  }

  free(): void {
    this.world?.free();
    this.world = null;
  }
}

const runs = new Map<string, SimRun>();
let started = 0;

/** How many runs were ever started (a restart shows up as a new one): for tests and diagnostics. */
export function runsStarted(): number {
  return started;
}
let useClock = 0;

/** The run for a signature (made when new). Old runs are freed, least recently used first. */
export function getRun(signature: string, bodies: BodySpec[], spec: WorldSpec, backend: PhysBackend, pushBody: number): SimRun {
  let r = runs.get(signature);
  if (!r) {
    r = new SimRun(bodies, spec, backend, pushBody);
    started++;
    runs.set(signature, r);
    while (runs.size > MAX_RUNS) {
      let oldest: [string, SimRun] | null = null;
      for (const e of runs) if (e !== undefined && e[1] !== r && (!oldest || e[1].lastUse < oldest[1].lastUse)) oldest = e;
      if (!oldest) break;
      oldest[1].free();
      runs.delete(oldest[0]);
    }
  }
  r.lastUse = ++useClock;
  return r;
}

/** Drop every run (tests, and when the engine is reset). */
export function clearRuns(): void {
  for (const r of runs.values()) r.free();
  runs.clear();
}

export function runCount(): number {
  return runs.size;
}
