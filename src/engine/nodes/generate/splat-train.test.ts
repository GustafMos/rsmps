/**
 * Splat from Video (`splat-train`). Always: stand-in, readable failures (web build / missing add-ons), the whole process with a fake
 * desktop host (frames sent, cloud stored in the tool's frame, renders, a solved camera that moves with time).
 *
 * OPT-IN end to end (the real COLMAP and Brush): set RSMPS_SPLAT_E2E to a folder holding the stage-0 scene (`scene/orbit/*.jpg`,
 * `scene/heldout/*.jpg`, `scene/cameras.json`, made by the scene script described in docs/SPLATS.md) and RSMPS_COLMAP / RSMPS_BRUSH to the
 * programs. The node then runs its real process: frame selection -> the REAL renderer client (src/io/splat-train.ts) -> the REAL
 * main-process module (desktop/addons/splat-train.mjs, behind a tiny in-test router standing in for desktop/main.mjs) -> COLMAP -> Brush,
 * and the result is compared with held-out ground-truth views and with the training views seen through the solved camera.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error the main-process module is plain JavaScript without type declarations
import { createSplatTrainService } from '../../../../desktop/addons/splat-train.mjs';
import { SplatTrainClient } from '../../../io/splat-train';
import { EvalGate } from '../../../io/gate';
import { MemoryProcessLibrary, ProcessRuntime } from '../../../io/processes';
import { defineNode } from '../../define';
import { addNode, connect, createGraph } from '../../graph';
import { cameraFromAxes, fitSimilarity, mulMV } from '../../lib/colmap';
import { ARC_CAMERA_TXT, ARC_COLMAP } from '../../lib/colmap-fixture';
import { cameraBasis, type V3 } from '../../lib/gen-camera';
import { writePng, sheet, PNG_DIR } from '../../lib/gen-3d-testutil';
import { finishCloud } from '../../lib/splat-cloud';
import { writeSplatPly } from '../../lib/splat-ply';
import { withProcessResult } from '../../process';
import { harness } from '../../testing';
import type { CameraValue, GraphDoc, Host, ImageValue, SplatTrainHost, SplatTrainOutput } from '../../types';

/** A camera source node (test only): params = position, target, fov, roll, shift. */
const camNode = defineNode({
  id: 'test-cam-src',
  title: 'cam',
  category: 'input',
  description: 'test camera',
  inputs: {},
  outputs: { camera: { type: 'camera' } },
  params: { json: { type: 'string', default: '' } },
  render: (ctx) => ({ camera: JSON.parse(ctx.params.json) as CameraValue }),
});

/** An animated clip from in-memory RGBA frames (one per project frame). */
function clipNode(id: string, frames: { data: Uint8ClampedArray; width: number; height: number }[]) {
  return defineNode({
    id,
    title: 'clip',
    category: 'input',
    description: 'test clip',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      const f = frames[Math.min(frames.length - 1, ctx.time.frame)];
      const img = ctx.gpu.upload(f.data, f.width, f.height, 1, true);
      return { image: img };
    },
  });
}

async function setup(frames: { data: Uint8ClampedArray; width: number; height: number }[], fps: number, splatTrain?: SplatTrainHost) {
  const lib = new MemoryProcessLibrary();
  let rt: ProcessRuntime;
  const host: Host = {
    assetInfo: (id) => lib.assetInfo(id),
    assetFrame: (id, s) => lib.assetFrame(id, s),
    assetBytes: (id) => lib.assetBytes(id),
    processLive: (n) => rt.live(n),
    splatTrain,
  };
  const clipId = `test-clip-${Math.random().toString(36).slice(2)}`;
  const t = await harness([camNode, clipNode(clipId, frames)], host);
  lib.gpu = t.gpu;
  lib.onChange = () => t.engine.clear();
  rt = new ProcessRuntime({ engine: t.engine, gpu: t.gpu, registry: t.registry, gate: new EvalGate(t.engine), library: lib, host, encode: async (img) => new Blob([(await t.gpu.readRaw(img)) as BlobPart]) });
  let g: GraphDoc = createGraph('splat');
  g = { ...g, project: { ...g.project, width: frames[0].width, height: frames[0].height, fps, duration: frames.length / fps, loop: false } };
  const c = addNode(g, t.registry, clipId);
  const s = addNode(c.graph, t.registry, 'splat-train', { x: 0, y: 0 });
  g = connect(s.graph, t.registry, { node: c.node.id, port: 'image' }, { node: s.node.id, port: 'image' });
  return { t, rt, g, host, clip: c.node.id, node: s.node.id };
}

/** A clip whose picture moves (so frame selection finds motion): a textured strip sliding sideways. */
const slidingClip = (n: number, w = 64, h = 48) =>
  Array.from({ length: n }, (_, k) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = Math.sin((x + k * 2) * 0.7) * Math.cos(y * 0.9) > 0 ? 220 : 40;
      data.set([v, 255 - v, (x * 4) & 255, 255], (y * w + x) * 4);
    }
    return { data, width: w, height: h };
  });

/** The recorded COLMAP poses of the arc fixture and a small cloud in COLMAP's frame, as the desktop app would return them. */
function fakeOutput(): SplatTrainOutput {
  const cam = ARC_CAMERA_TXT.split(' ');
  const cloud = finishCloud(
    {
      count: 200,
      positions: Float32Array.from({ length: 600 }, (_, i) => Math.sin(i * 12.9898) * 1.5),
      scales: new Float32Array(600).fill(0.08),
      rotations: Float32Array.from({ length: 800 }, (_, i) => (i % 4 === 0 ? 1 : 0)),
      colors: Float32Array.from({ length: 600 }, (_, i) => 0.3 + 0.5 * Math.abs(Math.sin(i))),
      opacity: new Float32Array(200).fill(0.9),
      sh1: null,
    },
    'ply',
  );
  return {
    ply: writeSplatPly(cloud),
    model: {
      cameras: [{ id: 1, model: cam[1], width: +cam[2], height: +cam[3], params: cam.slice(4).map(Number) }],
      images: ARC_COLMAP.slice(0, 20).map(([, qw, qx, qy, qz, tx, ty, tz], i) => ({ name: `frame_${String(i).padStart(4, '0')}.jpg`, q: [qw, qx, qy, qz], t: [tx, ty, tz], cameraId: 1 })),
      points: [0, 0, 0, 0.5, 0, 0, 0, 0.5, 0.2],
      stats: { cameras: 20, points: 3, parallax: 1.5 },
    },
    report: { registered: 20 },
  };
}

describe('Splat from Video', () => {
  it('needs the desktop app; until processed the clip passes through', async () => {
    const frames = slidingClip(24);
    const { t, rt, g, node, clip } = await setup(frames, 12);
    const def = t.registry.get('splat-train')!;
    expect(def.title).toBe('Splat from Video');
    expect(def.requires).toEqual(['desktop']);
    const out = await t.engine.evaluate({ graph: g, node, seconds: 0.5 });
    const src = await t.engine.evaluate({ graph: g, node: clip, seconds: 0.5 });
    expect(out.errors.size).toBe(0);
    expect(await t.diff(out.value as ImageValue, src.value as ImageValue)).toBe(0);
    await expect(rt.run(g, node)).rejects.toThrow(/desktop app/);
  });

  it('missing add-ons are named and nothing is downloaded', async () => {
    let trained = 0;
    const host: SplatTrainHost = { status: async () => ({ available: false, missing: ['colmap', 'brush'] }), train: async () => (trained++, fakeOutput()) };
    const { rt, g, node } = await setup(slidingClip(12), 12, host);
    await expect(rt.run(g, node)).rejects.toThrow(/Missing add-ons: COLMAP and Brush\. Install them in Plugins > Official add-ons/);
    expect(trained).toBe(0);
  });

  it('runs the process: picks moving frames, sends them in order, stores a +y cloud and a camera path that moves with time', async () => {
    const sent: { width: number; height: number }[] = [];
    let settings: unknown = null;
    const host: SplatTrainHost = {
      status: async () => ({ available: true, missing: [] }),
      train: async (req) => {
        settings = req.settings;
        for (let i = 0; i < req.frameCount; i++) sent.push(await req.frame(i));
        req.onProgress(1, 'done');
        return fakeOutput();
      },
    };
    const { t, rt, g, node } = await setup(slidingClip(60), 12, host);
    const g2 = { ...g, nodes: g.nodes.map((n) => (n.id === node ? { ...n, params: { ...n.params, frames: 20 } } : n)) };
    const result = await rt.run(g2, node);
    expect(sent.length).toBeGreaterThan(10);
    expect(sent.length).toBeLessThanOrEqual(20);
    expect(settings).toMatchObject({ input: 'video', quality: 'normal', matcher: 'auto', solver: 'auto', keepPoses: true });
    expect(result.meta).toMatchObject({ splats: 200, registered: 20 });
    const done = withProcessResult(g2, t.registry, node, result);
    const img = await t.engine.evaluate({ graph: done, node, seconds: 0.2 });
    expect(img.errors.size).toBe(0);
    const px = await t.pixels(img.value as ImageValue);
    let covered = 0;
    for (let i = 3; i < px.data.length; i += 4) covered += px.data[i] > 0 ? 1 : 0;
    expect(covered).toBeGreaterThan(20); // the splats are drawn
    const c0 = (await t.engine.evaluate({ graph: done, node, port: 'camera', seconds: 0 })).value as CameraValue;
    const c1 = (await t.engine.evaluate({ graph: done, node, port: 'camera', seconds: 1.2 })).value as CameraValue;
    expect(c0.kind).toBe('camera');
    expect(Math.hypot(c0.position[0] - c1.position[0], c0.position[1] - c1.position[1], c0.position[2] - c1.position[2])).toBeGreaterThan(0.01);
    expect(c0.fov).toBeCloseTo(2 * Math.atan(240 / 460.33) * (180 / Math.PI), 1);
  });
});

/* ------------------------------------------------------------------------------------------------------------------------------ */
/* Opt-in end to end with the real programs                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------------------ */

const E2E = process.env.RSMPS_SPLAT_E2E;
const COLMAP = process.env.RSMPS_COLMAP;
const BRUSH = process.env.RSMPS_BRUSH;

/** The few routes of desktop/main.mjs's handleSplatTrain, over the real service (no Electron in a test). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function router(svc: any) {
  return async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).slice(2); // after __rsmps/splat-train
    const ok = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    try {
      if (!parts.length) return ok(await svc.status());
      if (parts[0] === 'start') return ok(svc.create());
      const [id, action, what] = parts;
      if (!action) return ok(svc.get(id));
      if (action === 'result') return what === 'ply' ? new Response(svc.result(id, what)) : new Response(svc.result(id, what), { headers: { 'content-type': 'application/json' } });
      if (action === 'frame') return ok(svc.addFrame(id, u.searchParams.get('name') ?? '', Buffer.from(init.body as Uint8Array)));
      if (action === 'run') return ok(svc.run(id, JSON.parse(String(init.body))));
      if (action === 'cancel') return ok(svc.cancel(id));
      if (action === 'dispose') return ok(await svc.dispose(id));
    } catch (e) {
      return new Response(JSON.stringify({ error: String((e as Error).message) }), { status: (e as { status?: number }).status ?? 500, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  };
}

describe.skipIf(!E2E || !COLMAP || !BRUSH)('Splat from Video end to end with COLMAP and Brush (opt-in)', () => {
  it('clip -> frames -> COLMAP -> Brush -> stored splats render the held-out views; the solved camera reproduces the shot', { timeout: 60 * 60_000 }, async () => {
    const sharp = (await import('sharp')).default;
    const scene = join(E2E!, 'scene');
    const truth = JSON.parse(readFileSync(join(scene, 'cameras.json'), 'utf8'));
    const set = process.env.RSMPS_SPLAT_SET ?? 'orbit';
    const files = readdirSync(join(scene, set)).filter((f) => f.endsWith('.jpg')).sort();
    const decode = async (f: string) => {
      const { data, info } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
    };
    const frames = await Promise.all(files.map((f) => decode(join(scene, set, f))));
    const root = mkdtempSync(join(tmpdir(), 'rsmps-splat-e2e-'));
    const svc = createSplatTrainService({ root, tools: async () => ({ colmap: { path: COLMAP!, gpu: false }, brush: BRUSH! }) });
    const jpeg = async (px: Uint8ClampedArray, w: number, h: number) => new Uint8Array(await sharp(Buffer.from(px.buffer, px.byteOffset, px.byteLength), { raw: { width: w, height: h, channels: 4 } }).jpeg({ quality: 92 }).toBuffer());
    const client = new SplatTrainClient(router(svc) as never, 'app://rsmps/__rsmps/', jpeg, 500);
    const fps = 12;
    const { t, rt, g, node, host } = await setup(frames, fps, client);
    const quality = process.env.RSMPS_SPLAT_QUALITY ?? 'normal';
    const g2 = { ...g, nodes: g.nodes.map((n) => (n.id === node ? { ...n, params: { ...n.params, frames: Number(process.env.RSMPS_SPLAT_FRAMES ?? 80), trainQuality: quality, minOpacity: 0 } } : n)) };
    const t0 = performance.now();
    const notes: string[] = [];
    const result = await rt.run(g2, node, { onProgress: (p) => p.note && notes[notes.length - 1] !== p.note.split(':')[0] && notes.push(p.note.split(':')[0]) });
    const seconds = (performance.now() - t0) / 1000;
    const done = withProcessResult(g2, t.registry, node, result);
    expect(readdirSync(join(root, 'jobs'))).toEqual([]); // the job folder is gone after the result was read

    // the solved camera at each sent frame vs the truth: one similarity maps the truth into the node's world
    const solve = JSON.parse(new TextDecoder().decode((await host.assetBytes!(result.items.solve.id))!));
    const sentTimes: number[] = solve.frames.map((f: { seconds: number }) => f.seconds);
    const X: V3[] = [];
    const Y: V3[] = [];
    const ours: CameraValue[] = [];
    for (const s of sentTimes) {
      const cam = (await t.engine.evaluate({ graph: done, node, port: 'camera', seconds: s })).value as CameraValue;
      const v = truth.sets[set][Math.round(s * fps)];
      X.push(v.p);
      Y.push(cam.position as V3);
      ours.push(cam);
    }
    const sim = fitSimilarity(X, Y);
    const toNode = (p: V3): V3 => mulMV(sim.R, p).map((x, i) => sim.s * x + sim.t[i]) as V3;
    const W = frames[0].width;
    const H = frames[0].height;
    const camSrc = addNode(done, t.registry, 'test-cam-src');
    const withCam = (c: CameraValue) => {
      const gg = connect(camSrc.graph, t.registry, { node: camSrc.node.id, port: 'camera' }, { node, port: 'camera' });
      return { ...gg, nodes: gg.nodes.map((n) => (n.id === camSrc.node.id ? { ...n, params: { json: JSON.stringify(c) } } : n)) };
    };
    const psnr = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
      let s = 0;
      for (let i = 0; i < W * H; i++) for (let k = 0; k < 3; k++) s += ((a[i * 4 + k] * a[i * 4 + 3]) / 255 - b[i * 4 + k]) ** 2;
      return 10 * Math.log10((255 * 255) / (s / (W * H * 3)));
    };
    const pics: { data: Uint8ClampedArray; width: number; height: number }[] = [];
    const held: number[] = [];
    for (const v of truth.sets.heldout) {
      const b = cameraBasis({ position: v.p, target: v.t, roll: 0 });
      const c = cameraFromAxes(toNode(v.p), mulMV(sim.R, b.forward), mulMV(sim.R, b.right), { width: W, height: H, model: 'PINHOLE', params: [1, 1, W / 2, H / 2] });
      c.fov = truth.fovShortSideDeg;
      const r = await t.engine.evaluate({ graph: withCam(c), node, seconds: 0 });
      const px = await t.pixels(r.value as ImageValue);
      const gt = await decode(join(scene, 'heldout', v.name));
      held.push(psnr(px.data, gt.data));
      pics.push(gt, px);
    }
    // match-moving: the node's own solved camera at a sent frame, wired back into it, shows that frame
    const mm: number[] = [];
    for (const k of [0, Math.floor(sentTimes.length / 2)]) {
      const r = await t.engine.evaluate({ graph: withCam(ours[k]), node, seconds: sentTimes[k] });
      const px = await t.pixels(r.value as ImageValue);
      const gt = frames[Math.round(sentTimes[k] * fps)];
      mm.push(psnr(px.data, gt.data));
      pics.push(gt, px);
    }
    const file = writePng(`splat-train/e2e-${set}-${quality}`, sheet(pics, 2));
    const mean = held.reduce((a, b) => a + b, 0) / held.length;
    console.log(JSON.stringify({ set, quality, frames: sentTimes.length, registered: result.meta.registered, splats: result.meta.splats, seconds: +seconds.toFixed(1), stages: notes, positionRmsVsTruth: +(sim.rms / sim.s).toFixed(4), heldOutPsnr: held.map((x) => +x.toFixed(2)), heldOutMean: +mean.toFixed(2), matchMovePsnr: mm.map((x) => +x.toFixed(2)), png: file, previews: PNG_DIR }));
    expect(result.meta.registered).toBeGreaterThan(sentTimes.length * 0.8);
    expect(Math.min(...mm)).toBeGreaterThan(20);
    if (set === 'orbit') expect(mean).toBeGreaterThan(21);
    rmSync(root, { recursive: true, force: true });
  });
});
