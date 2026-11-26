import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { brushArgs, cleanSettings, colmapArgs, createSplatTrainService, explainFailure, inside, matcherFor, overall, parseProgress, QUALITY, runTool, safeFrameName } from './splat-train.mjs';

// Lines recorded from COLMAP 4.2.1 (Windows, no CUDA) and Brush 0.3.0 runs on the stage-0 scene (docs/SPLATS.md).
const LOG = {
  extract: 'I20261116 16:06:30.117254 25300 feature_extraction.cc:270] Processed file [1/48]',
  seq: 'I20261116 16:13:17.421486 24764 pairing.cc:562] Processing image [2/60]',
  block: 'I20261116 16:06:34.111806 21872 pairing.cc:214] Processing block [1/1, 1/1]',
  mapper: 'I20261116 16:07:33.445155 10108 incremental_pipeline.cc:620] Registering image #31 (num_reg_frames=2)',
  global: 'I20261116 16:13:41.531612 26504 global_mapper.cc:575] === Running global positioning ===',
  brush: '[2026-11-16T15:25:58Z INFO  brush_cli] Refine iter 201, 5938 splats.',
  noMatches: 'W20261116 16:30:36.158859 23092 incremental_pipeline.cc:390] No images with matches\nE20261116 16:30:36.158864 23092 sfm.cc:310] Failed to create any sparse model',
  brushError: 'Error: I/O error while constructing BrushVfs.\n\nCaused by:\n    The system cannot find the path specified. (os error 3)',
};

const P = { db: 'W/database.db', images: 'W/images', sparse: 'W/sparse', dense: 'W/dense', out: 'W/result', model: 'W/sparse/0' };

describe('arguments', () => {
  it('only fixed choices and clamped numbers survive from the renderer', () => {
    const s = cleanSettings({ quality: 'ultra; rm -rf /', matcher: '--evil', solver: 'global', threads: 1e9, input: 'photos' });
    expect(s).toEqual({ quality: 'normal', input: 'photos', matcher: 'auto', solver: 'global', keepPoses: true, refine: false, singleCamera: true, threads: 64 });
  });
  it('video = sequential, photo sets = exhaustive up to 150 images', () => {
    expect(matcherFor(cleanSettings({ input: 'video' }), 80)).toBe('sequential');
    expect(matcherFor(cleanSettings({ input: 'photos' }), 80)).toBe('exhaustive');
    expect(matcherFor(cleanSettings({ input: 'photos' }), 200)).toBe('sequential');
    expect(matcherFor(cleanSettings({ input: 'video', matcher: 'exhaustive' }), 80)).toBe('exhaustive');
  });
  it('COLMAP: CPU SIFT unless the CUDA build is installed, SIFT matcher (no model downloads), one camera, no loop detection', () => {
    const s = cleanSettings({});
    const ex = colmapArgs('extract', P, s, { gpu: false });
    expect(ex[0]).toBe('feature_extractor');
    expect(ex.join(' ')).toContain('--FeatureExtraction.use_gpu 0');
    expect(ex.join(' ')).toContain('--ImageReader.single_camera 1');
    expect(colmapArgs('extract', P, s, { gpu: true }).join(' ')).toContain('--FeatureExtraction.use_gpu 1');
    const m = colmapArgs('match', P, s, { frames: 60 });
    expect(m[0]).toBe('sequential_matcher');
    expect(m.join(' ')).toContain('--FeatureMatching.type SIFT_BRUTEFORCE');
    expect(m.join(' ')).toContain('--SequentialMatching.loop_detection 0');
    expect(colmapArgs('solve', P, s)[0]).toBe('mapper');
    expect(colmapArgs('solve', P, cleanSettings({ solver: 'global' }))[0]).toBe('global_mapper');
    expect(colmapArgs('undistort', P, cleanSettings({ quality: 'draft' })).join(' ')).toContain('--max_image_size 960');
    for (const step of ['extract', 'match', 'solve', 'undistort']) for (const a of colmapArgs(step, P, s, { frames: 10 })) expect(typeof a).toBe('string');
  });
  it('Brush: SH degree 1 (what the viewer draws), steps and size from the preset, one export at the end', () => {
    const a = brushArgs(P, cleanSettings({ quality: 'draft' }));
    expect(a[0]).toBe('W/dense');
    expect(a.join(' ')).toContain(`--total-steps ${QUALITY.draft.steps}`);
    expect(a.join(' ')).toContain(`--export-every ${QUALITY.draft.steps}`);
    expect(a.join(' ')).toContain('--sh-degree 1');
    expect(a.join(' ')).toContain('--export-name splat.ply');
  });
});

describe('progress and errors from recorded logs', () => {
  it('parses every format', () => {
    expect(parseProgress('extract', LOG.extract)).toEqual({ done: 1, total: 48 });
    expect(parseProgress('match', LOG.seq)).toEqual({ done: 1, total: 60 });
    expect(parseProgress('match', LOG.block)).toEqual({ done: 0, total: 1 });
    expect(parseProgress('solve', LOG.mapper, { frames: 48 })).toEqual({ done: 2, total: 48 });
    expect(parseProgress('solve', LOG.global)).toEqual({ done: 2, total: 5 });
    expect(parseProgress('train', LOG.brush, { steps: 3000 })).toEqual({ done: 201, total: 3000, splats: 5938 });
    expect(parseProgress('train', 'noise')).toBeNull();
  });
  it('overall progress is monotonic across steps', () => {
    const seq = [overall('extract', 0, 1), overall('extract', 1, 1), overall('match', 5, 10), overall('solve', 1, 1), overall('train', 0, 10), overall('train', 10, 10)];
    for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
    expect(seq.at(-1)).toBe(1);
  });
  it('failure signatures become plain advice', () => {
    expect(explainFailure('solve', 1, LOG.noMatches)).toMatch(/textured footage/);
    expect(explainFailure('solve', 1, 'Finding good initial image pair\nNo good initial image pair found.\nFailed to create any sparse model')).toMatch(/MOVE sideways/);
    expect(explainFailure('train', 1, LOG.brushError)).toMatch(/^Brush stopped: I\/O error/);
    expect(explainFailure('train', 1, 'Error: out of memory')).toMatch(/graphics memory/);
    expect(explainFailure('match', 0, '', { timedOut: 90 * 60000 })).toMatch(/longer than 90 minutes/);
    expect(explainFailure('extract', -1, '', { spawnError: 'ENOENT' })).toMatch(/could not be started/);
  });
});

describe('paths and names', () => {
  it('frame names are plain, paths stay inside the job folder', () => {
    expect(safeFrameName('frame_0001.jpg')).toBe('frame_0001.jpg');
    for (const bad of ['../x.jpg', 'a/b.jpg', 'x.exe', 'C:\\x.jpg', '', '.jpg', 'a b.jpg']) expect(() => safeFrameName(bad)).toThrow();
    expect(inside('/w/job', '/w/job/images/a.jpg')).toBe(true);
    expect(inside('/w/job', '/w/job2/a.jpg')).toBe(false);
    expect(inside('/w/job', '/w/job/../x')).toBe(false);
  });
});

describe('service with fake programs', () => {
  const dirs = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  /** spawn stand-in: prints the given lines then exits with `code`, or waits forever (`hang`). Records every call. */
  const fakeSpawn = (script, calls) => (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const c = new EventEmitter();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.exitCode = null;
    c.pid = 999999;
    c.kill = () => {
      if (c.exitCode === null) {
        c.exitCode = 1;
        c.emit('close', 1);
      }
    };
    const s = script(args) ?? { lines: [], code: 0 };
    setTimeout(() => {
      for (const l of s.lines ?? []) c.stderr.write(l + '\n');
      if (!s.hang) {
        c.exitCode = s.code ?? 0;
        c.emit('close', c.exitCode);
      }
    }, 5);
    return c;
  };
  const make = (script, opts = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'rsmps-splat-svc-'));
    dirs.push(root);
    const calls = [];
    const svc = createSplatTrainService({ root, tools: async () => ({ colmap: { path: 'colmap.exe', gpu: false }, brush: 'brush_app.exe' }), spawnImpl: fakeSpawn(script, calls), free: opts.free });
    return { svc, calls, root };
  };
  const filled = (svc, n = 4) => {
    const { id } = svc.create();
    for (let i = 0; i < n; i++) svc.addFrame(id, `f_${i}.jpg`, JPEG);
    return id;
  };

  it('a mapper that finds nothing fails with the advice, the bulky files are deleted, the logs stay', async () => {
    const { svc, calls, root } = make((args) => (args[0] === 'mapper' ? { lines: LOG.noMatches.split('\n'), code: 1 } : { lines: [LOG.extract] }));
    const id = filled(svc);
    svc.run(id, { input: 'video' });
    await svc.wait(id);
    const v = svc.get(id);
    expect(v.state).toBe('failed');
    expect(v.error).toMatch(/textured footage/);
    expect(calls.map((c) => c.args[0])).toEqual(['feature_extractor', 'sequential_matcher', 'mapper']);
    expect(calls.every((c) => c.opts.shell === false)).toBe(true);
    expect(existsSync(join(root, 'jobs', id, 'images'))).toBe(false);
    expect(readdirSync(join(root, 'jobs', id, 'logs'))).toContain('solve.log');
    await svc.dispose(id);
    expect(existsSync(join(root, 'jobs', id))).toBe(false);
  });

  it('cancel stops a running step at once and reports cancelled', async () => {
    const { svc } = make((args) => (args[0] === 'feature_extractor' ? { lines: [LOG.extract], hang: true } : {}));
    const id = filled(svc);
    svc.run(id, {});
    await new Promise((r) => setTimeout(r, 30));
    expect(svc.get(id).note).toMatch(/Extract features: 1 of 48/);
    svc.cancel(id);
    await svc.wait(id);
    expect(svc.get(id).state).toBe('cancelled');
  });

  it('cancel kills the whole process TREE (a real child that started a grandchild)', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'rsmps-tree-')), 'pid');
    dirs.push(join(pidFile, '..'));
    const code = `const { spawn } = require('child_process'); const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(g.pid)); console.log('ready'); setTimeout(() => {}, 120000);`;
    const ac = new AbortController();
    const done = runTool(process.execPath, ['-e', code], { signal: ac.signal, onLine: (l) => l === 'ready' && setTimeout(() => ac.abort(), 50) });
    const r = await done;
    expect(r.code).not.toBe(0);
    const g = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((res) => setTimeout(res, 300));
    let alive = true;
    try {
      process.kill(g, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it('refuses a second job, bad frames, too few frames and a full disk', async () => {
    const { svc } = make(() => ({ hang: true }), { free: () => 1e6 });
    const { id } = svc.create();
    expect(() => svc.addFrame(id, 'x.jpg', Buffer.from('MZ not an image'))).toThrow(/JPEG or PNG/);
    expect(() => svc.addFrame(id, '../x.jpg', JPEG)).toThrow(/Bad frame name/);
    svc.addFrame(id, 'a.jpg', JPEG);
    expect(() => svc.addFrame(id, 'a.jpg', JPEG)).toThrow(/already/);
    expect(() => svc.run(id, {})).toThrow(/At least 3/);
    svc.addFrame(id, 'b.jpg', JPEG);
    svc.addFrame(id, 'c.jpg', JPEG);
    expect(() => svc.run(id, {})).toThrow(/disk space/);
    await svc.dispose(id);
  });

  it('missing add-ons are named', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rsmps-splat-svc-'));
    dirs.push(root);
    const svc = createSplatTrainService({ root, tools: async () => ({ colmap: null, brush: 'b' }) });
    expect(await svc.status()).toMatchObject({ available: false, missing: ['colmap'] });
  });

  it('runTool: argument arrays reach the program unchanged (no shell), lines stream, exit codes come back', async () => {
    const lines = [];
    const r = await runTool(process.execPath, ['-e', 'console.log(process.argv.slice(1).join("|")); console.error("err line"); process.exit(3)', 'a b', '&& echo pwned', '"q"'], { onLine: (l) => lines.push(l) });
    expect(r.code).toBe(3);
    expect(lines).toContain('a b|&& echo pwned|"q"');
    expect(lines).toContain('err line');
    const t = await runTool(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 });
    expect(t.timedOut).toBe(300);
  });
});
