import { describe, expect, it } from 'vitest';
import { decimateCloud, estimateUp, importanceOf, jacobi3, SH_C0 } from './splat-cloud';
import { ballCloud, manualCloud, quatAxisAngle, rng, terrainCloud, torusCloud } from './splat-gen';
import { axisIndex, pictureOrder, projectRef, quadRef, quatToMat3, sortBackToFront, sortView, viewSetup, worldCovariance, SPLAT_NEAR, type ViewSetup } from './splat-math';
import { parsePly, parseSplat32, parseSplatBytes, SplatError, writeSplatPly } from './splat-ply';
import type { CameraValue } from '../types';

const camera = (over: Partial<CameraValue> = {}): CameraValue => ({ kind: 'camera', projection: 'perspective', fov: 40, orthoSize: 4, position: [0, 0, -4], target: [0, 0, 0], roll: 0, shift: [0, 0], ...over });

/** Build a .ply by hand (not through writeSplatPly) so the formulas are checked against the file format itself. */
function handPly(rows: { pos: number[]; dc: number[]; op: number; sc: number[]; rot: number[]; rest?: number[] }[], opts: { rest?: number; extra?: boolean; comment?: string } = {}): ArrayBuffer {
  const nRest = opts.rest ?? 0;
  const props = ['x', 'y', 'z', ...(opts.extra ? ['nx', 'ny', 'nz'] : []), 'f_dc_0', 'f_dc_1', 'f_dc_2', ...Array.from({ length: nRest }, (_, i) => `f_rest_${i}`), 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = `ply\r\nformat binary_little_endian 1.0\r\n${opts.comment ? `comment ${opts.comment}\r\n` : ''}element vertex ${rows.length}\r\n${props.map((p) => `property float ${p}\r\n`).join('')}end_header\r\n`;
  const head = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(head.length + rows.length * props.length * 4 + 3); // trailing slack must be ignored
  new Uint8Array(buf).set(head);
  const dv = new DataView(buf, head.length);
  rows.forEach((r, i) => {
    const vals = [...r.pos, ...(opts.extra ? [0.1, 0.2, 0.3] : []), ...r.dc, ...(r.rest ?? new Array(nRest).fill(0)), r.op, ...r.sc, ...r.rot];
    vals.forEach((v, k) => dv.setFloat32((i * props.length + k) * 4, v, true));
  });
  return buf;
}

describe('.ply parser', () => {
  it('applies the 3DGS formulas exactly (colour, sigmoid, exp, normalisation)', () => {
    const buf = handPly(
      [
        { pos: [1, 2, 3], dc: [1, -1, 0], op: Math.log(2), sc: [Math.log(0.1), Math.log(0.2), Math.log(0.3)], rot: [2, 0, 0, 0] },
        { pos: [-4, 5, -6], dc: [0.25, 0.5, 2], op: -3, sc: [0, -1, -2], rot: [0, 3, 4, 0] },
      ],
      { extra: true, comment: 'made by a test' },
    );
    const c = parsePly(buf);
    expect(c.count).toBe(2);
    expect(Array.from(c.positions)).toEqual([1, 2, 3, -4, 5, -6]);
    const col = (v: number) => Math.fround(SH_C0 * v + 0.5);
    expect(c.colors[0]).toBeCloseTo(col(1), 6);
    expect(c.colors[1]).toBeCloseTo(col(-1), 6);
    expect(c.colors[2]).toBeCloseTo(0.5, 6);
    expect(c.colors[5]).toBeCloseTo(col(2), 6);
    expect(SH_C0).toBe(0.28209479177387814);
    expect(c.opacity[0]).toBeCloseTo(2 / 3, 6); // sigmoid(ln 2) = 2/3
    expect(c.opacity[1]).toBeCloseTo(1 / (1 + Math.exp(3)), 6);
    expect(c.scales[0]).toBeCloseTo(0.1, 6);
    expect(c.scales[1]).toBeCloseTo(0.2, 6);
    expect(c.scales[2]).toBeCloseTo(0.3, 6);
    expect(c.scales[3]).toBeCloseTo(1, 6);
    expect(c.scales[5]).toBeCloseTo(Math.exp(-2), 6);
    expect(Array.from(c.rotations.subarray(0, 4))).toEqual([1, 0, 0, 0]);
    expect(c.rotations[4]).toBeCloseTo(0, 6);
    expect(c.rotations[5]).toBeCloseTo(0.6, 6);
    expect(c.rotations[6]).toBeCloseTo(0.8, 6);
    expect(c.sh1).toBeNull();
    expect(c.bounds.min).toEqual([-4, 2, -6]);
    expect(c.bounds.max).toEqual([1, 5, 3]);
  });

  it('reads degree-1 spherical harmonics channel-major and skips higher degrees', () => {
    // a degree-3 file: 45 f_rest values, channel-major (15 per channel); value = channel * 100 + k
    const rest = Array.from({ length: 45 }, (_, i) => Math.floor(i / 15) * 100 + (i % 15));
    const c = parsePly(handPly([{ pos: [0, 0, 0], dc: [0, 0, 0], op: 0, sc: [0, 0, 0], rot: [1, 0, 0, 0], rest }], { rest: 45 }));
    expect(c.shDegreeInFile).toBe(3);
    expect(Array.from(c.sh1!)).toEqual([0, 1, 2, 100, 101, 102, 200, 201, 202]);
    const c1 = parsePly(handPly([{ pos: [0, 0, 0], dc: [0, 0, 0], op: 0, sc: [0, 0, 0], rot: [1, 0, 0, 0], rest: [7, 8, 9, 17, 18, 19, 27, 28, 29] }], { rest: 9 }));
    expect(c1.shDegreeInFile).toBe(1);
    expect(Array.from(c1.sh1!)).toEqual([7, 8, 9, 17, 18, 19, 27, 28, 29]);
  });

  it('round trips a generated cloud through writeSplatPly (values, SH, up hint)', () => {
    const src = torusCloud(500, 7);
    src.sh1 = new Float32Array(500 * 9).map((_, i) => Math.sin(i) * 0.2);
    const back = parsePly(writeSplatPly(src, '+y'));
    expect(back.count).toBe(500);
    expect(back.upHint).toBe('+y');
    for (let i = 0; i < 500; i++) {
      for (let k = 0; k < 3; k++) {
        expect(back.positions[i * 3 + k]).toBe(src.positions[i * 3 + k]);
        expect(back.scales[i * 3 + k]).toBeCloseTo(src.scales[i * 3 + k], 6);
        expect(back.colors[i * 3 + k]).toBeCloseTo(src.colors[i * 3 + k], 5);
      }
      for (let k = 0; k < 4; k++) expect(back.rotations[i * 4 + k]).toBeCloseTo(src.rotations[i * 4 + k], 6);
      expect(back.opacity[i]).toBeCloseTo(src.opacity[i], 5);
    }
    expect(Array.from(back.sh1!.subarray(0, 18))).toEqual(Array.from(src.sh1.subarray(0, 18)));
    expect(back.id).toBeTruthy();
  });

  it('reads properties by name and type: extra properties, uchar colours, double positions', () => {
    const header = 'ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float opacity\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nend_header\n';
    const head = new TextEncoder().encode(header);
    const buf = new ArrayBuffer(head.length + 24 + 3 + 4 * 8);
    new Uint8Array(buf).set(head);
    const dv = new DataView(buf, head.length);
    [1.5, 2.5, 3.5].forEach((v, i) => dv.setFloat64(i * 8, v, true));
    [255, 128, 0].forEach((v, i) => dv.setUint8(24 + i, v));
    [0, 0, 0, 0, 1, 0, 0, 0].forEach((v, i) => dv.setFloat32(27 + i * 4, v, true));
    const c = parsePly(buf);
    expect(Array.from(c.positions)).toEqual([1.5, 2.5, 3.5]);
    expect(c.colors[0]).toBeCloseTo(1, 6);
    expect(c.colors[1]).toBeCloseTo(128 / 255, 6);
    expect(c.opacity[0]).toBe(0.5);
  });

  it('refuses unsupported variants with a readable message', () => {
    const t = (buf: ArrayBuffer) => {
      try {
        parseSplatBytes(buf);
      } catch (e) {
        expect(e).toBeInstanceOf(SplatError);
        return (e as Error).message;
      }
      return '';
    };
    const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
    expect(t(enc('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n'))).toMatch(/ASCII/);
    expect(t(enc('ply\nformat binary_big_endian 1.0\nelement vertex 0\nend_header\n'))).toMatch(/little endian/);
    expect(t(enc('ply\nformat binary_little_endian 1.0\nelement chunk 1\nproperty float min_x\nelement vertex 1\nproperty uint packed_position\nend_header\n'))).toMatch(/compressed/);
    expect(t(enc('ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n'))).toMatch(/plain point cloud or mesh/);
    expect(t(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]).buffer as ArrayBuffer)).toMatch(/gzip/);
    expect(t(new ArrayBuffer(0))).toMatch(/empty/);
    expect(t(new ArrayBuffer(33))).toMatch(/not a Gaussian splat/);
    const good = handPly([{ pos: [0, 0, 0], dc: [0, 0, 0], op: 0, sc: [0, 0, 0], rot: [1, 0, 0, 0] }]);
    expect(t(good.slice(0, good.byteLength - 20))).toMatch(/cut short/);
  });

  it('reads the 32-byte .splat layout', () => {
    const buf = new ArrayBuffer(64);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    // splat 0: position, linear scale, rgba, rotation (w, x, y, z) as (v - 128) / 128
    [1, 2, 3, 0.1, 0.2, 0.3].forEach((v, i) => dv.setFloat32(i * 4, v, true));
    u8.set([255, 128, 0, 204, 255, 128, 128, 128], 24); // w = 127/128 .. normalised later
    [-1, -2, -3, 1, 1, 1].forEach((v, i) => dv.setFloat32(32 + i * 4, v, true));
    u8.set([10, 20, 30, 255, 128, 192, 128, 128], 56); // rotation: x = 0.5 -> (w, x) = (0, 0.5) -> normalised (0, 1, 0, 0)
    const c = parseSplat32(buf);
    expect(c.count).toBe(2);
    expect(Array.from(c.positions)).toEqual([1, 2, 3, -1, -2, -3]);
    expect(c.scales[0]).toBeCloseTo(0.1, 6);
    expect(c.colors[0]).toBeCloseTo(1, 6);
    expect(c.colors[1]).toBeCloseTo(128 / 255, 6);
    expect(c.opacity[0]).toBeCloseTo(204 / 255, 6);
    expect(Array.from(c.rotations.subarray(0, 4))).toEqual([1, 0, 0, 0]);
    expect(c.rotations[4]).toBeCloseTo(0, 6);
    expect(c.rotations[5]).toBeCloseTo(1, 6);
    expect(parseSplatBytes(buf).count).toBe(2); // sniffed
  });
});

describe('cloud helpers', () => {
  it('jacobi3 finds the eigen-decomposition of a symmetric matrix', () => {
    const { values, vectors } = jacobi3([4, 1, 0, 1, 3, 0, 0, 0, 1]);
    const m = [4, 1, 0, 1, 3, 0, 0, 0, 1];
    values.forEach((l, i) => {
      const v = vectors[i];
      const mv = [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
      for (let k = 0; k < 3; k++) expect(mv[k]).toBeCloseTo(l * v[k], 9);
    });
  });

  it('decimation keeps the largest and most opaque splats, deterministically', () => {
    const c = ballCloud(3000, 5);
    const a = decimateCloud(c, 1000);
    const b = decimateCloud(c, 1000);
    expect(a).toBe(b); // memoised
    expect(a.count).toBe(1000);
    const kept = new Set<number>();
    for (let i = 0, j = 0; i < c.count && j < a.count; i++) if (c.positions[i * 3] === a.positions[j * 3] && c.positions[i * 3 + 1] === a.positions[j * 3 + 1] && c.positions[i * 3 + 2] === a.positions[j * 3 + 2]) kept.add(i), j++;
    expect(kept.size).toBe(1000);
    const minKept = Math.min(...[...kept].map((i) => importanceOf(c, i)));
    const maxDropped = Math.max(...Array.from({ length: c.count }, (_, i) => i).filter((i) => !kept.has(i)).map((i) => importanceOf(c, i)));
    expect(maxDropped).toBeLessThanOrEqual(minKept * 1.01); // the histogram bins are 4096 log steps wide
    expect(decimateCloud(ballCloud(3000, 5), 1000).id).toBe(a.id); // same input, same output
    expect(decimateCloud(c, 5000)).toBe(c); // under the cap: untouched
  });

  it('estimateUp: file hint, flat scene ground plane, default y-down', () => {
    expect(estimateUp(torusCloud(200, 1)).basis).toBe('file-hint');
    // a terrain written without the hint, upside down (y down): the ground plane axis is found and signed
    const down = terrainCloud(4000, 3, true);
    const bare = { ...down, upHint: null };
    const est = estimateUp(bare as never);
    expect(est.basis).toBe('flat-scene');
    // the heights are mostly below 0 here (mirrored): "up" must come out as -y
    expect(est.up[1]).toBeLessThan(-0.9);
    const m = est.matrix;
    // matrix maps the found up onto +y
    expect(m[3] * est.up[0] + m[4] * est.up[1] + m[5] * est.up[2]).toBeCloseTo(1, 5);
    const ball = { ...ballCloud(2000, 2), upHint: null };
    expect(estimateUp(ball as never).basis).toBe('default-y-down');
  });
});

describe('projection maths', () => {
  const v: ViewSetup = viewSetup(camera(), 256, 192);

  it('perspective: the centre pixel and the covariance match projecting samples of the Gaussian', () => {
    const q = quatAxisAngle([0.3, 1, 0.2], 0.7);
    const s: [number, number, number] = [0.25, 0.1, 0.04];
    const A = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const cw: [number, number, number] = [0.4, -0.3, 0.5];
    const sig = worldCovariance(A, q, s);
    const pr = projectRef(v, cw, sig);
    expect(pr.ok).toBe(true);
    // centre: pinhole of fov 40 on the short side (192 px): f = 96 / tan(20deg)
    const f = 96 / Math.tan((20 * Math.PI) / 180);
    const z = cw[2] + 4;
    expect(pr.centre[0]).toBeCloseTo((f * cw[0]) / z, 6);
    expect(pr.centre[1]).toBeCloseTo((f * cw[1]) / z, 6);
    // Monte Carlo: sample points of the 3D Gaussian, project each exactly, take the 2D sample covariance
    const R = quatToMat3(...q);
    const rand = rng(11);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    let sxx = 0, sxy = 0, syy = 0, mx = 0, my = 0;
    const N = 40000;
    const pts: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const l = [gauss() * s[0], gauss() * s[1], gauss() * s[2]];
      const p = [cw[0] + R[0] * l[0] + R[1] * l[1] + R[2] * l[2], cw[1] + R[3] * l[0] + R[4] * l[1] + R[5] * l[2], cw[2] + R[6] * l[0] + R[7] * l[1] + R[8] * l[2]];
      pts.push([(f * p[0]) / (p[2] + 4), (f * p[1]) / (p[2] + 4)]);
    }
    pts.forEach((p) => { mx += p[0]; my += p[1]; });
    mx /= N; my /= N;
    pts.forEach((p) => { sxx += (p[0] - mx) ** 2; sxy += (p[0] - mx) * (p[1] - my); syy += (p[1] - my) ** 2; });
    sxx /= N; sxy /= N; syy /= N;
    expect(pr.cov[0]).toBeCloseTo(sxx, -1);
    expect(Math.abs(pr.cov[0] - sxx) / sxx).toBeLessThan(0.04);
    expect(Math.abs(pr.cov[2] - syy) / syy).toBeLessThan(0.04);
    expect(Math.abs(pr.cov[1] - sxy)).toBeLessThan(0.04 * Math.sqrt(sxx * syy));
    // axes from the eigen-decomposition reproduce the matrix
    const qd = quadRef(pr.cov, 1, { antialias: false, maxPix: 1e6 })!;
    const l1 = qd.lambda1 - 0.3;
    const l2 = qd.lambda2 - 0.3;
    // a = l1 c² + l2 s², b = (l1 - l2) c s, c = l1 s² + l2 c² (up to the 0.3 low pass added to the diagonal)
    const [c1, s1] = qd.axis1;
    expect(pr.cov[0] + 0.3).toBeCloseTo(qd.lambda1 * c1 * c1 + qd.lambda2 * s1 * s1, 5);
    expect(pr.cov[1]).toBeCloseTo((qd.lambda1 - qd.lambda2) * c1 * s1, 5);
    expect(l1).toBeGreaterThan(l2);
  });

  it('orthographic: pixels per unit are exact', () => {
    const o = viewSetup(camera({ projection: 'orthographic', orthoSize: 4 }), 128, 96);
    const sig = worldCovariance([1, 0, 0, 0, 1, 0, 0, 0, 1], [1, 0, 0, 0], [0.5, 0.25, 0.1]);
    const pr = projectRef(o, [1, 0.5, 2], sig);
    expect(pr.centre[0]).toBeCloseTo(24, 6); // 96 px / 4 units = 24 px per unit
    expect(pr.centre[1]).toBeCloseTo(12, 6);
    expect(pr.cov[0]).toBeCloseTo((0.5 * 24) ** 2, 6);
    expect(pr.cov[2]).toBeCloseTo((0.25 * 24) ** 2, 6);
    expect(pr.depth).toBeCloseTo(6, 6);
  });

  it('the low pass and the compensation: tiny splats fade, big ones are unchanged', () => {
    const big = quadRef([400, 0, 400], 0.8, { antialias: true, maxPix: 1e6 })!;
    expect(big.alpha).toBeCloseTo(0.8 * Math.sqrt(160000 / (400.3 * 400.3)), 6);
    const tiny = quadRef([0.01, 0, 0.01], 0.8, { antialias: true, maxPix: 1e6 })!;
    expect(tiny.alpha).toBeLessThan(0.1);
    expect(quadRef([0.01, 0, 0.01], 0.8, { antialias: false, maxPix: 1e6 })!.alpha).toBe(0.8);
  });

  it('lens fallback is reported for fisheye / panoramic / cylindrical', () => {
    expect(viewSetup(camera({ projection: 'fisheye', fov: 180 }), 64, 64).lensFallback).toBe(true);
    expect(viewSetup(camera({ projection: 'perspective' }), 64, 64).lensFallback).toBe(false);
    expect(viewSetup(camera({ projection: 'orthographic' }), 64, 64).lensFallback).toBe(false);
  });
});

describe('sorting', () => {
  const view = (pos: [number, number, number], fwd: [number, number, number]) => ({ pos, fwd, persp: true, near: SPLAT_NEAR, key: '' });

  it('orders back to front (within the 16-bit quantum) and drops splats in front of the near plane', () => {
    const rand = rng(3);
    const n = 20000;
    const pos = new Float32Array(n * 3).map(() => rand() * 10 - 5);
    const v = view([0, 0, -8], [0, 0, 1]);
    const r = sortBackToFront(pos, n, v);
    const depth = (i: number) => pos[i * 3 + 2] + 8;
    let included = 0;
    for (let i = 0; i < n; i++) if (depth(i) >= SPLAT_NEAR) included++;
    expect(r.count).toBe(included);
    const quantum = 10.5 / 65535 * 1.01;
    for (let k = 1; k < r.count; k++) expect(depth(r.order[k - 1])).toBeGreaterThanOrEqual(depth(r.order[k]) - quantum);
    expect(new Set(r.order).size).toBe(r.count);
    // a pure function: the same input gives the same order
    expect(Array.from(sortBackToFront(pos, n, v).order)).toEqual(Array.from(r.order));
    // ties keep index order
    const same = new Float32Array(30).fill(0);
    const tie = sortBackToFront(same, 10, view([0, 0, -1], [0, 0, 1]));
    expect(Array.from(tie.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('the view key is snapped: tiny camera moves share a key, real moves do not', () => {
    const A = [2, 0, 0, 0, 2, 0, 0, 0, 2];
    const base = viewSetup(camera({ position: [1, 2, -5], target: [0, 0, 0] }), 100, 100);
    const k = (cam: Partial<CameraValue>) => sortView(viewSetup(camera({ position: [1, 2, -5], target: [0, 0, 0], ...cam }), 100, 100), A, [0, 0, 0], [0, 0, 0], 1).key;
    expect(sortView(base, A, [0, 0, 0], [0, 0, 0], 1).key).toBe(k({}));
    expect(k({ position: [1.0001, 2, -5] })).toBe(k({}));
    expect(k({ position: [1.5, 2, -5] })).not.toBe(k({}));
    expect(k({ position: [1, 2, -5], target: [0, 0.05, 0] })).not.toBe(k({}));
    expect(k({ fov: 60 })).toBe(k({})); // the lens does not change the order
  });
});

describe('picture draw order (occlusion compatible)', () => {
  /**
   * Paint a blocky heightfield from another camera twice: cell by cell in the picture order (later wins = painter's algorithm) and with an
   * exact z-buffer (one-pixel squares). The two images must agree on most pixels (the rest are cells almost, not exactly, on one ray of
   * the new camera); with the direction of the order deliberately reversed they must not.
   */
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cases: { name: string; cap: CameraValue; view: CameraValue }[] = [
    { name: 'persp/persp right', cap: camera(), view: camera({ position: [1.4, 0.2, -4.2] }) },
    { name: 'persp/persp left-up', cap: camera(), view: camera({ position: [-1.2, 0.9, -4.5] }) },
    { name: 'persp/persp from the far side (behind the picture plane)', cap: camera(), view: camera({ position: [0.3, 0.2, 9], target: [0, 0, 0] }) },
    { name: 'persp/persp beside the scene', cap: camera(), view: camera({ position: [3, 0, -2], target: [0, 0, 5] }) },
    { name: 'persp/ortho', cap: camera(), view: camera({ projection: 'orthographic', orthoSize: 6, position: [2, 1, -4], target: [0, 0, 0] }) },
    { name: 'ortho/persp', cap: camera({ projection: 'orthographic', orthoSize: 4 }), view: camera({ position: [1.5, -0.7, -4.5] }) },
    { name: 'ortho/ortho', cap: camera({ projection: 'orthographic', orthoSize: 4 }), view: camera({ projection: 'orthographic', orthoSize: 6, position: [-2, 1, -4], target: [0, 0, 0] }) },
  ];
  function mismatch(c: { cap: CameraValue; view: CameraValue }, reverse: boolean): number {
    const gw = 48, gh = 36, IW = 144, IH = 108, W = 160, H = 120;
    const rand = rng(17);
    const blocks = Array.from({ length: 16 * 12 }, () => 3 + rand() * 3);
    const dist = (x: number, y: number) => blocks[Math.floor(y / 3) * 16 + Math.floor(x / 3)];
    const capV = viewSetup(c.cap, IW, IH);
    const viewV = viewSetup(c.view, W, H);
    const ord = pictureOrder(capV, viewV, { w: gw, h: gh, imgW: IW, imgH: IH });
    if (reverse) {
      ord.x.dir = -ord.x.dir;
      ord.y.dir = -ord.y.dir;
    }
    const ish = Math.min(IW, IH);
    const point = (x: number, y: number): number[] => {
      const p = [((x + 0.5) / gw - 0.5) * IW, -((y + 0.5) / gh - 0.5) * IH];
      const uf = [p[0] / (ish / 2) - capV.shift[0], p[1] / (ish / 2) - capV.shift[1]];
      const d = dist(x, y);
      if (!capV.persp) return [0, 1, 2].map((k) => capV.pos[k] + capV.right[k] * uf[0] * capV.orthoHalf + capV.up[k] * uf[1] * capV.orthoHalf + capV.fwd[k] * d);
      const dir = [0, 1, 2].map((k) => capV.fwd[k] + capV.right[k] * uf[0] * capV.tanH + capV.up[k] * uf[1] * capV.tanH);
      const l = Math.hypot(...dir);
      return [0, 1, 2].map((k) => capV.pos[k] + (dir[k] / l) * d);
    };
    const short = Math.min(W, H);
    const toScreen = (P: number[]) => {
      const d = [P[0] - viewV.pos[0], P[1] - viewV.pos[1], P[2] - viewV.pos[2]];
      const t = [dot(d, viewV.right), dot(d, viewV.up), dot(d, viewV.fwd)];
      if (viewV.persp) {
        if (t[2] < 0.05) return null;
        const f = short / 2 / viewV.tanH;
        return { x: W / 2 + (f * t[0]) / t[2], y: H / 2 - (f * t[1]) / t[2], z: Math.hypot(...d), px: f / t[2] };
      }
      const f = short / 2 / viewV.orthoHalf;
      return { x: W / 2 + f * t[0], y: H / 2 - f * t[1], z: t[2], px: f };
    };
    const rank = (n: number, o: { split: number; dir: number }) => Array.from({ length: n }, (_, k) => axisIndex(k, n, o));
    const rx = rank(gw, ord.x);
    const ry = rank(gh, ord.y);
    const painter = new Int32Array(W * H).fill(-1);
    const zbuf = new Float32Array(W * H).fill(Infinity);
    const zid = new Int32Array(W * H).fill(-1);
    for (let ky = 0; ky < gh; ky++) {
      for (let kx = 0; kx < gw; kx++) {
        const x = rx[kx], y = ry[ky];
        const P = point(x, y);
        const sc = toScreen(P);
        if (!sc) continue;
        const Pn = point(Math.min(gw - 1, x + 1), y);
        const Pm = point(Math.max(0, x - 1), y);
        const world = Math.hypot(Pn[0] - Pm[0], Pn[1] - Pm[1], Pn[2] - Pm[2]) / 2;
        const side = Math.max(1, Math.min(world * sc.px * 0.25, 12));
        const id = y * gw + x;
        for (let py = Math.max(0, Math.floor(sc.y - side / 2)); py <= Math.min(H - 1, Math.floor(sc.y + side / 2)); py++) {
          for (let px = Math.max(0, Math.floor(sc.x - side / 2)); px <= Math.min(W - 1, Math.floor(sc.x + side / 2)); px++) {
            painter[py * W + px] = id;
            if (sc.z < zbuf[py * W + px]) {
              zbuf[py * W + px] = sc.z;
              zid[py * W + px] = id;
            }
          }
        }
      }
    }
    let covered = 0, bad = 0;
    for (let i = 0; i < W * H; i++) {
      if (zid[i] < 0) continue;
      covered++;
      if (painter[i] !== zid[i] && Math.abs(zbuf[i] - 0) >= 0) {
        // same block = same depth: not a real mismatch
        const a = painter[i], b = zid[i];
        if (dist(a % gw, Math.floor(a / gw)) !== dist(b % gw, Math.floor(b / gw))) bad++;
      }
    }
    return bad / covered;
  }
  for (const c of cases) {
    it(c.name, () => {
      const good = mismatch(c, false);
      const wrong = mismatch(c, true);
      if (process.env.SPLAT_VERBOSE) console.log(c.name, 'mismatch', good.toFixed(4), 'reversed', wrong.toFixed(4));
      // Cells one pixel apart that are nearly (not exactly) on one ray of the new camera can land in either order: a small floor remains.
      expect(good).toBeLessThan(0.18);
      expect(good).toBeLessThan(wrong * 0.45);
    });
  }
});

describe('synthetic clouds', () => {
  it('are deterministic', () => {
    expect(torusCloud(1000, 4).id).toBe(torusCloud(1000, 4).id);
    expect(torusCloud(1000, 4).id).not.toBe(torusCloud(1000, 5).id);
    const c = manualCloud([{ p: [0, 0, 0], s: [1, 1, 1], rgb: [1, 1, 1], o: 1 }]);
    expect(c.count).toBe(1);
  });
});
