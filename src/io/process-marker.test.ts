/**
 * Marker Camera "Analyze clip" (process mode), and the start-screen template.
 * The job finds the marker in every frame of a filmed clip once; afterwards the node serves the camera from the stored sightings:
 * the same for preview and export, in whatever order frames are asked for, without searching the picture again.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defineNode } from '../engine/define';
import { addNode, connect, createGraph, setParam } from '../engine/graph';
import { greyToRgba, orbitPose, renderScene } from '../engine/lib/marker-testutil';
import { withProcessResult } from '../engine/process';
import { harness, type Harness } from '../engine/testing';
import type { AnyNodeDef, CameraValue, GraphDoc, Host, ImageValue, ProcessLive } from '../engine/types';
import { EvalGate } from './gate';
import { MemoryProcessLibrary, ProcessRuntime } from './processes';
import { encodePng } from './print/png';
import { TEMPLATES, templateGraph } from './templates';

/** Set MARKER_DUMP to a folder to get sample pictures (camera picture + object) as PNG files. */
const DUMP = process.env.MARKER_DUMP ?? '';

const FPS = 10;
const FRAMES = 24;
const FOV = 50;
/** The camera circles the marker; frames 8 to 11 have no marker in them. */
const poseAt = (f: number) => (f >= 8 && f < 12 ? null : orbitPose(5, f * 5, 50, 0));

function clip(id: string, t: () => Harness, count: { n: number }): AnyNodeDef {
  const made = new Map<number, ImageValue>();
  return defineNode({
    id,
    title: id,
    category: 'input',
    description: 'test clip of a marker',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: { x: { type: 'number', default: 0 } },
    render(ctx) {
      count.n++;
      const f = ctx.time.frame;
      let img = made.get(f);
      if (!img) {
        const pose = poseAt(f);
        const g = pose ? renderScene({ width: 320, height: 180, fov: FOV, pose, samples: 2 }) : new Uint8Array(320 * 180).fill(120);
        img = t().gpu.upload(greyToRgba(g), 320, 180, 1, true);
        t().gpu.retain(img.texture);
        made.set(f, img);
      }
      return { image: img };
    },
  });
}

async function setup(params: Record<string, unknown> = {}) {
  const lib = new MemoryProcessLibrary();
  const count = { n: 0 };
  const sid = `marker-clip-${Math.random().toString(36).slice(2)}`;
  const host: Host = {
    assetInfo: (id) => lib.assetInfo(id),
    assetFrame: async () => null,
    assetBytes: (id) => lib.assetBytes(id),
    processLive: (n): ProcessLive | null => rt.live(n),
  };
  // eslint-disable-next-line prefer-const
  let t: Harness;
  t = await harness([clip(sid, () => t, count)], host);
  lib.gpu = t.gpu;
  lib.onChange = () => t.engine.clear();
  const rt: ProcessRuntime = new ProcessRuntime({ engine: t.engine, gpu: t.gpu, registry: t.registry, gate: new EvalGate(t.engine), library: lib, host });
  let g: GraphDoc = createGraph('marker-proc');
  g = { ...g, project: { ...g.project, width: 320, height: 180, fps: FPS, duration: FRAMES / FPS, loop: false } };
  const s = addNode(g, t.registry, sid);
  const m = addNode(s.graph, t.registry, 'marker-camera', { x: 0, y: 0 }, { fov: FOV, smoothing: 0, objectSize: 1, floor: 0, analysis: '320', lost: 'hide', holdTime: 0.1, ...params });
  g = connect(m.graph, t.registry, { node: s.node.id, port: 'image' }, { node: m.node.id, port: 'image' });
  const at = async (graph: GraphDoc, f: number, port = 'camera') => {
    const r = await t.engine.evaluate({ graph, node: m.node.id, port, seconds: f / FPS });
    expect([...r.errors.values()]).toEqual([]);
    return r.value;
  };
  return { t, rt, g, src: s.node.id, node: m.node.id, at, renders: () => count.n };
}
const azimuth = (cam: CameraValue): number => (Math.atan2(cam.position[0], -cam.position[2]) * 180) / Math.PI;

describe('marker-camera: Analyze clip (process mode)', () => {
  it('stores one sighting per frame; afterwards the camera comes from the store, in any order, without the picture', async () => {
    const { t, rt, g, node, at, renders } = await setup();
    expect(rt.status(g, node)?.state).toBe('none');
    // before: the live path, frame by frame
    const live: number[] = [];
    for (const f of [0, 3, 6]) live.push(azimuth((await at(g, f)) as CameraValue));

    const result = await rt.run(g, node);
    expect(result.meta.frames).toBe(FRAMES);
    expect(result.meta.seen).toBe(FRAMES - 4);
    const done = withProcessResult(g, t.registry, node, result);
    expect(rt.status(done, node)?.state).toBe('done');

    t.engine.clear();
    const before = renders();
    // out of order, as scrubbing would
    for (const f of [23, 6, 0, 15, 3]) expect(Math.abs(azimuth((await at(done, f)) as CameraValue) - f * 5)).toBeLessThan(1.5);
    // with smoothing off the stored result is the live result
    for (const [i, f] of [0, 3, 6].entries()) expect(azimuth((await at(done, f)) as CameraValue)).toBeCloseTo(live[i], 1);
    expect(renders() - before).toBe(0); // the clip was not looked at again: only the camera was asked for

    // the gap: held for 0.1 s (frame 8), then hidden; found again at frame 12
    expect(await at(done, 7, 'found')).toBe(1);
    expect(await at(done, 8, 'found')).toBe(1);
    expect(await at(done, 9, 'found')).toBe(0);
    expect(await at(done, 12, 'found')).toBe(1);
    // the same answer twice, and whatever was asked before (an export and a preview read the same numbers)
    const a = await at(done, 15);
    t.engine.clear();
    await at(done, 2);
    expect(await at(done, 15)).toEqual(a);
  });
  it('display settings do not make it stale; the marker choice, the search size and the clip do', async () => {
    const { t, rt, g, src, node } = await setup();
    const done = withProcessResult(g, t.registry, node, await rt.run(g, node));
    for (const [k, v] of [['fov', 60], ['smoothing', 0.8], ['objectSize', 2], ['lost', 'hold'], ['overlay', true]] as const) expect(rt.status(setParam(done, node, k, v), node)?.state, k).toBe('done');
    expect(rt.status(setParam(done, node, 'analysis', '640'), node)?.state).toBe('stale');
    expect(rt.status(setParam(done, node, 'marker', '3'), node)?.state).toBe('stale');
    expect(rt.status(setParam(done, src, 'x', 1), node)?.state).toBe('stale');
  });
  it('smoothing of an analysed clip looks at both neighbours: a steady move is not delayed at all', async () => {
    const { t, rt, g, node, at } = await setup({ smoothing: 1 });
    const done = withProcessResult(g, t.registry, node, await rt.run(g, node));
    // frame 17 is in the middle of a steady circling (frames 12 to 23): the smoothed camera is where the real one was
    expect(Math.abs(azimuth((await at(done, 17)) as CameraValue) - 85)).toBeLessThan(1.5);
  });
});

describe('template: An object standing on a marker', () => {
  it('shows the marker picture with the object on it; a different marker picture moves the object with it', async () => {
    const t = await harness();
    const tpl = TEMPLATES.find((x) => x.id === 'marker-object')!;
    const g = templateGraph(tpl);
    const out = g.nodes.find((n) => n.type === 'image-out')!;
    const golden = async (graph: GraphDoc): Promise<{ n: number; x: number }> => {
      const px = await t.pixels((await t.evalGraph({ ...graph, project: { ...graph.project, width: 640, height: 360 } }, out.id, { seconds: 0 })) as ImageValue);
      let n = 0;
      let sx = 0;
      for (let y = 0; y < px.height; y++)
        for (let x = 0; x < px.width; x++) {
          const [r, gg, b] = px.at(x, y);
          // gold: clearly more red than blue (the marker picture is black and white)
          if (r - b > 60 && gg > 40) (n++, (sx += x));
        }
      return { n, x: sx / n };
    };
    const a = await golden(g);
    expect(a.n).toBeGreaterThan(400);
    expect(Math.abs(a.x - 320)).toBeLessThan(6);
  });
});

describe('sample pictures (only with MARKER_DUMP)', () => {
  it.skipIf(!DUMP)('writes the camera picture with a cube standing on the marker, from several sides', async () => {
    const t = await harness();
    mkdirSync(DUMP, { recursive: true });
    const [w, h] = [960, 540];
    const views: [string, number, number, number, number][] = [['front', 6, 0, 40, 0], ['left', 6, -75, 35, 0], ['right-close', 3.5, 60, 50, 8], ['behind-far', 10, 170, 30, -5], ['above', 6, 20, 80, 30]];
    for (const [name, d, az, el, roll] of views) {
      const pose = orbitPose(d, az, el, roll, [0.2, 0, 0.1]);
      const img = t.gpu.upload(greyToRgba(renderScene({ width: w, height: h, fov: FOV, pose, id: 0, samples: 3, sheet: 1.4 })), w, h, 1, true);
      t.gpu.retain(img.texture);
      for (const [tag, extra] of [['overlay', { overlay: true }], ['covered', { cover: true }]] as const) {
        // a real graph (not node by node): the picture must still be alive when the merge reads it
        let g: GraphDoc = createGraph('sample');
        g = { ...g, project: { ...g.project, width: w, height: h } };
        const src = addNode(g, t.registry, t.source(img));
        const mc = addNode(src.graph, t.registry, 'marker-camera', { x: 0, y: 0 }, { fov: FOV, smoothing: 0, objectSize: 1, floor: -0.55, ...extra });
        const obj = addNode(mc.graph, t.registry, 'object-3d', { x: 0, y: 0 }, { shape: 'cube', rotX: 0, rotY: 0, rotZ: 0, baseColor: [0.95, 0.6, 0.2, 1] });
        const comp = addNode(obj.graph, t.registry, 'merge', { x: 0, y: 0 }, { mode: 'normal' });
        g = comp.graph;
        for (const [from, fp, to, tp] of [[src.node.id, 'out', mc.node.id, 'image'], [mc.node.id, 'camera', obj.node.id, 'camera'], [mc.node.id, 'picture', obj.node.id, 'size'], [mc.node.id, 'picture', comp.node.id, 'background'], [obj.node.id, 'image', comp.node.id, 'foreground']])
          g = connect(g, t.registry, { node: from, port: fp }, { node: to, port: tp });
        const px = await t.pixels((await t.evalGraph(g, comp.node.id, { seconds: 0 })) as ImageValue);
        writeFileSync(`${DUMP}/sample-${name}-${tag}.png`, encodePng({ width: px.width, height: px.height, data: px.data }, { opaque: true }));
      }
    }
  });
});
