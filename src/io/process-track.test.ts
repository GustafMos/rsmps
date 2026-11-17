/**
 * Track "Analyse clip": the second real user of process mode. The job detects every frame once and tracks the WHOLE clip in one pass;
 * afterwards the node serves the stored regions without evaluating the detector.
 */
import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph, setParam } from '../engine/graph';
import { regionsSource } from '../engine/lib/track-testutil';
import { runTracker, runTrackerAll } from '../engine/lib/track-tracker';
import { withProcessResult } from '../engine/process';
import { RenderTally, harness } from '../engine/testing';
import type { GraphDoc, Host, ProcessLive, Region, RegionsValue } from '../engine/types';
import { EvalGate } from './gate';
import { MemoryProcessLibrary, ProcessRuntime } from './processes';

const FPS = 10;
const FRAMES = 40;
const box = (cx: number, cy: number, s = 0.1): [number, number, number, number] => [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2];
const det = (f: number): Region[] => [
  { id: 0, label: 'obj', score: 0.9, box: box(0.1 + 0.02 * f, 0.4) },
  { id: 0, label: 'obj', score: 0.9, box: box(0.9 - 0.02 * f, 0.7) },
];

async function setup(params: Record<string, unknown> = { history: 10, memory: 2 }) {
  const lib = new MemoryProcessLibrary();
  let detections = 0;
  const sid = `proc-regions-${Math.random().toString(36).slice(2)}`;
  const host: Host = {
    assetInfo: (id) => lib.assetInfo(id),
    assetFrame: async () => null,
    assetBytes: (id) => lib.assetBytes(id),
    processLive: (n): ProcessLive | null => rt.live(n),
  };
  const t = await harness(
    [
      regionsSource(sid, (f) => {
        detections++;
        return det(f);
      }),
    ],
    host,
  );
  lib.gpu = t.gpu;
  lib.onChange = () => t.engine.clear();
  const rt: ProcessRuntime = new ProcessRuntime({ engine: t.engine, gpu: t.gpu, registry: t.registry, gate: new EvalGate(t.engine), library: lib, host });
  let g: GraphDoc = createGraph('track-proc');
  g = { ...g, project: { ...g.project, width: 64, height: 64, fps: FPS, duration: FRAMES / FPS, loop: false } };
  const s = addNode(g, t.registry, sid);
  const tr = addNode(s.graph, t.registry, 'track', { x: 0, y: 0 }, params);
  g = connect(tr.graph, t.registry, { node: s.node.id, port: 'regions' }, { node: tr.node.id, port: 'regions' });
  const regions = async (graph: GraphDoc, f: number) => {
    const r = await t.engine.evaluate({ graph, node: tr.node.id, seconds: f / FPS });
    expect(r.errors.size).toBe(0);
    return (r.value as RegionsValue).items;
  };
  return { t, rt, lib, g, src: s.node.id, track: tr.node.id, regions, detections: () => detections };
}

describe('track: Analyse clip (process mode)', () => {
  it('whole-clip ids are global and equal to the tracker run from frame 0; the detector is never evaluated afterwards', async () => {
    const { t, rt, lib, g, track, regions, detections } = await setup();
    expect(rt.status(g, track)?.state).toBe('none');

    // Stand-in ('preview'): the windowed tracker. An object that lives longer than "Keep ids for" gets a new id when the window moves.
    const windowed = new Set<number>();
    for (let f = 0; f < FRAMES; f += 1) for (const r of await regions(g, f)) if (r.box[1] < 0.5) windowed.add(r.id);
    expect(windowed.size).toBeGreaterThan(1);

    const result = await rt.run(g, track);
    expect(result.meta.frames).toBe(FRAMES);
    expect(result.items.tracks.kind).toBe('blob');
    expect(rt.job(track)).toMatchObject({ state: 'done', gpu: false });
    expect(lib.assets.size).toBe(1);
    const done = withProcessResult(g, t.registry, track, result);
    expect(rt.status(done, track)?.state).toBe('done');

    // identical to a direct run of the tracker over the whole clip, frame by frame
    const seq = Array.from({ length: FRAMES }, (_, f) => det(f));
    const opts = { maxMove: 0.12, smooth: 0.35, hold: 4, matchLabels: true, loopFrames: 0 };
    const all = runTrackerAll(seq, 0, opts);
    for (const k of [0, 7, 19, 39]) expect(all[k]).toEqual(runTracker(seq.slice(0, k + 1), 0, opts)); // the "all frames" pass equals the prefix runs

    const before = detections();
    const upstream = new RenderTally();
    const ids = new Set<number>();
    t.engine.clear();
    for (let f = 0; f < FRAMES; f++) {
      const r = await t.engine.evaluate({ graph: done, node: track, seconds: f / FPS });
      upstream.add(r);
      const items = (r.value as RegionsValue).items;
      expect(items).toEqual(all[f]);
      for (const x of items) if (x.box[1] < 0.5) ids.add(x.id);
    }
    expect(detections() - before).toBe(0); // zero detections: everything came from the store
    expect(upstream.get(track)).toBe(FRAMES);
    expect(ids.size).toBe(1); // one object, one id, for the whole clip
  });

  it('is stale when the tracker settings or the detector change, and then shows the windowed stand-in again', async () => {
    const { t, rt, g, src, track, regions } = await setup();
    const done = withProcessResult(g, t.registry, track, await rt.run(g, track));
    expect(rt.status(done, track)?.state).toBe('done');
    expect(rt.status(setParam(done, track, 'smooth', 0.8), track)?.state).toBe('stale');
    expect(rt.status(setParam(done, track, 'history', 50), track)?.state).toBe('done'); // window settings only shape the stand-in
    expect(rt.status(setParam(done, src, 'x', 1), track)?.state).toBe('stale');
    const stale = setParam(done, track, 'smooth', 0.8);
    const windowed = new Set<number>();
    for (let f = 0; f < FRAMES; f++) for (const r of await regions(stale, f)) if (r.box[1] < 0.5) windowed.add(r.id);
    expect(windowed.size).toBeGreaterThan(1);
  });

  it('export gate: never run = not required (the stand-in is the old behaviour); run once and lost = required', async () => {
    const { t, rt, lib, g, track } = await setup();
    expect(rt.pending(g, [track])).toEqual([]);
    const done = withProcessResult(g, t.registry, track, await rt.run(g, track));
    expect(rt.pending(done, [track])).toEqual([]);
    lib.assets.clear();
    expect(rt.pending(done, [track])).toMatchObject([{ node: track, title: 'Analyze clip', state: 'missing' }]);
    const stale = setParam(withProcessResult(g, t.registry, track, await rt.run(g, track)), track, 'smooth', 0.9);
    expect(rt.pending(stale, [track])).toMatchObject([{ state: 'stale' }]);
  });

  it('a node without a process refuses to run and stores nothing', async () => {
    const { rt, lib, g, track, t } = await setup();
    void t;
    const bad = { ...g, nodes: g.nodes.filter((n) => n.type !== 'track') };
    await expect(rt.run(bad, track)).rejects.toThrow(/no process/);
    expect(lib.assets.size).toBe(0);
  });
});
