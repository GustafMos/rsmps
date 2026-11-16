/**
 * Dev-only heavy-session benchmark for the memory pass. NOT imported by the app: load it from a dev tab with
 *   const b = await import('/src/io/bench.ts'); await b.heavy(window.__rsmpsIo)
 * It counts every GPU object by patching the WebGPU prototypes (independent of src/engine/gpu, so the same script measures the
 * code before and after the optimisation), plays, scrubs, edits and exports a heavy graph and returns a report.
 */
import { addNode, connect, createGraph, setParam } from '../engine/graph';
import type { GraphDoc } from '../engine/types';
import type { Io } from './api';

type Counts = Record<string, number>;
const counts: Counts = {};
const liveBuf = new Map<object, number>();
const liveTex = new Map<object, number>();
let peakBuf = 0;
let peakTex = 0;
let installed = false;

function bytesOfTexture(d: GPUTextureDescriptor): number {
  const size = Array.isArray(d.size) ? d.size : ((d.size as unknown as Iterable<number>) && [...(d.size as unknown as Iterable<number>)]) || [1, 1];
  const [w, h = 1, layers = 1] = size as number[];
  const bpp: Record<string, number> = { rgba8unorm: 4, bgra8unorm: 4, rgba16float: 8, depth24plus: 4, rgba32float: 16, r32float: 4, rgba8unorm_srgb: 4 };
  return w * h * layers * (bpp[d.format] ?? 4) * (d.sampleCount ?? 1);
}

function sum(m: Map<object, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}

export function install(): void {
  if (installed) return;
  installed = true;
  const inc = (k: string) => (counts[k] = (counts[k] ?? 0) + 1);
  const dev = GPUDevice.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const wrap = (proto: Record<string, (...a: unknown[]) => unknown>, name: string, after?: (res: unknown, args: unknown[]) => void) => {
    const orig = proto[name];
    proto[name] = function (this: unknown, ...args: unknown[]) {
      inc(name);
      const res = orig.apply(this, args);
      after?.(res, args);
      return res;
    };
  };
  wrap(dev, 'createBuffer', (res, args) => {
    liveBuf.set(res as object, (args[0] as GPUBufferDescriptor).size);
    peakBuf = Math.max(peakBuf, sum(liveBuf));
  });
  wrap(dev, 'createTexture', (res, args) => {
    liveTex.set(res as object, bytesOfTexture(args[0] as GPUTextureDescriptor));
    peakTex = Math.max(peakTex, sum(liveTex));
  });
  for (const n of ['createBindGroup', 'createBindGroupLayout', 'createRenderPipeline', 'createComputePipeline', 'createShaderModule', 'createSampler', 'createCommandEncoder', 'createPipelineLayout']) wrap(dev, n);
  wrap(GPUTexture.prototype as unknown as Record<string, (...a: unknown[]) => unknown>, 'createView');
  const bd = GPUBuffer.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const origBd = bd.destroy;
  bd.destroy = function (this: unknown) {
    inc('bufferDestroy');
    liveBuf.delete(this as object);
    return origBd.apply(this);
  };
  const td = GPUTexture.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  const origTd = td.destroy;
  td.destroy = function (this: unknown) {
    inc('textureDestroy');
    liveTex.delete(this as object);
    return origTd.apply(this);
  };
  wrap(GPUQueue.prototype as unknown as Record<string, (...a: unknown[]) => unknown>, 'submit');
  wrap(GPUQueue.prototype as unknown as Record<string, (...a: unknown[]) => unknown>, 'writeBuffer');
}

export function snapshotCounts(): Record<string, number> {
  return { ...counts, liveBuffers: liveBuf.size, liveBufferBytes: sum(liveBuf), peakBufferBytes: peakBuf, liveTextures: liveTex.size, liveTextureBytes: sum(liveTex), peakTextureBytes: peakTex };
}

const MB = 1048576;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Sample {
  t: number;
  phase: string;
  liveTexMB: number;
  liveBufMB: number;
  liveTextures: number;
  liveBuffers: number;
  createdViews: number;
  createdBindGroups: number;
  createdBuffers: number;
  submits: number;
  pipelines: number;
  shaders: number;
  poolMB: number;
  engineMB: number;
  frameCacheMB: number;
  decodedMB: number;
  jsHeapMB: number;
  fps?: number;
  [k: string]: unknown;
}

function sample(io: Io, phase: string, t0: number, extra: Record<string, unknown> = {}): Sample {
  const c = snapshotCounts();
  const m = io.memory() as unknown as Record<string, number>;
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number } };
  return {
    t: Math.round(performance.now() - t0),
    phase,
    liveTexMB: +(c.liveTextureBytes / MB).toFixed(1),
    liveBufMB: +(c.liveBufferBytes / MB).toFixed(1),
    liveTextures: c.liveTextures,
    liveBuffers: c.liveBuffers,
    createdViews: c.createView ?? 0,
    createdBindGroups: c.createBindGroup ?? 0,
    createdBuffers: c.createBuffer ?? 0,
    submits: c.submit ?? 0,
    pipelines: (c.createRenderPipeline ?? 0) + (c.createComputePipeline ?? 0),
    shaders: c.createShaderModule ?? 0,
    poolMB: +(m.gpuPoolBytes / MB).toFixed(1),
    engineMB: +(m.engineCacheBytes / MB).toFixed(1),
    frameCacheMB: +(m.frameCacheBytes / MB).toFixed(1),
    decodedMB: +(m.decodedMediaBytes / MB).toFixed(1),
    jsHeapMB: +((perf.memory?.usedJSHeapSize ?? 0) / MB).toFixed(1),
    ...extra,
  };
}

async function noise4k(): Promise<File> {
  const c = new OffscreenCanvas(3840, 2160);
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 3840, 2160);
  grad.addColorStop(0, '#f43'); grad.addColorStop(0.5, '#3af'); grad.addColorStop(1, '#fd2');
  g.fillStyle = grad;
  g.fillRect(0, 0, 3840, 2160);
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `hsl(${(i * 37) % 360} 80% 55%)`;
    g.beginPath();
    g.arc((i * 997) % 3840, (i * 577) % 2160, 20 + (i % 90), 0, 7);
    g.fill();
  }
  return new File([await c.convertToBlob({ type: 'image/png' })], 'big4k.png', { type: 'image/png' });
}

export interface HeavyOptions {
  playFrames?: number;
  scrubs?: number;
  edits?: number;
  exportFrames?: number;
  skip?: string[];
  log?: (s: Sample) => void;
}

/** Build the heavy graph. Returns the graph and the output node id. */
export async function buildHeavyGraph(io: Io, assets: { videoA: string; videoB: string; big: string; small: string }): Promise<{ graph: GraphDoc; out: string; ids: Record<string, string> }> {
  const R = io.registry;
  let g = createGraph('bench');
  g = { ...g, project: { ...g.project, width: 1920, height: 1080, fps: 24, duration: 100 / 24, loop: true } };
  const ids: Record<string, string> = {};
  const add = (key: string, type: string, params: Record<string, unknown> = {}) => {
    const r = addNode(g, R, type, { x: 0, y: 0 }, params);
    g = r.graph;
    ids[key] = r.node.id;
    return r.node.id;
  };
  const wire = (a: string, b: string, from = 'image', to = 'image') => {
    g = connect(g, R, { node: ids[a], port: from }, { node: ids[b], port: to });
  };
  add('vidA', 'media-in', { assets: [assets.videoA] });
  add('vidB', 'media-in', { assets: [assets.videoB] });
  add('big', 'media-in', { assets: [assets.big], fullRes: true });
  add('small', 'media-in', { assets: [assets.small] });
  add('blur', 'blur', { radius: 12 });
  add('bloom', 'bloom');
  add('pixelate', 'pixelate');
  add('dither', 'dither', { algorithm: 'floyd-steinberg' });
  add('crt', 'crt-display');
  add('sort', 'pixel-sort');
  add('blur2', 'blur', { radius: 6 });
  add('obj', 'object-3d', { spinY: 1 });
  add('merge', 'merge');
  add('stack', 'stack');
  add('out', 'image-out', { kind: 'sequence' });
  wire('vidA', 'blur'); wire('blur', 'bloom'); wire('bloom', 'pixelate'); wire('pixelate', 'dither'); wire('dither', 'crt');
  wire('big', 'sort'); wire('sort', 'blur2');
  wire('crt', 'merge', 'image', 'background'); wire('blur2', 'merge', 'image', 'foreground');
  wire('merge', 'stack', 'image', 'images'); wire('obj', 'stack', 'image', 'images'); wire('vidB', 'stack', 'image', 'images'); wire('small', 'stack', 'image', 'images');
  wire('stack', 'out');
  return { graph: g, out: ids.out, ids };
}

export async function heavy(io: Io, opts: HeavyOptions = {}): Promise<{ samples: Sample[]; phases: Record<string, Sample>; notes: string[] }> {
  install();
  const t0 = performance.now();
  const samples: Sample[] = [];
  const phases: Record<string, Sample> = {};
  const notes: string[] = [];
  const skip = new Set(opts.skip ?? []);
  let phase = 'setup';
  const take = (extra: Record<string, unknown> = {}) => {
    const s = sample(io, phase, t0, extra);
    samples.push(s);
    opts.log?.(s);
    return s;
  };
  const ticker = setInterval(() => take(), 1000);
  let addedIds: string[] = [];
  let canvasEl: HTMLCanvasElement | null = null;
  try {
    const vid = await (await fetch('/test-assets/testsrc.mp4')).blob();
    const big = await noise4k();
    const png = await (await fetch('/test-assets/scene-1920x1080.png')).blob();
    const added = await io.library.add([
      new File([vid], 'vidA.mp4', { type: 'video/mp4' }),
      new File([vid], 'vidB.mp4', { type: 'video/mp4' }),
      big,
      new File([png], 'small.png', { type: 'image/png' }),
    ]);
    addedIds = added.map((a) => a.id);
    const { graph: g0, out, ids } = await buildHeavyGraph(io, { videoA: added[0].id, videoB: added[1].id, big: added[2].id, small: added[3].id });
    let graph = g0;
    const canvas = document.createElement('canvas');
    canvasEl = canvas;
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:480px;height:270px;z-index:-1';
    document.body.appendChild(canvas);
    io.player.setCanvas(canvas);
    const view = () => io.player.setView({ graph, node: out, item: 0, itemCount: 1, activeOutput: out });
    const settle = async (ms = 4000) => {
      const end = performance.now() + ms;
      let last = '';
      let stable = 0;
      while (performance.now() < end) {
        await sleep(40);
        const s = io.player.getState();
        const k = `${s.frame}|${s.proxy}|${s.renderedSize?.width}`;
        stable = k === last ? stable + 1 : 0;
        last = k;
        if (stable >= 4) return;
      }
    };
    phase = 'first-render';
    view();
    await settle(15000);
    phases.firstRender = take({ errors: [...io.player.getState().errors.entries()].map(([k, v]) => `${k}: ${v}`) });

    if (!skip.has('play')) {
      phase = 'play';
      io.player.setProxy('auto');
      const frames = opts.playFrames ?? 300;
      const start = performance.now();
      io.player.seek(0);
      io.player.play();
      const needMs = (frames / 24) * 1000;
      await sleep(Math.min(needMs * 1.5, 40000));
      io.player.pause();
      const st = io.player.getState();
      phases.play = take({ playSeconds: +((performance.now() - start) / 1000).toFixed(1), fps: st.measuredFps, proxy: st.proxy });
      await settle(8000);
    }
    if (!skip.has('scrub')) {
      phase = 'scrub';
      const n = opts.scrubs ?? 100;
      const startScrub = performance.now();
      for (let i = 0; i < n; i++) {
        io.player.seek(Math.random() * (100 / 24));
        await sleep(35);
      }
      await settle(8000);
      phases.scrub = take({ scrubMsPer: +((performance.now() - startScrub) / n).toFixed(1) });
    }
    if (!skip.has('edit')) {
      phase = 'edit';
      const n = opts.edits ?? 50;
      const proxies: ('auto' | number)[] = [1, 0.5, 0.25, 'auto', 0.75];
      for (let i = 0; i < n; i++) {
        const k = i % 5;
        if (k === 0) graph = setParam(graph, ids.blur, 'radius', 4 + ((i * 7) % 37));
        else if (k === 1) graph = setParam(graph, ids.pixelate, 'size', 2 + (i % 9));
        else if (k === 2) graph = setParam(graph, ids.bloom, 'radius', 8 + (i % 30));
        else if (k === 3) graph = setParam(graph, ids.crt, 'glowRadius', 2 + (i % 20));
        else io.player.setProxy(proxies[(i / 5) % 5 | 0]);
        view();
        await sleep(90);
      }
      io.player.setProxy('auto');
      await settle(8000);
      phases.edit = take();
    }
    if (!skip.has('export')) {
      phase = 'export';
      const startExport = performance.now();
      try {
        const files = await io.exporter.run({ graph, outputs: [out], items: 'current', item: 0, zip: false });
        const bytes = files.reduce((s, f) => s + f.blob.size, 0);
        phases.export = take({ exportMs: Math.round(performance.now() - startExport), exportFiles: files.length, exportMB: +(bytes / MB).toFixed(1) });
      } catch (e) {
        notes.push(`export failed: ${e instanceof Error ? e.message : String(e)}`);
        phases.export = take({ exportMs: Math.round(performance.now() - startExport), exportError: String(e) });
      }
      await settle(8000);
    }
    phase = 'idle-end';
    await sleep(3000);
    phases.idleEnd = take();
    await sleep(3000);
    phases.idleEnd2 = take();
    await io.freeMemory();
    await sleep(500);
    phase = 'after-free';
    phases.afterFree = take();
  } finally {
    clearInterval(ticker);
    canvasEl?.remove();
    // leave the user's library as it was
    for (const id of addedIds) await io.library.remove(id).catch(() => undefined);
  }
  return { samples, phases, notes };
}

/** Counts per second while nothing changes (the view is paused and not edited). */
export async function idleRate(io: Io, seconds = 5): Promise<Record<string, number>> {
  install();
  const a = snapshotCounts();
  await sleep(seconds * 1000);
  const b = snapshotCounts();
  const out: Record<string, number> = {};
  for (const k of Object.keys(b)) if (!k.startsWith('live') && !k.startsWith('peak')) out[k] = +(((b[k] ?? 0) - (a[k] ?? 0)) / seconds).toFixed(2);
  void io;
  return out;
}
