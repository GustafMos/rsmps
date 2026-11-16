/**
 * Synthetic splat clouds for tests, benchmarks and demos (no sample files are downloaded). Deterministic: the same seed gives the same cloud.
 */
import { finishCloud, type SplatCloud } from './splat-cloud';

export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return ([[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]] as [number, number, number][])[((i % 6) + 6) % 6];
}

/** Quaternion (w, x, y, z) of the rotation whose columns are the orthonormal vectors u (tangent), v (bitangent), n (normal). */
function quatFromBasis(u: number[], v: number[], n: number[]): [number, number, number, number] {
  const m00 = u[0], m10 = u[1], m20 = u[2], m01 = v[0], m11 = v[1], m21 = v[2], m02 = n[0], m12 = n[1], m22 = n[2];
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
  }
  const l = Math.hypot(w, x, y, z);
  return [w / l, x / l, y / l, z / l];
}

const norm = (a: number[]): number[] => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: number[], b: number[]): number[] => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

interface Builder {
  cloud(n: number): { set(i: number, p: number[], s: number[], q: number[], rgb: number[], o: number): void; done(up: '+y' | '-y' | '+z' | null): SplatCloud };
}
function builder(): Builder {
  return {
    cloud(n) {
      const positions = new Float32Array(n * 3), scales = new Float32Array(n * 3), rotations = new Float32Array(n * 4), colors = new Float32Array(n * 3), opacity = new Float32Array(n);
      return {
        set(i, p, s, q, rgb, o) {
          positions.set(p, i * 3); scales.set(s, i * 3); rotations.set(q, i * 4); colors.set(rgb, i * 3); opacity[i] = o;
        },
        done: (up) => finishCloud({ count: n, positions, scales, rotations, colors, opacity, upHint: up }, 'generated'),
      };
    },
  };
}

/** A torus (major radius R, minor r) of `n` flat splats lying on its surface, hue running round the ring. Y-up, around the origin. */
export function torusCloud(n: number, seed = 1, R = 0.7, r = 0.28): SplatCloud {
  const rand = rng(seed);
  const b = builder().cloud(n);
  const spacing = Math.sqrt((4 * Math.PI * Math.PI * R * r) / n);
  for (let i = 0; i < n; i++) {
    const u = rand() * Math.PI * 2;
    const v = rand() * Math.PI * 2;
    const p = [(R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u)];
    const nrm = [Math.cos(v) * Math.cos(u), Math.sin(v), Math.cos(v) * Math.sin(u)];
    const tu = [-Math.sin(u), 0, Math.cos(u)];
    const tv = cross(nrm, tu);
    const q = quatFromBasis(tu, tv, nrm);
    const sc = spacing * (0.55 + 0.25 * rand());
    const stripe = 0.85 + 0.15 * Math.sin(v * 3);
    const col = hsv(u / (Math.PI * 2), 0.65, stripe);
    b.set(i, p, [sc, sc, sc * 0.18], q, col, 0.9);
  }
  return b.done('+y');
}

/** A hilly terrain (a square of side 2 centred on the origin, heights up to about 0.35) of `n` flat splats, green to white by height. */
export function terrainCloud(n: number, seed = 2, yDown = false): SplatCloud {
  const rand = rng(seed);
  const b = builder().cloud(n);
  const h = (x: number, z: number) => 0.18 * Math.sin(x * 3.1) * Math.cos(z * 2.3) + 0.12 * Math.sin(x * 7.3 + z * 5.1) + 0.05 * Math.sin(z * 13);
  const spacing = Math.sqrt(4 / n);
  const e = 0.01;
  for (let i = 0; i < n; i++) {
    const x = rand() * 2 - 1;
    const z = rand() * 2 - 1;
    const y = h(x, z);
    const nrm = norm([-(h(x + e, z) - h(x - e, z)) / (2 * e), 1, -(h(x, z + e) - h(x, z - e)) / (2 * e)]);
    const tu = norm(cross([0, 0, 1], nrm));
    const tv = cross(nrm, tu);
    const q = quatFromBasis(tu, tv, nrm);
    const t = Math.min(1, Math.max(0, (y + 0.3) / 0.6));
    const col = t > 0.75 ? [0.9, 0.92, 0.95] : [0.15 + 0.5 * t, 0.45 + 0.4 * t, 0.15 + 0.1 * t];
    const sc = spacing * (0.55 + 0.3 * rand());
    const p = yDown ? [x, -y, z] : [x, y, z];
    const qq: [number, number, number, number] = q;
    if (yDown) {
      // mirror y: the rotation basis is mirrored too (thin axis stays the normal): flip tangent's y by rebuilding from mirrored vectors
      const m = (v: number[]) => [v[0], -v[1], v[2]];
      const nq = quatFromBasis(m(tu), m(tv), m(nrm).map((c) => -c));
      b.set(i, p, [sc, sc, sc * 0.18], nq, col, 0.92);
    } else b.set(i, p, [sc, sc, sc * 0.18], qq, col, 0.92);
  }
  return b.done(yDown ? '-y' : '+y');
}

/** A few explicit splats (tests). Rotation defaults to identity. */
export function manualCloud(items: { p: [number, number, number]; s: [number, number, number]; rgb: [number, number, number]; o: number; q?: [number, number, number, number] }[]): SplatCloud {
  const b = builder().cloud(items.length);
  items.forEach((it, i) => b.set(i, it.p, it.s, it.q ?? [1, 0, 0, 0], it.rgb, it.o));
  return b.done(null);
}

/** A rotation about an axis as (w, x, y, z). */
export function quatAxisAngle(axis: [number, number, number], rad: number): [number, number, number, number] {
  const a = norm(axis);
  const s = Math.sin(rad / 2);
  return [Math.cos(rad / 2), a[0] * s, a[1] * s, a[2] * s];
}

/** Uniform random splats in a ball (benchmarks: depth complexity is high, colours random). */
export function ballCloud(n: number, seed = 3, radius = 1): SplatCloud {
  const rand = rng(seed);
  const b = builder().cloud(n);
  const sc = radius * Math.cbrt(1 / n) * 0.9;
  for (let i = 0; i < n; i++) {
    let x, y, z;
    do {
      x = rand() * 2 - 1; y = rand() * 2 - 1; z = rand() * 2 - 1;
    } while (x * x + y * y + z * z > 1);
    b.set(i, [x * radius, y * radius, z * radius], [sc, sc * (0.5 + rand()), sc * 0.5], [1, 0, 0, 0], [rand(), rand(), rand()], 0.2 + 0.7 * rand());
  }
  return b.done('+y');
}
