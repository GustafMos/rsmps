import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cameraBasis } from './gen-camera';
import { MARKER_CODES, MARKER_COUNT, bitCount, markerBitmap, matchCode, mirrorCode, rotateCode } from './marker-code';
import { detectMarkers } from './marker-detect';
import {
  MARKER_CORNERS,
  blendPoses,
  cameraFromPose,
  columnsFromQuat,
  homography,
  mapPoint,
  poseFromCamera,
  poseFromCorners,
  projectPoint,
  quatFromColumns,
  rotationAngle,
  smoothStep,
  type MarkerPose,
  type Pt,
  type SmoothState,
} from './marker-pose';
import { addNoise, blur, gauss, lightGradient, lowContrast, occlude, orbitCamera, orbitPose, renderScene, seeded, trueCorners } from './marker-testutil';

/** Set MARKER_DUMP to a folder to get the test pictures as .pgm files and the measured numbers on the console. */
const DUMP = process.env.MARKER_DUMP ?? '';
const say = (...a: unknown[]): void => {
  if (!DUMP) return;
  mkdirSync(DUMP, { recursive: true });
  appendFileSync(`${DUMP}/report.txt`, `${a.join(' ')}\n`);
};
function dump(name: string, g: Uint8Array, w: number, h: number): void {
  if (!DUMP) return;
  mkdirSync(DUMP, { recursive: true });
  writeFileSync(`${DUMP}/${name}.pgm`, Buffer.concat([Buffer.from(`P5\n${w} ${h}\n255\n`), Buffer.from(g)]));
}
const cornerError = (a: readonly Pt[], b: readonly Pt[]): number => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
const deg = (rad: number): number => (rad * 180) / Math.PI;

describe('marker codes', () => {
  const variants = (c: number): number[] => {
    const v: number[] = [];
    let a = c;
    let b = mirrorCode(c);
    for (let i = 0; i < 4; i++) {
      v.push(a, b);
      a = rotateCode(a);
      b = rotateCode(b);
    }
    return v;
  };
  it('four quarter turns and two mirrors give the code back', () => {
    for (const c of MARKER_CODES) {
      expect(rotateCode(rotateCode(rotateCode(rotateCode(c))))).toBe(c);
      expect(mirrorCode(mirrorCode(c))).toBe(c);
    }
    // a quarter turn clockwise moves the top-left cell to the top-right
    expect(rotateCode(0x8000)).toBe(0x1000);
    expect(mirrorCode(0x8000)).toBe(0x1000);
    expect(rotateCode(0x1000)).toBe(0x0001);
  });
  it('every code differs from every other reading (any rotation, mirrored or not, its own included) in at least 6 cells', () => {
    const all = MARKER_CODES.map(variants);
    let min = 16;
    for (let i = 0; i < all.length; i++) {
      for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) min = Math.min(min, bitCount(all[i][a] ^ all[i][b]));
      for (let j = i + 1; j < all.length; j++) for (const a of all[i]) for (const b of all[j]) min = Math.min(min, bitCount(a ^ b));
    }
    expect(min).toBeGreaterThanOrEqual(6);
    for (const c of MARKER_CODES) {
      expect(bitCount(c)).toBeGreaterThanOrEqual(6);
      expect(bitCount(c)).toBeLessThanOrEqual(10);
    }
  });
  it('a reading is matched in every rotation and mirrored, one wrong cell is corrected, two are refused', () => {
    for (let id = 0; id < MARKER_COUNT; id++) {
      const v = variants(MARKER_CODES[id]);
      for (let k = 0; k < 8; k++) {
        const m = matchCode(v[k])!;
        expect([m.id, m.turns, m.mirrored, m.errors]).toEqual([id, k >> 1, (k & 1) === 1, 0]);
        expect(matchCode(v[k] ^ 0x0040)!.errors).toBe(1);
        expect(matchCode(v[k] ^ 0x0040)!.id).toBe(id);
        expect(matchCode(v[k] ^ 0x0240)).toBeNull();
      }
      expect(matchCode(mirrorCode(MARKER_CODES[id]), false)).toBeNull();
    }
    expect(matchCode(0)).toBeNull();
    expect(matchCode(0xffff)).toBeNull();
  });
  it('the bitmap has a white margin, a black border and the code inside', () => {
    const { data, size } = markerBitmap(2, 4, 1);
    expect(size).toBe(32);
    expect(data[0]).toBe(255);
    expect(data[5 * size + 5]).toBe(0);
    // first data cell of code 0xce0f is white (bit 15 set)
    expect(data[9 * size + 9]).toBe(255);
  });
});

describe('homography and pose maths', () => {
  it('a homography maps its four points exactly', () => {
    const dst: Pt[] = [[10, 12], [90, 20], [80, 95], [5, 70]];
    const H = homography(MARKER_CORNERS, dst)!;
    MARKER_CORNERS.forEach((p, i) => {
      const q = mapPoint(H, p[0], p[1]);
      expect(q[0]).toBeCloseTo(dst[i][0], 8);
      expect(q[1]).toBeCloseTo(dst[i][1], 8);
    });
  });
  it('pose <-> camera round trip, and the quaternion helpers', () => {
    for (const [d, az, el, roll] of [[4, 0, 60, 0], [3, 130, 25, 20], [6, -70, 89.9, -45], [2, 200, 45, 170]]) {
      const cam = orbitCamera(d, az, el, roll);
      const pose = poseFromCamera(cam, { markerWidth: 2, floor: -1 });
      const back = cameraFromPose(pose, { fov: 50, markerWidth: 2, floor: -1 });
      const a = cameraBasis(cam);
      const b = cameraBasis(back);
      for (let k = 0; k < 3; k++) {
        expect(back.position[k]).toBeCloseTo(cam.position[k], 6);
        expect(b.forward[k]).toBeCloseTo(a.forward[k], 6);
        expect(b.right[k]).toBeCloseTo(a.right[k], 5);
        expect(b.up[k]).toBeCloseTo(a.up[k], 5);
      }
      const r2 = columnsFromQuat(quatFromColumns(pose.r));
      for (let k = 0; k < 9; k++) expect(r2[k]).toBeCloseTo(pose.r[k], 9);
    }
  });
  it('seen from straight above with the top edge away, the marker is upright in the picture', () => {
    // camera above the marker looking down; "up" on screen is +z, which is where the printed top edge points
    const pose = poseFromCamera({ position: [0, 5, 0], target: [0, 0, 0], roll: 0 }, { markerWidth: 1, floor: 0 });
    const c = trueCorners({ width: 200, height: 200, fov: 40, pose });
    expect(c[0][0]).toBeLessThan(c[1][0]); // top-left is left of top-right
    expect(c[0][1]).toBeLessThan(c[3][1]); // and above bottom-left
  });

  const views: [string, number, number, number, number][] = [
    ['above', 5, 0, 89, 0],
    ['front 45', 5, 0, 45, 0],
    ['left 45', 5, -90, 45, 0],
    ['right 45', 5, 90, 45, 0],
    ['behind low', 6, 180, 25, 10],
    ['close', 2.2, 30, 60, -20],
    ['far', 12, -140, 50, 35],
    ['shallow', 7, 60, 15, 0],
  ];
  it('exact corners give the exact pose from every side, landscape and portrait', () => {
    for (const [w, h] of [[1280, 720], [720, 1280], [640, 640]]) {
      for (const [name, d, az, el, roll] of views) {
        const truth = orbitPose(d, az, el, roll, [0.2, 0, -0.1]);
        const pose = poseFromCorners(trueCorners({ width: w, height: h, fov: 52, pose: truth }), w, h, 52)!;
        expect(pose, name).toBeTruthy();
        expect(deg(rotationAngle(pose.r, truth.r)), name).toBeLessThan(0.01);
        for (let k = 0; k < 3; k++) expect(pose.t[k], name).toBeCloseTo(truth.t[k], 5);
        expect(pose.error).toBeLessThan(1e-3);
      }
    }
  });
  it('noisy corners: the pose stays within tolerance (reported with MARKER_DUMP)', () => {
    const rnd = seeded(7);
    const [w, h, fov] = [1280, 720, 52];
    const rows: string[] = [];
    for (const sigma of [0.25, 0.5, 1]) {
      for (const [name, d, az, el, roll] of views) {
        const truth = orbitPose(d, az, el, roll);
        const exact = trueCorners({ width: w, height: h, fov, pose: truth });
        let rot = 0;
        let pos = 0;
        let rep = 0;
        let flips = 0;
        let worstCentre = 0;
        const N = 200;
        for (let i = 0; i < N; i++) {
          const noisy = exact.map((p): Pt => [p[0] + gauss(rnd) * sigma, p[1] + gauss(rnd) * sigma]);
          // the frame before is known while tracking: that is what settles the tilt ambiguity
          const pose = poseFromCorners(noisy, w, h, fov, truth)!;
          const a = deg(rotationAngle(pose.r, truth.r));
          if (a > 20) flips++;
          rot += a;
          // camera position error, in percent of the marker's width
          const ca = cameraFromPose(pose, { fov, markerWidth: 1, floor: 0 }).position;
          const cb = cameraFromPose(truth, { fov, markerWidth: 1, floor: 0 }).position;
          pos += Math.hypot(ca[0] - cb[0], ca[1] - cb[1], ca[2] - cb[2]) * 100;
          rep += pose.error;
          // what the user sees: where a point one marker width above the marker lands on screen
          const pa = projectPoint(pose, [0, 1, 0], w, h, fov)!;
          const pb = projectPoint(truth, [0, 1, 0], w, h, fov)!;
          worstCentre = Math.max(worstCentre, Math.hypot(pa[0] - pb[0], pa[1] - pb[1]));
        }
        rows.push(`noise ${sigma}px ${name.padEnd(11)} rot ${(rot / N).toFixed(2)} deg  camera ${(pos / N).toFixed(1)} % of marker  reproj ${(rep / N).toFixed(2)} px  top of a 1-marker-tall object off by at most ${worstCentre.toFixed(1)} px  flips ${flips}`);
        // far away with a full pixel of noise the tilt itself is barely measurable: a few wild frames are allowed there, none elsewhere
        expect(flips, `${name} @${sigma}`).toBeLessThanOrEqual(sigma >= 1 && d > 7 ? 6 : 0);
        if (sigma <= 0.5 && d <= 7) expect(rot / N, `${name} @${sigma}`).toBeLessThan(6);
      }
    }
    say(rows.join('\n'));
  });
  it('the tilt ambiguity: without a hint the better-fitting pose is taken; a hint from the frame before keeps it from flipping', () => {
    // far away and nearly head-on is the hard case
    const truth = orbitPose(9, 20, 60, 0);
    const exact = trueCorners({ width: 1280, height: 720, fov: 52, pose: truth });
    const pose = poseFromCorners(exact, 1280, 720, 52)!;
    expect(deg(rotationAngle(pose.r, truth.r))).toBeLessThan(0.5);
    const rnd = seeded(3);
    let wrong = 0;
    for (let i = 0; i < 100; i++) {
      const noisy = exact.map((p): Pt => [p[0] + gauss(rnd) * 0.4, p[1] + gauss(rnd) * 0.4]);
      if (deg(rotationAngle(poseFromCorners(noisy, 1280, 720, 52, truth)!.r, truth.r)) > 20) wrong++;
    }
    expect(wrong).toBe(0);
  });
  it('corners in the wrong winding (a mirrored picture that was not flipped back) are refused', () => {
    const truth = orbitPose(5, 30, 50, 0);
    const c = trueCorners({ width: 640, height: 480, fov: 50, pose: truth, mirror: true });
    expect(poseFromCorners(c, 640, 480, 50)).toBeNull();
  });
});

describe('smoothing', () => {
  it('amount 0 passes the pose through; a still pose is unchanged; jitter is reduced; a fast move is followed', () => {
    const a = orbitPose(5, 0, 45);
    expect(smoothStep(null, a, 1 / 30, 0.5).t).toEqual(a.t);
    const rnd = seeded(11);
    let st: SmoothState | null = null;
    let rawDev = 0;
    let smoothDev = 0;
    for (let i = 0; i < 200; i++) {
      const noisy: MarkerPose = { ...a, t: [a.t[0] + gauss(rnd) * 0.01, a.t[1] + gauss(rnd) * 0.01, a.t[2] + gauss(rnd) * 0.03] };
      st = smoothStep(st, noisy, 1 / 30, 0.6);
      if (i > 50) {
        rawDev += Math.abs(noisy.t[2] - a.t[2]);
        smoothDev += Math.abs(st.t[2] - a.t[2]);
      }
    }
    expect(smoothDev).toBeLessThan(rawDev * 0.5);
    // a sweep at walking speed: after half a second the smoothed pose is close behind
    let s2: SmoothState | null = null;
    let last = a;
    for (let i = 0; i <= 30; i++) {
      last = orbitPose(5, i * 3, 45);
      s2 = smoothStep(s2, last, 1 / 30, 0.6);
    }
    const lagDeg = deg(rotationAngle(columnsFromQuat(s2!.q), last.r));
    say(`smoothing 0.6, turning 90 deg/s: trails by ${lagDeg.toFixed(1)} deg (${(lagDeg / 90 * 1000).toFixed(0)} ms)`);
    expect(lagDeg).toBeLessThan(6);
    const off = smoothStep(st, last, 1 / 30, 0);
    expect(off.t).toEqual(last.t);
  });
  it('blendPoses is a weighted mean (halfway between two poses)', () => {
    const a = orbitPose(5, 0, 45);
    const b = orbitPose(5, 20, 45);
    const m = blendPoses([a, b], [1, 1])!;
    const mid = orbitPose(5, 10, 45);
    expect(deg(rotationAngle(m.r, mid.r))).toBeLessThan(0.2);
    expect(blendPoses([a, b], [0, 0])).toBeNull();
    expect(deg(rotationAngle(blendPoses([a, b], [0, 3])!.r, b.r))).toBeLessThan(1e-4);
  });
});

describe('finding the marker in a picture', () => {
  const [W, H, FOV] = [480, 270, 52];
  const views: [string, number, number, number, number][] = [
    ['above', 4, 0, 89, 0],
    ['front45', 4.5, 0, 45, 0],
    ['left45', 4.5, -90, 45, 0],
    ['right45', 4.5, 90, 45, 0],
    ['back45', 4.5, 180, 45, 0],
    ['close', 2.4, 30, 60, -20],
    ['far', 9, -140, 50, 35],
    ['shallow', 5, 60, 22, 0],
    ['turned', 4, 0, 80, 37],
  ];
  it('every id from every side: the right id, the corners labelled as printed, to a fraction of a pixel', () => {
    let worst = 0;
    let sum = 0;
    let n = 0;
    for (let id = 0; id < MARKER_COUNT; id++) {
      for (const [name, d, az, el, roll] of views) {
        const pose = orbitPose(d, az, el, roll);
        const g = renderScene({ width: W, height: H, fov: FOV, pose, id });
        if (id === 0) dump(`view-${name}`, g, W, H);
        const found = detectMarkers(g, W, H);
        expect(found.length, `${id} ${name}`).toBe(1);
        expect(found[0].id).toBe(id);
        expect(found[0].mirrored).toBe(false);
        expect(found[0].errors).toBe(0);
        const e = cornerError(found[0].corners, trueCorners({ width: W, height: H, fov: FOV, pose }));
        worst = Math.max(worst, e);
        sum += e;
        n++;
        expect(e, `${id} ${name}`).toBeLessThan(0.6);
      }
    }
    say(`clean pictures ${W}x${H}: corner error mean ${(sum / n).toFixed(3)} px, worst ${worst.toFixed(3)} px`);
  });
  it('portrait pictures, and a mirrored (front camera) picture is recognised as mirrored with the corners still labelled as printed', () => {
    const pose = orbitPose(4.5, 40, 50, 15);
    const g = renderScene({ width: 270, height: 480, fov: FOV, pose, id: 3 });
    const p = detectMarkers(g, 270, 480);
    expect(p[0]?.id).toBe(3);
    expect(cornerError(p[0].corners, trueCorners({ width: 270, height: 480, fov: FOV, pose }))).toBeLessThan(0.6);
    for (let id = 0; id < MARKER_COUNT; id++) {
      const m = renderScene({ width: W, height: H, fov: FOV, pose, id, mirror: true });
      if (id === 0) dump('mirrored', m, W, H);
      const f = detectMarkers(m, W, H);
      expect(f[0]?.id).toBe(id);
      expect(f[0].mirrored).toBe(true);
      expect(cornerError(f[0].corners, trueCorners({ width: W, height: H, fov: FOV, pose, mirror: true }))).toBeLessThan(0.6);
      expect(detectMarkers(m, W, H, { allowMirror: false }).length).toBe(0);
    }
  });
  it('several markers: all are found, and one can be chosen by id', () => {
    // two sheets side by side: paste the right half of one picture into the other
    const a = renderScene({ width: W, height: H, fov: FOV, pose: orbitPose(6, 10, 60, 0, [1.2, 0, 0]), id: 1 });
    const b = renderScene({ width: W, height: H, fov: FOV, pose: orbitPose(6, 10, 60, 0, [-1.2, 0, 0]), id: 4 });
    for (let y = 0; y < H; y++) for (let x = W / 2; x < W; x++) a[y * W + x] = b[y * W + x];
    dump('two-markers', a, W, H);
    expect(detectMarkers(a, W, H).map((d) => d.id).sort()).toEqual([1, 4]);
    expect(detectMarkers(a, W, H, { id: 4 }).map((d) => d.id)).toEqual([4]);
    expect(detectMarkers(a, W, H, { id: 2 })).toEqual([]);
  });
  it('things that are not markers are refused: a plain black square, a wrong pattern, a marker cut off by the edge, noise', () => {
    const blank = new Uint8Array(W * H).fill(230);
    const square = Uint8Array.from(blank);
    for (let y = 80; y < 180; y++) for (let x = 150; x < 250; x++) square[y * W + x] = 20;
    expect(detectMarkers(square, W, H)).toEqual([]);
    // a border with an all-white inside
    const ring = Uint8Array.from(square);
    for (let y = 97; y < 163; y++) for (let x = 167; x < 233; x++) ring[y * W + x] = 230;
    expect(detectMarkers(ring, W, H)).toEqual([]);
    const cut = renderScene({ width: W, height: H, fov: FOV, pose: orbitPose(4, 0, 70, 0, [3.4, 0, 0]), id: 0 });
    dump('cut-off', cut, W, H);
    expect(detectMarkers(cut, W, H)).toEqual([]);
    expect(detectMarkers(addNoise(new Uint8Array(W * H).fill(128), 60, 5), W, H)).toEqual([]);
  });

  it('a worse picture: how often the marker is still found, and how good the corners are (reported with MARKER_DUMP)', () => {
    const rnd = seeded(99);
    const cases: [string, (g: Uint8Array, i: number, c: Pt[]) => Uint8Array, number][] = [
      ['clean', (g) => g, 1],
      ['blur 1 px', (g) => blur(g, W, H, 1), 1],
      ['blur 2 px', (g) => blur(g, W, H, 2), 0.95],
      ['motion blur 4 px', (g) => blur(g, W, H, 4, 0.5), 0.6],
      ['motion blur 8 px', (g) => blur(g, W, H, 8, 0.5), 0],
      ['noise 8', (g, i) => addNoise(g, 8, i + 1), 1],
      ['noise 20', (g, i) => addNoise(g, 20, i + 1), 0.9],
      ['light gradient 1 : 0.35', (g) => lightGradient(g, W, H, 1, 0.35), 0.95],
      ['low contrast 0.3', (g) => lowContrast(g, 0.3), 0.95],
      ['low contrast 0.3 + noise 8', (g, i) => addNoise(lowContrast(g, 0.3), 8, i + 1), 0.85],
      ['dim 0.25 + noise 6', (g, i) => addNoise(lightGradient(g, W, H, 0.25, 0.25), 6, i + 1), 0.85],
      ['blur 1 + noise 10 + gradient', (g, i) => addNoise(lightGradient(blur(g, W, H, 1), W, H, 1, 0.5), 10, i + 1), 0.9],
      ['finger over one data cell', (g, _i, c) => occlude(g, W, H, (c[0][0] * 0.65 + c[2][0] * 0.35), (c[0][1] * 0.65 + c[2][1] * 0.35), Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) * 0.07, 150), 0.5],
      ['finger over a corner', (g, _i, c) => occlude(g, W, H, c[2][0], c[2][1], Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) * 0.2, 150), 0],
    ];
    const N = 60;
    const scenes: { g: Uint8Array; truth: Pt[]; id: number }[] = [];
    for (let i = 0; i < N; i++) {
      const pose = orbitPose(3 + rnd() * 5, rnd() * 360, 25 + rnd() * 64, (rnd() - 0.5) * 60, [(rnd() - 0.5) * 0.8, 0, (rnd() - 0.5) * 0.8]);
      const id = Math.floor(rnd() * MARKER_COUNT);
      scenes.push({ g: renderScene({ width: W, height: H, fov: FOV, pose, id, samples: 2 }), truth: trueCorners({ width: W, height: H, fov: FOV, pose }), id });
    }
    const rows: string[] = [];
    for (const [name, fn, need] of cases) {
      let ok = 0;
      let wrong = 0;
      let err = 0;
      let score = 0;
      scenes.forEach((s, i) => {
        const g = fn(s.g, i, s.truth);
        if (i === 0) dump(`worse-${name.replace(/[^a-z0-9]+/gi, '-')}`, g, W, H);
        const f = detectMarkers(g, W, H);
        if (f.length && f[0].id === s.id && cornerError(f[0].corners, s.truth) < 3) {
          ok++;
          err += cornerError(f[0].corners, s.truth);
          score += f[0].score;
        } else if (f.length) { wrong++; say(name, i, f[0].id === s.id, cornerError(f[0].corners, s.truth).toFixed(1), f[0].score.toFixed(2)); }
      });
      rows.push(`${name.padEnd(30)} found ${String(Math.round((ok / N) * 100)).padStart(3)} %  wrong ${wrong}  corner error ${ok ? (err / ok).toFixed(2) : '-'} px  score ${ok ? (score / ok).toFixed(2) : '-'}`);
      expect(ok / N, name).toBeGreaterThanOrEqual(need);
      // a wrong answer (wrong id or corners far off) is worse than none
      expect(wrong, name).toBeLessThanOrEqual(1);
    }
    say(rows.join('\n'));
  });
  it('blur lowers the score', () => {
    const pose = orbitPose(4, 20, 60);
    const g = renderScene({ width: W, height: H, fov: FOV, pose });
    const sharp = detectMarkers(g, W, H)[0].score;
    const soft = detectMarkers(blur(g, W, H, 2.5), W, H)[0].score;
    expect(soft).toBeLessThan(sharp * 0.8);
  });
  it('speed: one frame takes a few milliseconds at every analysis size (reported with MARKER_DUMP)', () => {
    for (const [w, h] of [[320, 180], [480, 270], [640, 360]]) {
      const g = addNoise(renderScene({ width: w, height: h, fov: FOV, pose: orbitPose(4.5, 30, 50, 10), samples: 2 }), 6, 3);
      for (let i = 0; i < 5; i++) detectMarkers(g, w, h);
      const t0 = performance.now();
      const runs = 30;
      for (let i = 0; i < runs; i++) expect(detectMarkers(g, w, h).length).toBe(1);
      const ms = (performance.now() - t0) / runs;
      say(`detect ${w}x${h}: ${ms.toFixed(2)} ms per frame`);
      expect(ms).toBeLessThan(40);
    }
    const c = trueCorners({ width: 1280, height: 720, fov: FOV, pose: orbitPose(4.5, 30, 50, 10) });
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) poseFromCorners(c, 1280, 720, FOV);
    say(`pose from corners: ${((performance.now() - t0) / 200).toFixed(3)} ms`);
  });
  it('end to end without the GPU: picture -> corners -> pose, from every side', () => {
    const [w, h] = [480, 270];
    const rows: string[] = [];
    for (const [name, d, az, el, roll] of views) {
      const truth = orbitPose(d, az, el, roll);
      const f = detectMarkers(addNoise(renderScene({ width: w, height: h, fov: FOV, pose: truth }), 4, 2), w, h)[0];
      // corners are measured on the small picture and used at the size of the full one
      const k = 1920 / w;
      const pose = poseFromCorners(f.corners.map((p): Pt => [p[0] * k, p[1] * k]), 1920, 1080, FOV, truth)!;
      const top = projectPoint(pose, [0, 1, 0], 1920, 1080, FOV)!;
      const want = projectPoint(truth, [0, 1, 0], 1920, 1080, FOV)!;
      const off = Math.hypot(top[0] - want[0], top[1] - want[1]);
      rows.push(`${name.padEnd(8)} rot ${deg(rotationAngle(pose.r, truth.r)).toFixed(2)} deg  reproj ${pose.error.toFixed(2)} px  a point one marker width up lands ${off.toFixed(1)} px off (of 1920)`);
      expect(off, name).toBeLessThan(40);
    }
    say(rows.join('\n'));
  });
});
