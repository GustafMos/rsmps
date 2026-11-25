/**
 * AI Style Transfer node contract, on the real GPU with a RAM library and a FAKE model (the real one is 27 MB and is not in the
 * repository). The fake behaves like the model where the node depends on it: the encoder shrinks a 512 x 512 picture to 64 x 64
 * feature cells (its three colour planes become three feature maps, the other 509 stay empty) and the decoder enlarges them again,
 * so "decode(encode(picture))" is the picture, and what the node does between the two (blend the contents, move the statistics from
 * A's to B's) shows in the stored frames. The node's whole path is exercised: plan, render A and B small, tiles, AdaIN, store, serve.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineNode } from '../engine/define';
import { resolveNodeParams } from '../engine/engine';
import { addNode, connect, createGraph, setParam } from '../engine/graph';
import { stableStringify } from '../engine/lib/stable-json';
import { withProcessResult } from '../engine/process';
import { STYLE_AI_MESSAGES, STYLE_AI_MODEL, setStyleAiService, type StyleAiService } from '../engine/lib/style-ai-bridge';
import styleTransferAi from '../engine/nodes/filter/style-transfer-ai.node';
import { harness } from '../engine/testing';
import type { GraphDoc, Host, ImageValue, ProcessLive } from '../engine/types';
import { EvalGate } from './gate';
import { MemoryProcessLibrary, ProcessRuntime } from './processes';

const FPS = 12;
const FRAMES = 12;
const W = 32;
const H = 16;
const T = STYLE_AI_MODEL.tile;
const CELLS = T / STYLE_AI_MODEL.stride;

interface Fake {
  ready: boolean;
  opens: number;
  encodes: number;
  decodes: number;
  /** Mean of the red plane of every picture the encoder was given (proof of the value range and plane order). */
  reds: number[];
  /** Throw this at the nth decode (counted from 1). */
  failAt?: { n: number; error: Error };
  onDecode?: (n: number) => void;
}

const newFake = (over: Partial<Fake> = {}): Fake => ({ ready: true, opens: 0, encodes: 0, decodes: 0, reds: [], ...over });

function fakeService(f: Fake): StyleAiService {
  const n = T * T;
  const cells = CELLS * CELLS;
  return {
    modelReady: async () => f.ready,
    async open() {
      f.opens++;
      return {
        provider: 'fake',
        async encode(rgb) {
          expect(rgb.length).toBe(3 * n);
          f.encodes++;
          let red = 0;
          for (let i = 0; i < n; i++) red += rgb[i];
          f.reds.push(red / n);
          const out = new Float32Array(STYLE_AI_MODEL.channels * cells);
          for (let c = 0; c < 3; c++)
            for (let y = 0; y < CELLS; y++)
              for (let x = 0; x < CELLS; x++) {
                let s = 0;
                for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) s += rgb[c * n + (y * 8 + j) * T + x * 8 + i];
                out[c * cells + y * CELLS + x] = s / 64;
              }
          return out;
        },
        async decode(features) {
          expect(features.length).toBe(STYLE_AI_MODEL.channels * cells);
          f.decodes++;
          f.onDecode?.(f.decodes);
          if (f.failAt?.n === f.decodes) throw f.failAt.error;
          const out = new Float32Array(3 * n);
          for (let c = 0; c < 3; c++) for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) out[c * n + y * T + x] = features[c * cells + (y >> 3) * CELLS + (x >> 3)];
          return out;
        },
        toBlob: async (rgba) => new Blob([rgba as BlobPart]),
      };
    },
  };
}

async function setup() {
  const lib = new MemoryProcessLibrary();
  const renders = { a: 0, b: 0 };
  // A: a red field with a white bar that moves right by 2 pixels per frame. B: a still, blue, brighter towards the right.
  const srcA = defineNode({
    id: 'style-src-a',
    title: 'shot a',
    category: 'generate',
    description: 'red with a moving bar',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: { gain: { type: 'number', default: 1 } },
    render(ctx) {
      renders.a++;
      return {
        image: ctx.gpu.pass({
          size: { width: Math.round(W * ctx.proxy), height: Math.round(H * ctx.proxy), unit: 1 },
          uniforms: { f: ctx.time.frame % FRAMES, g: ctx.params.gain },
          wgsl: `fn fx(uv: vec2f, px: vec2f) -> vec4f {
            let x = uv.x * ${W}.0;
            let bar = step(u.f * 2.0, x) * step(x, u.f * 2.0 + 4.0);
            return vec4f(mix(vec3f(0.8, 0.1, 0.1) * u.g, vec3f(1.0), bar), 1.0);
          }`,
        }),
      };
    },
  });
  const srcB = defineNode({
    id: 'style-src-b',
    title: 'shot b',
    category: 'generate',
    description: 'a still blue gradient',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      renders.b++;
      return {
        image: ctx.gpu.pass({
          size: { width: Math.round(W * ctx.proxy), height: Math.round(H * ctx.proxy), unit: 1 },
          wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.1, 0.2 + 0.4 * uv.x, 0.5 + 0.4 * uv.x, 1.0); }',
        }),
      };
    },
  });
  // Style: a still of hard green and yellow stripes (no red, no blue: unlike A and B).
  const srcS = defineNode({
    id: 'style-src-s',
    title: 'style picture',
    category: 'generate',
    description: 'green and yellow stripes',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      return {
        image: ctx.gpu.pass({
          size: { width: Math.round(W * ctx.proxy), height: Math.round(H * ctx.proxy), unit: 1 },
          wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { let k = step(0.5, fract(uv.x * 4.0)); return vec4f(mix(vec3f(0.0, 0.6, 0.0), vec3f(0.9, 0.9, 0.0), k), 1.0); }',
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
  const t = await harness([srcA, srcB, srcS, styleTransferAi], host);
  lib.gpu = t.gpu;
  lib.onChange = () => t.engine.clear();
  const rt: ProcessRuntime = new ProcessRuntime({ engine: t.engine, gpu: t.gpu, registry: t.registry, gate: new EvalGate(t.engine), library: lib, host, encode: async (img) => new Blob([(await t.gpu.readRaw(img)) as BlobPart]) });
  let g: GraphDoc = createGraph('style');
  g = { ...g, project: { ...g.project, width: W, height: H, fps: FPS, duration: FRAMES / FPS, loop: true } };
  const a = addNode(g, t.registry, 'style-src-a');
  const b = addNode(a.graph, t.registry, 'style-src-b');
  const m = addNode(b.graph, t.registry, 'style-src-s');
  const s = addNode(m.graph, t.registry, 'style-transfer-ai');
  g = connect(s.graph, t.registry, { node: a.node.id, port: 'image' }, { node: s.node.id, port: 'a' });
  g = connect(g, t.registry, { node: b.node.id, port: 'image' }, { node: s.node.id, port: 'b' });
  const ids = { a: a.node.id, b: b.node.id, material: m.node.id, style: s.node.id };
  /** The graph as it is when the node is new: nothing set but the wires (A and B). */
  const fresh = g;
  // The transition takes the middle half of the project: frames 0..3 are A, 4..8 are painted, 9..11 are B.
  g = setParam(g, ids.style, 'drive', 'span');
  // The mildest look, the one the node had before it had looks: the tests of the strong looks set their own.
  g = setParam(g, ids.style, 'look', 'painterly');
  /** The middle row of the picture at a frame, as a list of [r, g, b]. */
  const row = async (graph: GraphDoc, node: string, frame: number, proxy = 1) => {
    const r = await t.engine.evaluate({ graph, node, seconds: frame / FPS, proxy });
    expect([...r.errors.values()]).toEqual([]);
    const img = r.value as ImageValue;
    const px = await t.pixels(img);
    const out: number[][] = [];
    for (let x = 0; x < img.width; x++) out.push(px.at(x, Math.floor(img.height / 2)).slice(0, 3));
    return { px: out, width: img.width, height: img.height };
  };
  const render = async (graph: GraphDoc) => withProcessResult(graph, t.registry, ids.style, await rt.run(graph, ids.style));
  return { t, lib, rt, g, fresh, ids, row, render, renders };
}

const far = (a: number[][], b: number[][]) => a.reduce((m, p, i) => Math.max(m, ...p.map((v, k) => Math.abs(v - b[i][k]))), 0);

afterEach(() => setStyleAiService(null));

describe('AI Style Transfer node', () => {
  it('before it is rendered it shows A, a plain dissolve, then B; the model is never touched and an export is told the render is missing', async () => {
    const fake = newFake();
    setStyleAiService(fakeService(fake));
    const { rt, g, ids, row } = await setup();
    expect(rt.status(g, ids.style)?.state).toBe('none');
    for (const f of [0, 3]) expect((await row(g, ids.style, f)).px).toEqual((await row(g, ids.a, f)).px);
    for (const f of [9, 11]) expect((await row(g, ids.style, f)).px).toEqual((await row(g, ids.b, f)).px);
    // the middle of the transition: half A, half B
    const mid = (await row(g, ids.style, 6)).px;
    const a = (await row(g, ids.a, 6)).px;
    const b = (await row(g, ids.b, 6)).px;
    for (const x of [1, 30]) for (let k = 0; k < 3; k++) expect(Math.abs(mid[x][k] - (a[x][k] + b[x][k]) / 2)).toBeLessThanOrEqual(2);
    expect(fake.opens).toBe(0);
    expect(rt.pending(g, [ids.style]).length).toBe(1);
  });

  it('the job refuses with a clear sentence when there is no runtime (command line) or the model is not downloaded', async () => {
    const { rt, g, ids } = await setup();
    setStyleAiService(null);
    await expect(rt.run(g, ids.style)).rejects.toThrow(STYLE_AI_MESSAGES.noRuntime);
    expect(rt.status(g, ids.style)?.state).toBe('failed');
    const fake = newFake({ ready: false });
    setStyleAiService(fakeService(fake));
    await expect(rt.run(g, ids.style)).rejects.toThrow(STYLE_AI_MESSAGES.noModel);
    expect(fake.opens).toBe(0); // it does not even load the runtime, and it never downloads
  });

  it('a transition with no frame between A and B says so instead of storing nothing', async () => {
    setStyleAiService(fakeService(newFake()));
    const { rt, g, ids } = await setup();
    await expect(rt.run(setParam(g, ids.style, 'start', 100), ids.style)).rejects.toThrow(STYLE_AI_MESSAGES.noFrames);
  });

  it('rendered: the ends are exactly A and B, the middle is the network’s painting and neither picture nor their dissolve', async () => {
    const fake = newFake();
    setStyleAiService(fakeService(fake));
    const { rt, g, ids, row, render } = await setup();
    const before = (await row(g, ids.style, 6)).px;
    const done = await render(g);
    expect(rt.status(done, ids.style)?.state).toBe('done');
    expect(rt.pending(done, [ids.style])).toEqual([]);
    expect(rt.status(done, ids.style)?.result?.meta).toMatchObject({ model: 'AdaIN', revision: STYLE_AI_MODEL.revision, provider: 'fake', drive: 'span', first: 4, count: 5, frames: FRAMES, width: W, height: H, tiles: 1, item: null });
    // the painting is stored at the work size: longest side 512, the shape of the frame
    expect(rt.status(done, ids.style)?.result?.items.frames).toMatchObject({ kind: 'sequence', frames: 5, width: 512, height: 256 });

    for (const f of [0, 3]) expect((await row(done, ids.style, f)).px).toEqual((await row(g, ids.a, f)).px);
    for (const f of [9, 11]) expect((await row(done, ids.style, f)).px).toEqual((await row(g, ids.b, f)).px);

    const mid = await row(done, ids.style, 6);
    expect([mid.width, mid.height]).toEqual([W, H]);
    const a = (await row(g, ids.a, 6)).px;
    const b = (await row(g, ids.b, 6)).px;
    expect(far(mid.px, before)).toBeGreaterThan(20);
    expect(far(mid.px, a)).toBeGreaterThan(20);
    expect(far(mid.px, b)).toBeGreaterThan(20);

    // A moves, so it is encoded for every frame that still needs it (4..7); B is a still: once. One decode per painted frame.
    expect(fake.encodes).toBe(5);
    expect(fake.decodes).toBe(5);
    // the encoder was given 0..1 values, red plane first: A is mostly red 0.8, B has red 0.1
    expect(fake.reds[0]).toBeGreaterThan(0.75);
    expect(fake.reds[0]).toBeLessThan(0.9);
    expect(fake.reds[1]).toBeCloseTo(0.1, 1);
  });

  it('style arrives before the shapes: early in the transition A’s bar is still where it was, but the colours are already B’s', async () => {
    setStyleAiService(fakeService(newFake()));
    const { g, ids, row, render } = await setup();
    // "Ends fade" at its shortest, so frame 5 (a third of the way) shows the painting alone
    const done = await render(setParam(g, ids.style, 'fade', 0.02));
    const early = (await row(done, ids.style, 5)).px;
    const a = (await row(g, ids.a, 5)).px;
    // the bar of A at frame 5 covers x 10..14: still the brightest part of the row in the painting
    const lum = (p: number[]) => p[0] + p[1] + p[2];
    expect(lum(early[12])).toBeGreaterThan(lum(early[25]) + 30);
    // but the field is no longer A's red
    expect(early[25][0]).toBeLessThan(a[25][0] - 40);
    expect(early[25][2]).toBeGreaterThan(a[25][2] + 40);
  });

  it('served from the store: with the painting alone on screen A and B are not evaluated, and a looping project wraps', async () => {
    setStyleAiService(fakeService(newFake()));
    const { t, g, ids, row, render, renders } = await setup();
    const done = await render(g);
    t.engine.clear();
    const n = { ...renders };
    const mid = (await row(done, ids.style, 6)).px;
    expect((await row(done, ids.style, 6 + FRAMES)).px).toEqual(mid);
    expect(renders).toEqual(n);
  });

  it('"Painting" and "Ends fade" act on the stored result: no new render, and Painting 0 is the plain dissolve', async () => {
    setStyleAiService(fakeService(newFake()));
    const { rt, g, ids, row, render } = await setup();
    const dissolve = (await row(g, ids.style, 6)).px;
    const done = await render(g);
    const off = setParam(done, ids.style, 'strength', 0);
    expect(rt.status(off, ids.style)?.state).toBe('done');
    expect(far((await row(off, ids.style, 6)).px, dissolve)).toBeLessThanOrEqual(1);
    const half = setParam(done, ids.style, 'strength', 0.5);
    const full = (await row(done, ids.style, 6)).px;
    const mixed = (await row(half, ids.style, 6)).px;
    for (const x of [2, 28]) for (let k = 0; k < 3; k++) expect(Math.abs(mixed[x][k] - (full[x][k] + dissolve[x][k]) / 2)).toBeLessThanOrEqual(2);
    expect(rt.status(setParam(done, ids.style, 'fade', 0.4), ids.style)?.state).toBe('done');
  });

  it('a settings or upstream change makes it stale; the old painting stays on screen until it is rendered again', async () => {
    setStyleAiService(fakeService(newFake()));
    const { rt, g, ids, row, render } = await setup();
    const done = await render(g);
    for (const [key, value] of [['drive', 'loop'], ['start', 10], ['length', 30], ['size', '768'], ['steady', 0.8]] as const) {
      expect(rt.status(setParam(done, ids.style, key, value), ids.style)?.state, key).toBe('stale');
    }
    const edited = setParam(done, ids.a, 'gain', 0.5);
    expect(rt.status(edited, ids.style)?.state).toBe('stale');
    expect((await row(edited, ids.style, 6)).px).toEqual((await row(done, ids.style, 6)).px);
    expect(rt.pending(edited, [ids.style]).length).toBe(1); // an export asks for a fresh render
    // a stale painting keeps the timing it was made with, also when the timing settings changed since
    const moved = setParam(done, ids.style, 'start', 10);
    expect((await row(moved, ids.style, 6)).px).toEqual((await row(done, ids.style, 6)).px);
    const again = await render(edited);
    expect(rt.status(again, ids.style)?.state).toBe('done');
  });

  it('cancel stores nothing', async () => {
    const ctl = new AbortController();
    setStyleAiService(fakeService(newFake({ onDecode: (n) => n === 2 && ctl.abort() })));
    const { lib, rt, g, ids } = await setup();
    await expect(rt.run(g, ids.style, { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(lib.assets.size).toBe(0);
    expect(rt.status(g, ids.style)?.state).toBe('none');
  });

  it('a model that stops half way: the sentence reaches the user, nothing is stored, the dissolve is still shown', async () => {
    setStyleAiService(fakeService(newFake({ failAt: { n: 3, error: new Error(STYLE_AI_MESSAGES.memory) } })));
    const { lib, rt, g, ids, row } = await setup();
    const before = (await row(g, ids.style, 6)).px;
    await expect(rt.run(g, ids.style)).rejects.toThrow(STYLE_AI_MESSAGES.memory);
    expect(rt.status(g, ids.style)?.state).toBe('failed');
    expect(lib.assets.size).toBe(0);
    expect((await row(g, ids.style, 6)).px).toEqual(before);
  });

  it('A to B over the loop paints every frame but the first, which is A itself; a smaller preview is served smaller', async () => {
    const fake = newFake();
    setStyleAiService(fakeService(fake));
    const { rt, g, ids, row, render } = await setup();
    const done = await render(setParam(g, ids.style, 'drive', 'loop'));
    expect(rt.status(done, ids.style)?.result?.meta).toMatchObject({ drive: 'loop', first: 1, count: 11 });
    expect((await row(done, ids.style, 0)).px).toEqual((await row(g, ids.a, 0)).px);
    const half = await row(done, ids.style, 6, 0.5);
    expect([half.width, half.height]).toEqual([16, 8]);
  });

  /* ---------------------------------------------------------------------------------------------------------------- */
  /* Looks, the Style input, held                                                                                      */
  /* ---------------------------------------------------------------------------------------------------------------- */

  it('a new node has the strong look; a node saved before looks existed keeps Painterly and its stored result is not called out of date', async () => {
    setStyleAiService(fakeService(newFake()));
    const { t, rt, g, fresh, ids, render } = await setup();
    const def = t.registry.get('style-transfer-ai')!;
    const node = fresh.nodes.find((n) => n.id === ids.style)!;
    expect(node.params.look).toBe('hallucination');
    // an old project: the node has no value for any of the new settings
    const old = { ...node.params };
    for (const k of ['look', 'material', 'pieces', 'push', 'passes', 'crawl', 'texture']) delete old[k];
    expect(resolveNodeParams(def, old)).toMatchObject({ look: 'painterly', texture: '1' });
    // its signature is the one the node had then, character for character
    const p = resolveNodeParams(def, { ...old, drive: 'span' });
    const then = `${stableStringify({ drive: 'span', start: 25, length: 50, size: '512', steady: 0.3, model: STYLE_AI_MODEL.encoder, rev: STYLE_AI_MODEL.revision })}|sig-a|sig-b`;
    expect(def.process!.signature(p as never, { a: 'sig-a', b: 'sig-b' })).toBe(then);
    expect(def.process!.signature(p as never, { a: 'sig-a', b: 'sig-b', style: '' })).toBe(then);
    // and every new setting that changes the painting changes it
    const done = await render(g);
    for (const [key, value] of [['look', 'material'], ['look', 'hallucination'], ['texture', '2'], ['drive', 'hold']] as const) {
      expect(rt.status(setParam(done, ids.style, key, value), ids.style)?.state, key).toBe('stale');
    }
    const customLook = setParam(done, ids.style, 'look', 'custom');
    expect(rt.status(customLook, ids.style)?.state).toBe('stale');
    const again = await render(customLook);
    for (const [key, value] of [['material', 0.5], ['pieces', 0.1], ['push', 1.5], ['passes', 3], ['crawl', 0.9]] as const) {
      expect(rt.status(setParam(again, ids.style, key, value), ids.style)?.state, key).toBe('stale');
    }
    // a custom look that is the Painterly one is the same painting
    let same = setParam(done, ids.style, 'look', 'custom');
    for (const [key, value] of [['material', 0], ['push', 1], ['passes', 1]] as const) same = setParam(same, ids.style, key, value);
    expect(rt.status(same, ids.style)?.state).toBe('done');
    // wiring a Style picture changes it too
    expect(rt.status(connect(done, t.registry, { node: ids.material, port: 'image' }, { node: ids.style, port: 'style' }), ids.style)?.state).toBe('stale');
  });

  it('Material: the middle of the transition is built from B’s cells only; Hallucination runs the network again on its own painting', async () => {
    const fake = newFake();
    setStyleAiService(fakeService(fake));
    const { rt, g, ids, row, render } = await setup();
    const material = await render(setParam(setParam(g, ids.style, 'look', 'material'), ids.style, 'steady', 0));
    expect(rt.status(material, ids.style)?.result?.meta).toMatchObject({ method: 'swap', material: 1, passes: 1, source: 'pair', drive: 'span' });
    // one decode per painted frame, as for Painterly: the swap costs no run of the network
    expect(fake.decodes).toBe(5);
    // frame 6 (the middle): every pixel is a colour that exists in B (red 0.1, green and blue rising together), none is A's red or white
    const mid = (await row(material, ids.style, 6)).px;
    for (const px of mid) {
      expect(px[0]).toBeLessThan(40);
      expect(px[2] - px[1]).toBeGreaterThan(55);
      expect(px[2] - px[1]).toBeLessThan(100);
    }
    // ...but laid out by A: the bar of A (x 12..16 at frame 6) took B's brightest cells, the field B's darker ones
    expect(mid[14][2]).toBeGreaterThan(mid[26][2] + 30);

    const before = { e: fake.encodes, d: fake.decodes };
    const strong = await render(setParam(g, ids.style, 'look', 'hallucination'));
    expect(rt.status(strong, ids.style)?.result?.meta).toMatchObject({ method: 'swap', passes: 2 });
    // five frames; the frames in the middle are painted twice (and the painting encoded in between), those at the very ends once
    expect(fake.decodes - before.d).toBeGreaterThan(5);
    expect(fake.decodes - before.d).toBeLessThanOrEqual(10);
    expect(fake.encodes - before.e).toBeGreaterThan(5);
  });

  it('a picture wired to Style is the material of the middle: A and B both turn into it, and it is not B’s', async () => {
    const fake = newFake();
    setStyleAiService(fakeService(fake));
    const { t, rt, g, ids, row, render } = await setup();
    let wiredG = connect(g, t.registry, { node: ids.material, port: 'image' }, { node: ids.style, port: 'style' });
    wiredG = setParam(setParam(wiredG, ids.style, 'look', 'material'), ids.style, 'steady', 0);
    const done = await render(wiredG);
    expect(rt.status(done, ids.style)?.result?.meta).toMatchObject({ method: 'swap', source: 'style', drive: 'span', first: 4, count: 5 });
    // the ends are still exactly A and B
    expect((await row(done, ids.style, 3)).px).toEqual((await row(g, ids.a, 3)).px);
    expect((await row(done, ids.style, 9)).px).toEqual((await row(g, ids.b, 9)).px);
    // the middle is made of the style's green and yellow: no blue to speak of, a lot of green
    for (const px of (await row(done, ids.style, 6)).px) {
      expect(px[2]).toBeLessThan(40);
      expect(px[1]).toBeGreaterThan(120);
    }
    // the style picture is a still: encoded once, next to A (frames 4..7 while it has a say) and B (once)
    expect(fake.encodes).toBe(4 + 1 + 1);
  });

  it('held: no transition, every frame of the project is A repainted; without a render it is plain A; "Painting" mixes', async () => {
    const fake = newFake();
    setStyleAiService(fakeService(fake));
    const { rt, g, ids, row, render } = await setup();
    const held = setParam(setParam(setParam(g, ids.style, 'drive', 'hold'), ids.style, 'look', 'material'), ids.style, 'steady', 0);
    for (const f of [0, 6, 11]) expect((await row(held, ids.style, f)).px).toEqual((await row(g, ids.a, f)).px);
    const done = await render(held);
    expect(rt.status(done, ids.style)?.result?.meta).toMatchObject({ drive: 'hold', source: 'hold', first: 0, count: FRAMES, method: 'swap' });
    // also the first and the last frame are the painting (B's colours laid out by A), not A
    for (const f of [0, 6, 11]) {
      const px = (await row(done, ids.style, f)).px;
      const a = (await row(g, ids.a, f)).px;
      expect(far(px, a)).toBeGreaterThan(60);
      for (const q of px) expect(q[0]).toBeLessThan(40);
    }
    const half = (await row(setParam(done, ids.style, 'strength', 0.5), ids.style, 6)).px;
    const full = (await row(done, ids.style, 6)).px;
    const a = (await row(g, ids.a, 6)).px;
    for (const x of [2, 28]) for (let k = 0; k < 3; k++) expect(Math.abs(half[x][k] - (full[x][k] + a[x][k]) / 2)).toBeLessThanOrEqual(2);
    expect((await row(setParam(done, ids.style, 'strength', 0), ids.style, 6)).px).toEqual(a);
  });

  it('nothing wired to B: with a Style picture it is held by itself; with neither the job says what is missing', async () => {
    setStyleAiService(fakeService(newFake()));
    const { t, rt, g, ids, row } = await setup();
    const noB: GraphDoc = { ...g, edges: g.edges.filter((e) => !(e.to.node === ids.style && e.to.port === 'b')) };
    await expect(rt.run(noB, ids.style)).rejects.toThrow(STYLE_AI_MESSAGES.noMaterial);
    // unrendered and without B: picture A as it is, on every frame
    expect((await row(noB, ids.style, 6)).px).toEqual((await row(g, ids.a, 6)).px);
    const styled = setParam(connect(noB, t.registry, { node: ids.material, port: 'image' }, { node: ids.style, port: 'style' }), ids.style, 'look', 'material');
    const done = withProcessResult(styled, t.registry, ids.style, await rt.run(styled, ids.style));
    // "Driven by" still says a part of the project, but there is nothing to go to
    expect(rt.status(done, ids.style)?.result?.meta).toMatchObject({ drive: 'hold', source: 'hold', count: FRAMES });
    for (const px of (await row(done, ids.style, 0)).px) expect(px[1]).toBeGreaterThan(120);
  });

  it('Crawl makes a still picture move: without it every held frame of two stills is the same painting, with it they differ and the loop closes', async () => {
    setStyleAiService(fakeService(newFake()));
    const { t, rt, g, ids } = await setup();
    // B (a still gradient) repainted with the Style stripes: nothing moves in either.
    let base: GraphDoc = { ...g, edges: g.edges.filter((e) => e.to.node !== ids.style) };
    base = connect(base, t.registry, { node: ids.b, port: 'image' }, { node: ids.style, port: 'a' });
    base = connect(base, t.registry, { node: ids.material, port: 'image' }, { node: ids.style, port: 'style' });
    base = setParam(setParam(base, ids.style, 'look', 'custom'), ids.style, 'steady', 0);
    base = setParam(setParam(base, ids.style, 'passes', 1), ids.style, 'pieces', 0);
    const frames = async (graph: GraphDoc) => {
      const done = withProcessResult(graph, t.registry, ids.style, await rt.run(graph, ids.style));
      const out: string[] = [];
      for (const f of [0, 1, 6]) {
        const r = await t.engine.evaluate({ graph: done, node: ids.style, seconds: f / FPS, proxy: 1 });
        const px = await t.pixels(r.value as ImageValue);
        const all: number[] = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) all.push(...px.at(x, y).slice(0, 3));
        out.push(all.join(','));
      }
      return out;
    };
    const steady = await frames(setParam(base, ids.style, 'crawl', 0));
    expect(steady[1]).toBe(steady[0]);
    expect(steady[2]).toBe(steady[0]);
    const crawling = await frames(setParam(base, ids.style, 'crawl', 1));
    expect(crawling[2]).not.toBe(crawling[0]);
  });
});
