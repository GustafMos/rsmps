import { describe, expect, it } from 'vitest';
import { cameraBasis, type V3 } from './gen-camera';
import * as cm from './colmap';
import { ARC_CAMERA_TXT, ARC_CAMERAS_BIN_B64, ARC_COLMAP, ARC_FOV_SHORT_DEG, ARC_TRUTH } from './colmap-fixture';
import { finishCloud, SH_C1 } from './splat-cloud';

const b64 = (s: string) => {
  const b = Buffer.from(s, 'base64');
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const images = (): cm.ColmapImage[] => ARC_COLMAP.map(([name, qw, qx, qy, qz, tx, ty, tz], i) => ({ id: i + 1, q: [qw, qx, qy, qz], t: [tx, ty, tz], cameraId: 1, name }));
const deg = (r: number) => (r * 180) / Math.PI;
const angle = (a: V3, b: V3) => deg(Math.acos(Math.min(1, Math.max(-1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b))))));

/** Write an images.bin the way COLMAP does (for the parser test): u64 count, then per image id, q, t, camera, name\0, u64 n2d, n2d x (x, y, id). */
function imagesBin(list: cm.ColmapImage[], points2d = 3): ArrayBuffer {
  const parts: number[] = [];
  const buf: Buffer[] = [];
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeUInt32LE(n, 0); buf.push(b); };
  u64(list.length);
  for (const im of list) {
    const b = Buffer.alloc(4 + 7 * 8 + 4);
    b.writeUInt32LE(im.id, 0);
    [...im.q, ...im.t].forEach((v, k) => b.writeDoubleLE(v, 4 + k * 8));
    b.writeUInt32LE(im.cameraId, 60);
    buf.push(b, Buffer.from(im.name + '\0', 'utf8'));
    u64(points2d);
    for (let k = 0; k < points2d; k++) { const p = Buffer.alloc(24); p.writeDoubleLE(k, 0); p.writeDoubleLE(k * 2, 8); p.writeInt32LE(-1, 16); p.writeInt32LE(-1, 20); buf.push(p); }
  }
  void parts;
  const all = Buffer.concat(buf);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer;
}

describe('COLMAP model files', () => {
  it('reads the real cameras.bin COLMAP 4.2.1 wrote, equal to the text model', () => {
    const bin = cm.parseCamerasBin(b64(ARC_CAMERAS_BIN_B64)).get(1)!;
    const txt = cm.parseCamerasTxt(ARC_CAMERA_TXT).get(1)!;
    expect(bin.model).toBe('SIMPLE_RADIAL');
    expect([bin.width, bin.height]).toEqual([640, 480]);
    for (let k = 0; k < 4; k++) expect(bin.params[k]).toBeCloseTo(txt.params[k], 9);
  });
  it('images.bin and images.txt give the same poses; points are skipped; a cut file is refused', () => {
    const list = images().slice(0, 5);
    const parsed = cm.parseImagesBin(imagesBin(list));
    expect(parsed.map((p) => p.name)).toEqual(list.map((p) => p.name));
    expect(parsed[3].q[2]).toBeCloseTo(list[3].q[2], 12);
    const txt = list.map((im) => `${im.id} ${im.q.join(' ')} ${im.t.join(' ')} ${im.cameraId} ${im.name}\n1 2 -1`).join('\n');
    expect(cm.parseImagesTxt(`# header\n${txt}\n`).map((p) => p.t[1])).toEqual(list.map((p) => p.t[1]));
    expect(cm.parseImagesTxt(list.map((im) => `${im.id} ${im.q.join(' ')} ${im.t.join(' ')} 1 ${im.name}\n`).join('\n')).length).toBe(5); // empty points lines
    expect(() => cm.parseImagesBin(imagesBin(list).slice(0, 100))).toThrow(cm.ColmapError);
  });
});

describe('poses in the tool frame (recorded COLMAP solve vs ground truth)', () => {
  const poses = images().map(cm.poseOf);
  const cam = cm.parseCamerasTxt(ARC_CAMERA_TXT).get(1)!;
  const fr = cm.sceneFrame(poses);
  const truth = new Map(ARC_TRUTH.map(([n, p, t]) => [n, cameraBasis({ position: p, target: t, roll: 0 })]));
  const solved = poses.map((p) => ({ name: p.name, cam: cm.cameraValueOf(fr, p, cam) }));

  it('the frame is a mirror (det -1) that makes up +y; the up estimate is the gravity of the truth', () => {
    expect(cm.det3(fr.M)).toBeCloseTo(-1, 9);
    expect(fr.basis).toBe('right-axes');
  });

  it('every solved camera matches the truth up to ONE similarity with a proper rotation about +y (no mirror, no tilt)', () => {
    const X = solved.map((s) => s.cam.position as V3);
    const Y = solved.map((s) => truth.get(s.name)!.position as V3);
    const sim = cm.fitSimilarity(X, Y);
    const span = Math.hypot(...(Y[0].map((v, i) => v - Y[Y.length - 1][i]) as V3));
    expect(sim.rms / span).toBeLessThan(0.002);
    expect(cm.det3(sim.R)).toBeCloseTo(1, 6);
    // the fitted rotation keeps +y: up was found correctly (within half a degree)
    expect(angle(cm.mulMV(sim.R, [0, 1, 0]), [0, 1, 0])).toBeLessThan(0.5);
    let worst = 0;
    for (const s of solved) {
      const b = cameraBasis(s.cam);
      const t = truth.get(s.name)!;
      for (const [a, g] of [[b.forward, t.forward], [b.right, t.right], [b.up, t.up]] as [V3, V3][]) worst = Math.max(worst, angle(cm.mulMV(sim.R, a), g));
    }
    expect(worst).toBeLessThan(0.5); // degrees; measured 0.2 (rotation error of the solve itself)
  });

  it('the field of view and lens shift follow the tool convention (fov over the shorter side)', () => {
    for (const s of solved) {
      expect(s.cam.fov).toBeCloseTo(ARC_FOV_SHORT_DEG, 0);
      expect(Math.abs(s.cam.shift[0]) + Math.abs(s.cam.shift[1])).toBeLessThan(1e-9); // SIMPLE_RADIAL: principal point at the centre
    }
    const off = cm.cameraFromAxes([0, 0, 0], [0, 0, 1], [1, 0, 0], { width: 640, height: 480, model: 'PINHOLE', params: [500, 500, 340, 230] });
    expect(off.shift[0]).toBeCloseTo(20 / 480, 12);
    expect(off.shift[1]).toBeCloseTo(10 / 480, 12); // principal point ABOVE the centre = positive (y up)
    expect(off.roll).toBeCloseTo(0, 9);
  });

  it('roll is recovered: a camera rolled by 30 degrees comes back with roll 30', () => {
    const r = (30 * Math.PI) / 180;
    const c = cm.cameraFromAxes([0, 0, -3], [0, 0, 1], [Math.cos(r), Math.sin(r), 0], { width: 100, height: 100, model: 'PINHOLE', params: [50, 50, 50, 50] });
    expect(c.roll).toBeCloseTo(30, 6);
    expect(angle(cameraBasis(c).right, [Math.cos(r), Math.sin(r), 0])).toBeLessThan(1e-6);
  });

  it('the camera path interpolates between solved frames and holds at the ends', () => {
    const keys = solved.slice(0, 3).map((s, i) => {
      const b = cameraBasis(s.cam);
      return cm.pathKeyOf(i, s.cam.position as V3, b.forward, b.right);
    });
    const path: cm.CameraPath = { keys, width: 640, height: 480, fov: 55, shift: [0, 0] };
    const at0 = cm.cameraAt(path, -1)!;
    expect(at0.position).toEqual(keys[0].position);
    const mid = cm.cameraAt(path, 0.5)!;
    for (let a = 0; a < 3; a++) expect(mid.position[a]).toBeCloseTo((keys[0].position[a] + keys[1].position[a]) / 2, 9);
    const b1 = cameraBasis(solved[1].cam);
    expect(angle(cm.cameraAt(path, 1)!.forward, b1.forward)).toBeLessThan(1e-6);
    expect(angle(cm.cameraAt(path, 1)!.right, b1.right)).toBeLessThan(1e-6);
    expect(cm.cameraAt(path, 9)!.position).toEqual(keys[2].position);
  });

  it('a pan on the spot is recognised by its parallax; a moving camera is not', () => {
    const pts = new Float64Array([0, 0, 5, 1, 0, 6, -1, 1, 5]);
    const turn = [0, 0.1, 0.2].map((a) => cm.poseOf({ id: 1, q: [Math.cos(a / 2), 0, Math.sin(a / 2), 0], t: [0, 0, 0], cameraId: 1, name: 'x' }));
    expect(cm.solveStats(turn, pts).parallax).toBeLessThan(cm.PARALLAX_FAIL);
    expect(cm.solveStats(poses, new Float64Array([0, 0, 0])).parallax).toBeGreaterThan(cm.PARALLAX_WARN);
  });
});

describe('transformCloud', () => {
  const M = (() => {
    const fr = cm.sceneFrame(images().map(cm.poseOf));
    return { M: fr.M, centre: [0.3, -0.2, 1.5] as V3 };
  })();
  const cloud = finishCloud(
    {
      count: 2,
      positions: Float32Array.from([1, 2, 3, -1, 0.5, 2]),
      scales: Float32Array.from([0.1, 0.02, 0.3, 0.2, 0.2, 0.05]),
      rotations: Float32Array.from([0.9, 0.1, 0.3, -0.2, 0.5, 0.5, 0.5, 0.5]).map((v, i, a) => v / Math.hypot(a[(i >> 2) * 4], a[(i >> 2) * 4 + 1], a[(i >> 2) * 4 + 2], a[(i >> 2) * 4 + 3])),
      colors: Float32Array.from([0.5, 0.4, 0.3, 0.2, 0.9, 0.1]),
      opacity: Float32Array.from([0.8, 0.3]),
      sh1: Float32Array.from({ length: 18 }, (_, i) => Math.sin(i * 1.7) * 0.3),
    },
    'ply',
  );
  const out = cm.transformCloud(cloud, M);
  const sigma = (c: typeof cloud, i: number) => {
    const R = cm.quatToMat([c.rotations[i * 4], c.rotations[i * 4 + 1], c.rotations[i * 4 + 2], c.rotations[i * 4 + 3]]);
    const s = [c.scales[i * 3], c.scales[i * 3 + 1], c.scales[i * 3 + 2]];
    const RS = R.map((v, k) => v * s[k % 3]);
    return cm.mulMM(RS, [RS[0], RS[3], RS[6], RS[1], RS[4], RS[7], RS[2], RS[5], RS[8]]);
  };
  const shAt = (c: typeof cloud, i: number, d: V3) => [0, 1, 2].map((ch) => SH_C1 * (-d[1] * c.sh1![i * 9 + ch * 3] + d[2] * c.sh1![i * 9 + ch * 3 + 1] - d[0] * c.sh1![i * 9 + ch * 3 + 2]));

  it('moves the centres, turns the covariances (M Sigma M^T, still a rotation + scales) and the view-dependent colour with them', () => {
    expect(out.upHint).toBe('+y');
    for (let i = 0; i < 2; i++) {
      const p = cm.toTool(M as cm.SceneFrame, [cloud.positions[i * 3], cloud.positions[i * 3 + 1], cloud.positions[i * 3 + 2]]);
      for (let a = 0; a < 3; a++) expect(out.positions[i * 3 + a]).toBeCloseTo(p[a], 5);
      const want = cm.mulMM(cm.mulMM(M.M, sigma(cloud, i)), [M.M[0], M.M[3], M.M[6], M.M[1], M.M[4], M.M[7], M.M[2], M.M[5], M.M[8]]);
      const got = sigma(out, i);
      for (let k = 0; k < 9; k++) expect(got[k]).toBeCloseTo(want[k], 6);
      const q = [out.rotations[i * 4], out.rotations[i * 4 + 1], out.rotations[i * 4 + 2], out.rotations[i * 4 + 3]];
      expect(Math.hypot(...q)).toBeCloseTo(1, 6);
      const d = [0.3, -0.5, 0.81].map((v) => v / Math.hypot(0.3, -0.5, 0.81)) as V3;
      const before = shAt(cloud, i, d);
      const after = shAt(out, i, cm.mulMV(M.M, d));
      for (let ch = 0; ch < 3; ch++) expect(after[ch]).toBeCloseTo(before[ch], 6);
    }
  });

  it('matToQuat inverts quatToMat', () => {
    const q: [number, number, number, number] = [0.2, -0.6, 0.3, 0.71];
    const l = Math.hypot(...q);
    const back = cm.matToQuat(cm.quatToMat(q));
    const sign = Math.sign(back[0]) === Math.sign(q[0]) ? 1 : -1;
    for (let k = 0; k < 4; k++) expect(back[k] * sign).toBeCloseTo(q[k] / l, 9);
  });
});
