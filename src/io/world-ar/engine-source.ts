/**
 * The object's picture for the AR view, rendered by the node graph: this is how the app's WebGPU output gets into a WebXR session,
 * which can only show WebGL.
 *
 * For every request the graph is evaluated with the pose of that camera frame written into every World AR Camera node (a copy of
 * the graph with the hidden `live` param filled in, the same trick live picture nodes use for their tick). The result, a picture
 * with a transparent background, then goes into the painter's WebGL texture one of two ways:
 *  - 'canvas': it is drawn into a WebGPU canvas and the browser copies that canvas into the WebGL texture (`texImage2D`). On a
 *    phone both live on the same GPU, so this can stay on the GPU.
 *  - 'pixels': the pixels are read back to memory and uploaded. Always works; costs a round trip through memory per picture.
 * Which one is used is decided by trying: `probeCanvasCopy` draws a known pattern through the canvas route once and reads it back.
 * (In headless desktop Chromium the canvas route delivers an empty texture, which is exactly the case the probe is for.)
 *
 * One request at a time: a request while one is running is refused, so the loop always renders for the newest pose it can.
 */
import type { Registry } from '../../engine/define';
import type { Gpu } from '../../engine/gpu/gpu';
import { GROUP_MAX_DEPTH, GROUP_TYPE, PATH_SEP, groupData, updateNodeAtPath } from '../../engine/group';
import { upstream } from '../../engine/graph';
import type { EvalRequest, EvalResult } from '../../engine/engine';
import type { GraphDoc } from '../../engine/types';
import type { WorldMoment } from '../../engine/lib/world-take';
import { liveNodeIds, stampLive } from '../live-stamp';
import type { ArPicture, ArPictureSource } from './loop';

export const WORLD_AR_TYPE = 'world-ar';

/** Ids (paths inside groups) of the World AR Camera nodes of a graph. */
export function worldArNodeIds(graph: GraphDoc): string[] {
  const ids: string[] = [];
  const walk = (nodes: GraphDoc['nodes'], prefix: string, depth: number) => {
    for (const n of nodes) {
      if (n.type === WORLD_AR_TYPE) ids.push(prefix + n.id);
      if (n.type === GROUP_TYPE && depth < GROUP_MAX_DEPTH) walk(groupData(n).nodes, prefix + n.id + PATH_SEP, depth + 1);
    }
  };
  walk(graph.nodes, '', 0);
  return ids;
}

/** Does the graph hold a Physics node (also inside groups)? The AR view then runs the physics live. */
export function hasPhysics(graph: GraphDoc): boolean {
  const walk = (nodes: GraphDoc['nodes'], depth: number): boolean => nodes.some((n) => n.type === 'physics' || (n.type === GROUP_TYPE && depth < GROUP_MAX_DEPTH && walk(groupData(n).nodes, depth + 1)));
  return walk(graph.nodes, 0);
}

/**
 * Does any World AR Camera (also inside groups) have "Match room light" on? Only then does the AR view ask the phone to estimate the
 * light: the estimate is work the phone does for every camera frame, so it is not asked for when nothing would use it.
 */
export function wantsRoomLight(graph: GraphDoc): boolean {
  const walk = (nodes: GraphDoc['nodes'], depth: number): boolean => nodes.some((n) => (n.type === WORLD_AR_TYPE && n.params.matchLight !== false) || (n.type === GROUP_TYPE && depth < GROUP_MAX_DEPTH && walk(groupData(n).nodes, depth + 1)));
  return walk(graph.nodes, 0);
}

/** A copy of the graph in which every World AR Camera carries `moment` (null takes it out again). Other nodes keep their identity. */
export function stampWorldAr(graph: GraphDoc, ids: string[], moment: WorldMoment | null): GraphDoc {
  let g = graph;
  for (const id of ids) g = updateNodeAtPath(g, id, (n) => ({ ...n, params: { ...n.params, live: moment } }));
  return g;
}

/** Does a World AR Camera feed `nodeId`? Then its picture is the object seen from the phone; otherwise it is a flat picture. */
export function fedByWorldAr(graph: GraphDoc, nodeId: string): boolean {
  const ids = worldArNodeIds(graph);
  if (!ids.length) return false;
  if (ids.some((id) => id.includes(PATH_SEP))) return true; // inside a group: assume it feeds what is shown
  const up = upstream(graph, nodeId);
  return ids.some((id) => id === nodeId || up.has(id));
}

/** The painter's side of the copy. */
export interface PictureTarget {
  uploadPixels(bytes: Uint8Array | Uint8ClampedArray, width: number, height: number): void;
  uploadCanvas?(canvas: TexImageSource): void;
  readPicture?(points: [number, number][], height: number): number[][];
}

export type CopyRoute = 'canvas' | 'pixels';

export interface EngineSourceDeps {
  gate: { evaluateHeld(req: EvalRequest): Promise<EvalResult>; drop(res: EvalResult): void };
  gpu: Pick<Gpu, 'readRaw' | 'blit' | 'upload' | 'scoped' | 'device'>;
  registry: Registry;
  /** The graph as it is now (the user's project). */
  graph(): GraphDoc;
  node: string;
  port?: string;
  target: PictureTarget;
  route: CopyRoute;
  /** The WebGPU canvas of the 'canvas' route. */
  canvas?: { el: HTMLCanvasElement | OffscreenCanvas; ctx: GPUCanvasContext };
  /** True = render at the size the loop asks for (the phone's view). False = the project's own frame, scaled down to `maxSide`. */
  viewSized: boolean;
  maxSide: number;
  now(): number;
  /** Fewest milliseconds between two pictures (0 = as fast as they finish). */
  minInterval?: number;
}

function isTextured(v: unknown): v is { texture: GPUTexture; width: number; height: number } {
  return !!v && typeof v === 'object' && 'texture' in (v as object) && 'width' in (v as object);
}

export class EnginePictureSource implements ArPictureSource {
  private busy = false;
  private last: ArPicture | null = null;
  private lastError: string | null = null;
  private seq = 0;
  private tick = 0;
  private lastStart = -1e9;
  private disposed = false;
  /** Milliseconds the last picture took: evaluation, and the copy into WebGL. */
  timing = { render: 0, copy: 0 };
  route: CopyRoute;

  constructor(private d: EngineSourceDeps) {
    this.route = d.route === 'canvas' && d.canvas && d.target.uploadCanvas ? 'canvas' : 'pixels';
  }

  latest(): ArPicture | null {
    return this.last;
  }
  error(): string | null {
    return this.lastError;
  }
  dispose(): void {
    this.disposed = true;
  }

  request(req: { moment: WorldMoment; depth: number; size: { width: number; height: number }; seconds: number }): boolean {
    if (this.busy || this.disposed) return false;
    const now = this.d.now();
    if (now - this.lastStart < (this.d.minInterval ?? 0)) return false;
    this.lastStart = now;
    this.busy = true;
    void this.run(req)
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
      })
      .then(() => {
        this.busy = false;
      });
    return true;
  }

  private async run(req: { moment: WorldMoment; depth: number; size: { width: number; height: number }; seconds: number }): Promise<void> {
    const d = this.d;
    const base = d.graph();
    let graph = stampWorldAr(base, worldArNodeIds(base), req.moment);
    graph = stampLive(graph, liveNodeIds(graph, d.registry), ++this.tick);
    const long = Math.max(base.project.width, base.project.height);
    const t0 = d.now();
    const res = await d.gate.evaluateHeld({
      graph,
      node: d.node,
      port: d.port,
      seconds: req.seconds,
      proxy: d.viewSized ? 1 : Math.min(1, d.maxSide / Math.max(1, long)),
      canvas: d.viewSized ? req.size : undefined,
      quality: 'preview',
    });
    try {
      if (this.disposed) return;
      const first = res.errors.size ? [...res.errors.values()][0] : null;
      const v = res.value;
      if (!isTextured(v)) {
        this.lastError = first ?? 'This node has no picture to show. View a node that makes a picture.';
        return;
      }
      const t1 = d.now();
      if (this.route === 'canvas' && d.canvas && d.target.uploadCanvas) {
        const { el, ctx } = d.canvas;
        if (el.width !== v.width || el.height !== v.height) {
          el.width = v.width;
          el.height = v.height;
        }
        d.gpu.blit(v, ctx.getCurrentTexture(), false);
        // the canvas's picture only lasts until the browser's next paint: it is copied into WebGL right here, in the same task
        d.target.uploadCanvas(el as TexImageSource);
      } else {
        const bytes = await d.gpu.readRaw(v);
        if (this.disposed) return;
        d.target.uploadPixels(bytes, v.width, v.height);
      }
      this.timing = { render: t1 - t0, copy: d.now() - t1 };
      this.lastError = first;
      this.last = { moment: req.moment, depth: req.depth, width: v.width, height: v.height, seq: ++this.seq };
    } finally {
      d.gate.drop(res);
    }
  }
}

/**
 * Does copying from the WebGPU canvas into WebGL really deliver the picture here? Draws four known colours through that route and
 * reads them back from the WebGL texture. Any doubt (wrong colours, upside down, an exception) answers false, and the caller uses
 * the read-back route instead.
 */
export function probeCanvasCopy(gpu: Pick<Gpu, 'upload' | 'blit' | 'scoped'>, canvas: { el: HTMLCanvasElement | OffscreenCanvas; ctx: GPUCanvasContext }, target: PictureTarget): boolean {
  if (!target.uploadCanvas || !target.readPicture) return false;
  try {
    const N = 8;
    // four quarters: red (top-left), green (top-right), blue (bottom-left), half-transparent white (bottom-right)
    const colours = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 128]];
    const data = new Uint8Array(N * N * 4);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) data.set(colours[(y < N / 2 ? 0 : 2) + (x < N / 2 ? 0 : 1)], (y * N + x) * 4);
    canvas.el.width = N;
    canvas.el.height = N;
    gpu.scoped(() => gpu.blit(gpu.upload(data, N, N, 1, true), canvas.ctx.getCurrentTexture(), true));
    target.uploadCanvas(canvas.el as TexImageSource);
    const got = target.readPicture([[1, 1], [N - 2, 1], [1, N - 2], [N - 2, N - 2]], N);
    // premultiplied: half-transparent white reads as about 128 in every channel
    const want = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [128, 128, 128, 128]];
    return got.every((px, i) => px.every((c, k) => Math.abs(c - want[i][k]) <= 6));
  } catch {
    return false;
  }
}
