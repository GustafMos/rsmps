// Splat from Video with a 3D Scan: the known-camera steps (argument arrays, step plan, the check of the camera model, the fallback).
// COLMAP is faked: nothing here proves point_triangulator accepts these arguments (see docs/SPLATS.md, "From a 3D Scan").
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { lookAtQuat } from '../../src/engine/lib/scan-coverage.ts';
import { DEFAULT_GRID, intrinsicsFromProjection } from '../../src/engine/lib/scan-data.ts';
import { colmapTextForSizes, scanTextFiles } from '../../src/engine/lib/scan-export.ts';
import { lensFromFov, projectionMatrix } from '../../src/engine/lib/xr-math.ts';
import { cleanKnown, cleanSettings, colmapArgs, createSplatTrainService, explainFailure, KNOWN_POSES_MISFIT, matcherFor, overall, parseProgress, readModelCounts, stepPlan, STEPS, triangulationOk } from './splat-train.mjs';

const P = { db: '/w/j/database.db', images: '/w/j/images', sparse: '/w/j/sparse', dense: '/w/j/dense', out: '/w/j/result', model: '/w/j/m', known: '/w/j/known', tri: '/w/j/triangulated', triOut: '/w/j/triangulated/0', refined: '/w/j/triangulated/refined' };
const scanSettings = (o = {}) => cleanSettings({ input: 'scan', ...o });

const proj = projectionMatrix(lensFromFov(60, 0.75));
const shotAt = (i) => {
  const pos = [Math.sin(i), 0.4, Math.cos(i) - 2];
  return { asset: `a${i}`, t: i, pos, quat: lookAtQuat(pos, [0, 0.3, -2]), w: 90, h: 120, ...intrinsicsFromProjection(proj, 90, 120), sharp: 0.8 };
};
const scan = { v: 1, units: 'm', target: { center: [0, 0.3, -2], radius: 0.5, up: [0, 1, 0] }, grid: { ...DEFAULT_GRID }, shots: [0, 1, 2, 3].map(shotAt) };
const names = [0, 1, 2, 3].map((i) => `frame_${String(i).padStart(4, '0')}.jpg`);
const known = () => colmapTextForSizes(scan, scan.shots.map(() => ({ width: 45, height: 60 })), names);

describe('known-camera arguments', () => {
  it('a scan job extracts with PINHOLE and one camera per photo; the others keep SIMPLE_RADIAL', () => {
    const a = colmapArgs('extract', P, scanSettings()).join(' ');
    expect(a).toContain('--ImageReader.camera_model PINHOLE');
    expect(a).toContain('--ImageReader.single_camera 0');
    expect(colmapArgs('extract', P, cleanSettings({ input: 'video' })).join(' ')).toContain('SIMPLE_RADIAL');
  });
  it('point_triangulator: database, images, the known model in, a folder out; no mapper', () => {
    expect(colmapArgs('triangulate', P, scanSettings())).toEqual(['point_triangulator', '--database_path', P.db, '--image_path', P.images, '--input_path', P.known, '--output_path', P.triOut, '--log_color', '0', '--log_target', 'stderr']);
  });
  it('bundle_adjuster refines the triangulated model into its own folder', () => {
    expect(colmapArgs('refine', P, scanSettings({ refine: true }))).toEqual(['bundle_adjuster', '--input_path', P.triOut, '--output_path', P.refined, '--log_color', '0', '--log_target', 'stderr']);
  });
  it('a scan is matched like a photo set: exhaustive up to 150, sequential with the wide window above', () => {
    expect(matcherFor(scanSettings(), 100)).toBe('exhaustive');
    expect(matcherFor(scanSettings(), 200)).toBe('sequential');
    expect(colmapArgs('match', P, scanSettings(), { frames: 200 }).join(' ')).toContain('--SequentialMatching.overlap 20');
  });
  it('refine is on only when asked; nothing else about the settings changes', () => {
    expect(scanSettings().refine).toBe(false);
    expect(scanSettings({ refine: true }).refine).toBe(true);
    expect(scanSettings({ refine: 'yes' }).refine).toBe(false);
    expect(cleanSettings({ input: 'scan' }).input).toBe('scan');
  });
});

describe('step plan', () => {
  const ids = (s) => stepPlan(s).map((x) => x.id);
  it('video and photos keep the old plan', () => {
    expect(stepPlan(cleanSettings({ input: 'video' }))).toBe(STEPS);
    expect(stepPlan(cleanSettings({ input: 'photos' }))).toBe(STEPS);
  });
  it('a scan triangulates (and refines only when asked); solve stays for the fallback', () => {
    expect(ids(scanSettings())).toEqual(['extract', 'match', 'triangulate', 'solve', 'undistort', 'train']);
    expect(ids(scanSettings({ refine: true }))).toEqual(['extract', 'match', 'triangulate', 'refine', 'solve', 'undistort', 'train']);
  });
  it('the bar never goes backwards from one step to the next and ends at 1', () => {
    for (const s of [scanSettings(), scanSettings({ refine: true })]) {
      const plan = stepPlan(s);
      for (const st of plan) {
        expect(st.to).toBeGreaterThan(st.from);
        expect(overall(st.id, 1, 1, plan)).toBeCloseTo(st.to, 9);
      }
      expect(plan.at(-1).to).toBe(1);
      expect(overall('train', 1, 1, plan)).toBe(1);
      // the steps that run in a row (without the fallback) are in order
      const run = plan.filter((x) => x.id !== 'solve');
      run.forEach((x, i) => i && expect(x.from).toBeGreaterThanOrEqual(run[i - 1].to - 1e-9));
    }
  });
  it('triangulation and refining print nothing the bar can use, and a failed triangulation reads as the plain sentence', () => {
    expect(parseProgress('triangulate', 'anything')).toBeNull();
    expect(explainFailure('triangulate', 1, '')).toBe(KNOWN_POSES_MISFIT);
    expect(KNOWN_POSES_MISFIT).toBe('The saved camera positions did not fit the photos; solving them from the pictures instead.');
    expect(explainFailure('refine', 3, '')).toMatch(/could not refine the cameras/);
    expect(explainFailure('refine', -1, '', { timedOut: 30 * 60000 })).toMatch(/^Refine cameras took longer than 30 minutes/);
  });
  it('is the triangulated model usable? enough images placed and enough points', () => {
    expect(triangulationOk({ images: 80, points: 5000 }, 80)).toBe(true);
    expect(triangulationOk({ images: 80, points: 40 }, 80)).toBe(false);
    expect(triangulationOk({ images: 2, points: 5000 }, 4)).toBe(false);
    expect(triangulationOk({ images: 0, points: 0 }, 80)).toBe(false);
  });
});

describe('the known camera model the renderer sends', () => {
  it('the text the app writes passes the check, and the check refuses anything else', () => {
    const k = known();
    expect(cleanKnown(k, names).cameras).toBe(k.cameras);
    expect(() => cleanKnown(k, names.slice(1))).toThrow(/expected form/); // a frame is missing from the job
    expect(() => cleanKnown({ ...k, images: k.images.replace('frame_0001.jpg', '../x.jpg') }, names)).toThrow();
    expect(() => cleanKnown({ ...k, cameras: '1 SIMPLE_RADIAL 90 120 1 2 3 4\n' }, names)).toThrow();
    expect(() => cleanKnown({ cameras: k.cameras, images: k.images.replace(/\n$/, '\n9 9\n') }, names)).toThrow();
    expect(() => cleanKnown(null, names)).toThrow();
  });
  it('is scaled to the real photo size: a 90 x 120 still sent at 45 x 60 has half the focal length', () => {
    const full = scanTextFiles(scan).text['sparse/0/cameras.txt'].split('\n').find((l) => l.startsWith('1 '));
    const half = known().cameras.split('\n').find((l) => l.startsWith('1 '));
    const [fx1, fy1] = full.split(' ').slice(4, 6).map(Number);
    const [fx2, fy2] = half.split(' ').slice(4, 6).map(Number);
    expect(fx2).toBeCloseTo(fx1 / 2, 9);
    expect(fy2).toBeCloseTo(fy1 / 2, 9);
    expect(half).toContain(' 45 60 ');
  });
});

/* ---- the service with fake programs ---- */
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const f64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
/** A binary model folder with `images` images and `points` points (poses and positions are nonsense: only the counts matter here). */
function writeModel(dir, images, points) {
  mkdirSync(dir, { recursive: true });
  const im = [u64(images)];
  for (let i = 0; i < images; i++) im.push(u32(i + 1), ...[1, 0, 0, 0, 0, 0, 0].map(f64), u32(1), Buffer.from(`frame_${String(i).padStart(4, '0')}.jpg\0`), u64(0));
  writeFileSync(join(dir, 'images.bin'), Buffer.concat(im));
  const pt = [u64(points)];
  for (let i = 0; i < points; i++) pt.push(u64(i + 1), f64(i), f64(0), f64(1), Buffer.from([1, 2, 3]), f64(0.5), u64(0));
  writeFileSync(join(dir, 'points3D.bin'), Buffer.concat(pt));
}

describe('service: scan job with fake programs', () => {
  const dirs = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const fakeSpawn = (script, calls) => (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.exitCode = null;
    c.pid = 999999;
    c.kill = () => undefined;
    const s = script(args) ?? { code: 0 };
    setTimeout(() => {
      for (const l of s.lines ?? []) c.stderr.write(l + '\n');
      c.exitCode = s.code ?? 0;
      c.emit('close', c.exitCode);
    }, 3);
    return c;
  };
  const make = (script) => {
    const root = mkdtempSync(join(tmpdir(), 'rsmps-splat-scan-'));
    dirs.push(root);
    const calls = [];
    const svc = createSplatTrainService({ root, tools: async () => ({ colmap: { path: 'colmap.exe', gpu: false }, brush: 'brush_app.exe' }), spawnImpl: fakeSpawn(script, calls) });
    return { svc, calls, root };
  };
  const start = (svc, settings = {}) => {
    const { id } = svc.create();
    names.forEach((n) => svc.addFrame(id, n, JPEG));
    svc.run(id, { input: 'scan', ...settings, known: known() });
    return id;
  };
  const arg = (call, flag) => call.args[call.args.indexOf(flag) + 1];

  it('triangulates with the known model; when COLMAP cannot, it says so and solves the cameras from the pictures', async () => {
    const { svc, calls, root } = make((args) => {
      if (args[0] === 'point_triangulator') return { code: 1, lines: ['Check failed: image name not found'] };
      if (args[0] === 'mapper') return { code: 1, lines: ['Failed to create any sparse model'] };
    });
    const id = start(svc);
    await svc.wait(id);
    expect(calls.map((c) => c.args[0])).toEqual(['feature_extractor', 'exhaustive_matcher', 'point_triangulator', 'mapper']);
    const tri = calls[2];
    expect(arg(tri, '--input_path')).toBe(join(root, 'jobs', id, 'known'));
    expect(arg(tri, '--database_path')).toBe(arg(calls[0], '--database_path'));
    expect(calls.every((c) => c.opts.shell === false)).toBe(true);
    const v = svc.get(id);
    expect(v.warnings).toContain(KNOWN_POSES_MISFIT);
    expect(v.state).toBe('failed'); // the fake mapper also found nothing
  });

  it('writes the known model (cameras, images, empty points) for the triangulator to read', async () => {
    const seen = {};
    const { svc } = make((args) => {
      if (args[0] === 'point_triangulator') {
        const dir = arg({ args }, '--input_path');
        seen.cameras = readFileSync(join(dir, 'cameras.txt'), 'utf8');
        seen.images = readFileSync(join(dir, 'images.txt'), 'utf8');
        seen.points = readFileSync(join(dir, 'points3D.txt'), 'utf8');
        seen.outExists = existsSync(arg({ args }, '--output_path')); // the output folder exists before the tool runs
        return { code: 1 };
      }
      if (args[0] === 'mapper') return { code: 1 };
    });
    const id = start(svc);
    await svc.wait(id);
    expect(seen.cameras).toBe(known().cameras);
    expect(seen.images).toBe(known().images);
    expect(seen.points).toContain('Number of points: 0');
    expect(seen.outExists).toBe(true);
  });

  it('a triangulation that finds almost no points also falls back', async () => {
    const { svc, calls } = make((args) => {
      if (args[0] === 'point_triangulator') {
        writeModel(arg({ args }, '--output_path'), 4, 10);
        return { code: 0 };
      }
      if (args[0] === 'mapper') return { code: 1 };
    });
    const id = start(svc);
    await svc.wait(id);
    expect(calls.map((c) => c.args[0])).toEqual(['feature_extractor', 'exhaustive_matcher', 'point_triangulator', 'mapper']);
    expect(svc.get(id).warnings).toContain(KNOWN_POSES_MISFIT);
  });

  it('a good triangulation goes straight to preparing the frames with that model: no mapper', async () => {
    const { svc, calls, root } = make((args) => {
      if (args[0] === 'point_triangulator') {
        writeModel(arg({ args }, '--output_path'), 4, 400);
        return { code: 0 };
      }
      if (args[0] === 'image_undistorter') return { code: 1 }; // stop here: the rest needs real models
    });
    const id = start(svc);
    await svc.wait(id);
    expect(calls.map((c) => c.args[0])).toEqual(['feature_extractor', 'exhaustive_matcher', 'point_triangulator', 'image_undistorter']);
    expect(arg(calls[3], '--input_path')).toBe(join(root, 'jobs', id, 'triangulated', '0'));
    expect(svc.get(id).warnings).not.toContain(KNOWN_POSES_MISFIT);
  });

  it('Refine cameras runs bundle_adjuster and prepares the frames from its result; a failed refine keeps the triangulated model', async () => {
    const ok = make((args) => {
      if (args[0] === 'point_triangulator') return writeModel(arg({ args }, '--output_path'), 4, 400), { code: 0 };
      if (args[0] === 'bundle_adjuster') return writeModel(arg({ args }, '--output_path'), 4, 400), { code: 0 };
      if (args[0] === 'image_undistorter') return { code: 1 };
    });
    const a = start(ok.svc, { refine: true });
    await ok.svc.wait(a);
    expect(ok.calls.map((c) => c.args[0])).toEqual(['feature_extractor', 'exhaustive_matcher', 'point_triangulator', 'bundle_adjuster', 'image_undistorter']);
    expect(arg(ok.calls[4], '--input_path')).toBe(join(ok.root, 'jobs', a, 'triangulated', 'refined'));

    const bad = make((args) => {
      if (args[0] === 'point_triangulator') return writeModel(arg({ args }, '--output_path'), 4, 400), { code: 0 };
      if (args[0] === 'bundle_adjuster') return { code: 1 };
      if (args[0] === 'image_undistorter') return { code: 1 };
    });
    const b = start(bad.svc, { refine: true });
    await bad.svc.wait(b);
    expect(bad.calls.map((c) => c.args[0])).toEqual(['feature_extractor', 'exhaustive_matcher', 'point_triangulator', 'bundle_adjuster', 'image_undistorter']);
    expect(arg(bad.calls[4], '--input_path')).toBe(join(bad.root, 'jobs', b, 'triangulated', '0'));
    expect(bad.svc.get(b).warnings.join(' ')).toMatch(/Refining the cameras failed/);
  });

  it('a camera model the check refuses is ignored with the same sentence, and the job solves from the pictures', async () => {
    const { svc, calls } = make((args) => (args[0] === 'mapper' ? { code: 1 } : undefined));
    const { id } = svc.create();
    names.forEach((n) => svc.addFrame(id, n, JPEG));
    svc.run(id, { input: 'scan', known: { cameras: 'rm -rf /', images: '' } });
    await svc.wait(id);
    expect(calls.map((c) => c.args[0])).toEqual(['feature_extractor', 'exhaustive_matcher', 'mapper']);
    expect(svc.get(id).warnings).toContain(KNOWN_POSES_MISFIT);
  });

  it('readModelCounts reads the counts of a model folder and gives zeros for a missing one', () => {
    const d = mkdtempSync(join(tmpdir(), 'rsmps-counts-'));
    dirs.push(d);
    writeModel(d, 3, 7);
    expect(readModelCounts(d)).toEqual({ images: 3, points: 7 });
    expect(readModelCounts(join(d, 'nope'))).toEqual({ images: 0, points: 0 });
  });
});
