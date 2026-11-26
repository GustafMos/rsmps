import { describe, expect, it } from 'vitest';
import { parseCamerasBin, parseCamerasTxt, parseImagesBin, parseImagesTxt, poseOf, quatToMat } from './colmap';
import { qAxisAngle, qMul, type Quat, type Vec3 } from './motion-math';
import { lookAtQuat } from './scan-coverage';
import { backProjectDepth, camerasTxt, colmapExport, depthPoints, imagesTxt, points3dTxt, scanTextFiles, transformsJson, type ColmapExport } from './scan-export';
import { DEFAULT_GRID, encodeDepth, intrinsicsFromProjection, projectToShot, type ScanData, type ScanShot } from './scan-data';
import { lensFromFov, mat4Mul, projectionMatrix, viewMatrix } from './xr-math';

const CENTER: Vec3 = [0.4, 0.3, -2];
const proj = projectionMatrix(lensFromFov(60, 0.75));
const W = 1440;
const H = 1920;

/** A camera `dist` metres from the centre at azimuth/elevation (deg), looking at it, then rolled about its own viewing axis. */
function shot(az: number, el: number, roll = 0, dist = 1.3, i = 0): ScanShot {
  const a = (az * Math.PI) / 180;
  const e = (el * Math.PI) / 180;
  const pos: Vec3 = [CENTER[0] + dist * Math.cos(e) * Math.sin(a), CENTER[1] + dist * Math.sin(e), CENTER[2] + dist * Math.cos(e) * Math.cos(a)];
  const look = lookAtQuat(pos, CENTER);
  const quat = roll ? (qMul(look, qAxisAngle('z', roll)) as Quat) : look;
  return { asset: `a${i}`, t: i, pos, quat, w: W, h: H, ...intrinsicsFromProjection(proj, W, H), sharp: 0.9 };
}
const shots: ScanShot[] = [];
for (const [el, n] of [[-60, 5], [-20, 7], [10, 9], [40, 7], [75, 4], [-85, 2]] as const) for (let k = 0; k < n; k++) shots.push(shot((k * 360) / n + 11, el, k % 3 === 0 ? 0 : k % 3 === 1 ? 37 : -112 + el, 1.3, shots.length));
const scan: ScanData = { v: 1, units: 'm', target: { center: CENTER, radius: 0.5, up: [0, 1, 0] }, grid: { ...DEFAULT_GRID }, shots };
const POINTS: Vec3[] = [[0, 0, 0], [0.2, 0.1, 0.1], [-0.3, 0.25, 0.2], [0.1, -0.2, -0.3], [0.35, 0.3, -0.1], [-0.1, -0.35, 0.3]].map((p) => [p[0] + CENTER[0], p[1] + CENTER[1], p[2] + CENTER[2]] as Vec3);

/** The pixel a real phone camera with this pose and lens would see the point at: the XR view and projection matrices. */
function photographedAt(s: ScanShot, p: Vec3): [number, number] | null {
  const vp = mat4Mul(proj, viewMatrix({ p: s.pos, q: s.quat }));
  const c = [0, 1, 2, 3].map((r) => vp[r] * p[0] + vp[4 + r] * p[1] + vp[8 + r] * p[2] + vp[12 + r]);
  if (c[3] <= 1e-6) return null;
  return [((c[0] / c[3] + 1) / 2) * W, ((1 - c[1] / c[3]) / 2) * H];
}

/* ---- independent readers, written from the COLMAP docs and the nerfstudio convention ---- */
function readColmapText(cams: string, imgs: string) {
  const camera = new Map<number, { fx: number; fy: number; cx: number; cy: number }>();
  for (const l of cams.split('\n').filter((x) => x && !x.startsWith('#'))) {
    const w = l.split(' ');
    expect(w[1]).toBe('PINHOLE');
    camera.set(+w[0], { fx: +w[4], fy: +w[5], cx: +w[6], cy: +w[7] });
  }
  const lines = imgs.split('\n').filter((x) => !x.startsWith('#'));
  const images: { name: string; R: number[][]; t: number[]; cam: number }[] = [];
  for (let i = 0; lines[i] !== undefined && lines[i] !== ''; i += 2) {
    const w = lines[i].split(' ');
    const [qw, qx, qy, qz] = w.slice(1, 5).map(Number);
    expect(Math.hypot(qw, qx, qy, qz)).toBeCloseTo(1, 9);
    const R = [
      [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy)],
      [2 * (qx * qy + qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qw * qx)],
      [2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), 1 - 2 * (qx * qx + qy * qy)],
    ];
    images.push({ name: w[9], R, t: w.slice(5, 8).map(Number), cam: +w[8] });
    expect(lines[i + 1]).toBe(''); // the (empty) POINTS2D line
  }
  return { camera, images };
}
/** COLMAP: X_cam = R * X_world + t ; u = fx X/Z + cx ; v = fy Y/Z + cy ; Z forward, Y down. */
function colmapPixel(m: ReturnType<typeof readColmapText>, idx: number, p: Vec3): [number, number] | null {
  const im = m.images[idx];
  const c = im.R.map((row, r) => row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + im.t[r]);
  if (c[2] <= 1e-6) return null;
  const k = m.camera.get(im.cam)!;
  return [(k.fx * c[0]) / c[2] + k.cx, (k.fy * c[1]) / c[2] + k.cy];
}
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

describe('scan export conventions', () => {
  const files = scanTextFiles(scan, { folder: 'My scan!' });
  const model = readColmapText(files.text['sparse/0/cameras.txt'], files.text['sparse/0/images.txt']);

  it('has one camera for shared intrinsics and the folder name is file-safe', () => {
    expect(model.camera.size).toBe(1);
    expect(model.images.length).toBe(shots.length);
    expect(model.images[0].name).toBe('0001.jpg');
    expect(files.folder).toBe('My-scan');
  });

  it('COLMAP text: every known point lands on the pixel it was photographed at, and on projectToShot (all round, up, down, rolled)', () => {
    let worst = 0;
    let n = 0;
    shots.forEach((s, i) => {
      for (const p of POINTS) {
        const want = photographedAt(s, p);
        const lib = projectToShot(s, p);
        const got = colmapPixel(model, i, sub(p, CENTER)); // the export world is recentred on the target
        expect(got === null).toBe(want === null);
        if (!want || !got || !lib) continue;
        for (const k of [0, 1]) worst = Math.max(worst, Math.abs(got[k] - want[k]), Math.abs(got[k] - lib[k]));
        n++;
      }
    });
    expect(n).toBeGreaterThan(150);
    expect(worst).toBeLessThan(1e-3);
    console.log(`colmap txt: ${shots.length} cameras, ${n} projections, worst error ${worst.toExponential(2)} px`);
  });

  it('COLMAP camera frame: +Z forward, +Y down (the target is straight ahead; a point above it has negative y)', () => {
    const f = scanTextFiles({ ...scan, shots: [shot(30, 10, 0)] });
    const m = readColmapText(f.text['sparse/0/cameras.txt'], f.text['sparse/0/images.txt']);
    const im = m.images[0];
    expect(im.t[2]).toBeCloseTo(1.3, 6); // the export world origin is the target centre, 1.3 m in front
    expect(Math.hypot(im.t[0], im.t[1])).toBeLessThan(1e-9);
    const above = im.R.map((row, r) => row[1] * 0.1 + im.t[r]); // 10 cm above the centre
    expect(above[1]).toBeLessThan(0);
  });

  it('transforms.json: OpenGL camera axes, camera-to-world; points land on the same pixels', () => {
    const tj = JSON.parse(files.text['transforms.json']) as { fl_x: number; fl_y: number; cx: number; cy: number; w: number; h: number; frames: { file_path: string; transform_matrix: number[][] }[] };
    expect(tj.frames.length).toBe(shots.length);
    expect(tj.frames[0].file_path).toBe('images/0001.jpg');
    expect([tj.w, tj.h]).toEqual([W, H]);
    let worst = 0;
    let n = 0;
    tj.frames.forEach((fr, i) => {
      const M = fr.transform_matrix;
      expect(M[3]).toEqual([0, 0, 0, 1]);
      for (const p of POINTS) {
        const q = sub(p, CENTER);
        const d = [q[0] - M[0][3], q[1] - M[1][3], q[2] - M[2][3]];
        const c = [0, 1, 2].map((r) => M[0][r] * d[0] + M[1][r] * d[1] + M[2][r] * d[2]); // inverse of a rigid transform: R^T (p - C)
        const want = photographedAt(shots[i], p);
        if (c[2] >= -1e-6) {
          expect(want).toBeNull();
          continue;
        }
        const u = tj.fl_x * (c[0] / -c[2]) + tj.cx;
        const v = tj.fl_y * (-c[1] / -c[2]) + tj.cy;
        worst = Math.max(worst, Math.abs(u - want![0]), Math.abs(v - want![1]));
        n++;
      }
    });
    expect(n).toBeGreaterThan(150);
    expect(worst).toBeLessThan(1e-3);
    console.log(`transforms.json: ${n} projections, worst error ${worst.toExponential(2)} px`);
  });

  it('different intrinsics give a camera each and per-frame values in transforms.json', () => {
    const odd = { ...shots[1], fx: shots[1].fx * 1.1 };
    const two = { ...scan, shots: [shots[0], odd] };
    const tj = transformsJson(two) as { fl_x?: number; frames: { fl_x?: number }[] };
    expect(tj.fl_x).toBeUndefined();
    expect(tj.frames[1].fl_x).toBeCloseTo(odd.fx, 9);
    expect(colmapExport(two).cameras.length).toBe(2);
  });

  it('the desktop pipeline reader (colmap.ts) agrees: text and binary models give the same camera centres and viewing directions', () => {
    const exp = colmapExport(scan);
    const txtImgs = parseImagesTxt(imagesTxt(exp));
    const txtCams = parseCamerasTxt(camerasTxt(exp));
    expect(txtImgs.length).toBe(shots.length);
    expect(txtCams.get(1)!.params.length).toBe(4);
    const { cams, imgs } = writeBin(exp);
    const binCams = parseCamerasBin(cams);
    const binImgs = parseImagesBin(imgs);
    expect(binCams.get(1)!.model).toBe('PINHOLE');
    expect(binCams.get(1)!.width).toBe(W);
    expect(binImgs[5].name).toBe(txtImgs[5].name);
    shots.forEach((s, i) => {
      const C = sub(s.pos, CENTER);
      const l = Math.hypot(...C);
      for (const list of [txtImgs, binImgs]) {
        const pose = poseOf(list[i]);
        expect(Math.hypot(pose.centre[0] - C[0], pose.centre[1] - C[1], pose.centre[2] - C[2])).toBeLessThan(1e-9);
        // forward looks at the target centre, which is the origin: direction -C
        expect(-(pose.forward[0] * C[0] + pose.forward[1] * C[1] + pose.forward[2] * C[2]) / l).toBeGreaterThan(1 - 1e-9);
        const R = quatToMat(list[i].q);
        expect(Math.abs(R[0] * R[0] + R[1] * R[1] + R[2] * R[2] - 1)).toBeLessThan(1e-9);
      }
    });
  });

  it('points3D.txt is valid and empty without depth', () => {
    expect(files.points).toBe(0);
    const t = files.text['sparse/0/points3D.txt'];
    expect(t.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual([]);
    expect(t).toContain('Number of points: 0');
  });

  it('scan.json stays raw (not recentred) and the README names the commands', () => {
    const raw = JSON.parse(files.text['scan.json']) as ScanData;
    expect(raw.target.center).toEqual(CENTER);
    expect(raw.shots[3].pos).toEqual(shots[3].pos);
    const r = files.text['README.txt'];
    for (const w of ['feature_extractor', 'exhaustive_matcher', 'point_triangulator', 'bundle_adjuster', 'brush', 'splatfacto', '0, 0, 0']) expect(r).toContain(w);
  });
});

/** A binary COLMAP model (cameras.bin, images.bin) of an export, written from the COLMAP binary format description. */
function writeBin(m: ColmapExport): { cams: ArrayBuffer; imgs: ArrayBuffer } {
  const cam = new DataView(new ArrayBuffer(8 + m.cameras.length * (4 + 4 + 8 + 8 + 32)));
  let o = 0;
  const u64 = (dv: DataView, v: number) => {
    dv.setBigUint64(o, BigInt(v), true);
    o += 8;
  };
  u64(cam, m.cameras.length);
  for (const c of m.cameras) {
    cam.setUint32(o, c.id, true);
    o += 4;
    cam.setInt32(o, 1, true); // PINHOLE
    o += 4;
    u64(cam, c.w);
    u64(cam, c.h);
    for (const v of [c.fx, c.fy, c.cx, c.cy]) {
      cam.setFloat64(o, v, true);
      o += 8;
    }
  }
  const enc = new TextEncoder();
  const size = 8 + m.images.reduce((a, im) => a + 4 + 56 + 4 + enc.encode(im.name).length + 1 + 8, 0);
  const img = new DataView(new ArrayBuffer(size));
  o = 0;
  u64(img, m.images.length);
  for (const im of m.images) {
    img.setUint32(o, im.id, true);
    o += 4;
    for (const v of [...im.q, ...im.t]) {
      img.setFloat64(o, v, true);
      o += 8;
    }
    img.setUint32(o, im.cameraId, true);
    o += 4;
    const nm = enc.encode(im.name);
    new Uint8Array(img.buffer).set(nm, o);
    o += nm.length + 1;
    u64(img, 0);
  }
  return { cams: cam.buffer, imgs: img.buffer };
}

describe('depth points', () => {
  // a camera at (0.5, 1, -1) looking down -Z at a wall 2 m away: the plane z = -3
  const k = intrinsicsFromProjection(proj, W, H);
  const base: ScanShot = { asset: 'a', t: 0, pos: [0.5, 1, -1], quat: [0, 0, 0, 1], w: W, h: H, ...k, sharp: 1 };
  const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const map = (matrix: number[], raw = 2000, data = new Uint16Array(12 * 16).fill(raw)) => ({ width: 12, height: 16, rawValueToMeters: 0.001, normDepthBufferFromNormView: matrix, data });

  it('every back-projected sample lies on the wall z = -3 and projects back into its own sample pixel', () => {
    const pts = backProjectDepth(base, map(IDENT));
    expect(pts.length).toBe(12 * 16);
    for (const p of pts) expect(p[2]).toBeCloseTo(-3, 9);
    const first = projectToShot(base, pts[0])!;
    expect(first[0]).toBeCloseTo((W * 0.5) / 12, 6);
    expect(first[1]).toBeCloseTo((H * 0.5) / 16, 6);
    const last = projectToShot(base, pts[pts.length - 1])!;
    expect(last[0]).toBeCloseTo((W * 11.5) / 12, 6);
    expect(last[1]).toBeCloseTo((H * 15.5) / 16, 6);
    expect(pts[0][1]).toBeGreaterThan(1); // the top row is above the optical axis (y up)
    expect(pts[pts.length - 1][1]).toBeLessThan(1);
  });

  it('a depth buffer flipped and shifted relative to the view: the matrix is applied, not assumed', () => {
    // buffer x = 0.5 * view x + 0.25, buffer y = 1 - view y. Column-major: m[0] = 0.5, m[12] = 0.25, m[5] = -1, m[13] = 1
    const M = [0.5, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0.25, 1, 0, 1];
    const pts = backProjectDepth(base, map(M));
    for (const p of pts) expect(p[2]).toBeCloseTo(-3, 9);
    expect(pts.length).toBe(6 * 16); // only columns 3..8 of the buffer see the view; the others are outside it and dropped
    const px = projectToShot(base, pts[0])!; // the first kept cell is column 3, row 0: buffer (3.5/12, 0.5/16)
    expect(px[0]).toBeCloseTo(((3.5 / 12 - 0.25) / 0.5) * W, 6);
    expect(px[1]).toBeCloseTo((1 - 0.5 / 16) * H, 6);
  });

  it('zero values are skipped; the value is the distance along the viewing axis for a turned camera', () => {
    const data = new Uint16Array(12 * 16).fill(2000);
    data.fill(0, 0, 12);
    expect(backProjectDepth(base, map(IDENT, 0, data)).length).toBe(12 * 15);
    const pos: Vec3 = [1, 0.5, 0];
    const s = { ...base, pos, quat: lookAtQuat(pos, [0, 0.5, -2]) };
    const f = sub([0, 0.5, -2], pos);
    const fl = Math.hypot(...f);
    for (const p of backProjectDepth(s, map(IDENT))) {
      const d = sub(p, pos);
      expect((d[0] * f[0] + d[1] * f[1] + d[2] * f[2]) / fl).toBeCloseTo(2, 6);
    }
  });

  it('depthPoints writes grey points near the target into points3D.txt, in the export world', () => {
    const near: ScanShot = { ...base, pos: [CENTER[0], CENTER[1], CENTER[2] + 1.3], depth: encodeDepth(map(IDENT, 1300)) };
    const s2: ScanData = { v: 1, units: 'm', target: { center: CENTER, radius: 0.5, up: [0, 1, 0] }, grid: { ...DEFAULT_GRID }, shots: [near] };
    const pts = depthPoints(s2);
    expect(pts.length).toBeGreaterThan(5);
    for (const p of pts) {
      expect(p.xyz[2]).toBeCloseTo(0, 9); // the wall passes through the target centre
      expect(Math.hypot(...p.xyz)).toBeLessThanOrEqual(0.75 + 1e-9);
    }
    const files = scanTextFiles(s2);
    expect(files.points).toBe(pts.length);
    const lines = files.text['sparse/0/points3D.txt'].split('\n').filter((l) => l && !l.startsWith('#'));
    expect(lines.length).toBe(pts.length);
    expect(lines[0].split(' ').length).toBe(8);
    expect(points3dTxt({ cameras: [], images: [], points: pts })).toContain(`Number of points: ${pts.length}`);
  });
});
