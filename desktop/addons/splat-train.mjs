// "Splat from Video" pipeline for the desktop app: COLMAP (camera solving) then Brush (Gaussian splat training), run as child processes.
// Runs in the Electron main process; no Electron imports, so the pure parts and the whole pipeline can be tested with plain Node.
//
// Safety: programs are started with argument ARRAYS (never a shell, never a command string); nothing the renderer sends is put into an
// argument except numbers from fixed choices; every path is built here from the job folder and checked to stay inside it; frame names
// are validated. Cancelling kills the whole process tree. Each step has a timeout. Measured behaviour (stage 0, docs/SPLATS.md) decided
// the defaults: SIFT on the CPU unless the CUDA build is installed (the no-CUDA build HANGS without output when asked for GPU SIFT),
// sequential matching for video, exhaustive for photo sets, the incremental mapper, undistorted PINHOLE images for training, Brush with
// spherical harmonics degree 1 (the viewer renders degree 1 only; degree 3 + discard measured 0.7 dB worse).
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseCamerasBin, parseImagesBin, parsePointsBin, poseOf, solveStats, PARALLAX_FAIL, PARALLAX_WARN } from '../../src/engine/lib/colmap.ts';

export class SplatTrainError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Pure parts                                                                                                                     */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** Training presets. Steps and the longest image side Brush trains at; max splats keeps memory bounded. Stage 0 (RTX 3080, 48 frames at
 * 640 px): 3 000 steps 33 s, 10 000 steps 90 s. */
export const QUALITY = {
  draft: { steps: 3000, resolution: 960, maxSplats: 300_000, label: 'Draft' },
  normal: { steps: 10000, resolution: 1280, maxSplats: 1_000_000, label: 'Normal' },
  high: { steps: 30000, resolution: 1600, maxSplats: 3_000_000, label: 'High' },
};
export const MAX_FRAMES = 400;
export const MAX_FRAME_BYTES = 24 * 1024 * 1024;
/** Above this many photos exhaustive matching (every pair) gets slow: auto switches to sequential with a wide overlap. */
export const EXHAUSTIVE_MAX = 150;

const ONE = new Set(['draft', 'normal', 'high']);

/** Settings from the renderer, reduced to fixed choices and clamped numbers (nothing else ever reaches a command line). */
export function cleanSettings(raw = {}) {
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  return {
    quality: ONE.has(raw.quality) ? raw.quality : 'normal',
    input: pick(raw.input, ['video', 'photos'], 'video'),
    matcher: pick(raw.matcher, ['auto', 'sequential', 'exhaustive'], 'auto'),
    solver: pick(raw.solver, ['auto', 'incremental', 'global'], 'auto'),
    keepPoses: raw.keepPoses !== false,
    singleCamera: raw.singleCamera !== false,
    threads: Math.max(1, Math.min(64, Math.round(Number(raw.threads) || 4))),
  };
}

export function matcherFor(s, frames) {
  if (s.matcher !== 'auto') return s.matcher;
  return s.input === 'photos' && frames <= EXHAUSTIVE_MAX ? 'exhaustive' : 'sequential';
}

/** Argument arrays of every COLMAP step. `p` = absolute paths built by the service. */
export function colmapArgs(step, p, s, { gpu = false, frames = 0 } = {}) {
  const log = ['--log_color', '0', '--log_target', 'stderr'];
  const g = gpu ? '1' : '0';
  const t = String(s.threads);
  switch (step) {
    case 'extract':
      return ['feature_extractor', '--database_path', p.db, '--image_path', p.images, '--ImageReader.camera_model', 'SIMPLE_RADIAL', '--ImageReader.single_camera', s.singleCamera ? '1' : '0', '--FeatureExtraction.type', 'SIFT', '--FeatureExtraction.use_gpu', g, '--FeatureExtraction.num_threads', t, '--FeatureExtraction.max_image_size', '1600', '--SiftExtraction.max_num_features', '8192', ...log];
    case 'match': {
      const m = matcherFor(s, frames);
      const common = ['--database_path', p.db, '--FeatureMatching.type', 'SIFT_BRUTEFORCE', '--FeatureMatching.use_gpu', g, '--FeatureMatching.num_threads', t];
      if (m === 'exhaustive') return ['exhaustive_matcher', ...common, '--ExhaustiveMatching.block_size', '25', ...log];
      // photo sets that are too big for exhaustive matching come here too: a wider window helps when the order is less strict
      const overlap = s.input === 'photos' ? '20' : '10';
      return ['sequential_matcher', ...common, '--SequentialMatching.overlap', overlap, '--SequentialMatching.quadratic_overlap', '1', '--SequentialMatching.loop_detection', '0', ...log];
    }
    case 'solve':
      return s.solver === 'global'
        ? ['global_mapper', '--database_path', p.db, '--image_path', p.images, '--output_path', p.sparse, '--GlobalMapper.num_threads', t, ...log]
        : ['mapper', '--database_path', p.db, '--image_path', p.images, '--output_path', p.sparse, '--Mapper.num_threads', t, ...log];
    case 'undistort':
      return ['image_undistorter', '--image_path', p.images, '--input_path', p.model, '--output_path', p.dense, '--output_type', 'COLMAP', '--max_image_size', String(QUALITY[s.quality].resolution), ...log];
    default:
      throw new Error(`unknown step ${step}`);
  }
}

export function brushArgs(p, s) {
  const q = QUALITY[s.quality];
  return [p.dense, '--total-steps', String(q.steps), '--sh-degree', '1', '--max-resolution', String(q.resolution), '--max-splats', String(q.maxSplats), '--export-every', String(q.steps), '--export-path', p.out, '--export-name', 'splat.ply', '--seed', '42'];
}

/**
 * Progress from one line of a tool's log: { done, total } within the current step, or null. Formats recorded from COLMAP 4.2.1 and
 * Brush 0.3.0 (with RUST_LOG=brush_cli=info):
 *   feature_extractor   "Processed file [12/48]"
 *   sequential_matcher  "Processing image [7/60]"
 *   exhaustive_matcher  "Processing block [2/5, 3/5]"
 *   mapper              "Registering image #31 (num_reg_frames=2)"   (frames placed so far; total = frames)
 *   global_mapper       "=== Running global positioning ===" and friends (5 phases)
 *   brush               "Refine iter 201, 5938 splats."               (every 200 steps; total = steps)
 */
const GLOBAL_PHASES = ['rotation averaging', 'track establishment', 'global positioning', 'iterative bundle adjustment', 'iterative retriangulation'];
export function parseProgress(step, line, ctx = {}) {
  let m;
  if (step === 'extract' && (m = /Processed file \[(\d+)\/(\d+)\]/.exec(line))) return { done: +m[1], total: +m[2] };
  if (step === 'match') {
    if ((m = /Processing image \[(\d+)\/(\d+)\]/.exec(line))) return { done: +m[1] - 1, total: +m[2] };
    if ((m = /Processing block \[(\d+)\/(\d+), (\d+)\/(\d+)\]/.exec(line))) return { done: (+m[1] - 1) * +m[4] + (+m[3] - 1), total: +m[2] * +m[4] };
  }
  if (step === 'solve') {
    if ((m = /num_reg_frames=(\d+)/.exec(line))) return { done: +m[1], total: Math.max(+m[1], ctx.frames ?? 0) };
    if ((m = /=== Running (.+?) ===/.exec(line))) {
      const i = GLOBAL_PHASES.indexOf(m[1].toLowerCase());
      if (i >= 0) return { done: i, total: GLOBAL_PHASES.length };
    }
  }
  if (step === 'train' && (m = /Refine iter (\d+), (\d+) splats/.exec(line))) return { done: +m[1], total: ctx.steps ?? 0, splats: +m[2] };
  return null;
}

/** Where each step sits in the overall bar, and its name for the panel. */
export const STEPS = [
  { id: 'extract', label: 'Extract features', from: 0, to: 0.08 },
  { id: 'match', label: 'Match', from: 0.08, to: 0.25 },
  { id: 'solve', label: 'Solve cameras', from: 0.25, to: 0.4 },
  { id: 'undistort', label: 'Prepare frames', from: 0.4, to: 0.43 },
  { id: 'train', label: 'Train', from: 0.43, to: 1 },
];

export function overall(step, done, total) {
  const s = STEPS.find((x) => x.id === step);
  if (!s) return 0;
  const f = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return s.from + (s.to - s.from) * f;
}

/** A readable message for a failed step, from its exit code and the end of its log (signatures recorded in stage 0). */
export function explainFailure(step, code, log, extra = {}) {
  const tail = String(log ?? '').slice(-6000);
  if (extra.timedOut) return `${STEPS.find((s) => s.id === step)?.label ?? step} took longer than ${Math.round(extra.timedOut / 60000)} minutes and was stopped. Try fewer frames, a smaller frame size or the Draft quality.`;
  if (extra.spawnError) return `The program could not be started (${extra.spawnError}). Check the add-on in Plugins > Official add-ons.`;
  if (step === 'extract') {
    if (/No images found|could not read|Failed to read image/i.test(tail)) return 'COLMAP could not read the frames.';
    return `COLMAP could not extract features (exit code ${code}).`;
  }
  if (step === 'match') return `COLMAP could not match the frames (exit code ${code}).`;
  if (step === 'solve') {
    if (/No images with matches/.test(tail)) return 'No two frames share recognisable detail, so no camera could be placed. Splats need sharp, textured footage (plain walls, sky, water and motion blur do not work).';
    if (/No good initial image pair|initial image pair/i.test(tail) && /Failed to create|No (sparse )?model/i.test(tail)) return 'COLMAP found no good starting pair of frames: the camera must MOVE sideways around the subject (parallax), not only turn, and the frames need sharp texture.';
    if (/Failed to create any sparse model/.test(tail)) return 'COLMAP could not place the cameras. Move around the subject slowly, keep it sharp and textured, and avoid moving objects.';
    return `COLMAP could not solve the cameras (exit code ${code}).`;
  }
  if (step === 'undistort') return `COLMAP could not prepare the frames for training (exit code ${code}).`;
  if (step === 'train') {
    const err = /Error: (.+)/.exec(tail);
    if (/out of memory|OutOfMemory|allocation/i.test(tail)) return 'Brush ran out of graphics memory. Use the Draft quality, fewer frames or a smaller frame size.';
    if (/adapter|No suitable|Vulkan|wgpu/i.test(tail) && /Error/.test(tail)) return 'Brush could not use the graphics card. Update the graphics driver; Brush needs Vulkan (Windows, Linux) or Metal (macOS).';
    return err ? `Brush stopped: ${err[1].trim()}` : `Brush stopped (exit code ${code}).`;
  }
  return `${step} failed (exit code ${code}).`;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}\.(jpg|jpeg|png)$/;
export function safeFrameName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new SplatTrainError('Bad frame name.');
  return name;
}

/** `child` resolved inside `root` (or root itself)? */
export function inside(root, child) {
  const r = resolve(root);
  const c = resolve(child);
  return c === r || c.startsWith(r + sep);
}

/** The largest model COLMAP wrote (sparse/0, sparse/1... when it split the scene), by registered images. */
export function pickModel(sparseDir, read = (f) => readFileSync(f)) {
  if (!existsSync(sparseDir)) return null;
  let best = null;
  for (const d of readdirSync(sparseDir)) {
    if (!/^\d+$/.test(d)) continue;
    const f = join(sparseDir, d, 'images.bin');
    if (!existsSync(f)) continue;
    const b = read(f);
    const n = b.length >= 8 ? b.readUInt32LE(0) : 0;
    if (!best || n > best.images) best = { dir: join(sparseDir, d), images: n };
  }
  return best;
}

const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

/** The solved model as compact JSON for the renderer (cameras + poses + stats; no 2D points). */
export function modelJson(modelDir) {
  const cameras = [...parseCamerasBin(ab(readFileSync(join(modelDir, 'cameras.bin')))).values()];
  const images = parseImagesBin(ab(readFileSync(join(modelDir, 'images.bin'))));
  const points = parsePointsBin(ab(readFileSync(join(modelDir, 'points3D.bin'))));
  const stats = solveStats(images.map(poseOf), points);
  // a small sample of the sparse points (for orientation / centring), at most 4000
  const n = points.length / 3;
  const step = Math.max(1, Math.ceil(n / 4000));
  const sample = [];
  for (let i = 0; i < n; i += step) sample.push(+points[i * 3].toFixed(5), +points[i * 3 + 1].toFixed(5), +points[i * 3 + 2].toFixed(5));
  return { cameras, images: images.map((i) => ({ name: i.name, q: i.q, t: i.t, cameraId: i.cameraId })), points: sample, stats };
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Processes                                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------------------ */

/** Kill a child and everything it started. Windows needs taskkill /T; elsewhere the child leads its own process group. */
export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
}

/** Run one program. Lines of stdout and stderr go to `onLine`; resolves { code, log } (log = the last 200 kB). Never a shell. */
export function runTool(bin, args, { cwd, env, timeoutMs, onLine, signal, logFile, spawnImpl = spawn }) {
  return new Promise((ok) => {
    let child;
    try {
      child = spawnImpl(bin, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      ok({ code: -1, log: '', spawnError: String(err?.message ?? err) });
      return;
    }
    let log = '';
    let timedOut = 0;
    const pending = { out: '', err: '' };
    const feed = (key, chunk) => {
      const text = pending[key] + chunk.toString('utf8');
      const lines = text.split(/\r?\n|\r/);
      pending[key] = lines.pop() ?? '';
      for (const l of lines) {
        log += l + '\n';
        if (log.length > 400_000) log = log.slice(-200_000);
        if (logFile) try { appendFileSync(logFile, l + '\n'); } catch { /* the log is a convenience */ }
        onLine?.(l);
      }
    };
    child.stdout?.on('data', (d) => feed('out', d));
    child.stderr?.on('data', (d) => feed('err', d));
    const timer = timeoutMs ? setTimeout(() => ((timedOut = timeoutMs), killTree(child)), timeoutMs) : null;
    const onAbort = () => killTree(child);
    signal?.addEventListener('abort', onAbort, { once: true });
    let spawnError = '';
    child.on('error', (e) => (spawnError = String(e?.message ?? e)));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      for (const k of ['out', 'err']) if (pending[k]) feed(k, '\n');
      ok({ code: code ?? -1, log, ...(timedOut ? { timedOut } : {}), ...(spawnError ? { spawnError } : {}) });
    });
  });
}

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Service                                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------------------ */

const MIN = 60_000;
export const TIMEOUTS = { extract: 30 * MIN, match: 90 * MIN, solve: 90 * MIN, undistort: 15 * MIN, train: 6 * 60 * MIN };
const JOB_TTL_MS = 24 * 60 * MIN;
const CACHE_KEEP = 3;

function freeBytes(dir) {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return Infinity; // unknown: do not block
  }
}

/**
 * @param {{ root: string, tools: () => Promise<{ colmap: { path: string, gpu: boolean } | null, brush: string | null }>, free?: (dir: string) => number, spawnImpl?: typeof spawn }} cfg
 */
export function createSplatTrainService({ root, tools, free = freeBytes, spawnImpl = spawn }) {
  const jobsDir = join(root, 'jobs');
  const cacheDir = join(root, 'cache');
  const brushHome = join(root, 'brush-home'); // Brush writes its GPU autotune cache to its working folder: keep one across jobs
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(brushHome, { recursive: true });
  // forget jobs of earlier sessions
  for (const d of readdirSync(jobsDir)) {
    try {
      if (Date.now() - statSync(join(jobsDir, d)).mtimeMs > JOB_TTL_MS || !/^[0-9a-f]{16}$/.test(d)) rmSync(join(jobsDir, d), { recursive: true, force: true });
    } catch {
      /* in use or gone */
    }
  }
  /** @type {Map<string, any>} */
  const jobs = new Map();
  const need = (id) => {
    const j = typeof id === 'string' && /^[0-9a-f]{16}$/.test(id) ? jobs.get(id) : null;
    if (!j) throw new SplatTrainError('Unknown or finished reconstruction job.', 404);
    return j;
  };
  const view = (j) => ({
    id: j.id,
    state: j.state,
    step: j.step,
    stepLabel: STEPS.find((s) => s.id === j.step)?.label ?? '',
    progress: j.progress,
    note: j.note,
    frames: j.frames.length,
    ...(j.error ? { error: j.error } : {}),
    warnings: j.warnings,
    ...(j.report ? { report: j.report } : {}),
  });

  async function status() {
    const t = await tools();
    const missing = [...(t.colmap ? [] : ['colmap']), ...(t.brush ? [] : ['brush'])];
    return { available: missing.length === 0, missing, colmapGpu: !!t.colmap?.gpu, active: [...jobs.values()].some((j) => j.state === 'running') };
  }

  function create() {
    if ([...jobs.values()].some((j) => j.state === 'running')) throw new SplatTrainError('A reconstruction is already running. Wait for it or cancel it.', 409);
    const id = randomBytes(8).toString('hex');
    const dir = join(jobsDir, id);
    mkdirSync(join(dir, 'images'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const j = { id, dir, state: 'receiving', step: '', progress: 0, note: '', frames: [], bytes: 0, warnings: [], error: '', report: null, abort: new AbortController(), hash: createHash('sha256') };
    jobs.set(id, j);
    return view(j);
  }

  function addFrame(id, name, bytes) {
    const j = need(id);
    if (j.state !== 'receiving') throw new SplatTrainError('This job is no longer accepting frames.', 409);
    safeFrameName(name);
    if (j.frames.includes(name)) throw new SplatTrainError('That frame was already sent.', 409);
    if (j.frames.length >= MAX_FRAMES) throw new SplatTrainError(`At most ${MAX_FRAMES} frames.`);
    if (!bytes?.length || bytes.length > MAX_FRAME_BYTES) throw new SplatTrainError('A frame must be a JPEG or PNG of at most 24 MB.');
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const png = bytes[0] === 0x89 && bytes[1] === 0x50;
    if (!jpeg && !png) throw new SplatTrainError('A frame must be a JPEG or PNG file.');
    const file = join(j.dir, 'images', name);
    if (!inside(join(j.dir, 'images'), file)) throw new SplatTrainError('Bad frame name.');
    writeFileSync(file, bytes);
    j.frames.push(name);
    j.bytes += bytes.length;
    j.hash.update(name).update(bytes);
    return { frames: j.frames.length };
  }

  function cacheKey(j, s) {
    return createHash('sha256').update(j.frameHash).update(JSON.stringify({ input: s.input, matcher: matcherFor(s, j.frames.length), solver: s.solver, single: s.singleCamera, res: QUALITY[s.quality].resolution })).digest('hex').slice(0, 24);
  }

  function trimCache(keep) {
    const entries = readdirSync(cacheDir)
      .filter((d) => /^[0-9a-f]{24}$/.test(d))
      .map((d) => ({ d, t: statSync(join(cacheDir, d)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const e of entries.slice(CACHE_KEEP)) if (e.d !== keep) rmSync(join(cacheDir, e.d), { recursive: true, force: true });
  }

  async function step(j, id, bin, args, opts = {}) {
    if (j.abort.signal.aborted) throw new SplatTrainError('Cancelled.', 499);
    j.step = id;
    j.progress = overall(id, 0, 1);
    j.note = STEPS.find((s) => s.id === id)?.label ?? id;
    const started = Date.now();
    const r = await runTool(bin, args, {
      cwd: opts.cwd ?? j.dir,
      env: opts.env,
      timeoutMs: TIMEOUTS[id],
      signal: j.abort.signal,
      logFile: join(j.dir, 'logs', `${id}.log`),
      spawnImpl,
      onLine: (line) => {
        const p = parseProgress(id, line, { frames: j.frames.length, steps: QUALITY[j.settings.quality].steps });
        if (!p) return;
        j.progress = overall(id, p.done, p.total);
        j.note = id === 'train' ? `${j.note.split(':')[0]}: step ${p.done} of ${p.total}${p.splats ? `, ${p.splats.toLocaleString('en-US')} splats` : ''}` : `${STEPS.find((s) => s.id === id)?.label}: ${p.done} of ${p.total}`;
      },
    });
    j.timings[id] = (Date.now() - started) / 1000;
    if (j.abort.signal.aborted) throw new SplatTrainError('Cancelled.', 499);
    if (r.code !== 0) throw new SplatTrainError(explainFailure(id, r.code, r.log, r), 500);
    return r;
  }

  async function pipeline(j, s) {
    const t = await tools();
    if (!t.colmap || !t.brush) throw new SplatTrainError(`Missing add-on: ${[!t.colmap && 'COLMAP', !t.brush && 'Brush'].filter(Boolean).join(' and ')}. Install it in Plugins > Official add-ons.`, 409);
    const key = cacheKey(j, s);
    const cached = join(cacheDir, key);
    const p = { db: join(j.dir, 'database.db'), images: join(j.dir, 'images'), sparse: join(j.dir, 'sparse'), dense: join(j.dir, 'dense'), out: join(j.dir, 'result'), model: '' };
    for (const v of Object.values(p)) if (v && !inside(j.dir, v)) throw new SplatTrainError('Bad work folder.', 500);
    mkdirSync(p.out, { recursive: true });
    let reused = false;
    if (existsSync(join(cached, 'dense', 'sparse', 'images.bin'))) {
      p.dense = join(cached, 'dense');
      reused = true;
      utimesSync(cached, new Date(), new Date()); // the cache is trimmed oldest-first by folder time
    } else {
      mkdirSync(p.sparse, { recursive: true });
      await step(j, 'extract', t.colmap.path, colmapArgs('extract', p, s, { gpu: t.colmap.gpu }));
      await step(j, 'match', t.colmap.path, colmapArgs('match', p, s, { gpu: t.colmap.gpu, frames: j.frames.length }));
      const solve = await step(j, 'solve', t.colmap.path, colmapArgs('solve', p, s));
      const best = pickModel(p.sparse);
      if (!best) throw new SplatTrainError(explainFailure('solve', 0, solve.log + '\nFailed to create any sparse model'), 500);
      p.model = best.dir;
      await step(j, 'undistort', t.colmap.path, colmapArgs('undistort', p, s));
    }
    const model = modelJson(join(p.dense, 'sparse'));
    const reg = model.images.length;
    if (reg < 3) throw new SplatTrainError(`COLMAP placed only ${reg} of ${j.frames.length} frames. Move around the subject slowly with more overlap between frames.`, 500);
    if (reg < j.frames.length * 0.5) j.warnings.push(`Only ${reg} of ${j.frames.length} frames could be placed; the rest are left out.`);
    if (model.stats.parallax < PARALLAX_FAIL) throw new SplatTrainError('The camera hardly moved sideways (it only turned). Splats need parallax: walk or move the camera around the subject.', 500);
    if (model.stats.parallax < PARALLAX_WARN) j.warnings.push('The camera moved only a little sideways; expect a blurry or flat result.');
    if (!reused && s.keepPoses) {
      rmSync(cached, { recursive: true, force: true });
      mkdirSync(cached, { recursive: true });
      try {
        renameSync(p.dense, join(cached, 'dense'));
      } catch {
        cpSync(p.dense, join(cached, 'dense'), { recursive: true });
      }
      p.dense = join(cached, 'dense');
      trimCache(key);
    }
    await step(j, 'train', t.brush, brushArgs(p, s), { cwd: brushHome, env: { RUST_LOG: 'brush_cli=info' } });
    const ply = join(p.out, 'splat.ply');
    if (!existsSync(ply)) throw new SplatTrainError('Brush finished without writing a splat file.', 500);
    writeFileSync(join(p.out, 'model.json'), JSON.stringify(model));
    j.report = { frames: j.frames.length, registered: reg, parallax: +model.stats.parallax.toFixed(3), sparsePoints: model.stats.points, quality: s.quality, steps: QUALITY[s.quality].steps, matcher: matcherFor(s, j.frames.length), solver: s.solver === 'global' ? 'global' : 'incremental', colmapGpu: t.colmap.gpu, reusedPoses: reused, timings: j.timings, plyBytes: statSync(ply).size, warnings: j.warnings };
    writeFileSync(join(p.out, 'report.json'), JSON.stringify(j.report, null, 1));
    // the frames, the database and (unless kept) the solved model are no longer needed
    for (const d of ['images', 'database.db', 'sparse', 'dense']) rmSync(join(j.dir, d), { recursive: true, force: true });
  }

  function run(id, rawSettings) {
    const j = need(id);
    if (j.state !== 'receiving') throw new SplatTrainError('This job was already started.', 409);
    if (j.frames.length < 3) throw new SplatTrainError('At least 3 frames are needed.');
    const s = cleanSettings(rawSettings);
    const needBytes = 2e9 + j.bytes * 12;
    const have = free(root);
    if (have < needBytes) throw new SplatTrainError(`Not enough free disk space: about ${(needBytes / 1e9).toFixed(1)} GB is needed in the app data folder, ${(have / 1e9).toFixed(1)} GB is free.`, 507);
    j.settings = s;
    j.frameHash = j.hash.digest('hex');
    j.timings = {};
    j.state = 'running';
    j.started = Date.now();
    j.done = pipeline(j, s).then(
      () => {
        j.state = 'done';
        j.progress = 1;
        j.note = 'Done';
      },
      (err) => {
        j.state = j.abort.signal.aborted ? 'cancelled' : 'failed';
        j.error = j.state === 'cancelled' ? 'Cancelled.' : String(err?.message ?? err);
        // keep the logs for a failed job (they are small), drop the bulky parts
        for (const d of ['images', 'database.db', 'dense']) rmSync(join(j.dir, d), { recursive: true, force: true });
      },
    );
    return view(j);
  }

  function result(id, what) {
    const j = need(id);
    if (j.state !== 'done') throw new SplatTrainError('The reconstruction is not finished.', 409);
    const file = { ply: 'splat.ply', model: 'model.json', report: 'report.json' }[what];
    if (!file) throw new SplatTrainError('Unknown result.', 404);
    return readFileSync(join(j.dir, 'result', file));
  }

  function cancel(id) {
    const j = jobs.get(id);
    if (!j) return { cancelled: true };
    j.abort.abort();
    if (j.state === 'receiving') {
      j.state = 'cancelled';
      rmSync(j.dir, { recursive: true, force: true });
    }
    return view(j);
  }

  async function dispose(id) {
    const j = jobs.get(id);
    if (!j) return { disposed: true };
    j.abort.abort();
    await j.done?.catch(() => undefined);
    rmSync(j.dir, { recursive: true, force: true });
    jobs.delete(id);
    return { disposed: true };
  }

  return {
    root,
    jobs,
    status,
    create,
    addFrame,
    run,
    get: (id) => view(need(id)),
    result,
    cancel,
    dispose,
    async disposeAll() {
      for (const id of [...jobs.keys()]) await dispose(id);
    },
    /** For tests: wait for a running job. */
    wait: (id) => need(id).done,
  };
}
