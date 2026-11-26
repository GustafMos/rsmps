import { describe, expect, it } from 'vitest';
import {
  HYPERCUBE_MOTIONS,
  eyeFactor,
  hypercubeEdges,
  hypercubeFaces,
  hypercubePoints,
  hypercubeVertices,
  loopExtent,
  planeCycles,
  projectND,
  projectedBound,
  quadToUnit,
  rotateND,
  rotationPlanes,
} from './hypercube';

const motion = (m: string, speed = 1) => ({ motion: m, speed, turn: 1, tumble: 2, fold4: 3, fold5: 4, fold6: 5 });

describe('hypercube maths', () => {
  it('counts corners, edges, faces and planes', () => {
    for (const n of [3, 4, 5, 6]) {
      expect(hypercubeVertices(n)).toHaveLength(2 ** n);
      expect(hypercubeEdges(n)).toHaveLength(n * 2 ** (n - 1));
      expect(hypercubeFaces(n)).toHaveLength(((n * (n - 1)) / 2) * 2 ** (n - 2));
      expect(rotationPlanes(n)).toHaveLength((n * (n - 1)) / 2);
    }
    expect(hypercubeEdges(5)).toHaveLength(80);
    expect(hypercubeEdges(6)).toHaveLength(192);
  });

  it('joins corners that differ on exactly the edge axis', () => {
    const v = hypercubeVertices(5);
    for (const [a, b, axis] of hypercubeEdges(5)) {
      const differing = v[a].map((c, k) => (c !== v[b][k] ? k : -1)).filter((k) => k >= 0);
      expect(differing).toEqual([axis]);
    }
  });

  it('faces are flat squares: four corners that differ on two axes only', () => {
    const v = hypercubeVertices(4);
    for (const [c, a, b] of hypercubeFaces(4)) {
      for (let k = 0; k < 4; k++) {
        const p = v[c[k]];
        const q = v[c[(k + 1) % 4]];
        const differing = p.map((x, i) => (x !== q[i] ? i : -1)).filter((i) => i >= 0);
        expect(differing).toHaveLength(1);
        expect([a, b]).toContain(differing[0]);
      }
    }
  });

  it('turning keeps every length', () => {
    const planes = rotationPlanes(6);
    const angles = planes.map((_, k) => 0.37 * (k + 1));
    for (const v of hypercubeVertices(6)) {
      const r = rotateND(v, planes, angles);
      expect(Math.hypot(...r)).toBeCloseTo(Math.sqrt(6), 10);
    }
    // and it really moves things
    expect(rotateND([1, 0, 0], rotationPlanes(3), [Math.PI / 2, 0, 0])[1]).toBeCloseTo(1, 10);
  });

  it('a plain cube seen straight on is a square inside a square', () => {
    const depth = 0.5;
    const pts = hypercubeVertices(3).map((v) => ({ v, p: projectND(v, depth) }));
    const q = eyeFactor(depth) * Math.sqrt(3);
    const near = q / (q - 1);
    const far = q / (q + 1);
    expect(near).toBeGreaterThan(far);
    for (const { v, p } of pts) {
      const f = v[2] > 0 ? near : far;
      expect(p.x).toBeCloseTo(v[0] * f, 10);
      expect(p.y).toBeCloseTo(v[1] * f, 10);
      expect(p.scale).toBeCloseTo(f, 10);
      expect(Math.sign(p.z)).toBe(v[2]);
    }
    // no perspective: both squares coincide
    for (const v of hypercubeVertices(3)) expect(projectND(v, 0).x).toBe(v[0]);
  });

  it('never flattens a point beyond the stated bound', () => {
    for (const n of [3, 4, 5, 6]) {
      const planes = rotationPlanes(n);
      const bound = projectedBound(n, 0.8);
      for (let s = 0; s < 40; s++) {
        const angles = planes.map((_, k) => s * 0.61 + k * 1.3);
        for (const v of hypercubeVertices(n)) {
          const p = projectND(rotateND(v, planes, angles), 0.8);
          expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(bound + 1e-9);
        }
      }
    }
  });

  it('every motion is made of whole turns, and Speed multiplies them', () => {
    for (const name of Object.keys(HYPERCUBE_MOTIONS)) {
      for (const n of [3, 4, 5, 6]) {
        const c = planeCycles(n, motion(name));
        expect(c).toHaveLength(rotationPlanes(n).length);
        expect(c.every((x) => Number.isInteger(x))).toBe(true);
        expect(planeCycles(n, motion(name, 3))).toEqual(c.map((x) => x * 3));
        // nothing stands still unless asked to
        expect(c.some((x) => x !== 0)).toBe(true);
      }
    }
    expect(planeCycles(5, motion('tumble', 0)).every((x) => x === 0)).toBe(true);
  });

  it('the end of the loop is the start, exactly', () => {
    for (const n of [3, 4, 5, 6]) {
      const pose = { n, cycles: planeCycles(n, motion('chaos', 2)), tilt: 0.3, turn: 0.4, fold: 0.35, depth: 0.4 };
      expect(hypercubePoints({ ...pose, phase: 1 })).toEqual(hypercubePoints({ ...pose, phase: 0 }));
      // and the middle of the loop is somewhere else
      expect(hypercubePoints({ ...pose, phase: 0.37 })).not.toEqual(hypercubePoints({ ...pose, phase: 0 }));
    }
  });

  it('measures the largest size over the loop', () => {
    const pose = { n: 5, cycles: planeCycles(5, motion('tumble')), tilt: 0.3, turn: 0.4, fold: 0.35, depth: 0.4 };
    const extent = loopExtent(pose);
    for (let s = 0; s < 500; s++) {
      for (const p of hypercubePoints({ ...pose, phase: s / 500 })) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(extent);
    }
    expect(extent).toBeLessThanOrEqual(projectedBound(5, 0.4) * 1.02);
  });

  it('finds the place on a face seen in perspective', () => {
    // a square leaning away: its top edge is shorter
    const quad: [number, number][] = [[-0.5, -1], [0.5, -1], [1, 1], [-1, 1]];
    const m = quadToUnit(quad)!;
    const at = (x: number, y: number) => {
      const w = m[6] * x + m[7] * y + m[8];
      return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w, w];
    };
    const want = [[0, 0], [1, 0], [1, 1], [0, 1]];
    quad.forEach(([x, y], k) => {
      const [u, v, w] = at(x, y);
      expect(u).toBeCloseTo(want[k][0], 9);
      expect(v).toBeCloseTo(want[k][1], 9);
      expect(w).toBeGreaterThan(0);
    });
    // where the diagonals cross is the middle of the picture
    const [u, v] = at(0, -1 / 3);
    expect(u).toBeCloseTo(0.5, 9);
    expect(v).toBeCloseTo(0.5, 9);
    // a face seen edge-on has no inside
    expect(quadToUnit([[0, 0], [1, 0], [1, 0], [0, 0]])).toBeNull();
  });
});
