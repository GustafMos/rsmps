import { describe, expect, it } from 'vitest';
import type { Vec3 } from './motion-math';
import { qAxisAngle } from './motion-math';
import {
  CELL_TARGET,
  PoseHistory,
  angleToDir,
  buildDomeMesh,
  cellCenterDir,
  coverageOf,
  dirToCell,
  guidanceFor,
  isAimed,
  isNewViewpoint,
  isTooBlurry,
  laplacianVariance,
  lookAtQuat,
  qualitySummary,
  reachableRows,
  sharpnessFromVariance,
  shotCell,
} from './scan-coverage';
import { DEFAULT_GRID, decodeDepth, emptyScan, encodeDepth, intrinsicsFromProjection, normalizeScan, projectToShot, shrinkDepth, stillSize, type ScanData, type ScanShot } from './scan-data';
import { lensFromFov, lensOf, mat4Mul, projectionMatrix, viewMatrix } from './xr-math';

const UP: Vec3 = [0, 1, 0];
const CENTER: Vec3 = [0, 0.3, -2];
const GRID = { ...DEFAULT_GRID };
const TARGET = { center: CENTER, radius: 0.5, up: UP, h: 0.3 };

/** A shot on the dome at azimuth az (deg) / elevation el (deg), `dist` metres from the centre, looking at it. */
function shotAt(az: number, el: number, dist = 1.2, aim: Vec3 = CENTER): ScanShot {
  const d = angleToDir((az * Math.PI) / 180, el, UP);
  const pos: Vec3 = [CENTER[0] + d[0] * dist, CENTER[1] + d[1] * dist, CENTER[2] + d[2] * dist];
  const quat = lookAtQuat(pos, aim);
  const m = projectionMatrix(lensFromFov(60, 0.75));
  return { asset: `a${az}_${el}`, t: 0, pos, quat, w: 1440, h: 1920, ...intrinsicsFromProjection(m, 1440, 1920), sharp: 0.8 };
}
const scanOf = (shots: ScanShot[], target = TARGET): ScanData => ({ v: 1, units: 'm', target, grid: GRID, shots });
const ring = (el: number, n: number, dist = 1.2): ScanShot[] => Array.from({ length: n }, (_, i) => shotAt((i * 360) / n + 3, el, dist));

describe('scan data', () => {
  it('normalises anything stored: bad photos dropped, numbers clamped, quaternion and up normalised', () => {
    expect(normalizeScan(null)).toEqual(emptyScan());
    expect(normalizeScan({ v: 2 })).toEqual(emptyScan());
    const good = shotAt(10, 20);
    const n = normalizeScan({ v: 1, target: { center: [1, 2, 3], radius: 99, up: [0, 5, 0] }, grid: { az: 24.4, el: 6 }, shots: [good, { ...good, asset: '' }, { ...good, pos: [0, NaN, 0] }, { ...good, w: 0 }, { ...good, quat: [0, 0, 0, 2] }, 7] });
    expect(n.target.radius).toBe(5);
    expect(n.target.up).toEqual([0, 1, 0]);
    expect(n.grid.az).toBe(24);
    expect(n.shots.length).toBe(2);
    expect(n.shots[1].quat).toEqual([0, 0, 0, 1]);
  });
  it('still size: longer side capped at 1920, never scaled up', () => {
    expect(stillSize(4000, 3000)).toEqual({ w: 1920, h: 1440 });
    expect(stillSize(1080, 1920)).toEqual({ w: 1080, h: 1920 });
    expect(stillSize(640, 480)).toEqual({ w: 640, h: 480 });
  });
  it('intrinsics from a known projection: a known world point reprojects to the same pixel the XR projection gives', () => {
    // an asymmetric lens (principal point off the middle) and a camera that is both moved and turned
    const lens: [number, number, number, number] = [1.9, 1.07, 0.04, -0.06];
    const proj = projectionMatrix(lens);
    const pos: Vec3 = [0.4, 1.3, 0.2];
    const quat = lookAtQuat(pos, [0.1, 0.4, -2]);
    const w = 1280;
    const h = 720; // any picture size: the numbers scale with it
    const k = intrinsicsFromProjection(proj, w, h);
    const view = viewMatrix({ p: pos, q: quat });
    const vp = mat4Mul(proj, view);
    for (const pt of [[0, 0.3, -2], [0.3, 0.5, -2.5], [-0.2, 0.1, -1.5], [0.5, 1, -3]] as Vec3[]) {
      const clip = [0, 1, 2, 3].map((r) => vp[r] * pt[0] + vp[4 + r] * pt[1] + vp[8 + r] * pt[2] + vp[12 + r]);
      const ndc = [clip[0] / clip[3], clip[1] / clip[3]];
      const expected = [((ndc[0] + 1) / 2) * w, ((1 - ndc[1]) / 2) * h];
      const got = projectToShot({ pos, quat, ...k }, pt)!;
      expect(got[0]).toBeCloseTo(expected[0], 3);
      expect(got[1]).toBeCloseTo(expected[1], 3);
    }
    expect(projectToShot({ pos, quat, ...k }, [pos[0], pos[1], pos[2] + 5])).toBeNull(); // behind the camera
    // the principal point offset shows in cx, cy
    expect(k.cx).toBeCloseTo(((1 - 0.04) * w) / 2, 4);
    expect(k.cy).toBeCloseTo(((1 - 0.06) * h) / 2, 4);
    expect(Array.from(lensOf(proj))).toEqual(Array.from(lens).map((v) => Math.fround(v)));
  });
  it('depth maps survive the compact text and shrink to a small size', () => {
    const data = new Uint16Array(160 * 90).map((_, i) => (i * 37) % 65535);
    const big = { width: 160, height: 90, rawValueToMeters: 0.001, normDepthBufferFromNormView: Array.from({ length: 16 }, (_, i) => i / 10), data };
    const small = shrinkDepth(big);
    expect(Math.max(small.width, small.height)).toBe(48);
    const back = decodeDepth(encodeDepth(small))!;
    expect(back.width).toBe(small.width);
    expect(back.rawValueToMeters).toBe(0.001);
    expect(Array.from(back.data)).toEqual(Array.from(small.data));
    expect(back.normDepthBufferFromNormView[3]).toBeCloseTo(0.3, 9);
    expect(decodeDepth('nonsense')).toBeNull();
    expect(encodeDepth(small).length).toBeLessThan(6000);
  });
});

describe('the dome and the cells', () => {
  it('maps directions to cells: azimuth around up, elevation rows from just below the horizon to the top', () => {
    expect(dirToCell(angleToDir(0.01, 0, UP), UP, GRID)).toEqual({ col: 0, row: 0 });
    expect(dirToCell(angleToDir(Math.PI + 0.01, 30, UP), UP, GRID)).toEqual({ col: 12, row: 2 });
    expect(dirToCell(UP, UP, GRID)!.row).toBe(5);
    expect(dirToCell(angleToDir(1, -30, UP), UP, GRID)).toBeNull(); // below the dome
    // every cell centre maps back to its own cell
    for (let row = 0; row < GRID.el; row++) for (let col = 0; col < GRID.az; col++) expect(dirToCell(cellCenterDir({ col, row }, UP, GRID), UP, GRID)).toEqual({ col, row });
    // a tilted up (a wall): still a bijection
    const wall: Vec3 = [0, 0, 1];
    expect(dirToCell(cellCenterDir({ col: 5, row: 3 }, wall, GRID), wall, GRID)).toEqual({ col: 5, row: 3 });
  });
  it('a shot counts only when it aims at the target and is at a sane distance', () => {
    expect(shotCell(shotAt(100, 20), TARGET, GRID)).not.toBeNull();
    expect(shotCell(shotAt(100, 20, 0.2), TARGET, GRID)).toBeNull(); // closer than half a radius
    expect(shotCell(shotAt(100, 20, 2.5), TARGET, GRID)).toBeNull(); // further than four radii
    expect(shotCell(shotAt(100, 20, 1.2, [3, 0.3, -2]), TARGET, GRID)).toBeNull(); // looking away
    expect(shotCell(shotAt(100, -40), TARGET, GRID)).toBeNull(); // from below the dome
    expect(isAimed([0.5, -0.5])).toBe(true);
    expect(isAimed([0.7, 0])).toBe(false);
    expect(isAimed(null)).toBe(false);
  });
  it('coverage: a ring of 24 shots fills one row; reachable rows set the percentage', () => {
    const one = coverageOf(scanOf(ring(15, 24)));
    expect(one.coveredCells).toBe(24);
    expect(one.counted).toBe(24);
    const rows = reachableRows(GRID, TARGET.radius, TARGET.h);
    expect(rows.filter(Boolean).length).toBe(6);
    expect(one.fraction).toBeCloseTo(24 / 144, 9);
    const two = coverageOf(scanOf([...ring(15, 24), ...ring(45, 24)]));
    expect(two.fraction).toBeCloseTo(48 / 144, 9);
  });
  it('low rows that would need the camera under the floor are left out of the percentage', () => {
    expect(reachableRows(GRID, 0.5, -0.5).filter(Boolean).length).toBeLessThan(6);
    expect(reachableRows(GRID, 0.5, null).every(Boolean)).toBe(true); // not on a floor: nothing excluded
    const floor = { ...TARGET, h: -0.5 };
    const r = coverageOf({ target: floor, grid: GRID, shots: [] });
    expect(r.reachableCells).toBeGreaterThan(0);
    expect(r.reachableCells).toBeLessThan(144);
    const all = coverageOf({ target: { ...TARGET, h: undefined }, grid: GRID, shots: [] });
    expect(all.reachableCells).toBe(144);
  });
  it('new viewpoint: not within 10 degrees of a kept shot at a similar distance; a thin cell accepts a closer second', () => {
    const s = shotAt(0, 20);
    const t = { ...TARGET };
    expect(isNewViewpoint(shotAt(5, 20).pos, [s], t, GRID)).toBe(false);
    expect(isNewViewpoint(shotAt(40, 20).pos, [s], t, GRID)).toBe(true);
    expect(isNewViewpoint(shotAt(5, 20, 2.2).pos, [s], t, GRID)).toBe(true); // a different distance is a different view
    // about 8.5 degrees apart: refused in a full cell, accepted in a thin one
    const counts = new Array<number>(144).fill(0);
    const cell = dirToCell(angleToDir(0, 20, UP), UP, GRID)!;
    expect(isNewViewpoint(shotAt(9, 20).pos, [s], t, GRID, counts)).toBe(true);
    counts[cell.row * 24 + cell.col] = CELL_TARGET;
    counts[cell.row * 24 + cell.col + 0] = CELL_TARGET;
    expect(isNewViewpoint(shotAt(9, 20).pos, [s], t, GRID, new Array<number>(144).fill(CELL_TARGET))).toBe(false);
  });
});

describe('steadiness from pose history', () => {
  const walk = (speed: number, turnDegS: number) => {
    const h = new PoseHistory();
    for (let i = 0; i < 12; i++) h.push({ t: i * 33, pos: [(speed * i * 33) / 1000, 1.4, 0], quat: qAxisAngle('y', (turnDegS * i * 33) / 1000) });
    return h;
  };
  it('measures linear and angular speed over the last third of a second', () => {
    const s = walk(0.2, 10).speeds()!;
    expect(s.lin).toBeCloseTo(0.2, 2);
    expect(s.ang).toBeCloseTo(10, 0);
  });
  it('steady under the thresholds, not over them, and unknown before there is history', () => {
    expect(walk(0.2, 10).steady()).toBe(true);
    expect(walk(0.6, 10).steady()).toBe(false);
    expect(walk(0.1, 60).steady()).toBe(false);
    expect(new PoseHistory().steady()).toBe(false);
  });
});

describe('guidance', () => {
  const base = (shots: ScanShot[], o: Partial<Parameters<typeof guidanceFor>[0]> = {}) => ({ steady: true, aimed: true, distance: 1.2, radius: 0.5, report: coverageOf(scanOf(shots)), dir: angleToDir(0.1, 20, UP), up: UP, ...o });
  it('priority: slower, then aim, then distance', () => {
    expect(guidanceFor(base([], { steady: false, aimed: false })).text).toBe('Move slower');
    expect(guidanceFor(base([], { aimed: false })).text).toBe('Aim at the object');
    expect(guidanceFor(base([], { distance: 0.1 })).kind).toBe('closer');
    expect(guidanceFor(base([], { distance: 9 })).kind).toBe('back');
  });
  it('all reachable cells covered: done', () => {
    const shots: ScanShot[] = [];
    for (let row = 0; row < GRID.el; row++) shots.push(...Array.from({ length: GRID.az }, (_, c) => shotAt(((c + 0.5) * 360) / GRID.az, -10 + (row + 0.5) * (100 / GRID.el))));
    expect(coverageOf(scanOf(shots)).fraction).toBe(1);
    expect(guidanceFor(base(shots)).text).toBe('Good: every side is covered. Press Done.');
  });
  it('a missing side to the left or right of the camera, by which cells are nearest', () => {
    const az = (s: ScanShot) => (((Math.atan2(CENTER[2] - s.pos[2], s.pos[0] - CENTER[0]) * 180) / Math.PI) + 360) % 360;
    const rows = [0, 18, 36, 54, 72, 85].flatMap((el) => ring(el, 24)).filter((s) => !(az(s) > 90 && az(s) < 150));
    // the camera at azimuth 60, just before the gap (increasing azimuth = walking to the right): walk right
    expect(guidanceFor(base(rows, { dir: angleToDir((60 * Math.PI) / 180, 20, UP) })).kind).toBe('right');
    expect(guidanceFor(base(rows, { dir: angleToDir((180 * Math.PI) / 180, 20, UP) })).kind).toBe('left');
  });
  it('a missing low or top row: go lower / over the top', () => {
    const noLow = [18, 36, 54, 72, 85].flatMap((el) => ring(el, 24));
    expect(guidanceFor(base(noLow, { dir: angleToDir(1, 40, UP) })).kind).toBe('lower');
    const noTop = [0, 18, 36, 54, 72].flatMap((el) => ring(el, 24));
    expect(guidanceFor(base(noTop, { dir: angleToDir(1, 40, UP) })).text).toBe('Go higher / over the top');
  });
});

describe('blur', () => {
  const grey = (w: number, h: number, f: (x: number, y: number) => number) => Float32Array.from({ length: w * h }, (_, i) => f(i % w, Math.floor(i / w)));
  it('a sharp checker has a high Laplacian variance, a flat or smooth one has none', () => {
    const sharp = laplacianVariance(grey(32, 32, (x, y) => ((x + y) % 2) * 255), 32, 32);
    const smooth = laplacianVariance(grey(32, 32, (x) => x * 2), 32, 32);
    expect(sharp).toBeGreaterThan(1000);
    expect(smooth).toBeLessThan(1);
    expect(sharpnessFromVariance(sharp)).toBeGreaterThan(0.95);
    expect(sharpnessFromVariance(0)).toBe(0);
  });
  it('too blurry means far under the running median; no judgement before a few photos', () => {
    expect(isTooBlurry(0.2, [0.8, 0.8, 0.8])).toBe(false);
    expect(isTooBlurry(0.2, [0.8, 0.85, 0.8, 0.75])).toBe(true);
    expect(isTooBlurry(0.6, [0.8, 0.85, 0.8, 0.75])).toBe(false);
    expect(isTooBlurry(0.01, [])).toBe(true);
  });
});

describe('quality summary and verdict', () => {
  const full = () => {
    const shots: ScanShot[] = [];
    for (const el of [0, 18, 36, 54, 72, 85]) shots.push(...ring(el, 36));
    return shots;
  };
  it('empty', () => expect(qualitySummary(scanOf([])).verdict.level).toBe('empty'));
  it('too few photos names the number to aim for', () => {
    const q = qualitySummary(scanOf(ring(20, 12)));
    expect(q.verdict).toEqual({ level: 'few', text: 'Too few photos: aim for at least 40' });
  });
  it('good: plenty of photos, high coverage, two rings, small gaps', () => {
    const q = qualitySummary(scanOf(full()), 3);
    expect(q.verdict.text).toBe('Good for reconstruction');
    expect(q.coverage).toBeGreaterThan(0.9);
    expect(q.rings).toBeGreaterThanOrEqual(2);
    expect(q.maxGapDeg).toBeLessThanOrEqual(15);
    expect(q.rejected).toBe(3);
    expect(q.medianDistance).toBeCloseTo(1.2, 2);
  });
  it('usable, but a thin side is named', () => {
    // everything except the back (relative to where the scan starts, at azimuth 3)
    const shots = full().filter((s) => {
      const a = (((Math.atan2(CENTER[2] - s.pos[2], s.pos[0] - CENTER[0]) * 180) / Math.PI) + 360) % 360;
      return !(a > 120 && a < 240);
    });
    const q = qualitySummary(scanOf(shots));
    expect(q.verdict.level).toBe('usable');
    expect(q.verdict.text).toMatch(/^Usable, but the back is thin/);
    expect(q.weakest[0]).toBe('the back');
  });
  it('one ring only is flagged', () => {
    const q = qualitySummary(scanOf([...ring(20, 36), ...ring(20, 36, 1.3)]));
    expect(q.rings).toBe(1);
    expect(q.notes.join(' ')).toMatch(/second round/);
    expect(q.verdict.level).toBe('usable');
  });
});

describe('the dome mesh', () => {
  it('has a patch for every cell, outlines, and a cross per photo', () => {
    const shots = ring(20, 24);
    const report = coverageOf(scanOf(shots));
    const m = buildDomeMesh(TARGET, report, { col: 3, row: 2 }, shots.map((s) => s.pos));
    expect(m.tris.length).toBe(144 * 6 * 7);
    expect(m.lines.length).toBe((144 * 8 + 24 * 6) * 7);
    expect(Array.from(m.tris).every(Number.isFinite)).toBe(true);
  });
});
