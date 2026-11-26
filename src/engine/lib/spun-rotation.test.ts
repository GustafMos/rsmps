import { describe, expect, it } from 'vitest';
import { rotationZYX, spunRotation } from './gen-common';

/** Where the object's own Y axis (the spindle of a record lying flat) points after rotation R. */
const spindle = (R: readonly number[]): number[] => [R[1], R[4], R[7]];
/** Where a point on the rim (the object's X axis) is. */
const rim = (R: readonly number[]): number[] => [R[0], R[3], R[6]];

describe('spin around the object’s own axes or the scene’s', () => {
  const tilted = { rotX: 35, rotY: 0, rotZ: 20, spinX: 0, spinY: 1, spinZ: 0 };
  it('own axes: a tilted record turns about its own spindle, which stays where it is', () => {
    const at0 = spindle(spunRotation({ ...tilted, spinAround: 'own' }, 0));
    for (const ph of [0.1, 0.37, 0.5, 0.9]) {
      const R = spunRotation({ ...tilted, spinAround: 'own' }, ph);
      spindle(R).forEach((v, i) => expect(v).toBeCloseTo(at0[i], 9));
    }
    // and it does turn: the rim is on the other side half a loop later
    const a = rim(spunRotation({ ...tilted, spinAround: 'own' }, 0));
    const b = rim(spunRotation({ ...tilted, spinAround: 'own' }, 0.5));
    a.forEach((v, i) => expect(b[i]).toBeCloseTo(-v, 9));
  });
  it('scene axes: the old behaviour exactly, so the tilted spindle swings round', () => {
    const R = spunRotation({ ...tilted, spinAround: 'scene' }, 0.25);
    const old = rotationZYX(35, 90, 20);
    R.forEach((v, i) => expect(v).toBeCloseTo(old[i], 12));
    const s0 = spindle(spunRotation({ ...tilted, spinAround: 'scene' }, 0));
    const s1 = spindle(spunRotation({ ...tilted, spinAround: 'scene' }, 0.25));
    expect(Math.abs(s0[0] - s1[0]) + Math.abs(s0[2] - s1[2])).toBeGreaterThan(0.3);
    // a node saved before the setting existed has no value: it keeps the old behaviour
    const legacy = spunRotation(tilted, 0.25);
    legacy.forEach((v, i) => expect(v).toBeCloseTo(old[i], 12));
  });
  it('both loop: the end of the loop is its start, and without spin both are the set rotation', () => {
    for (const spinAround of ['own', 'scene']) {
      const a = spunRotation({ ...tilted, spinX: 2, spinZ: -1, spinAround }, 0);
      const b = spunRotation({ ...tilted, spinX: 2, spinZ: -1, spinAround }, 1);
      a.forEach((v, i) => expect(b[i]).toBeCloseTo(v, 9));
      const still = spunRotation({ ...tilted, spinY: 0, spinAround }, 0.4);
      rotationZYX(35, 0, 20).forEach((v, i) => expect(still[i]).toBeCloseTo(v, 12));
    }
  });
});
