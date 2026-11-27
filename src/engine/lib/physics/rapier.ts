/**
 * The physics engine behind the Physics node: Rapier 3D, the deterministic build (`@dimforge/rapier3d-deterministic-compat` 0.21.0,
 * Apache-2.0, Rust compiled to WebAssembly, ~3.1 MB of WASM embedded in the JS file so no separate download or loader is needed).
 * The deterministic build gives bit-identical results on every machine, which exports and scrubbing rely on.
 *
 * Loaded lazily with a dynamic import, once, only when a Physics node renders: the module is its own chunk in the app build.
 * Everything outside this file talks to the `PhysBackend` interface (types.ts), so another engine could replace it.
 */
import type * as RapierNS from '@dimforge/rapier3d-deterministic-compat';
import { quatFromEuler, type Quat, type Vec3 } from './rotation';
import type { BodySpec, BodyState, FrameInputs, PhysBackend, PhysWorld, PushCmd, WorldSpec } from './types';

type Rapier = typeof RapierNS;

let loading: Promise<Rapier> | null = null;

/** Load and initialise the engine once (shared by every node and every world). */
export function loadRapier(): Promise<Rapier> {
  if (!loading) {
    loading = import('@dimforge/rapier3d-deterministic-compat').then(async (m) => {
      const R = ((m as unknown as { default?: Rapier }).default ?? m) as Rapier;
      await R.init();
      return R;
    });
    loading.catch(() => {
      loading = null; // a failed load may be tried again
    });
  }
  return loading;
}

const D2R = Math.PI / 180;
const FLOOR_HALF = 400;
const FLOOR_THICK = 5;
const WALL_HEIGHT = 60;

export function makeRapierBackend(R: Rapier): PhysBackend {
  return {
    name: 'rapier3d-deterministic-compat',
    create(bodies: BodySpec[], spec: WorldSpec): PhysWorld {
      return new RapierWorld(R, bodies, spec);
    },
  };
}

class RapierWorld implements PhysWorld {
  private world: RapierNS.World;
  private rb: RapierNS.RigidBody[] = [];
  private kinds: BodySpec['kind'][];
  private prevTarget: Vec3[];
  private impact = 0;
  private readonly g: Vec3;

  constructor(
    private R: Rapier,
    private specs: BodySpec[],
    private spec: WorldSpec,
  ) {
    this.g = [...spec.gravity];
    this.world = new R.World({ x: spec.gravity[0], y: spec.gravity[1], z: spec.gravity[2] });
    this.kinds = specs.map((b) => b.kind);
    this.prevTarget = specs.map((b) => [...b.pos] as Vec3);
    const dt = (spec.timeScale / Math.max(1, spec.fps)) / Math.max(1, spec.substeps);
    this.world.timestep = dt;
    for (const b of specs) this.rb.push(this.addBody(b));
    this.addStatics();
  }

  private addBody(b: BodySpec): RapierNS.RigidBody {
    const R = this.R;
    const q = quatFromEuler(b.rot[0], b.rot[1], b.rot[2]);
    let desc = b.kind === 'fixed' ? R.RigidBodyDesc.fixed() : b.kind === 'kinematic' ? R.RigidBodyDesc.kinematicPositionBased() : R.RigidBodyDesc.dynamic();
    desc = desc.setTranslation(b.pos[0], b.pos[1], b.pos[2]).setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
    if (b.kind === 'dynamic') {
      desc = desc.setLinvel(b.vel[0], b.vel[1], b.vel[2]).setAngvel({ x: b.spin[0] * D2R, y: b.spin[1] * D2R, z: b.spin[2] * D2R }).setCcdEnabled(true).setLinearDamping(this.spec.damping).setAngularDamping(this.spec.damping * 2);
    }
    const body = this.world.createRigidBody(desc);
    let cd: RapierNS.ColliderDesc;
    const [a, h, c] = b.size;
    switch (b.shape) {
      case 'box':
        cd = R.ColliderDesc.cuboid(a / 2, h / 2, c / 2);
        break;
      case 'capsule':
        cd = R.ColliderDesc.capsule(h / 2, a);
        break;
      case 'cylinder':
        cd = R.ColliderDesc.cylinder(h / 2, a);
        break;
      default:
        cd = R.ColliderDesc.ball(a);
    }
    cd = cd.setRestitution(b.bounce).setFriction(b.friction);
    if (b.kind === 'dynamic') cd = cd.setMass(Math.max(0.0001, b.mass));
    this.world.createCollider(cd, body);
    return body;
  }

  private addStatics(): void {
    const R = this.R;
    const s = this.spec;
    const solid = (hx: number, hy: number, hz: number, x: number, y: number, z: number) => {
      const cd = R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z).setRestitution(s.floorBounce).setFriction(s.floorFriction);
      this.world.createCollider(cd);
    };
    if (s.floor) solid(FLOOR_HALF, FLOOR_THICK, FLOOR_HALF, 0, s.floorHeight - FLOOR_THICK, 0);
    if (s.walls) {
      const [hw, hd] = [s.roomWidth / 2, s.roomDepth / 2];
      const y = s.floorHeight + WALL_HEIGHT / 2;
      solid(1, WALL_HEIGHT / 2, hd + 2, hw + 1, y, 0);
      solid(1, WALL_HEIGHT / 2, hd + 2, -hw - 1, y, 0);
      solid(hw + 2, WALL_HEIGHT / 2, 1, 0, y, hd + 1);
      solid(hw + 2, WALL_HEIGHT / 2, 1, 0, y, -hd - 1);
    }
  }

  step(inp: FrameInputs, push: PushCmd | null): void {
    const w = this.world;
    const n = Math.max(1, Math.round(this.spec.substeps));
    const g = this.g;
    if (inp.gravityDir) {
      const m = Math.hypot(...inp.gravityDir);
      const mag = Math.hypot(...this.spec.gravity);
      if (m > 1e-9) {
        g[0] = (inp.gravityDir[0] / m) * mag;
        g[1] = (inp.gravityDir[1] / m) * mag;
        g[2] = (inp.gravityDir[2] / m) * mag;
      }
    } else {
      g[0] = this.spec.gravity[0];
      g[1] = this.spec.gravity[1];
      g[2] = this.spec.gravity[2];
    }
    w.gravity = { x: g[0], y: g[1], z: g[2] };
    const before = this.rb.map((b, i) => (this.kinds[i] === 'dynamic' ? b.linvel() : null));
    const wasSleeping = this.rb.map((b) => b.isSleeping());
    if (push) {
      this.rb.forEach((b, i) => {
        if (this.kinds[i] !== 'dynamic') return;
        if (push.body !== 'all' && push.body !== i) return;
        const m = b.mass();
        b.applyImpulse({ x: push.dv[0] * m, y: push.dv[1] * m, z: push.dv[2] * m }, true);
      });
    }
    // kinematic bodies glide to their targets over the substeps, so the engine sees a velocity and can shove things
    const target = this.rb.map((_, i) => {
      if (this.kinds[i] !== 'kinematic') return null;
      const m = inp.move[i];
      return m ? ([m[0], m[1], m[2]] as Vec3) : this.prevTarget[i];
    });
    const turn = this.rb.map((_, i) => (this.kinds[i] === 'kinematic' && inp.turn[i] ? (inp.turn[i] as Vec3) : null));
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      this.rb.forEach((b, i) => {
        const tg = target[i];
        if (!tg) return;
        const p0 = this.prevTarget[i];
        b.setNextKinematicTranslation({ x: p0[0] + (tg[0] - p0[0]) * t, y: p0[1] + (tg[1] - p0[1]) * t, z: p0[2] + (tg[2] - p0[2]) * t });
        const tr = turn[i];
        if (tr) {
          const q: Quat = quatFromEuler(tr[0], tr[1], tr[2]);
          b.setNextKinematicRotation({ x: q[0], y: q[1], z: q[2], w: q[3] });
        }
      });
      w.step();
    }
    this.rb.forEach((_, i) => {
      const tg = target[i];
      if (tg) this.prevTarget[i] = tg;
    });
    let hit = 0;
    this.rb.forEach((b, i) => {
      const v0 = before[i];
      if (!v0 || wasSleeping[i]) return;
      const v1 = b.linvel();
      const dt = this.spec.timeScale / Math.max(1, this.spec.fps);
      const dv = Math.hypot(v1.x - v0.x - g[0] * dt, v1.y - v0.y - g[1] * dt, v1.z - v0.z - g[2] * dt);
      if (dv > hit) hit = dv;
    });
    this.impact = hit;
  }

  read(): BodyState[] {
    return this.rb.map((b) => {
      const t = b.translation();
      const r = b.rotation();
      return { pos: [t.x, t.y, t.z], quat: [r.x, r.y, r.z, r.w], asleep: b.isSleeping() };
    });
  }

  lastImpact(): number {
    return this.impact;
  }

  free(): void {
    this.world.free();
  }
}


let backend: Promise<PhysBackend> | null = null;

/** The shared backend (loads the engine on first use). */
export function rapierBackend(): Promise<PhysBackend> {
  if (!backend) backend = loadRapier().then(makeRapierBackend);
  backend.catch(() => {
    backend = null;
  });
  return backend;
}
