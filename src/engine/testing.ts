/**
 * Test harness for nodes. Runs on the real GPU (headless WebGPU in Node).
 *
 *   const t = await harness();
 *   const out = await t.run('blur', { radius: 4 }, { image: t.checker(64, 64) });
 *   const px = await t.pixels(out.image);
 */
import { Registry } from './define';
import { Engine } from './engine';
import { Gpu, createHeadlessDevice } from './gpu/gpu';
import { addNode, connect, createGraph } from './graph';
import { registerBuiltins } from './nodes';
import type { AnyNodeDef, GraphDoc, Host, ImageValue, MaskValue, ProjectSettings, Value } from './types';

let shared: Promise<Gpu> | null = null;
export function testGpu(): Promise<Gpu> {
  shared ??= createHeadlessDevice().then((d) => new Gpu(d));
  return shared;
}

/**
 * Render counters. `EvalResult.timings` holds only the nodes that actually rendered in an evaluation (cache hits are absent), so
 * "which nodes rendered" is exactly its key set. `renderedNodes(await engine.evaluate(...))` is the sorted list of node ids;
 * `RenderTally` adds them up over many evaluations ("this node rendered once in 60 frames").
 */
export function renderedNodes(r: { timings: Map<string, number> }): string[] {
  return [...r.timings.keys()].sort();
}

export class RenderTally {
  readonly counts = new Map<string, number>();
  add(r: { timings: Map<string, number> }): string[] {
    const ids = renderedNodes(r);
    for (const id of ids) this.counts.set(id, (this.counts.get(id) ?? 0) + 1);
    return ids;
  }
  get(id: string): number {
    return this.counts.get(id) ?? 0;
  }
  reset(): void {
    this.counts.clear();
  }
}

/** An input fed by a registered node (e.g. an animated test source) instead of a still picture: `{ node: 'noise', params: {...} }`. */
export interface NodeInput {
  node: string;
  params?: Record<string, unknown>;
}
type HarnessInput = ImageValue | MaskValue | number | NodeInput | (ImageValue | MaskValue | NodeInput)[];
const isNodeInput = (v: unknown): v is NodeInput => !!v && typeof v === 'object' && 'node' in (v as object) && !('texture' in (v as object));

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Straight RGBA at (x, y). */
  at(x: number, y: number): [number, number, number, number];
}

/** Largest acceptable `LoopReport.seam`. A perfect loop is about 1 or below; a pop is several times that. */
export const LOOP_SEAM_OK = 1.25;
/** Steps smaller than this (mean absolute byte difference, or 0.1% of the range for numbers) count as "no change". */
const STEP_FLOOR = 0.05;

export interface LoopCheckOptions {
  /** Loop length in frames (default 20). */
  frames?: number;
  fps?: number;
  /** Canvas size for generators and the size hint (default 64). */
  size?: number | { width: number; height: number };
  /** Output port to measure (default: the first picture output, else the first number). */
  port?: string;
  /** Also evaluate frame N (and N + a few) and report `exactDiff`: periodic bit-for-bit. */
  exact?: boolean;
  /** Extra project settings (loop is always on). */
  project?: Partial<ProjectSettings>;
}

export interface LoopReport {
  frames: number;
  /** Difference of the wrap step (last frame -> first frame). Mean absolute byte difference, or absolute value difference for numbers. */
  wrap: number;
  /** Median ordinary step. */
  typical: number;
  /** Mean ordinary step. */
  mean: number;
  /** Largest ordinary step. */
  max: number;
  /** wrap / max(largest ordinary step, floor). <= LOOP_SEAM_OK means the seam is no bigger than the biggest step elsewhere. */
  seam: number;
  /** Largest difference between frame 0 and any other frame: > 0 means it really moves (a still picture has 0). */
  motion: number;
  /** The worst step of all, wrap included. */
  worst: { from: number; to: number; diff: number; wrap: boolean };
  /** Every step k -> k + 1 (index k), the wrap step last. */
  steps: number[];
  /** With `exact`: largest absolute difference between frame N (and N + k) and frame 0 (and k). 0 = periodic bit for bit. */
  exactDiff?: number;
  /** One line for assertion messages. */
  text: string;
}

export interface Harness {
  gpu: Gpu;
  registry: Registry;
  engine: Engine;
  /** Register an in-test image so it can be wired as an input. Returns a node type id producing it. */
  source(image: ImageValue | MaskValue): string;
  /** Solid colour image (straight RGBA 0..255). `unit` defaults to 1. */
  solid(width: number, height: number, rgba: [number, number, number, number], unit?: number): ImageValue;
  /** Black/white checkerboard with `cell`-texel squares. */
  checker(width: number, height: number, cell?: number, unit?: number): ImageValue;
  /** Horizontal gradient black → white, with a hard vertical edge of a red square in the middle. Good for edge-aware tests. */
  scene(width: number, height: number, unit?: number): ImageValue;
  /** Image from a function returning straight RGBA 0..255 per pixel. */
  fromFn(width: number, height: number, fn: (x: number, y: number) => [number, number, number, number], unit?: number): ImageValue;
  /** Mask from a function returning coverage 0..1. */
  maskFn(width: number, height: number, fn: (x: number, y: number) => number, unit?: number): MaskValue;
  /**
   * Run one node. `inputs` maps input socket (or param socket) → test value. Returns all outputs.
   * `opts.seconds` sets the frame time; `opts.project` overrides project settings.
   */
  run(
    type: string,
    params?: Record<string, unknown>,
    inputs?: Record<string, HarnessInput>,
    opts?: { seconds?: number; project?: Partial<ProjectSettings>; item?: number; itemCount?: number; proxy?: number },
  ): Promise<Record<string, Value | null>>;
  /** Evaluate a prepared graph at a node. */
  evalGraph(graph: GraphDoc, node: string, opts?: { seconds?: number; port?: string; proxy?: number }): Promise<Value | null>;
  pixels(image: ImageValue | MaskValue | null | undefined): Promise<Pixels>;
  /** Mean absolute difference per channel (0..255) between two images of the same size. */
  diff(a: ImageValue | MaskValue, b: ImageValue | MaskValue): Promise<number>;
  /**
   * THE loop test. Renders frames 0..N-1 of a loop of N frames with Loop ON and compares the WRAP step (frame N-1 -> frame 0) with the
   * ordinary steps (k -> k+1). Frame N itself is never used for the seam: the clock wraps, so comparing frame 0 with "frame N" compares a
   * frame with itself and proves nothing (the old check did exactly that).
   * See `LoopReport`: `seam <= LOOP_SEAM_OK` and `motion > 0` is a real loop; `exact: true` additionally evaluates times beyond the
   * loop and reports `exactDiff` (0 = bit-for-bit periodic).
   */
  loopCheck(
    type: string,
    params?: Record<string, unknown>,
    inputs?: Record<string, HarnessInput>,
    opts?: LoopCheckOptions,
  ): Promise<LoopReport>;
}

const nullHost: Host = {
  assetInfo: () => null,
  assetFrame: async () => null,
};

export async function harness(extraDefs: AnyNodeDef[] = [], host: Host = nullHost): Promise<Harness> {
  const gpu = await testGpu();
  const registry = new Registry();
  registerBuiltins(registry);
  extraDefs.forEach((d) => registry.register(d));
  const engine = new Engine(gpu, registry, host);
  let sourceCount = 0;

  const fromFn: Harness['fromFn'] = (width, height, fn, unit = 1) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(fn(x, y), (y * width + x) * 4);
    const img = gpu.upload(data, width, height, unit, true);
    gpu.retain(img.texture); // test images live for the whole test run
    return img;
  };

  const source: Harness['source'] = (image) => {
    const id = `test-source-${++sourceCount}`;
    registry.register({
      id,
      title: id,
      category: 'input',
      description: 'test source',
      inputs: {},
      outputs: { out: { type: image.kind } },
      params: {},
      render: () => ({ out: image }),
    });
    return id;
  };

  const valueSource = (n: number): string => {
    const id = `test-number-${++sourceCount}`;
    registry.register({
      id,
      title: id,
      category: 'input',
      description: 'test number',
      inputs: {},
      outputs: { out: { type: 'number' } },
      params: {},
      render: () => ({ out: n }),
    });
    return id;
  };

  const run: Harness['run'] = async (type, params = {}, inputs = {}, opts = {}) => {
    const def = registry.get(type);
    if (!def) throw new Error(`Unknown node type "${type}"`);
    let graph = createGraph('test');
    graph.project = { ...graph.project, ...opts.project };
    const added = addNode(graph, registry, type, { x: 0, y: 0 }, params);
    graph = added.graph;
    for (const [port, value] of Object.entries(inputs)) {
      for (const v of Array.isArray(value) ? value : [value]) {
        const srcType = typeof v === 'number' ? valueSource(v) : isNodeInput(v) ? v.node : source(v);
        const s = addNode(graph, registry, srcType, { x: 0, y: 0 }, isNodeInput(v) ? v.params : undefined);
        graph = connect(s.graph, registry, { node: s.node.id, port: isNodeInput(v) ? Object.keys(registry.get(srcType)!.outputs)[0] : 'out' }, { node: added.node.id, port });
      }
    }
    const outputs: Record<string, Value | null> = {};
    const ports = Object.keys(def.outputs);
    for (const port of ports) {
      const r = await engine.evaluate({ graph, node: added.node.id, port, seconds: opts.seconds, item: opts.item, itemCount: opts.itemCount, proxy: opts.proxy });
      const err = r.errors.get(added.node.id);
      if (err) throw new Error(`${type}: ${err}`);
      outputs[port] = r.value;
    }
    return outputs;
  };

  const pixels: Harness['pixels'] = async (image) => {
    if (!image) throw new Error('pixels(): image is null (did the node produce an output?)');
    const data = await gpu.read(image, true);
    const { width, height } = image;
    return {
      data,
      width,
      height,
      at: (x, y) => {
        const i = (y * width + x) * 4;
        return [data[i], data[i + 1], data[i + 2], data[i + 3]];
      },
    };
  };

  return {
    gpu,
    registry,
    engine,
    source,
    fromFn,
    solid: (w, h, rgba, unit) => fromFn(w, h, () => rgba, unit),
    checker: (w, h, cell = 8, unit) => fromFn(w, h, (x, y) => ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]), unit),
    scene: (w, h, unit) =>
      fromFn(
        w,
        h,
        (x, y) => {
          const inside = x > w * 0.35 && x < w * 0.65 && y > h * 0.35 && y < h * 0.65;
          const g = Math.round((x / Math.max(1, w - 1)) * 255);
          return inside ? [220, 40, 40, 255] : [g, g, g, 255];
        },
        unit,
      ),
    maskFn: (w, h, fn, unit = 1) => {
      const img = fromFn(w, h, (x, y) => {
        const c = Math.round(Math.min(1, Math.max(0, fn(x, y))) * 255);
        return [c, c, c, 255];
      }, unit);
      return { ...img, kind: 'mask' };
    },
    run,
    evalGraph: async (graph, node, opts = {}) => {
      const r = await engine.evaluate({ graph, node, port: opts.port, seconds: opts.seconds, proxy: opts.proxy });
      if (r.errors.size) throw new Error([...r.errors.entries()].map(([k, v]) => `${k}: ${v}`).join('; '));
      return r.value;
    },
    pixels,
    diff: async (a, b) => {
      if (a.width !== b.width || a.height !== b.height) throw new Error(`diff(): sizes differ ${a.width}x${a.height} vs ${b.width}x${b.height}`);
      const [pa, pb] = [await gpu.read(a, false), await gpu.read(b, false)];
      let sum = 0;
      for (let i = 0; i < pa.length; i++) sum += Math.abs(pa[i] - pb[i]);
      return sum / pa.length;
    },
    loopCheck: async (type, params = {}, inputs = {}, opts = {}) => {
      const frames = Math.max(2, Math.round(opts.frames ?? 20));
      const fps = opts.fps ?? 10;
      const sz = typeof opts.size === 'number' ? { width: opts.size, height: opts.size } : (opts.size ?? { width: 64, height: 64 });
      const project = { fps, duration: frames / fps, loop: true, ...sz, referenceSide: Math.min(sz.width, sz.height), ...opts.project };
      type Shot = Uint8ClampedArray | Float32Array | number;
      let key = opts.port ?? '';
      const grab = async (f: number): Promise<Shot> => {
        const out = await run(type, params, inputs, { seconds: f / fps, project });
        if (!key) {
          key = Object.keys(out).find((k) => out[k] && typeof out[k] === 'object' && 'texture' in (out[k] as object)) ?? Object.keys(out).find((k) => typeof out[k] === 'number') ?? '';
          if (!key) throw new Error('loopCheck(): node has no picture or number output');
        }
        const v = out[key];
        if (typeof v === 'number') return v;
        if (v && typeof v === 'object' && 'texture' in v) return gpu.read(v as ImageValue, false);
        if (Array.isArray(v) && v.every((n) => typeof n === 'number')) return Float32Array.from(v as number[]);
        throw new Error(`loopCheck(): output "${key}" is neither a picture, a number nor a vector`);
      };
      const dist = (a: Shot, b: Shot): number => {
        if (typeof a === 'number' || typeof b === 'number') return Math.abs((a as number) - (b as number));
        let s = 0;
        for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
        return s / a.length;
      };
      const maxDist = (a: Shot, b: Shot): number => {
        if (typeof a === 'number' || typeof b === 'number') return Math.abs((a as number) - (b as number));
        let m = 0;
        for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
        return m;
      };
      const shots: Shot[] = [];
      for (let f = 0; f < frames; f++) shots.push(await grab(f));
      const steps: number[] = [];
      for (let f = 0; f < frames; f++) steps.push(dist(shots[f], shots[(f + 1) % frames]));
      const wrap = steps[frames - 1];
      const ord = steps.slice(0, frames - 1);
      const sorted = [...ord].sort((x, y) => x - y);
      const typical = sorted[Math.floor(sorted.length / 2)];
      const max = sorted[sorted.length - 1];
      const mean = ord.reduce((x, y) => x + y, 0) / ord.length;
      let floor = STEP_FLOOR;
      if (!(shots[0] instanceof Uint8ClampedArray)) {
        const vals = shots.flatMap((x) => (typeof x === 'number' ? [x] : [...x]));
        floor = Math.max(1e-9, (Math.max(...vals) - Math.min(...vals)) * 1e-3);
      }
      const seam = wrap / Math.max(max, floor);
      let motion = 0;
      for (let f = 1; f < frames; f++) motion = Math.max(motion, dist(shots[0], shots[f]));
      let wi = 0;
      steps.forEach((d, i) => { if (d > steps[wi]) wi = i; });
      const worst = { from: wi, to: (wi + 1) % frames, diff: steps[wi], wrap: wi === frames - 1 };
      let exactDiff: number | undefined;
      if (opts.exact) {
        const k = Math.max(1, Math.floor(frames / 3));
        exactDiff = Math.max(maxDist(await grab(frames), shots[0]), maxDist(await grab(frames + k), shots[k]));
      }
      const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
      const text = `${type} ${frames}f: wrap ${r4(wrap)} (${frames - 1}->0) vs ordinary median ${r4(typical)} max ${r4(max)} => seam ${r4(seam)}; worst step ${worst.from}->${worst.to} = ${r4(worst.diff)}${worst.wrap ? ' (THE WRAP)' : ''}; motion ${r4(motion)}${exactDiff === undefined ? '' : `; exact diff ${r4(exactDiff)}`}`;
      return { frames, wrap, typical, mean, max, seam, motion, worst, steps, exactDiff, text };
    },
  };
}
