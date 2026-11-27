/**
 * Playback benchmark: the real Player, the real engine and Media In, a fake video decoder with realistic costs (an in-order step is cheap,
 * a jump costs time in proportion to the distance from the previous key frame). It plays 120 frames, loops, then scrubs, and COUNTS what
 * happened. The thresholds are a regression guard on counts, not on milliseconds (those depend on the machine).
 *
 * What it guards: video frames are requested in order at the project rate (a jump only at the loop wrap and at a scrub), no frame is asked
 * for twice, at most one picture goes to the GPU per frame shown, the preview is smaller than full size on a phone-sized viewer, a
 * second pass over the clip is served from the saved frames with no graph evaluation, and the exporter-style full-size path is untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../engine/define';
import { Engine } from '../engine/engine';
import type { Gpu } from '../engine/gpu/gpu';
import { addNode, connect, createGraph } from '../engine/graph';
import { registerBuiltins } from '../engine/nodes';
import { testGpu } from '../engine/testing';
import type { AssetInfo, GraphDoc, Host } from '../engine/types';
import { EvalGate } from './gate';
import { PlayerImpl } from './player';

const W = 360;
const H = 640;
const FPS = 30;
const FRAMES = 120;
const KEY_EVERY = 30; // a long-GOP phone clip: one key frame a second

/** A decoder with a cursor: asking for the frame after the last one is cheap, anything else is a seek from the previous key frame. */
class FakeDecoder {
  cursor = -2;
  requests: number[] = [];
  sequential = 0;
  seeks = 0;
  repeats = 0;
  seekCostMs = 0;
  uploads: { w: number; h: number }[] = [];
  maxSides: number[] = [];
  private seen = new Set<string>();

  constructor(private gpu: Gpu) {}

  cost(idx: number): number {
    if (idx === this.cursor + 1) {
      this.sequential++;
      return 1;
    }
    this.seeks++;
    const c = 3 + 0.4 * (idx - Math.floor(idx / KEY_EVERY) * KEY_EVERY);
    this.seekCostMs += c;
    return c;
  }

  async frame(seconds: number, maxSide: number) {
    const idx = Math.min(FRAMES - 1, Math.max(0, Math.round(seconds * FPS)));
    this.requests.push(idx);
    this.maxSides.push(maxSide);
    const scale = maxSide > 0 ? Math.min(1, maxSide / H) : 1;
    const w = Math.max(1, Math.round(W * scale));
    const h = Math.max(1, Math.round(H * scale));
    const key = `${idx}|${maxSide}`;
    if (this.seen.has(key)) this.repeats++;
    this.seen.add(key);
    await new Promise((r) => setTimeout(r, this.cost(idx)));
    this.cursor = idx;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (idx * 7) & 255;
      data[i + 1] = 90;
      data[i + 2] = 200;
      data[i + 3] = 255;
    }
    this.uploads.push({ w, h });
    return this.gpu.upload(data, w, h, 1, true);
  }

  reset(): void {
    this.requests = [];
    this.sequential = 0;
    this.seeks = 0;
    this.repeats = 0;
    this.seekCostMs = 0;
    this.uploads = [];
    this.maxSides = [];
    this.seen.clear();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('playback benchmark (counts)', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame };
  beforeAll(() => {
    g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(performance.now()), 8) as unknown as number;
    g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  });
  afterAll(() => {
    g.requestAnimationFrame = saved.raf;
    g.cancelAnimationFrame = saved.caf;
  });

  async function setup() {
    const gpu = await testGpu();
    const registry = new Registry();
    registerBuiltins(registry);
    const dec = new FakeDecoder(gpu);
    const info: AssetInfo = { id: 'clip', name: 'clip', kind: 'video', width: W, height: H, duration: FRAMES / FPS, fps: FPS, hasAudio: false };
    const host: Host = { assetInfo: (id) => (id === 'clip' ? info : null), assetFrame: (id, s, m) => (id === 'clip' ? dec.frame(s, m) : Promise.resolve(null)) };
    const engine = new Engine(gpu, registry, host);
    let graph: GraphDoc = createGraph('bench');
    graph.project = { ...graph.project, width: W, height: H, fps: FPS, duration: FRAMES / FPS, loop: true };
    const a = addNode(graph, registry, 'media-in', { x: 0, y: 0 }, { assets: ['clip'] });
    const b = addNode(a.graph, registry, 'exposure', { x: 0, y: 0 }, {});
    graph = connect(b.graph, registry, { node: a.node.id, port: 'image' }, { node: b.node.id, port: 'image' });
    const gate = new EvalGate(engine);
    let evaluations = 0;
    const evaluateHeld = gate.evaluateHeld.bind(gate);
    gate.evaluateHeld = (req) => {
      evaluations++;
      return evaluateHeld(req);
    };
    let blits = 0;
    const blit = gpu.blit.bind(gpu);
    gpu.blit = (...args: Parameters<Gpu['blit']>) => {
      blits++;
      return blit(...args);
    };
    const audio = {
      running: false,
      setAssets() {},
      hasSignals: () => false,
      hasAudio: () => false,
      setGraph() {},
      setTransport() {},
      setVolume() {},
      start: async () => undefined,
      stop() {},
      meter: () => null,
    };
    const router = { exporting: false, fps: 24, flushHistory() {}, recordFrame() {}, onExportEnd: null };
    const library = { version: 1, playing: false, assetAudio: async () => null };
    const player = new PlayerImpl({ gpu, gate, registry, audio, library, router, phoneAudio: undefined } as never);
    // a stand-in for the page's canvas: the picture is drawn into a small texture
    const target = gpu.device.createTexture({ size: [16, 16], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const inner = player as unknown as { canvas: unknown; ctx: unknown };
    inner.canvas = { width: 0, height: 0, style: {} };
    inner.ctx = { getCurrentTexture: () => target, configure() {}, unconfigure() {} };
    player.setCacheQuality('lossless'); // the packing that needs no browser canvas
    player.setView({ graph, node: b.node.id, item: 0, itemCount: 1 });
    return { player, dec, counts: () => ({ evaluations, blits }), reset: () => { evaluations = 0; blits = 0; dec.reset(); } };
  }

  it('plays 120 frames forward, loops from the saved frames, and scrubs', async () => {
    const { player, dec, counts, reset } = await setup();
    // a phone-sized viewer: 72 x 128 CSS pixels at pixel ratio 3 -> about 144 device pixels wide for a 360 wide clip
    player.setViewerTarget({ cssWidth: 72, cssHeight: 128, dpr: 3 });
    await sleep(300);
    player.seek(0);
    await sleep(200);
    expect(dec.maxSides.at(-1) ?? 0).toBe(0); // paused: full size

    // ---- first pass: every frame is new
    reset();
    player.play();
    await sleep((FRAMES / FPS) * 1000 + 100);
    const first = { ...counts(), requests: dec.requests.length, seq: dec.sequential, seeks: dec.seeks, repeats: dec.repeats, up: dec.uploads.length };
    // Media In asks for the frames in order: the only jump is the one back to the start, and no frame is decoded twice
    expect(first.repeats).toBe(0);
    expect(first.seeks).toBeLessThanOrEqual(3);
    expect(first.seq).toBeGreaterThan(first.requests * 0.5);
    // one picture to the GPU per frame decoded, at most one per frame shown
    expect(first.up).toBeLessThanOrEqual(first.blits);
    // the preview is smaller than full size while playing (half size at most: 320 of 640 on the long side)
    expect(Math.max(...dec.maxSides.slice(2))).toBeLessThanOrEqual(Math.ceil(H * 0.5));
    expect(Math.max(...dec.uploads.slice(2).map((u) => u.h))).toBeLessThanOrEqual(Math.ceil(H * 0.5));
    // no frame was shown twice in a row for nothing: shown frames never exceed the clock's frames by much
    expect(first.blits).toBeLessThanOrEqual(FRAMES + 20);

    // ---- second pass: let the saved frames finish packing, then play again
    player.pause();
    await sleep(1500);
    const saved = player.getState().cachedFrames.size;
    if (process.env.BENCH_LOG) process.stderr.write(`\nfirst pass ${JSON.stringify(first)} saved ${saved}\n`);
    expect(saved).toBeGreaterThan(FRAMES * 0.4);
    reset();
    player.seek(0);
    player.play();
    await sleep((FRAMES / FPS) * 1000 + 100);
    const second = { ...counts(), requests: dec.requests.length };
    if (process.env.BENCH_LOG) process.stderr.write(`\nsecond pass ${JSON.stringify(second)} restored ${player.cacheStats.restored}\n`);
    // frames that were saved are shown without running the graph: evaluations are only for frames that were not saved
    expect(second.evaluations).toBeLessThanOrEqual(FRAMES - Math.floor(saved * 0.7) + 12);
    expect(second.requests).toBeLessThanOrEqual(second.evaluations);
    expect(player.cacheStats.restored).toBeGreaterThan(saved * 0.5);

    // ---- scrub: each jump is one seek, nothing else
    player.pause();
    await sleep(300);
    reset();
    for (const f of [90, 10, 55, 30, 100]) {
      player.seek(f / FPS);
      await sleep(250);
    }
    expect(dec.seeks).toBeLessThanOrEqual(10);
    expect(dec.repeats).toBeLessThanOrEqual(3);
    expect(Math.max(...dec.maxSides)).toBe(0); // paused frames are full size
    player.dispose();
  }, 60_000);

  it('without a known viewer size playback starts at full size (what the phone got before the viewer reported its size)', async () => {
    const { player, dec } = await setup();
    player.setViewerTarget(null);
    await sleep(200);
    dec.reset();
    player.play();
    await sleep(900);
    player.pause();
    expect(dec.maxSides.length).toBeGreaterThan(5);
    expect(dec.maxSides.every((m) => m === 0)).toBe(true);
    expect(dec.uploads.every((u) => u.h === H)).toBe(true);
    player.dispose();
  }, 30_000);

  it('the Performance readout measures only while it is on', async () => {
    const { player, dec } = await setup();
    expect(player.perfSnapshot()).toBeNull();
    player.setPerf(true);
    player.setViewerTarget({ cssWidth: 72, cssHeight: 128, dpr: 3 });
    dec.reset();
    player.play();
    await sleep(1200);
    const snap = player.perfSnapshot()!;
    expect(snap.window.frames).toBeGreaterThan(5);
    expect(snap.window.evalAvg).toBeGreaterThan(0);
    expect(snap.window.slowest.length).toBeGreaterThan(0);
    expect(snap.totalFrames).toBe(FRAMES);
    expect(snap.scale).toBeLessThanOrEqual(0.5);
    player.pause();
    player.setPerf(false);
    expect(player.perfSnapshot()).toBeNull();
    player.dispose();
  }, 30_000);
});
