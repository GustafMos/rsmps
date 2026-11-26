/**
 * Stabilize node contract, on the real GPU with a RAM process library: a synthetic shaky sequence (a textured picture moved and turned by a
 * known jitter per frame, with a bright blob to measure) is analysed by the real process path and rendered. The residual jitter of the blob
 * is measured before and after.
 *
 * Set STABILIZE_SHEETS=<dir> to also write contact sheets (PPM) of before and after.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defineNode } from '../engine/define';
import { addNode, connect, createGraph, setParam } from '../engine/graph';
import { withProcessResult } from '../engine/process';
import { applySim, IDENTITY, type Sim } from '../engine/lib/stabilize';
import { render as drawScene } from '../engine/lib/stabilize-testkit';
import stabilize from '../engine/nodes/transform/stabilize.node';
import { harness } from '../engine/testing';
import type { GraphDoc, Host, ImageValue, ProcessLive } from '../engine/types';
import { EvalGate } from './gate';
import { MemoryProcessLibrary, ProcessRuntime } from './processes';

const FPS = 12;
const W = 256;
const H = 192;
const L = W;
const deg = (a: number) => (a * Math.PI) / 180;
/** Where the bright blob sits in the scene (normalised units). */
const BLOB: [number, number] = [0.06, -0.05];

/** Deterministic pseudo-random in -1..1. */
const rnd = (i: number, k: number) => {
  let h = Math.imul(i + 1, 374761393) ^ Math.imul(k + 7, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 2147483647.5 - 1;
};

type Kind = 'small' | 'large';
/** Where the scene is in frame i. small: a camera held still with 4 percent of shake and 2 degrees of tilt. large: a slow pan plus jumps of 10 to 20 percent of the frame between frames (a hyperlapse). */
function pose(kind: Kind, i: number): Sim {
  if (i === 0) return IDENTITY;
  if (kind === 'small') return { ls: 0, rot: deg(2 * rnd(i, 3)), x: 0.04 * rnd(i, 1), y: 0.04 * rnd(i, 2) };
  // jumps of 10..20 percent of the width between neighbouring frames, on a pan of 1.5 percent per frame
  const jx = (k: number) => (k % 2 ? 1 : -1) * 0.07 * (1 + 0.5 * rnd(k, 4));
  return { ls: 0, rot: deg(1.5 * rnd(i, 3)), x: -0.015 * i + jx(i), y: 0.05 * rnd(i, 2) };
}

function sceneRgba(kind: Kind, i: number): Uint8ClampedArray {
  const t = pose(kind, i);
  const g = drawScene(W, H, t);
  const out = new Uint8ClampedArray(W * H * 4);
  const [bx, by] = applySim(t, BLOB[0], BLOB[1]);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = g.d[y * W + x] * 0.8;
      const qx = (x + 0.5 - W / 2) / L;
      const qy = (y + 0.5 - H / 2) / L;
      const d2 = ((qx - bx) ** 2 + (qy - by) ** 2) / 0.02 ** 2;
      const blob = Math.exp(-d2);
      const o = (y * W + x) * 4;
      out[o] = v + (255 - v) * blob;
      out[o + 1] = v * (1 - blob);
      out[o + 2] = v * (1 - blob);
      out[o + 3] = 255;
    }
  }
  return out;
}

async function setup(kind: Kind, frames: number) {
  const lib = new MemoryProcessLibrary();
  const src = defineNode({
    id: 'shaky-src',
    title: 'shaky',
    category: 'generate',
    description: 'a textured picture moved by a known jitter',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: { k: { type: 'number', default: 0 } },
    render(ctx) {
      const f = Math.min(frames - 1, ctx.time.frame);
      return { image: ctx.gpu.upload(sceneRgba(kind, f), W, H, 1) };
    },
  });
  const host: Host = {
    assetInfo: (id) => lib.assetInfo(id),
    assetFrame: (id, s) => lib.assetFrame(id, s),
    assetBytes: (id) => lib.assetBytes(id),
    processLive: (n): ProcessLive | null => rt.live(n),
  };
  const t = await harness([src, stabilize], host);
  lib.gpu = t.gpu;
  lib.onChange = () => t.engine.clear();
  const rt: ProcessRuntime = new ProcessRuntime({ engine: t.engine, gpu: t.gpu, registry: t.registry, gate: new EvalGate(t.engine), library: lib, host, encode: async (img) => new Blob([(await t.gpu.readRaw(img)) as BlobPart]) });
  let g: GraphDoc = createGraph('stab');
  g = { ...g, project: { ...g.project, width: W, height: H, fps: FPS, duration: frames / FPS, loop: false } };
  const a = addNode(g, t.registry, 'shaky-src');
  const s = addNode(a.graph, t.registry, 'stabilize');
  g = connect(s.graph, t.registry, { node: a.node.id, port: 'image' }, { node: s.node.id, port: 'image' });
  const ids = { src: a.node.id, stab: s.node.id };
  const frame = async (graph: GraphDoc, node: string, f: number): Promise<ImageValue> => {
    const r = await t.engine.evaluate({ graph, node, seconds: f / FPS });
    expect([...r.errors.values()]).toEqual([]);
    return r.value as ImageValue;
  };
  /** Centre of the red blob (pixels), by the weight of "redness" (r minus g). */
  const centroid = async (img: ImageValue): Promise<[number, number]> => {
    const px = await t.pixels(img);
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let y = 0; y < px.height; y++) {
      for (let x = 0; x < px.width; x++) {
        const [r, gg] = px.at(x, y);
        const w = Math.max(0, r - gg - 60);
        sx += w * (x + 0.5);
        sy += w * (y + 0.5);
        sw += w;
      }
    }
    return sw > 0 ? [sx / sw, sy / sw] : [NaN, NaN];
  };
  const analyse = async (graph: GraphDoc) => withProcessResult(graph, t.registry, ids.stab, await rt.run(graph, ids.stab));
  return { t, rt, g, ids, frame, centroid, analyse };
}

/** RMS distance of the points from a straight line fitted through them (a line in frame number: the pan). */
function residual(pts: [number, number][]): number {
  const n = pts.length;
  let sum = 0;
  for (const c of [0, 1]) {
    const mi = (n - 1) / 2;
    const mv = pts.reduce((a, p) => a + p[c], 0) / n;
    let num = 0;
    let den = 0;
    pts.forEach((p, i) => {
      num += (i - mi) * (p[c] - mv);
      den += (i - mi) ** 2;
    });
    const slope = num / den;
    pts.forEach((p, i) => {
      sum += (p[c] - (mv + slope * (i - mi))) ** 2;
    });
  }
  return Math.sqrt(sum / n);
}

function sheet(path: string, rows: ImageValue[][], px: (img: ImageValue) => Promise<Uint8ClampedArray>): Promise<void> {
  return (async () => {
    const cols = rows[0].length;
    const out = new Uint8Array(cols * W * rows.length * H * 3);
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols; c++) {
        const d = await px(rows[r][c]);
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const o = ((r * H + y) * cols * W + c * W + x) * 3;
            const i = (y * W + x) * 4;
            out[o] = d[i];
            out[o + 1] = d[i + 1];
            out[o + 2] = d[i + 2];
          }
        }
      }
    }
    writeFileSync(path, Buffer.concat([Buffer.from(`P6\n${cols * W} ${rows.length * H}\n255\n`), Buffer.from(out)]));
  })();
}

describe('Stabilize node', () => {
  it('before it is analysed the picture passes through unchanged and an export is told', async () => {
    const { rt, g, ids, frame, t } = await setup('small', 8);
    expect(rt.status(g, ids.stab)?.state).toBe('none');
    const a = await t.pixels(await frame(g, ids.src, 3));
    const b = await t.pixels(await frame(g, ids.stab, 3));
    expect(Array.from(b.data)).toEqual(Array.from(a.data));
    expect(rt.pending(g, [ids.stab]).length).toBe(1);
  });

  it('small shake: the residual jitter of a tracked blob is at least 5x smaller (Locked off and Smooth camera)', async () => {
    const N = 24;
    const { t, rt, g, ids, frame, centroid, analyse } = await setup('small', N);
    const done = await analyse(g);
    expect(rt.status(done, ids.stab)?.state).toBe('done');
    const meta = rt.status(done, ids.stab)?.result?.meta as Record<string, unknown>;
    expect(meta).toMatchObject({ frames: N, uncertain: 0, repeated: 0, item: null });
    expect(typeof meta.cpuMsPerFrame).toBe('number');
    // before
    const before: [number, number][] = [];
    for (let f = 0; f < N; f++) before.push(await centroid(await frame(done, ids.src, f)));
    const jitterBefore = residual(before);
    expect(jitterBefore).toBeGreaterThan(3);
    // after, locked off
    const locked = setParam(setParam(done, ids.stab, 'mode', 'locked'), ids.stab, 'edges', 'stretch');
    const after: [number, number][] = [];
    for (let f = 0; f < N; f++) after.push(await centroid(await frame(locked, ids.stab, f)));
    const jitterLocked = residual(after);
    // smooth camera, smoothed over the whole clip
    const smooth = setParam(setParam(done, ids.stab, 'smoothness', 20), ids.stab, 'edges', 'stretch');
    const afterSmooth: [number, number][] = [];
    for (let f = 0; f < N; f++) afterSmooth.push(await centroid(await frame(smooth, ids.stab, f)));
    const jitterSmooth = residual(afterSmooth);
    console.log(`STABILIZE small: before ${jitterBefore.toFixed(2)} px, locked ${jitterLocked.toFixed(2)} px (x${(jitterBefore / jitterLocked).toFixed(1)}), smooth ${jitterSmooth.toFixed(2)} px (x${(jitterBefore / jitterSmooth).toFixed(1)}), analysis CPU ${meta.cpuMsPerFrame} ms/frame`);
    expect(jitterLocked * 5).toBeLessThan(jitterBefore);
    expect(jitterSmooth * 5).toBeLessThan(jitterBefore);

    // Strength 0 is the picture as shot
    const none = setParam(done, ids.stab, 'strength', 0);
    const a = await t.pixels(await frame(none, ids.src, 5));
    const b = await t.pixels(await frame(none, ids.stab, 5));
    expect(Array.from(b.data)).toEqual(Array.from(a.data));

    // a node that is stale (the picture before it changed) keeps serving the old analysis
    const edited = setParam(done, ids.src, 'k', 1);
    expect(rt.status(edited, ids.stab)?.state).toBe('stale');
    const stale = await centroid(await frame(setParam(setParam(edited, ids.stab, 'mode', 'locked'), ids.stab, 'edges', 'stretch'), ids.stab, 7));
    expect(Math.abs(stale[0] - after[7][0])).toBeLessThan(0.5);

    const dir = process.env.STABILIZE_SHEETS;
    if (dir) {
      const pick = [0, 4, 8, 12, 16, 20];
      const rowA: ImageValue[] = [];
      const rowB: ImageValue[] = [];
      for (const f of pick) {
        rowA.push(await frame(done, ids.src, f));
        rowB.push(await frame(setParam(locked, ids.stab, 'edges', 'zoom'), ids.stab, f));
      }
      await sheet(`${dir}/small-shake.ppm`, [rowA, rowB], (img) => t.pixels(img).then((p) => p.data));
    }
  });

  it('hyperlapse jumps of 10 to 20 percent of the frame: a smooth pan comes out', async () => {
    const N = 24;
    const { t, g, ids, frame, centroid, analyse } = await setup('large', N);
    const done = await analyse(g);
    const before: [number, number][] = [];
    for (let f = 0; f < N; f++) before.push(await centroid(await frame(done, ids.src, f)));
    let maxJump = 0;
    for (let f = 1; f < N; f++) maxJump = Math.max(maxJump, Math.abs(before[f][0] - before[f - 1][0]));
    const jitterBefore = residual(before);
    const smooth = setParam(setParam(setParam(done, ids.stab, 'smoothness', 1.5), ids.stab, 'edges', 'stretch'), ids.stab, 'fixZoom', true);
    const after: [number, number][] = [];
    for (let f = 0; f < N; f++) after.push(await centroid(await frame(smooth, ids.stab, f)));
    const jitterAfter = residual(after);
    console.log(`STABILIZE large jumps: biggest jump ${(maxJump / W * 100).toFixed(1)} % of width, residual before ${jitterBefore.toFixed(2)} px, after ${jitterAfter.toFixed(2)} px (x${(jitterBefore / jitterAfter).toFixed(1)})`);
    expect(maxJump / W).toBeGreaterThan(0.1);
    expect(jitterAfter * 5).toBeLessThan(jitterBefore);

    const dir = process.env.STABILIZE_SHEETS;
    if (dir) {
      const pick = [0, 4, 8, 12, 16, 20];
      const rowA: ImageValue[] = [];
      const rowB: ImageValue[] = [];
      for (const f of pick) {
        rowA.push(await frame(done, ids.src, f));
        rowB.push(await frame(setParam(smooth, ids.stab, 'edges', 'mirror'), ids.stab, f));
      }
      await sheet(`${dir}/hyperlapse.ppm`, [rowA, rowB], (img) => t.pixels(img).then((p) => p.data));
    }
  });

  it('every edge mode and the track overlay render without errors', async () => {
    const N = 10;
    const { g, ids, frame, analyse } = await setup('small', N);
    const done = await analyse(g);
    for (const edges of ['zoom', 'mirror', 'stretch', 'clear', 'neighbours']) {
      const img = await frame(setParam(setParam(done, ids.stab, 'edges', edges), ids.stab, 'showTrack', edges === 'zoom'), ids.stab, 4);
      expect(img.width).toBe(W);
    }
  });
});
