/**
 * The Physics node's preview picture: bodies, floor and walls as thin lines, seen from a camera. Cheap on purpose: the lines are
 * projected and drawn on the CPU into a small picture (at most 1024 across), then uploaded once. Nothing here is a render of the
 * 3D nodes, just enough to see what the simulation is doing without wiring any object.
 */
import type { CameraValue } from '../../types';
import { cameraBasis, orbitPosition, type V3 } from '../gen-camera';
import { matrixFromQuat, quatFromEuler, type Quat, type Vec3 } from './rotation';
import type { BodySpec, WorldSpec } from './types';

export interface DrawBody {
  spec: BodySpec;
  pos: Vec3;
  rot: Vec3;
  asleep: boolean;
}

export interface ViewOptions {
  turn: number;
  tilt: number;
  distance: number;
}

export function defaultCamera(o: ViewOptions): CameraValue {
  return { kind: 'camera', projection: 'perspective', fov: 40, orthoSize: 8, position: orbitPosition([0, 0, 0], o.distance, o.turn, o.tilt), target: [0, 0, 0], roll: 0, shift: [0, 0] };
}

type Seg = [V3, V3];

const ring = (cx: number, cy: number, cz: number, r: number, axis: 'x' | 'y' | 'z', n = 20, from = 0, to = Math.PI * 2): Seg[] => {
  const out: Seg[] = [];
  const pt = (a: number): V3 => (axis === 'y' ? [cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r] : axis === 'x' ? [cx, cy + Math.cos(a) * r, cz + Math.sin(a) * r] : [cx + Math.cos(a) * r, cy + Math.sin(a) * r, cz]);
  for (let i = 0; i < n; i++) out.push([pt(from + ((to - from) * i) / n), pt(from + ((to - from) * (i + 1)) / n)]);
  return out;
};

/** Lines of one shape in its own frame (y is the long axis of capsules and cylinders). */
export function shapeLines(b: BodySpec): Seg[] {
  const [a, h, c] = b.size;
  switch (b.shape) {
    case 'box': {
      const [x, y, z] = [a / 2, h / 2, c / 2];
      const v: V3[] = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) v.push([sx * x, sy * y, sz * z]);
      const out: Seg[] = [];
      for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) if ((i ^ j) === 1 || (i ^ j) === 2 || (i ^ j) === 4) out.push([v[i], v[j]]);
      return out;
    }
    case 'cylinder': {
      const y = h / 2;
      const out = [...ring(0, y, 0, a, 'y'), ...ring(0, -y, 0, a, 'y')];
      for (const [px, pz] of [[a, 0], [-a, 0], [0, a], [0, -a]]) out.push([[px, -y, pz], [px, y, pz]]);
      return out;
    }
    case 'capsule': {
      const y = h / 2;
      const out = [...ring(0, y, 0, a, 'y'), ...ring(0, -y, 0, a, 'y')];
      for (const [px, pz] of [[a, 0], [-a, 0], [0, a], [0, -a]]) out.push([[px, -y, pz], [px, y, pz]]);
      // caps: half circles in the x-y and z-y planes
      out.push(...ring(0, y, 0, a, 'z', 10, 0, Math.PI), ...ring(0, -y, 0, a, 'z', 10, Math.PI, Math.PI * 2));
      out.push(...ring(0, y, 0, a, 'x', 10, 0, Math.PI), ...ring(0, -y, 0, a, 'x', 10, Math.PI, Math.PI * 2));
      return out;
    }
    default:
      return [...ring(0, 0, 0, a, 'x', 24), ...ring(0, 0, 0, a, 'y', 24), ...ring(0, 0, 0, a, 'z', 24)];
  }
}

/** Where a point of the scene lands in a picture `w` x `h`: [x, y, depth], or null when it is behind the camera. */
export function projector(cam: CameraValue, w: number, h: number): (p: V3) => [number, number, number] | null {
  const bs = cameraBasis(cam);
  const aspect = w / h;
  const short = Math.min(w, h);
  const tanV = Math.tan((Math.min(170, Math.max(5, cam.fov)) * Math.PI) / 360);
  const ortho = cam.projection === 'orthographic';
  return (p) => {
    const r: V3 = [p[0] - bs.position[0], p[1] - bs.position[1], p[2] - bs.position[2]];
    const zc = r[0] * bs.forward[0] + r[1] * bs.forward[1] + r[2] * bs.forward[2];
    const xc = r[0] * bs.right[0] + r[1] * bs.right[1] + r[2] * bs.right[2];
    const yc = r[0] * bs.up[0] + r[1] * bs.up[1] + r[2] * bs.up[2];
    let xs: number;
    let ys: number;
    if (ortho) {
      xs = xc / ((cam.orthoSize / 2) * aspect);
      ys = yc / (cam.orthoSize / 2);
    } else {
      if (zc < 0.05) return null;
      xs = xc / zc / tanV / aspect;
      ys = yc / zc / tanV;
    }
    return [(xs * 0.5 + 0.5) * w + cam.shift[0] * short, (0.5 - ys * 0.5) * h - cam.shift[1] * short, zc];
  };
}

class Canvas {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) this.data.set([18, 20, 26, 255], i * 4);
  }
  dot(x: number, y: number, c: readonly number[], a = 1): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 4;
    for (let k = 0; k < 3; k++) this.data[o + k] = this.data[o + k] * (1 - a) + c[k] * a;
  }
  line(x0: number, y0: number, x1: number, y1: number, c: readonly number[], thick = 1): void {
    const n = Math.min(4000, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= n; i++) {
      const t = n === 0 ? 0 : i / n;
      const x = Math.round(x0 + (x1 - x0) * t);
      const y = Math.round(y0 + (y1 - y0) * t);
      this.dot(x, y, c);
      if (thick > 1) {
        this.dot(x + 1, y, c, 0.5);
        this.dot(x, y + 1, c, 0.5);
      }
    }
  }
}

const COLORS = { dynamic: [255, 170, 80], asleep: [110, 150, 220], fixed: [150, 155, 165], kinematic: [110, 220, 140], grid: [52, 58, 70], wall: [95, 85, 120] } as const;

/** A picture of the sim: RGBA bytes, straight alpha (opaque). */
export function drawPhysics(bodies: DrawBody[], world: WorldSpec, cam: CameraValue, w: number, h: number): Uint8Array {
  const cv = new Canvas(w, h);
  const proj = projector(cam, w, h);
  const draw = (a: V3, b: V3, c: readonly number[], thick = 1) => {
    const pa = proj(a);
    const pb = proj(b);
    if (pa && pb) cv.line(pa[0], pa[1], pb[0], pb[1], c, thick);
  };
  const fy = world.floorHeight;
  if (world.floor) {
    const half = world.walls ? Math.max(world.roomWidth, world.roomDepth) / 2 : 6;
    for (let i = -Math.floor(half); i <= Math.floor(half); i++) {
      draw([i, fy, -half], [i, fy, half], COLORS.grid);
      draw([-half, fy, i], [half, fy, i], COLORS.grid);
    }
  }
  if (world.walls) {
    const [hw, hd] = [world.roomWidth / 2, world.roomDepth / 2];
    const top = fy + 3;
    const pts: V3[] = [[-hw, fy, -hd], [hw, fy, -hd], [hw, fy, hd], [-hw, fy, hd]];
    for (let i = 0; i < 4; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % 4];
      draw(a, b, COLORS.wall);
      draw([a[0], top, a[2]], [b[0], top, b[2]], COLORS.wall);
      draw(a, [a[0], top, a[2]], COLORS.wall);
    }
  }
  for (const b of bodies) {
    const q: Quat = quatFromEuler(b.rot[0], b.rot[1], b.rot[2]);
    const m = matrixFromQuat(q);
    const c = b.spec.kind === 'fixed' ? COLORS.fixed : b.spec.kind === 'kinematic' ? COLORS.kinematic : b.asleep ? COLORS.asleep : COLORS.dynamic;
    const place = (p: V3): V3 => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + b.pos[0], m[3] * p[0] + m[4] * p[1] + m[5] * p[2] + b.pos[1], m[6] * p[0] + m[7] * p[1] + m[8] * p[2] + b.pos[2]];
    for (const [s, e] of shapeLines(b.spec)) draw(place(s), place(e), c, 2);
    // a small shadow dot on the floor under the body helps to read its height
    if (world.floor) {
      const ps = proj([b.pos[0], fy, b.pos[2]]);
      if (ps) cv.dot(Math.round(ps[0]), Math.round(ps[1]), COLORS.grid, 1);
    }
  }
  return cv.data;
}
