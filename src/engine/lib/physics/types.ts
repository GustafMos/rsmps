/** Shared shapes of the physics node: what the user describes, and the small interface any engine behind it implements. */
import type { Vec3 } from './rotation';

export type BodyShape = 'sphere' | 'box' | 'capsule' | 'cylinder';
export type BodyKind = 'dynamic' | 'fixed' | 'kinematic';

/**
 * One body as the user describes it. Sizes are in scene units and match what the 3D nodes draw:
 *   sphere: radius        = [r]          (SDF Shape: Radius)
 *   box: full sizes       = [w, h, d]    (SDF Shape: Width, Height, Depth)
 *   capsule, cylinder     = [r, h]       (SDF Shape: Radius and Height; the capsule's height is the straight part, the round caps come on top)
 */
export interface BodySpec {
  shape: BodyShape;
  size: [number, number, number];
  pos: Vec3;
  /** Degrees, the 3D nodes' convention (Rz * Ry * Rx). */
  rot: Vec3;
  vel: Vec3;
  /** Degrees per second about the scene's x, y, z. */
  spin: Vec3;
  mass: number;
  bounce: number;
  friction: number;
  kind: BodyKind;
}

export interface WorldSpec {
  /** Scene units per second squared. */
  gravity: Vec3;
  floor: boolean;
  floorHeight: number;
  floorBounce: number;
  floorFriction: number;
  walls: boolean;
  /** Full width (x) and depth (z) of the walled box, centred on the origin. */
  roomWidth: number;
  roomDepth: number;
  /** Slows moving and spinning bodies (air, rolling resistance). 0 = none. */
  damping: number;
  /** Simulated time per project time. */
  timeScale: number;
  substeps: number;
  fps: number;
}

/** Per-frame values that can change while the sim runs. They are recorded as the sim advances. */
export interface FrameInputs {
  /** Gravity direction override (any length; null = the world's own). */
  gravityDir: Vec3 | null;
  push: Vec3 | null;
  /** Impulse is applied on the frame this rises above 0. */
  pushNow: number;
  /** Per body (index 0..): where a kinematic body is moved to / how it is turned (degrees). null = not wired. */
  move: (Vec3 | null)[];
  turn: (Vec3 | null)[];
}

/** What a stepped world reports for one body. */
export interface BodyState {
  pos: Vec3;
  quat: [number, number, number, number];
  asleep: boolean;
}

/** One body's push: velocity change applied at once (`all` = every falling body, else the 0-based index). */
export interface PushCmd {
  dv: Vec3;
  body: number | 'all';
}

/** The engine behind the node. Rapier today; anything with these methods can replace it. */
export interface PhysWorld {
  /** Advance by one project frame (several fixed substeps). */
  step(inputs: FrameInputs, push: PushCmd | null): void;
  read(): BodyState[];
  /** The hardest sudden speed change of any body during the last step, with gravity taken out: how hard something hit. */
  lastImpact(): number;
  free(): void;
}

export interface PhysBackend {
  name: string;
  create(bodies: BodySpec[], world: WorldSpec): PhysWorld;
}

export const MAX_BODIES = 16;
