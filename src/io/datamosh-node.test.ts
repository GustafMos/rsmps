/**
 * Codec Datamosh node contract, on the real GPU with a RAM library and a FAKE codec (the browser's encoder and decoder do not exist
 * here). The fake behaves like a codec where it matters: a key frame holds a whole picture, a delta frame holds only the DIFFERENCE
 * to the picture encoded before it, and the decoder adds deltas to whatever picture it currently holds. So a removed key frame and
 * a repeated delta frame have the same consequences as with a real codec, and the node's whole path (render every frame, plan,
 * rewrite, decode, store, serve) is exercised.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineNode } from '../engine/define';
import { addNode, connect, createGraph, setParam } from '../engine/graph';
import { withProcessResult } from '../engine/process';
import { DATAMOSH_MESSAGES, DatamoshRefused, setDatamoshService, type DatamoshOpenOptions, type DatamoshService } from '../engine/lib/datamosh-bridge';
import datamoshReal from '../engine/nodes/filter/datamosh-real.node';
import { harness } from '../engine/testing';
import type { GraphDoc, Host, ImageValue, ProcessLive } from '../engine/types';
import { EvalGate } from './gate';
import { MemoryProcessLibrary, ProcessRuntime } from './processes';

const FPS = 12;
const FRAMES = 12;
const CUT = 6;
const W = 32;
const H = 16;

interface Fake {
  opens: DatamoshOpenOptions[];
  /** Codec names whose decoder gives up. */
  refuse: string[];
  names: string[];
  /** What the decoder was given in the last run. */
  feed: number[];
  keys: boolean[];
}

const newFake = (over: Partial<Fake> = {}): Fake => ({ opens: [], refuse: [], names: ['fake'], feed: [], keys: [], ...over });

function fakeService(f: Fake): DatamoshService {
  return {
    async open(o) {
      f.opens.push(o);
      const name = f.names.find((n) => !o.exclude?.includes(n));
      if (!name) throw new Error(DATAMOSH_MESSAGES.refused);
      const chunks: { key: boolean; data: Int16Array }[] = [];
      let prev: Uint8ClampedArray | null = null;
      return {
        name,
        width: o.width,
        height: o.height,
        async encode(rgba, key) {
          const data = new Int16Array(rgba.length);
          for (let i = 0; i < rgba.length; i++) data[i] = key || !prev ? rgba[i] : rgba[i] - prev[i];
          chunks.push({ key, data });
          prev = rgba.slice();
        },
        finish: async () => chunks.map((c) => ({ key: c.key })),
        async decode(feed) {
          if (f.refuse.includes(name)) throw new DatamoshRefused(name, `The ${name} decoder stopped on the damaged stream.`);
          f.feed = [...feed];
          f.keys = chunks.map((c) => c.key);
          const pic = new Int16Array(o.width * o.height * 4);
          return feed.map((i) => {
            const c = chunks[i];
            for (let k = 0; k < pic.length; k++) pic[k] = c.key ? c.data[k] : pic[k] + c.data[k];
            const out = new Uint8ClampedArray(pic.length);
            for (let k = 0; k < pic.length; k++) out[k] = k % 4 === 3 ? 255 : pic[k];
            return new Blob([out as BlobPart]);
          });
        },
        close() {},
      };
    },
  };
}

async function setup() {
  const lib = new MemoryProcessLibrary();
  let renders = 0;
  // Shot A (frames 0..5): red field. Shot B (6..11): blue field. A white bar moves right by 2 pixels per frame in both.
  const src = defineNode({
    id: 'mosh-src',
    title: 'two shots',
    category: 'generate',
    description: 'two shots with a moving bar',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: { gain: { type: 'number', default: 1 } },
    render(ctx) {
      renders++;
      const f = ctx.time.frame % FRAMES;
      return {
        image: ctx.gpu.pass({
          size: { width: Math.round(W * ctx.proxy), height: Math.round(H * ctx.proxy), unit: 1 },
          uniforms: { f, cut: CUT, g: ctx.params.gain },
          wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f {
            let x = uv.x * ${W}.0;
            let bar = step(u.f * 2.0, x) * step(x, u.f * 2.0 + 4.0);
            let bg = select(vec3f(0.8, 0.1, 0.1), vec3f(0.1, 0.1, 0.8), u.f >= u.cut) * u.g;
            return vec4f(mix(bg, vec3f(1.0), bar), 1.0);
          }`,
        }),
      };
    },
  });
  const host: Host = {
    assetInfo: (id) => lib.assetInfo(id),
    assetFrame: (id, s) => lib.assetFrame(id, s),
    assetBytes: (id) => lib.assetBytes(id),
    processLive: (n): ProcessLive | null => rt.live(n),
  };
  const t = await harness([src, datamoshReal], host);
  lib.gpu = t.gpu;
  lib.onChange = () => t.engine.clear();
  const rt: ProcessRuntime = new ProcessRuntime({ engine: t.engine, gpu: t.gpu, registry: t.registry, gate: new EvalGate(t.engine), library: lib, host, encode: async (img) => new Blob([(await t.gpu.readRaw(img)) as BlobPart]) });
  let g: GraphDoc = createGraph('mosh');
  g = { ...g, project: { ...g.project, width: W, height: H, fps: FPS, duration: FRAMES / FPS, loop: true } };
  const a = addNode(g, t.registry, 'mosh-src');
  const m = addNode(a.graph, t.registry, 'datamosh-real');
  g = connect(m.graph, t.registry, { node: a.node.id, port: 'image' }, { node: m.node.id, port: 'image' });
  const ids = { src: a.node.id, mosh: m.node.id };
  /** Colour of the picture at frame `frame`, sampled at x (a pixel column) in the middle row. */
  const at = async (graph: GraphDoc, node: string, frame: number, x: number, proxy = 1) => {
    const r = await t.engine.evaluate({ graph, node, seconds: frame / FPS, proxy });
    expect([...r.errors.values()]).toEqual([]);
    const img = r.value as ImageValue;
    const px = await t.pixels(img);
    const [rr, gg, bb] = px.at(Math.min(img.width - 1, x), Math.floor(img.height / 2));
    return { r: rr, g: gg, b: bb, width: img.width, height: img.height };
  };
  const mosh = async (graph: GraphDoc) => withProcessResult(graph, t.registry, ids.mosh, await rt.run(graph, ids.mosh));
  return { t, lib, rt, g, ids, at, mosh, renders: () => renders };
}

afterEach(() => setDatamoshService(null));

// x = 30 is right of the bar in every frame but the last: it shows the background (the shot).
const BG = 30;
const isRed = (c: { r: number; b: number }) => c.r > 150 && c.b < 80;
const isBlue = (c: { r: number; b: number }) => c.b > 150 && c.r < 80;

describe('Codec Datamosh node', () => {
  it('before it is moshed the picture passes through unchanged, and an export is told that the mosh is missing', async () => {
    const fake = newFake();
    setDatamoshService(fakeService(fake));
    const { rt, g, ids, at } = await setup();
    expect(rt.status(g, ids.mosh)?.state).toBe('none');
    for (const f of [0, 5, 6, 11]) expect(await at(g, ids.mosh, f, BG)).toEqual(await at(g, ids.src, f, BG));
    expect(fake.opens.length).toBe(0); // rendering never touches the codec
    expect(rt.pending(g, [ids.mosh]).length).toBe(1);
  });

  it('the job refuses with a clear sentence when there is no codec (command line)', async () => {
    const { rt, g, ids } = await setup();
    setDatamoshService(null);
    await expect(rt.run(g, ids.mosh)).rejects.toThrow(DATAMOSH_MESSAGES.noRuntime);
    expect(rt.status(g, ids.mosh)?.state).toBe('failed');
  });

  it('key frame removal: the frame of the cut does NOT snap to the new shot; the old shot stays and only moves', async () => {
    const fake = newFake();
    setDatamoshService(fakeService(fake));
    const { rt, g, ids, at, mosh } = await setup();
    const done = await mosh(g);
    expect(rt.status(done, ids.mosh)?.state).toBe('done');
    expect(rt.pending(done, [ids.mosh])).toEqual([]);
    const meta = rt.status(done, ids.mosh)?.result?.meta as Record<string, unknown>;
    expect(meta).toMatchObject({ codec: 'fake', frames: FRAMES, cuts: 1, removed: 1, removedAt: [CUT + 1], blooms: 0, width: W, height: H, item: null });
    expect(rt.status(done, ids.mosh)?.result?.items.frames).toMatchObject({ kind: 'sequence', frames: FRAMES, width: W, height: H });

    // what the decoder got: 12 chunks for 12 frames, one key frame only, and never the key frame made at the cut
    expect(fake.feed.length).toBe(FRAMES);
    expect(fake.keys.filter(Boolean).length).toBe(2);
    expect(fake.feed.filter((i) => fake.keys[i])).toEqual([0]);

    // the source really cuts from red to blue...
    expect(isRed(await at(g, ids.src, CUT - 1, BG))).toBe(true);
    expect(isBlue(await at(g, ids.src, CUT, BG))).toBe(true);
    // ...the moshed picture does not: the first frame after the removed key frame is still the old shot, and so are the later ones
    expect(isRed(await at(done, ids.mosh, CUT - 1, BG))).toBe(true);
    expect(isRed(await at(done, ids.mosh, CUT, BG))).toBe(true);
    expect(isRed(await at(done, ids.mosh, CUT + 3, BG))).toBe(true);
    // before the cut nothing is damaged
    for (const f of [0, 2, 5]) expect(await at(done, ids.mosh, f, BG)).toEqual(await at(g, ids.src, f, BG));
    // and the new shot's MOTION is applied to the old picture: where the bar of the new shot moves, the old picture changes
    const before = await at(done, ids.mosh, CUT, 2 * (CUT + 2) + 1);
    const after = await at(done, ids.mosh, CUT + 2, 2 * (CUT + 2) + 1);
    expect(after).not.toEqual(before);
  });

  it('served from the store: the nodes before it are not evaluated, and a looping project wraps', async () => {
    setDatamoshService(fakeService(newFake()));
    const { t, g, ids, at, mosh, renders } = await setup();
    const done = await mosh(g);
    t.engine.clear();
    const n = renders();
    const a = await at(done, ids.mosh, CUT, BG);
    expect(await at(done, ids.mosh, CUT + FRAMES, BG)).toEqual(a);
    expect(renders()).toBe(n);
  });

  it('with nothing removed and no bloom the result is the input (this codec is exact)', async () => {
    const fake = newFake();
    setDatamoshService(fakeService(fake));
    const { rt, g, ids, at, mosh } = await setup();
    const done = await mosh(setParam(g, ids.mosh, 'removeAt', 'list'));
    expect(rt.status(done, ids.mosh)?.result?.meta).toMatchObject({ removed: 0, cuts: 1 });
    expect(fake.feed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (let f = 0; f < FRAMES; f++) for (const x of [3, 14, BG]) expect(await at(done, ids.mosh, f, x)).toEqual(await at(g, ids.src, f, x));
  });

  it('listed frames count from 1 like the transport, and "Key frame every" heals the picture', async () => {
    const fake = newFake();
    setDatamoshService(fakeService(fake));
    const { rt, g, ids, at, mosh } = await setup();
    let graph = setParam(g, ids.mosh, 'removeAt', 'list');
    graph = setParam(graph, ids.mosh, 'positions', '7'); // frame 7 on the transport = frame 6 = the cut
    graph = setParam(graph, ids.mosh, 'refreshEvery', 9);
    const done = await mosh(graph);
    expect(rt.status(done, ids.mosh)?.result?.meta).toMatchObject({ removed: 1, removedAt: [7] });
    expect(isRed(await at(done, ids.mosh, 8, BG))).toBe(true); // still the old shot
    expect(isBlue(await at(done, ids.mosh, 9, BG))).toBe(true); // the kept key frame: whole again
    expect(await at(done, ids.mosh, 10, 3)).toEqual(await at(g, ids.src, 10, 3));
  });

  it('bloom: one delta frame is given to the decoder again and again in place of the frames after it', async () => {
    const fake = newFake();
    setDatamoshService(fakeService(fake));
    const { rt, g, ids, at, mosh } = await setup();
    let graph = setParam(g, ids.mosh, 'mode', 'bloom');
    graph = setParam(graph, ids.mosh, 'bloomAt', 3); // transport frame 3 = frame 2
    graph = setParam(graph, ids.mosh, 'bloomCount', 4);
    const done = await mosh(graph);
    expect(rt.status(done, ids.mosh)?.result?.meta).toMatchObject({ blooms: 1, removed: 0 });
    expect(fake.feed).toEqual([0, 1, 2, 2, 2, 2, 2, 7, 8, 9, 10, 11]);
    // up to the bloom frame nothing is damaged; inside the repeats the picture is no longer the input
    expect(await at(done, ids.mosh, 2, 5)).toEqual(await at(g, ids.src, 2, 5));
    let differs = 0;
    for (let x = 0; x < W; x++) if (JSON.stringify(await at(done, ids.mosh, 5, x)) !== JSON.stringify(await at(g, ids.src, 5, x))) differs++;
    expect(differs).toBeGreaterThan(0);
  });

  it('both: the bloom starts on the first moving frame after the removed key frame', async () => {
    const fake = newFake();
    setDatamoshService(fakeService(fake));
    const { rt, g, ids, at, mosh } = await setup();
    let graph = setParam(g, ids.mosh, 'mode', 'both');
    graph = setParam(graph, ids.mosh, 'bloomCount', 3);
    const done = await mosh(graph);
    expect(rt.status(done, ids.mosh)?.result?.meta).toMatchObject({ blooms: 1, removed: 1 });
    // steps: 0..5, 6 = key of frame 6 (left out), 7 = "nothing moved", 8 = frame 7 (repeated 3 more times), then frame 11
    expect(fake.feed).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 8, 8, 8, 12]);
    expect(isRed(await at(done, ids.mosh, CUT, BG))).toBe(true);
  });

  it('a settings or upstream change makes it stale; the old mosh stays on screen until it is moshed again', async () => {
    setDatamoshService(fakeService(newFake()));
    const { rt, g, ids, at, mosh } = await setup();
    const done = await mosh(g);
    for (const [key, value] of [['mode', 'both'], ['compression', 0.9], ['maxSide', 640], ['refreshEvery', 4], ['cutSensitivity', 0.9]] as const) {
      expect(rt.status(setParam(done, ids.mosh, key, value), ids.mosh)?.state, key).toBe('stale');
    }
    const edited = setParam(done, ids.src, 'gain', 0.5);
    expect(rt.status(edited, ids.mosh)?.state).toBe('stale');
    expect(isRed(await at(edited, ids.mosh, CUT, BG))).toBe(true); // the stored mosh, not the (now darker, blue) live picture
    expect(rt.pending(edited, [ids.mosh]).length).toBe(1); // an export asks for a fresh mosh
    const again = await mosh(edited);
    expect(rt.status(again, ids.mosh)?.state).toBe('done');
  });

  it('a decoder that refuses the damaged stream: the job renders again with the next codec and says which one it used', async () => {
    const fake = newFake({ names: ['first', 'second'], refuse: ['first'] });
    setDatamoshService(fakeService(fake));
    const { rt, g, ids, at, mosh } = await setup();
    const done = await mosh(g);
    expect(fake.opens.map((o) => [...(o.exclude ?? [])])).toEqual([[], ['first']]);
    expect(rt.status(done, ids.mosh)?.result?.meta).toMatchObject({ codec: 'second', removed: 1 });
    expect(isRed(await at(done, ids.mosh, CUT, BG))).toBe(true);
  });

  it('every decoder refuses: a readable failure, nothing stored, the picture still passes through', async () => {
    const fake = newFake({ names: ['first', 'second'], refuse: ['first', 'second'] });
    setDatamoshService(fakeService(fake));
    const { rt, g, ids, at } = await setup();
    await expect(rt.run(g, ids.mosh)).rejects.toThrow(DATAMOSH_MESSAGES.refused);
    expect(rt.status(g, ids.mosh)?.state).toBe('failed');
    expect(await at(g, ids.mosh, CUT, BG)).toEqual(await at(g, ids.src, CUT, BG));
  });

  it('"Longest side" renders and stores smaller, and the node enlarges the result back to the size it replaces', async () => {
    const fake = newFake();
    setDatamoshService(fakeService(fake));
    const { rt, g, ids, at, mosh } = await setup();
    const done = await mosh(setParam(g, ids.mosh, 'maxSide', 16));
    expect(fake.opens[0]).toMatchObject({ width: 16, height: 8, maxSide: 16, fps: FPS });
    expect(rt.status(done, ids.mosh)?.result?.items.frames).toMatchObject({ width: 16, height: 8 });
    expect(rt.status(done, ids.mosh)?.result?.meta).toMatchObject({ width: W, height: H });
    const full = await at(done, ids.mosh, CUT, BG);
    expect([full.width, full.height]).toEqual([W, H]);
    expect(isRed(full)).toBe(true);
    const half = await at(done, ids.mosh, CUT, 15, 0.5);
    expect([half.width, half.height]).toEqual([16, 8]);
  });
});
