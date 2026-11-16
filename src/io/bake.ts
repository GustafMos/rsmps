/**
 * Baking, now a thin layer over process mode (src/io/processes.ts): a Cache / Bake node declares `process` (its job renders every
 * frame of what feeds it and stages them as one sequence), the scheduler runs it, and the frames are stored as a hidden image sequence
 * owned by the project and the node, exactly as before. This file keeps the public `Io.bake` API and the `baked*` params contract so
 * existing callers, saved projects and tests are unchanged.
 *
 * Storage: frames are encoded one at a time (PNG when 'lossless', high-quality WebP otherwise) and only the encoded Blobs are kept,
 * so memory never holds more than one raw frame; the browser keeps large Blobs on disk. One IndexedDB write persists the sequence.
 */
import type { Registry } from '../engine/define';
import type { Engine, EvalRequest, EvalResult } from '../engine/engine';
import type { Gpu } from '../engine/gpu/gpu';
import type { AssetInfo, GraphDoc } from '../engine/types';
import type { BakeInfo, BakeOptions, BakeResult, BakeApi } from './api';
import { BAKE_OWNER, itemDependent, ProcessRuntime, processOwner, type ProcessLibrary } from './processes';

/** Hidden sequences of baked nodes are owned by `bake:<project>:<node>`. */
export { BAKE_OWNER };
export const bakeOwner = processOwner;

/** What baking needs from the media library (a fake in tests). */
export type BakeLibrary = ProcessLibrary;

export interface BakeDeps {
  engine: Pick<Engine, 'signatureOf' | 'processStatus' | 'processSignature'>;
  gpu: Gpu;
  registry: Registry;
  gate: { evaluateHeld(req: EvalRequest): Promise<EvalResult>; drop(res: EvalResult): void; exclusive<T>(fn: () => T | Promise<T>): Promise<T> };
  library: BakeLibrary;
  /** Draw a finished frame and encode it. Defaults to an OffscreenCanvas WebGPU presenter; tests inject their own. */
  encode?: (image: { texture: GPUTexture; width: number; height: number }, quality: 'lossless' | 'compressed') => Promise<Blob>;
  activeProject?: () => Promise<string | null>;
  player?: { hold(): () => void };
  governor?: { enter(mode: 'export'): () => void };
}

interface BakeMeta {
  signature: string;
  quality: 'lossless' | 'compressed';
  bytes: number;
  frames: number;
  item: number | null;
  nodeId: string;
  createdAt: number;
  width: number;
  height: number;
  unit: number;
  canvas: string;
}

export class BakeImpl implements BakeApi {
  private runtime: ProcessRuntime;

  /** `runtime`: the app's shared process runtime (so a bake queues with every other job); without it the bake gets a private one. */
  constructor(
    private d: BakeDeps,
    runtime?: ProcessRuntime,
  ) {
    this.runtime = runtime ?? new ProcessRuntime({ engine: d.engine, gpu: d.gpu, registry: d.registry, gate: d.gate, library: d.library, encode: d.encode, activeProject: d.activeProject, player: d.player, governor: d.governor });
  }

  /** True when the picture feeding fromNode can differ between batch items (a Media In with several files, an Item node). */
  itemDependent(graph: GraphDoc, fromNode: string): boolean {
    return itemDependent(graph, this.d.registry, fromNode);
  }

  async bake(graph: GraphDoc, nodeId: string, opts: BakeOptions): Promise<BakeResult> {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== 'cache') throw new Error('Bake needs a Cache / Bake node.');
    const edge = graph.edges.find((e) => e.to.node === nodeId && e.to.port === 'image');
    if (!edge) throw new Error('Connect something to the Cache / Bake node first: there is nothing to bake.');
    const busy = this.runtime.job(nodeId, opts.projectId);
    if (busy && (busy.state === 'queued' || busy.state === 'running' || busy.state === 'paused')) throw new Error('This node is already being baked.');
    const result = await this.runtime.run(graph, nodeId, {
      projectId: opts.projectId ?? (await this.d.activeProject?.()) ?? 'project',
      item: opts.item,
      signal: opts.signal,
      options: { quality: opts.quality, ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}) },
      onProgress: (p) => opts.onProgress?.({ frame: p.detail?.frame ?? 0, frames: p.detail?.frames ?? 0, fraction: p.fraction, bytes: p.detail?.bytes ?? 0 }),
    });
    const seq = result.items.frames;
    const item = typeof result.meta.item === 'number' ? result.meta.item : null;
    const handle = this.d.registry.get('cache')!.process!.handle!;
    return {
      assetId: seq.id,
      signature: result.signature,
      frames: seq.frames ?? 0,
      bytes: result.bytes,
      item,
      itemDependent: item !== null,
      params: handle.write(result) as Record<string, string>,
    };
  }

  private ownedAssets(nodeId: string): (AssetInfo & { owner?: string; bake?: BakeMeta })[] {
    const suffix = `:${nodeId}`;
    return (this.d.library.list({ includeHidden: true }) as (AssetInfo & { owner?: string; bake?: BakeMeta })[]).filter((a) => a.owner?.startsWith(BAKE_OWNER) && a.owner.endsWith(suffix));
  }

  async unbake(nodeId: string): Promise<void> {
    for (const a of this.ownedAssets(nodeId)) await this.d.library.removeOwned(a.owner!);
  }

  info(nodeId: string): BakeInfo | null {
    const a = this.ownedAssets(nodeId).find((x) => x.bake);
    if (!a?.bake) return null;
    const m = a.bake;
    const j = this.runtime.job(nodeId);
    return { assetId: a.id, signature: m.signature, frames: m.frames, bytes: m.bytes, quality: m.quality, item: m.item, fps: a.fps, width: m.width, height: m.height, createdAt: m.createdAt, running: !!j && (j.state === 'running' || j.state === 'paused' || j.state === 'queued') };
  }

  /** Remove stored sequences of a project whose Cache / Bake node no longer exists. Call after deleting nodes or on project load. */
  prune(projectId: string, graph: GraphDoc): Promise<number> {
    return this.runtime.prune(projectId, graph);
  }
}
