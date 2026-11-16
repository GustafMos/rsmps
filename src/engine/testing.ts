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

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Straight RGBA at (x, y). */
  at(x: number, y: number): [number, number, number, number];
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
    inputs?: Record<string, ImageValue | MaskValue | number | (ImageValue | MaskValue)[]>,
    opts?: { seconds?: number; project?: Partial<ProjectSettings>; item?: number; itemCount?: number; proxy?: number },
  ): Promise<Record<string, Value | null>>;
  /** Evaluate a prepared graph at a node. */
  evalGraph(graph: GraphDoc, node: string, opts?: { seconds?: number; port?: string; proxy?: number }): Promise<Value | null>;
  pixels(image: ImageValue | MaskValue | null | undefined): Promise<Pixels>;
  /** Mean absolute difference per channel (0..255) between two images of the same size. */
  diff(a: ImageValue | MaskValue, b: ImageValue | MaskValue): Promise<number>;
  /**
   * Assert-friendly loop check: renders the node at frame 0 and at the frame one full loop later
   * and returns their difference (must be ~0 for anything animated), plus the difference between
   * frame 0 and the middle frame (must be > 0 if the node is supposed to move).
   */
  loopCheck(
    type: string,
    params?: Record<string, unknown>,
    inputs?: Record<string, ImageValue | MaskValue | number>,
  ): Promise<{ seam: number; motion: number }>;
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
        const srcType = typeof v === 'number' ? valueSource(v) : source(v);
        const s = addNode(graph, registry, srcType);
        graph = connect(s.graph, registry, { node: s.node.id, port: 'out' }, { node: added.node.id, port });
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
    loopCheck: async (type, params = {}, inputs = {}) => {
      const project = { fps: 10, duration: 2, loop: true, width: 64, height: 64 };
      const first = await run(type, params, inputs, { seconds: 0, project });
      const key = Object.keys(first).find((k) => first[k] && typeof first[k] === 'object' && 'texture' in (first[k] as object));
      if (!key) throw new Error('loopCheck(): node has no image output');
      const a = await gpu.read(first[key] as ImageValue, false);
      const mid = await gpu.read((await run(type, params, inputs, { seconds: 1, project }))[key] as ImageValue, false);
      const end = await gpu.read((await run(type, params, inputs, { seconds: 2, project }))[key] as ImageValue, false);
      let seam = 0;
      let motion = 0;
      for (let i = 0; i < a.length; i++) {
        seam += Math.abs(a[i] - end[i]);
        motion += Math.abs(a[i] - mid[i]);
      }
      return { seam: seam / a.length, motion: motion / a.length };
    },
  };
}
