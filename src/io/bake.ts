/**
 * Baking: render every frame of what feeds a Cache / Bake node, store it as a hidden image sequence owned by the project and the
 * node, and hand back what the UI must write into the node's params. The node itself (src/engine/nodes/time/cache.node.ts) then
 * serves those frames and no longer evaluates anything upstream.
 *
 * Storage: frames are encoded one at a time (PNG when 'lossless', high-quality WebP otherwise) and only the encoded Blobs are kept,
 * so memory never holds more than one raw frame; the browser keeps large Blobs on disk. One IndexedDB write persists the sequence.
 */
import type { Registry } from '../engine/define';
import type { Engine, EvalRequest, EvalResult } from '../engine/engine';
import type { Gpu } from '../engine/gpu/gpu';
import { batchCount } from '../engine/graph';
import type { AssetInfo, GraphDoc, ImageValue } from '../engine/types';
import type { BakeInfo, BakeOptions, BakeResult, BakeApi } from './api';
import { OffscreenPresenter, presentToBlob } from './encode';
import { totalFramesOf } from './util';

/** Hidden sequences of baked nodes are owned by `bake:<project>:<node>`. */
export const BAKE_OWNER = 'bake:';
export function bakeOwner(projectId: string, nodeId: string): string {
  return `${BAKE_OWNER}${projectId}:${nodeId}`;
}

/** What baking needs from the media library (a fake in tests). */
export interface BakeLibrary {
  attachSequence(owner: string, name: string, frames: Blob[], fps: number, meta?: Record<string, unknown>): Promise<AssetInfo>;
  removeOwned(owner: string): Promise<void>;
  list(opts?: { includeHidden?: boolean }): AssetInfo[];
  exact?: boolean;
}

export interface BakeDeps {
  engine: Pick<Engine, 'signatureOf'>;
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

/** Frames above this many encoded bytes stop a bake (the browser's storage quota would fail later, less readably). */
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024 * 1024;

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
  private presenter: OffscreenPresenter | null = null;
  private running = new Set<string>();

  constructor(private d: BakeDeps) {}

  private async encode(img: { texture: GPUTexture; width: number; height: number }, quality: 'lossless' | 'compressed'): Promise<Blob> {
    if (this.d.encode) return this.d.encode(img, quality);
    this.presenter ??= new OffscreenPresenter(this.d.gpu, false);
    return quality === 'lossless' ? presentToBlob(this.presenter, img, 'image/png') : presentToBlob(this.presenter, img, 'image/webp', 0.92);
  }

  /** True when the picture feeding fromNode can differ between batch items (a Media In with several files, an Item node). */
  itemDependent(graph: GraphDoc, fromNode: string): boolean {
    const seen = new Set<string>();
    const stack = [fromNode];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const node = graph.nodes.find((n) => n.id === id);
      const def = node && this.d.registry.get(node.type);
      if (node && def) {
        if (node.type === 'item') return true;
        for (const [key, p] of Object.entries(def.params as Record<string, { type: string }>)) {
          const v = node.params[key];
          if (p.type === 'assets' && Array.isArray(v) && v.length > 1) return true;
        }
      }
      for (const e of graph.edges) if (e.to.node === id) stack.push(e.from.node);
    }
    return false;
  }

  async bake(graph: GraphDoc, nodeId: string, opts: BakeOptions): Promise<BakeResult> {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== 'cache') throw new Error('Bake needs a Cache / Bake node.');
    const edge = graph.edges.find((e) => e.to.node === nodeId && e.to.port === 'image');
    if (!edge) throw new Error('Connect something to the Cache / Bake node first: there is nothing to bake.');
    if (this.running.has(nodeId)) throw new Error('This node is already being baked.');
    const { gpu, gate, library } = this.d;
    const project = graph.project;
    const frames = totalFramesOf(project);
    const fps = project.fps;
    const projectId = opts.projectId ?? (await this.d.activeProject?.()) ?? 'project';
    const owner = bakeOwner(projectId, nodeId);
    const itemCount = batchCount(graph, this.d.registry);
    const itemDependent = itemCount > 1 && this.itemDependent(graph, edge.from.node);
    const item = Math.min(Math.max(0, opts.item ?? 0), itemCount - 1);
    // Identical to what the node computes with ctx.inputSignature('image').
    const signature = this.d.engine.signatureOf(graph, edge.from.node, edge.from.port);
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

    this.running.add(nodeId);
    const prevExact = library.exact;
    library.exact = true; // frame-exact video decoding, as for an export
    const unhold = this.d.player?.hold();
    const leaveMode = this.d.governor?.enter('export');
    await gate.exclusive(() => gpu.trim());
    const blobs: Blob[] = [];
    let bytes = 0;
    let first: { width: number; height: number; unit: number } | null = null;
    try {
      for (let i = 0; i < frames; i++) {
        if (opts.signal?.aborted) throw new DOMException('Baking was cancelled.', 'AbortError');
        const res = await gate.evaluateHeld({
          graph,
          node: edge.from.node,
          port: edge.from.port,
          seconds: i / fps,
          item,
          itemCount,
          proxy: 1,
          quality: 'final',
        });
        try {
          const v = res.value;
          if (!(v && typeof v === 'object' && 'texture' in v)) {
            const firstError = [...res.errors.values()][0];
            throw new Error(firstError ?? 'The picture before the Cache / Bake node is empty.');
          }
          const img = v as ImageValue;
          first ??= { width: img.width, height: img.height, unit: img.unit };
          if (img.width !== first.width || img.height !== first.height) throw new Error(`Frame ${i + 1} has another size (${img.width}x${img.height}) than the first (${first.width}x${first.height}); a baked sequence needs one size.`);
          const blob = await this.encode(img, opts.quality);
          blobs.push(blob);
          bytes += blob.size;
        } finally {
          gate.drop(res);
        }
        if (bytes > maxBytes) throw new Error(`The baked frames are over ${Math.round(maxBytes / 1048576)} MB. Bake as compressed, or bake a shorter project.`);
        opts.onProgress?.({ frame: i + 1, frames, fraction: (i + 1) / frames, bytes });
      }
      if (!first) throw new Error('Nothing to bake.');
      const meta: BakeMeta = {
        signature,
        quality: opts.quality,
        bytes,
        frames,
        item: itemDependent ? item : null,
        nodeId,
        createdAt: Date.now(),
        width: first.width,
        height: first.height,
        unit: first.unit,
        canvas: `${Math.round(project.width)}x${Math.round(project.height)}`,
      };
      const info = await library.attachSequence(owner, `Baked: ${node.type}`, blobs, fps, { bake: meta });
      return {
        assetId: info.id,
        signature,
        frames,
        bytes,
        item: meta.item,
        itemDependent,
        params: {
          baked: info.id,
          bakedSignature: signature,
          bakedQuality: opts.quality,
          bakedItem: meta.item === null ? '' : String(meta.item),
          bakedUnit: String(first.unit),
          bakedWidth: String(first.width),
          bakedCanvas: meta.canvas,
        },
      };
    } finally {
      this.running.delete(nodeId);
      if (this.running.size === 0) {
        this.presenter?.dispose();
        this.presenter = null;
      }
      library.exact = prevExact ?? false;
      leaveMode?.();
      await gate.exclusive(() => gpu.trim());
      unhold?.();
    }
  }

  private ownedAssets(nodeId: string): (AssetInfo & { owner?: string; bake?: BakeMeta })[] {
    const suffix = `:${nodeId}`;
    return (this.d.library.list({ includeHidden: true }) as (AssetInfo & { owner?: string; bake?: BakeMeta })[]).filter((a) => a.owner?.startsWith(BAKE_OWNER) && a.owner.endsWith(suffix));
  }

  async unbake(nodeId: string): Promise<void> {
    for (const a of this.ownedAssets(nodeId)) await this.d.library.removeOwned(a.owner!);
  }

  info(nodeId: string): BakeInfo | null {
    const a = this.ownedAssets(nodeId)[0];
    if (!a?.bake) return null;
    const m = a.bake;
    return { assetId: a.id, signature: m.signature, frames: m.frames, bytes: m.bytes, quality: m.quality, item: m.item, fps: a.fps, width: m.width, height: m.height, createdAt: m.createdAt, running: this.running.has(nodeId) };
  }

  /** Remove baked sequences of a project whose Cache / Bake node no longer exists. Call after deleting nodes or on project load. */
  async prune(projectId: string, graph: GraphDoc): Promise<number> {
    const alive = new Set(graph.nodes.filter((n) => n.type === 'cache').map((n) => n.id));
    let removed = 0;
    for (const a of this.d.library.list({ includeHidden: true }) as (AssetInfo & { owner?: string })[]) {
      const o = a.owner;
      if (!o?.startsWith(`${BAKE_OWNER}${projectId}:`)) continue;
      const nodeId = o.slice(`${BAKE_OWNER}${projectId}:`.length);
      if (!alive.has(nodeId)) {
        await this.d.library.removeOwned(o);
        removed++;
      }
    }
    return removed;
  }
}
