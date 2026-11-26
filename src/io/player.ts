/**
 * Player: owns the WebGPU canvas and the render loop.
 *
 * - Single flight: at most one evaluation runs at a time; when it finishes it looks at the latest
 *   requested state (frame, view, proxy) and renders that. Intermediate states are skipped.
 * - Playing: a requestAnimationFrame clock locked to the project fps picks the frame index from wall time,
 *   so slow frames are dropped rather than the clock drifting.
 * - Paused: any view change re-renders at full resolution (or the forced proxy).
 * - Finished frames are kept in SYSTEM RAM, packed (see pixel-codec.ts), not as GPU textures: when the player is idle a shown frame is
 *   read back and packed in the background, and playing a cached frame decodes it into ONE reusable texture. The GPU holds none of
 *   them, so a long loop costs RAM (budgeted by the governor's ram budget) instead of VRAM.
 */
import type { Registry } from '../engine/define';
import type { EvalResult } from '../engine/engine';
import type { Gpu } from '../engine/gpu/gpu';
import type { GraphDoc, ImageValue, MaskValue } from '../engine/types';
import type { Player, PlayerState } from './api';
import type { AudioBridge } from './audio-bridge';
import { ProxyController, frameAtTime } from './clock';
import { OffscreenPresenter, presentToBlob } from './encode';
import { RenderedFrameCache } from './frame-cache';
import { isLossy, packFrame, unpackBytes, unpackToBitmap, type CacheQuality, type Packed } from './pixel-codec';
import { uploadExternal } from './upload';
import type { EvalGate } from './gate';
import type { Library } from './library';
import { upstream } from '../engine/graph';
import { feedsFromLive, liveNodeIds, shootNodeIds, stampLive, stampShoot } from './live-stamp';
import type { MemoryState } from './memory';
import { phoneAudioWired } from './phone-audio';
import { needsInvalidate, type FrameEvent, type SignalRouter } from './signals';
import { conformImage, enlargeNearest } from './frame-gpu';
import { effectiveConform, isCustomFrame, readFrameParams, resolveFrame, scaleSize, type ConformAnchor, type Size } from './frame';
import { errorMessage, renderHash, totalFramesOf } from './util';

export interface PlayerDeps {
  gpu: Gpu;
  gate: EvalGate;
  registry: Registry;
  audio: AudioBridge;
  library: Library;
  router: SignalRouter;
  memory?: { snapshot(): MemoryState; relieve(): void };
  /** Phone microphone routing: told about every graph so it can map pairing tokens to Phone Camera nodes. */
  phoneAudio?: { setGraph(graph: GraphDoc): void };
}

interface FrameSpec {
  /** Frame size at proxy 1; undefined = the project canvas. */
  canvas?: Size;
  /** Conform to the frame (viewing an Output node only). */
  /** Output pixel size (> 1 only): render at 1/k and enlarge k times. */
  pixelSize?: number;
  conform?: { size: Size; mode: ReturnType<typeof effectiveConform>; anchor: ConformAnchor };
}

interface View {
  activeOutput?: string | null;
  graph: GraphDoc;
  node: string | null;
  port?: string;
  item: number;
  itemCount: number;
}

interface Job {
  graph: GraphDoc;
  node: string;
  port?: string;
  item: number;
  itemCount: number;
  frame: number;
  proxy: number;
  key: string;
  frameSpec: FrameSpec;
  /** A "Full-resolution frame" job: quality 'final', no frame-cache lookup or capture, no proxy measurement. */
  final?: boolean;
}

type Shown = { texture: GPUTexture; width: number; height: number };

/** RAM for packed frames until the governor sets the real budget. */
const CACHE_BYTES = 256 * 1024 * 1024;
/** Out-of-memory errors tolerated per frame before the error is shown. */
const OOM_RETRIES = 3;
const FPS_RING = 256;
/** Frames kept waiting for the RAM cache while playing (each holds one texture of the viewed size). */
const CAPTURE_QUEUE = 4;
const EMPTY_ERRORS: ReadonlyMap<string, string> = new Map();

function isTextured(v: unknown): v is ImageValue | MaskValue {
  return !!v && typeof v === 'object' && 'texture' in (v as object) && 'width' in (v as object);
}

function bytesOf(t: { texture: GPUTexture }): number {
  return t.texture.width * t.texture.height * (t.texture.format === 'rgba8unorm' ? 4 : 8);
}

/** True when the page was opened with ?safe (see Player.setView). */
export const SAFE_MODE = typeof location !== 'undefined' && /[?&]safe/.test(location.search);

export class PlayerImpl implements Player {
  private gpu: Gpu;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: GPUCanvasContext | null = null;
  private view: View | null = null;
  private key = '';
  private keyDirty = true;
  private dirty = false;

  private playing = false;
  private frame = 0;
  private totalFrames = 1;
  /** Run on: time does not wrap or end at the project length, and the graph is evaluated with Loop off (see `setRunOn`). */
  private runOn = false;
  private runOnSrc: GraphDoc | null = null;
  private runOnGraph: GraphDoc | null = null;
  private proxyMode: 'auto' | number = 'auto';
  private ctl = new ProxyController();
  /**
   * "Full-resolution frame" request. Valid for one frame of one view (key); `key` is filled in by the next `nextJob` (after pending key
   * changes are applied). Dropped when the frame, the key or the playing state differs, so the normal preview resumes by itself.
   */
  private fullReq: { frame: number; key: string | null; done: boolean } | null = null;

  private clockStartMs = 0;
  private clockStartFrame = 0;
  private lastCycle = 0;
  private raf = 0;

  private running = false;
  /** performance.now() when the evaluation in flight began; null while nothing is being rendered. */
  private jobSince: number | null = null;
  private kickQueued = false;
  private disposed = false;

  private cache: RenderedFrameCache<Packed>;
  /** The one GPU texture cached frames are decoded into (retained by the player). */
  private restoreTex: GPUTexture | null = null;
  private cacheQuality: CacheQuality = 'compressed';
  /**
   * Frames waiting to be packed into the RAM cache, oldest first. While paused only the latest matters (one slot); while PLAYING up to
   * CAPTURE_QUEUE are kept, because a heavy graph never leaves the player idle: without a queue not one frame of the first pass would
   * reach the cache and the second pass would render everything again.
   */
  private pendingCaptures: { frame: number; texture: GPUTexture; width: number; height: number; proxy: number; key: string; tries: number }[] = [];
  private captureTimer: ReturnType<typeof setTimeout> | null = null;
  private capturing = false;
  private capturePresenter: OffscreenPresenter | null = null;
  /** Diagnostics of the RAM frame cache. */
  readonly cacheStats = { captured: 0, skipped: 0, restored: 0, restoreMs: 0, captureMs: 0, rawBytes: 0 };
  private shown: Shown | null = null;
  private shownKey = '';
  private shownFrame = -1;
  private shownProxy = 1;
  /** Key/frame of the last job that finished without an image (null result, error, no canvas): do not retry it until something changes. */
  private audioNeeded = false;
  private hasSig = false;
  private micNodes = 0;
  private clearPending = false;
  private liveIds = new Set<string>();
  private shootGraph: GraphDoc | null = null;
  private liveGraph: GraphDoc | null = null;
  private hasLive = false;
  private liveTick = 0;
  /** Stop Motion nodes that show the live picture while paused (see live-stamp.ts), and whether one feeds the viewed node. */
  private shootIds = new Set<string>();
  private hasShoot = false;
  private liveTimer: ReturnType<typeof setInterval> | null = null;
  private liveFps = 0;
  private curPixel = 1;
  private settledKey = '';
  private settledFrame = -1;
  private settledProxy = 1;
  /** Size the image has at proxy 1 (what the user sees reported). */
  private size: { width: number; height: number } | null = null;
  /** Actual texture size on screen. */
  private rendered: { width: number; height: number } | null = null;
  /** Last size measured in a proxy-1 render of the viewed node. Proxy-independent nodes (Pixelate, Resize) make `rendered / proxy` wrong. */
  private fullReal: { width: number; height: number } | null = null;
  private errors: ReadonlyMap<string, string> = EMPTY_ERRORS;
  private timings: ReadonlyMap<string, number> = EMPTY_ERRORS as unknown as ReadonlyMap<string, number>;
  private lostMessage: string | null = null;

  private fpsRing = new Float64Array(FPS_RING);
  private fpsHead = 0;
  private fpsCount = 0;

  private listeners = new Set<(s: PlayerState) => void>();
  private notifyQueued = false;
  private audioGraph: GraphDoc | null = null;
  private snapshotPresenter: OffscreenPresenter | null = null;

  constructor(private deps: PlayerDeps) {
    this.gpu = deps.gpu;
    this.cache = new RenderedFrameCache<Packed>(CACHE_BYTES, () => undefined);
    deps.audio.setAssets((id) => deps.library.assetAudio(id));
  }

  /* ------------------------------ public API ------------------------------ */

  setCanvas(canvas: HTMLCanvasElement | null): void {
    if (this.ctx) {
      try {
        this.ctx.unconfigure();
      } catch {
        /* context already lost */
      }
    }
    this.canvas = canvas;
    this.ctx = null;
    if (!canvas) return;
    const ctx = canvas.getContext('webgpu') as unknown as GPUCanvasContext | null;
    if (!ctx) {
      this.errors = new Map([['canvas', 'This canvas cannot create a WebGPU context.']]);
      this.markChanged();
      return;
    }
    ctx.configure({
      device: this.gpu.device,
      format: navigator.gpu.getPreferredCanvasFormat(),
      alphaMode: 'premultiplied',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    this.ctx = ctx;
    // A fresh canvas is blank: redraw what we have, and make sure the current state gets rendered.
    if (this.shown) this.present(this.shown);
    this.dirty = true;
    this.kick();
  }

  setView(view: { graph: GraphDoc; node: string | null; port?: string; item: number; itemCount: number; activeOutput?: string | null }): void {
    // Safe mode: open the app with ?safe in the address to load the project WITHOUT rendering anything,
    // so a setting that makes rendering hang can be fixed. Remove ?safe and reload to render again.
    if (SAFE_MODE) view = { ...view, node: null };
    const prev = this.view;
    const changed =
      !prev || prev.graph !== view.graph || prev.node !== view.node || prev.port !== view.port || prev.item !== view.item || prev.itemCount !== view.itemCount || (prev.activeOutput ?? null) !== (view.activeOutput ?? null);
    if (!prev || prev.node !== view.node || prev.port !== view.port || (prev.activeOutput ?? null) !== (view.activeOutput ?? null)) this.fullReal = null;
    this.view = { graph: view.graph, node: view.node, port: view.port, item: view.item, itemCount: view.itemCount, activeOutput: view.activeOutput ?? null };
    if (!changed) return;
    this.keyDirty = true;
    this.updateLive(view);
    const p = view.graph.project;
    const total = totalFramesOf(p);
    const timeChanged = !prev || prev.graph.project.fps !== p.fps || prev.graph.project.duration !== p.duration || prev.graph.project.loop !== p.loop;
    this.totalFrames = total;
    if (this.frame >= total && !this.runOn) this.frame = total - 1;
    if (this.playing && timeChanged) this.anchorClock();
    if (view.graph !== this.audioGraph) {
      this.audioGraph = view.graph;
      this.deps.audio.setGraph(view.graph, this.deps.registry);
      this.updateAudioInfo(view.graph);
      if (timeChanged) this.syncTransport();
    }
    this.kick();
    this.markChanged();
  }

  /** Library content changed (asset removed or replaced): rendered frames may be stale. */
  invalidate(): void {
    this.keyDirty = true;
    this.kick();
  }

  play(): void {
    if (this.playing || !this.view) return;
    if (!this.runOn && !this.view.graph.project.loop && this.frame >= this.totalFrames - 1) this.frame = 0;
    this.signalEvent('play');
    if (this.audioNeeded && !this.deps.audio.running) this.deps.audio.start().then(() => this.markChanged(), () => undefined);
    this.playing = true;
    this.fullReq = null;
    this.ctl.warmup();
    this.anchorClock();
    this.syncTransport();
    this.raf = requestAnimationFrame(this.tick);
    this.dirty = true;
    this.kick();
    this.markChanged();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.hasShoot) this.dirty = true;
    cancelAnimationFrame(this.raf);
    this.syncTransport();
    // Refine the frame on screen to full resolution.
    this.kick();
    this.markChanged();
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(seconds: number): void {
    const fps = this.fps();
    this.frame = Math.min(this.totalFrames - 1, Math.max(0, Math.round(seconds * fps)));
    this.signalEvent('seek');
    if (this.playing) this.anchorClock();
    this.syncTransport();
    this.dirty = true;
    this.kick();
    this.markChanged();
  }

  step(frames: number): void {
    if (this.playing) this.pause();
    const total = this.totalFrames;
    let f = this.frame + Math.round(frames);
    if (this.view?.graph.project.loop) f = ((f % total) + total) % total;
    else f = Math.min(total - 1, Math.max(0, f));
    this.frame = f;
    this.signalEvent('step');
    this.syncTransport();
    this.dirty = true;
    this.kick();
    this.markChanged();
  }

  /**
   * The present, in project seconds: the time of the frame being rendered (the clock may already be a frame further on
   * while a frame renders).
   */
  nowSeconds(): number {
    const fps = this.view?.graph.project.fps ?? 0;
    return fps > 0 ? (this.settledFrame >= 0 ? this.settledFrame : this.frame) / fps : 0;
  }

  renderingSince(): number | null {
    return this.jobSince;
  }

  /**
   * Run on (live recording): the clock keeps counting past the project length instead of wrapping or stopping, and the graph is
   * evaluated with Loop off, so nothing snaps back to the start: motion that follows the clock keeps going and stepped randomness
   * keeps finding new values. Turning it off brings the playhead back inside the project.
   */
  setRunOn(on: boolean): void {
    if (on === this.runOn) return;
    this.runOn = on;
    this.runOnSrc = null;
    this.runOnGraph = null;
    if (!on) this.frame = this.frame % Math.max(1, this.totalFrames);
    this.keyDirty = true;
    this.dirty = true;
    if (this.playing) this.anchorClock();
    this.syncTransport();
    this.kick();
    this.markChanged();
  }

  /** The graph a frame is rendered from: the view's, with Loop off while running on. */
  private graphOf(view: { graph: GraphDoc }): GraphDoc {
    if (!this.runOn || !view.graph.project.loop) return view.graph;
    if (this.runOnSrc !== view.graph) {
      this.runOnSrc = view.graph;
      this.runOnGraph = { ...view.graph, project: { ...view.graph.project, loop: false } };
    }
    return this.runOnGraph!;
  }

  setProxy(mode: 'auto' | number): void {
    this.proxyMode = mode === 'auto' ? 'auto' : Math.min(1, Math.max(0.05, mode));
    this.ctl.reset();
    this.dirty = true;
    this.kick();
    this.markChanged();
  }

  renderFullFrame(): boolean {
    const view = this.view;
    if (!view?.node || this.disposed || this.lostMessage || !this.ctx) return false;
    if (this.playing) this.pause();
    this.fullReq = { frame: this.frame, key: null, done: false };
    this.dirty = true;
    this.kick();
    this.markChanged();
    return true;
  }

  getState(): PlayerState {
    return this.buildState();
  }

  subscribe(listener: (state: PlayerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async snapshot(): Promise<Blob | null> {
    const img = this.shown;
    if (!img) return null;
    // Hold the texture while the encode is in flight.
    this.gpu.retain(img.texture);
    try {
      this.snapshotPresenter ??= new OffscreenPresenter(this.gpu, false);
      const presenter = this.snapshotPresenter;
      try {
        return await presentToBlob(presenter, img, 'image/png');
      } finally {
        // A snapshot is rare: do not keep a WebGPU canvas (and its textures) around for it.
        presenter.dispose();
        this.snapshotPresenter = null;
      }
    } catch (err) {
      console.warn('Snapshot failed:', err);
      return null;
    } finally {
      this.gpu.release(img.texture);
    }
  }

  async grabNode(nodeId: string, port: string | undefined, maxSide = 0, mime: 'image/png' | 'image/jpeg' = 'image/png'): Promise<Blob | null> {
    const view = this.view;
    if (!view) return null;
    const graph = this.graphOf(view);
    const ids = liveNodeIds(graph, this.deps.registry);
    const spec = this.frameSpecFor(view);
    let res: EvalResult | null = null;
    try {
      res = await this.deps.gate.evaluateHeld({
        graph: ids.size ? stampLive(graph, ids, ++this.liveTick) : graph,
        node: nodeId,
        port,
        seconds: this.frame / graph.project.fps,
        item: view.item,
        itemCount: view.itemCount,
        proxy: 1,
        canvas: spec.canvas,
        quality: 'final',
      });
      const v = res.value;
      if (!isTextured(v)) return null;
      const presenter = new OffscreenPresenter(this.gpu, mime === 'image/jpeg');
      try {
        const long = Math.max(v.width, v.height);
        if (maxSide > 0 && long > maxSide) {
          const k = maxSide / long;
          const size = { width: Math.max(2, Math.round(v.width * k)), height: Math.max(2, Math.round(v.height * k)) };
          const small = this.gpu.scoped(() => {
            const out = conformImage(this.gpu, v, size, 'stretch', 'center') as ImageValue;
            this.gpu.retain(out.texture);
            return out;
          });
          try {
            return await presentToBlob(presenter, small, mime, mime === 'image/jpeg' ? 0.92 : undefined);
          } finally {
            this.gpu.release(small.texture);
          }
        }
        return await presentToBlob(presenter, v, mime, mime === 'image/jpeg' ? 0.92 : undefined);
      } finally {
        presenter.dispose();
      }
    } catch (err) {
      console.warn('Grab failed:', err);
      return null;
    } finally {
      if (res) this.deps.gate.drop(res);
    }
  }

  setVolume(volume: number): void {
    this.deps.audio.setVolume(Math.min(1, Math.max(0, volume)));
  }

  async enableAudio(): Promise<void> {
    await this.deps.audio.start();
    this.clearPending = this.liveSignals();
    this.dirty = true;
    this.kick();
    this.markChanged();
  }

  meter(nodeId: string): [number, number] | null {
    return this.deps.audio.meter(nodeId);
  }

  dispose(): void {
    this.disposed = true;
    if (this.liveTimer) clearInterval(this.liveTimer);
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.cache.clear();
    this.dropCapture();
    this.setShown(null);
    this.freeRestoreTexture();
    this.listeners.clear();
    this.deps.audio.stop();
    try {
      this.ctx?.unconfigure();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.canvas = null;
  }

  /* -------------------------------- internals ------------------------------ */

  /**
   * Frame to render the viewed node in. An Output node uses its own frame and conforms to it; any other node
   * uses the frame of the active output (no conform) so previews match what that output will export.
   */
  private frameSpecFor(view: View): FrameSpec {
    const nodes = view.graph.nodes;
    const viewed = nodes.find((n) => n.id === view.node);
    const isOutput = !!viewed && this.deps.registry.get(viewed.type)?.category === 'output';
    const source = isOutput ? viewed : view.activeOutput ? nodes.find((n) => n.id === view.activeOutput && this.deps.registry.get(n.type)?.category === 'output') : undefined;
    if (!source) return {};
    const fp = readFrameParams(source.params);
    const size = resolveFrame(view.graph.project, fp);
    const spec: FrameSpec = {};
    if (isCustomFrame(view.graph.project, size)) spec.canvas = size;
    if (fp.pixelSize > 1) spec.pixelSize = fp.pixelSize;
    if (isOutput) spec.conform = { size, mode: effectiveConform(fp), anchor: fp.conformAnchor };
    return spec;
  }

  /** Bytes of SYSTEM RAM held by the cache of rendered (packed) frames. */
  get cacheBytes(): number {
    return this.cache.bytes;
  }

  /** 'compressed' (default: exact when the picture deflates well, lossy JPEG/WebP otherwise) or 'lossless' (always exact, more RAM). */
  setCacheQuality(q: CacheQuality): void {
    if (q === this.cacheQuality) return;
    this.cacheQuality = q;
    this.cache.clear();
    this.dirty = true;
  }

  getCacheQuality(): CacheQuality {
    return this.cacheQuality;
  }

  private dropCapture(): void {
    this.capturePresenter?.dispose();
    this.capturePresenter = null;
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = null;
    for (const c of this.pendingCaptures) this.gpu.release(c.texture);
    this.pendingCaptures = [];
  }

  private freeRestoreTexture(): void {
    // A frame still on screen holds its own reference, so releasing ours is always right.
    if (this.restoreTex) this.gpu.release(this.restoreTex);
    this.restoreTex = null;
  }

  /** The reusable texture cached frames are decoded into, resized when the frame size changes. */
  private restoreTarget(width: number, height: number): GPUTexture {
    if (this.restoreTex && (this.restoreTex.width !== width || this.restoreTex.height !== height)) this.freeRestoreTexture();
    if (!this.restoreTex) {
      this.restoreTex = this.gpu.acquire(width, height);
      this.gpu.retain(this.restoreTex);
    }
    return this.restoreTex;
  }

  /** Decode a cached packed frame into the reusable texture. Null when it cannot be decoded (the frame is rendered instead). */
  private async restore(p: Packed): Promise<Shown | null> {
    const started = performance.now();
    try {
      const tex = this.restoreTarget(p.width, p.height);
      const device = this.gpu.device;
      if (isLossy(p)) {
        const bmp = await unpackToBitmap(p);
        try {
          await uploadExternal(device, bmp, tex, p.width, p.height);
        } finally {
          bmp.close();
        }
      } else {
        const bytes = await unpackBytes(p);
        device.queue.writeTexture({ texture: tex }, bytes as BufferSource, { bytesPerRow: p.width * 4, rowsPerImage: p.height }, [p.width, p.height]);
      }
      this.cacheStats.restored++;
      this.cacheStats.restoreMs += performance.now() - started;
      return { texture: tex, width: p.width, height: p.height };
    } catch {
      return null;
    }
  }

  /** Remember the frame on screen for later: it is read back and packed when nothing else is going on. Latest wins. */
  private queueCapture(frame: number, image: Shown, proxy: number, key: string): void {
    if (this.cache.maxBytes <= 0) return;
    const have = this.cache.get(frame, proxy);
    if (have) return;
    if (this.pendingCaptures.some((c) => c.frame === frame && c.key === key && c.proxy >= proxy)) return;
    this.gpu.retain(image.texture);
    const room = this.playing ? CAPTURE_QUEUE : 1;
    while (this.pendingCaptures.length >= room) {
      this.gpu.release(this.pendingCaptures.shift()!.texture); // the oldest gives way: latest wins
      this.cacheStats.skipped++;
    }
    this.pendingCaptures.push({ frame, texture: image.texture, width: image.width, height: image.height, proxy, key, tries: 0 });
    this.scheduleCapture();
  }

  private scheduleCapture(): void {
    if (this.captureTimer || this.pendingCaptures.length === 0) return;
    this.captureTimer = setTimeout(() => {
      this.captureTimer = null;
      void this.runCapture();
    }, 25);
  }

  private async runCapture(): Promise<void> {
    const job = this.pendingCaptures[0];
    if (!job || this.capturing || this.disposed) return;
    // Never compete with the render: paused, wait until the player and the GPU are idle. Playing, a heavy graph keeps the player busy
    // all the time, so the only condition is that the GPU is not running far ahead (at most one frame in flight).
    const busy = this.holds > 0 || this.deps.router.exporting || (this.playing ? this.gpu.queuedFrames > 1 : this.running || this.kickQueued || this.gpu.queuedFrames > 0);
    if (busy) {
      if (++job.tries > (this.playing ? 40 : 6)) {
        this.pendingCaptures.shift();
        this.gpu.release(job.texture);
        this.cacheStats.skipped++;
        if (this.pendingCaptures.length) this.scheduleCapture();
        return;
      }
      this.scheduleCapture();
      return;
    }
    this.pendingCaptures.shift();
    this.capturing = true;
    const started = performance.now();
    try {
      const raw = await this.gpu.readRaw({ texture: job.texture, width: job.width, height: job.height });
      if (job.key === this.key && !this.disposed) {
        // Lossy packing draws the texture into a canvas and lets the browser encode it: no pixel loops on the main thread.
        const lossy = async (alpha: boolean) => {
          this.capturePresenter ??= new OffscreenPresenter(this.gpu, false);
          return presentToBlob(this.capturePresenter, { texture: job.texture, width: job.width, height: job.height }, alpha ? 'image/webp' : 'image/jpeg', alpha ? 0.9 : 0.92);
        };
        const packed = await packFrame(raw, job.width, job.height, this.cacheQuality, lossy);
        if (job.key === this.key && this.cache.put(job.frame, packed, job.proxy, packed.bytes)) {
          this.cacheStats.captured++;
          this.cacheStats.rawBytes += raw.byteLength;
          this.markChanged(); // the "cached frames" bar
        }
      }
    } catch {
      /* the cache is an optimisation */
    } finally {
      this.cacheStats.captureMs += performance.now() - started;
      this.gpu.release(job.texture);
      this.capturing = false;
      if (this.pendingCaptures.length) this.scheduleCapture();
    }
  }

  /**
   * Project switch: stop, drop every cached frame and the shown image, blank the canvas. The next `setView`
   * renders the new project from scratch.
   */
  releaseCaches(): void {
    this.pause();
    this.cache.clear();
    this.dropCapture();
    this.clearOutput();
    this.freeRestoreTexture();
    this.view = null;
    this.key = '';
    this.keyDirty = true;
    this.fullReal = null;
    this.frame = 0;
    this.audioGraph = null;
    this.markChanged();
  }

  /**
   * Live pictures change without the graph changing: while a live node feeds the viewed node, keep rendering
   * while paused (at the project fps) and let stampLive() defeat the evaluation cache.
   */
  private updateLive(view: View): void {
    if (this.liveGraph !== view.graph) {
      this.liveGraph = view.graph;
      this.liveIds = liveNodeIds(view.graph, this.deps.registry);
    }
    this.hasLive = feedsFromLive(view.graph, view.node, this.liveIds);
    if (this.shootGraph !== view.graph) {
      this.shootGraph = view.graph;
      this.shootIds = shootNodeIds(view.graph);
    }
    this.hasShoot = this.shootIds.size > 0 && !!view.node && [...upstream(view.graph, view.node)].some((id) => this.shootIds.has(id));
    const fps = view.graph.project.fps;
    if (this.liveTimer && (!this.hasLive || this.liveFps !== fps)) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
    if (this.hasLive && !this.liveTimer) {
      this.liveFps = fps;
      this.liveTimer = setInterval(() => {
        if (this.playing || this.disposed) return;
        this.dirty = true;
        this.kick();
      }, Math.max(16, 1000 / fps));
    }
  }

  private holds = 0;

  /**
   * Stop rendering (and free the RAM frame cache) until the returned function is called. Exports use it so the player does not
   * evaluate, evict and recycle textures between export frames, and so its memory is free for the export.
   */
  hold(): () => void {
    this.holds++;
    this.cache.clear();
    this.dropCapture();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (this.holds === 0) {
        this.dirty = true;
        this.kick();
      }
    };
  }

  /** Show a GPU error (out of memory, invalid texture) in the state: a silently failed pass would otherwise look like a wrong picture. */
  reportGpuError(message: string): void {
    if (/out of memory/i.test(message) && this.oomStreak < OOM_RETRIES) {
      // Free what can be rebuilt and retry: the same frame first, then (while playing) at a lower resolution.
      this.oomStreak++;
      this.deps.memory?.relieve();
      if (this.oomStreak >= 2) {
        if (this.playing && this.proxyMode === 'auto') this.ctl.forceLower();
        else this.proxyCap = Math.max(0.25, Math.min(this.proxyCap, this.currentProxy() * 0.7));
      }
      this.dirty = true;
      this.kick();
      return;
    }
    this.errors = new Map([...this.errors, ['gpu', message]]);
    this.markChanged();
  }

  private oomStreak = 0;
  /** Upper bound for the render resolution after repeated out-of-memory errors. */
  private proxyCap = 1;

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Byte budget of the RAM frame cache, in system RAM (set by the memory governor). */
  setCacheBudget(bytes: number): void {
    this.cache.setMaxBytes(bytes);
  }

  /** Drop the RAM frame cache (the shown picture stays). */
  dropFrameCache(): void {
    this.cache.clear();
  }

  /**
   * After a device loss was recovered (`Gpu.replaceDevice`): every texture handle here is invalid. Forget them, reconnect the
   * canvas to the new device and render the current view again.
   */
  onDeviceReset(): void {
    this.lostMessage = null;
    this.errors = new Map();
    this.cache.clear(); // packed frames live in RAM and would still be valid, but the key space is reset with the device
    this.pendingCaptures = []; // their textures belonged to the old device
    this.restoreTex = null;
    this.shown = null;
    this.size = null;
    this.rendered = null;
    this.shownFrame = -1;
    this.snapshotPresenter = null;
    this.oomStreak = 0;
    this.proxyCap = 1;
    const canvas = this.canvas;
    if (canvas) this.setCanvas(canvas); // configure the context with the new device
    this.keyDirty = true;
    this.dirty = true;
    this.kick();
    this.markChanged();
  }

  /** Device loss that could not be recovered: tell the user. */
  deviceLost(message: string): void {
    this.onDeviceLost(message);
  }

  private liveSignals(): boolean {
    return this.hasSig && this.deps.audio.running;
  }

  /** See needsInvalidate(): live bridge values must not be served from a cache. */
  private signalEvent(ev: FrameEvent): void {
    if (needsInvalidate(this.liveSignals(), ev)) {
      this.clearPending = true;
      this.deps.router.flushHistory(); // a new pass: history is write-once per frame within a pass
    }
  }

  private updateAudioInfo(graph: GraphDoc): void {
    const { audio, registry } = this.deps;
    this.hasSig = audio.hasSignals(graph, registry);
    this.deps.router.fps = graph.project.fps;
    this.audioNeeded = this.hasSig || audio.hasAudio(graph, registry) || phoneAudioWired(graph);
    this.deps.phoneAudio?.setGraph(graph);
    // nodes the browser will ask the microphone for: Microphone nodes, and a Webcam whose sound is wired
    const camHeard = (id: string) => graph.edges.some((e) => e.from.node === id && (e.from.port === 'audio' || e.from.port === 'tap'));
    this.micNodes = graph.nodes.filter((n) => !n.bypass && (n.type === 'microphone' || (n.type === 'camera-in' && camHeard(n.id)))).length;
  }

  private fps(): number {
    return this.view?.graph.project.fps ?? 24;
  }

  private anchorClock(): void {
    this.clockStartMs = performance.now();
    this.clockStartFrame = this.frame;
    this.lastCycle = 0;
  }

  private syncTransport(): void {
    const p = this.view?.graph.project;
    if (!p) return;
    // running on: the sound does not wrap at the project length either
    this.deps.audio.setTransport({ playing: this.playing, seconds: this.frame / p.fps, duration: this.runOn ? 1e7 : p.duration, loop: this.runOn ? false : p.loop, item: this.view?.item ?? 0 });
  }

  private tick = (now: number): void => {
    if (!this.playing || this.disposed) return;
    const p = this.view?.graph.project;
    if (p) {
      const r = this.runOn
        ? { frame: this.clockStartFrame + Math.floor((Math.max(0, now - this.clockStartMs) * p.fps) / 1000), cycle: 0, ended: false }
        : frameAtTime(this.clockStartFrame, now - this.clockStartMs, p.fps, this.totalFrames, p.loop);
      const wrapped = r.cycle !== this.lastCycle;
      if (wrapped) {
        this.lastCycle = r.cycle;
        this.frame = r.frame;
        this.signalEvent('wrap');
        this.syncTransport(); // loop wrap: re-align audio to the start
        this.kick();
        this.markChanged();
      }
      if (r.ended) {
        this.frame = r.frame;
        this.playing = false;
        this.dirty = true;
        this.syncTransport();
        this.kick();
        this.markChanged();
        return;
      }
      if (this.liveSignals()) this.deps.router.recordFrame(r.frame);
      if (r.frame !== this.frame) {
        this.frame = r.frame;
        this.kick();
        this.markChanged();
      }
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Start the render loop on a microtask so bursts of setView calls collapse into one pass. */
  private kick(): void {
    if (this.running || this.kickQueued || this.disposed) return;
    this.kickQueued = true;
    queueMicrotask(() => {
      this.kickQueued = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      for (;;) {
        if (this.clearPending) {
          this.clearPending = false;
          await this.deps.gate.clearEngine();
          this.cache.clear();
          this.dirty = true;
        }
        const job = this.nextJob();
        if (!job) break;
        this.jobSince = performance.now();
        try {
          await this.execute(job);
        } finally {
          this.jobSince = null;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private currentProxy(): number {
    if (this.proxyMode !== 'auto') return Math.min(this.proxyMode, this.proxyCap);
    return Math.min(this.playing ? this.ctl.proxy : 1, this.proxyCap);
  }

  private nextJob(): Job | null {
    const view = this.view;
    if (!view || this.disposed || this.lostMessage || !this.ctx) return null;
    if (this.deps.router.exporting || this.holds > 0) return null; // an export owns Host.signal / the GPU right now
    if (this.keyDirty) {
      // Only what feeds the viewed node (plus the active Output, whose frame settings size the picture) is part of the key: an edit in
      // another branch must not throw away the finished frames.
      const key = renderHash(this.graphOf(view), view.node, view.port, `${view.item}/${view.itemCount}/${this.deps.library.version}/${view.activeOutput ?? ''}`, view.activeOutput ? [view.activeOutput] : []);
      this.keyDirty = false;
      if (key !== this.key) {
        this.key = key;
        this.ctl.warmup();
        this.cache.clear();
        this.dirty = true;
      }
    }
    if (this.fullReq) {
      const r = this.fullReq;
      if (r.key === null && view.node) r.key = this.key;
      if (!view.node || this.playing || r.frame !== this.frame || r.key !== this.key) {
        this.fullReq = null;
        this.dirty = true;
        this.markChanged();
      }
    }
    if (!view.node) {
      if (this.shown || this.size) this.clearOutput();
      return null;
    }
    const spec = this.frameSpecFor(view);
    if (this.fullReq) {
      if (this.fullReq.done) return null;
      return { graph: this.graphOf(view), node: view.node, port: view.port, item: view.item, itemCount: view.itemCount, frame: this.frame, proxy: spec.pixelSize ? 1 / spec.pixelSize : 1, key: this.key, frameSpec: spec, final: true };
    }
    this.curPixel = spec.pixelSize ?? 1;
    const proxy = spec.pixelSize ? 1 / spec.pixelSize : this.currentProxy();
    const upToDate = !this.dirty && this.shown && this.shownKey === this.key && this.shownFrame === this.frame && this.shownProxy >= proxy - 1e-6;
    if (upToDate) return null;
    if (!this.dirty && this.settledKey === this.key && this.settledFrame === this.frame && this.settledProxy >= proxy - 1e-6) return null;
    return { graph: this.graphOf(view), node: view.node, port: view.port, item: view.item, itemCount: view.itemCount, frame: this.frame, proxy, key: this.key, frameSpec: spec };
  }

  /** While paused, Stop Motion nodes that may show their live picture are stamped to (see live-stamp.ts). */
  private stampShoot(graph: GraphDoc): GraphDoc {
    return this.hasShoot && !this.playing ? stampShoot(graph, this.shootIds) : graph;
  }

  private async execute(job: Job): Promise<void> {
    this.dirty = false;
    // Assume this job settles; a successful show() makes `shown` authoritative instead.
    this.settledKey = job.key;
    this.settledFrame = job.frame;
    this.settledProxy = job.proxy;
    const live = this.liveSignals() || this.hasLive || this.hasShoot;
    const cached = live || job.final ? undefined : this.cache.get(job.frame, this.playing ? 0 : job.proxy);
    if (cached) {
      const img = await this.restore(cached.image);
      if (img) {
        if (this.keyDirty || job.key !== this.key) {
          this.markChanged();
          return;
        }
        this.show(img, job, cached.proxy, job.frameSpec.pixelSize ? 1 : cached.proxy);
        return;
      }
      this.cache.clear(); // undecodable: render it again
    }
    const started = performance.now();
    let res: EvalResult;
    try {
      res = await this.deps.gate.evaluateHeld({
        graph: this.stampShoot(this.hasLive ? stampLive(job.graph, this.liveIds, ++this.liveTick) : job.graph),
        node: job.node,
        port: job.port,
        seconds: job.frame / job.graph.project.fps,
        item: job.item,
        itemCount: job.itemCount,
        proxy: job.proxy,
        canvas: job.frameSpec.canvas,
        quality: job.final ? 'final' : 'preview',
      });
    } catch (err) {
      if (job.final) this.fullReq = null;
      this.errors = new Map([[job.node, errorMessage(err)]]);
      this.markChanged();
      return;
    }
    this.errors = res.errors;
    this.timings = res.timings;
    try {
    const stale = this.keyDirty || job.key !== this.key;
    const v = res.value;
    if (isTextured(v)) {
      if (stale) {
        this.markChanged();
        return;
      }
      // Conform / enlarge passes allocate temporaries: run them in a scope and retain only the final texture (the slot reference
      // for the cache / the shown image). The evaluation result itself is held by the gate until `drop` below.
      const image: Shown = this.gpu.scoped(() => {
        let shownValue: ImageValue | MaskValue = v;
        const cf = job.frameSpec.conform;
        if (cf) shownValue = conformImage(this.gpu, v, scaleSize(cf.size, job.proxy), cf.mode, cf.anchor);
        if (job.frameSpec.pixelSize) shownValue = enlargeNearest(this.gpu, shownValue, job.frameSpec.pixelSize);
        this.gpu.retain(shownValue.texture);
        return { texture: shownValue.texture, width: shownValue.width, height: shownValue.height };
      });
      try {
        this.show(image, job, job.proxy, job.frameSpec.pixelSize ? 1 : job.proxy);
        if (job.final) {
          if (this.fullReq) this.fullReq.done = true;
        } else if (!live) this.queueCapture(job.frame, image, job.proxy, job.key);
      } finally {
        this.gpu.release(image.texture);
      }
      if (this.playing && this.proxyMode === 'auto' && !job.frameSpec.pixelSize) {
        // Wait for the GPU so the measurement is real and the queue cannot run away.
        await this.gpu.device.queue.onSubmittedWorkDone().catch(() => undefined);
        const budget = 1000 / job.graph.project.fps;
        this.ctl.report(performance.now() - started, budget, performance.now());
      }
    } else if (!stale) {
      if (job.final) this.fullReq = null;
      this.clearOutput();
    }
    this.markChanged();
    } finally {
      this.deps.gate.drop(res);
    }
  }

  /** Put `image` on screen and remember what is showing. */
  /** `proxy`: what the cache/settle logic compares; `sizeProxy`: scale of the image relative to the full frame. */
  private show(image: Shown, job: Job, proxy: number, sizeProxy: number = proxy): void {
    this.oomStreak = 0;
    this.rendered = { width: image.width, height: image.height };
    if (sizeProxy >= 0.999) this.fullReal = this.rendered;
    const full = this.fullReal ?? { width: Math.max(1, Math.round(image.width / sizeProxy)), height: Math.max(1, Math.round(image.height / sizeProxy)) };
    if (!this.size || this.size.width !== full.width || this.size.height !== full.height) this.size = full;
    if (!this.present(image)) return;
    this.setShown(image);
    this.shownKey = job.key;
    this.shownFrame = job.frame;
    this.shownProxy = proxy;
    this.fpsRing[this.fpsHead] = performance.now();
    this.fpsHead = (this.fpsHead + 1) % FPS_RING;
    this.fpsCount = Math.min(FPS_RING, this.fpsCount + 1);
    this.markChanged();
  }

  private setShown(img: Shown | null): void {
    if (this.shown === img) return;
    if (img) this.gpu.retain(img.texture);
    if (this.shown) this.gpu.release(this.shown.texture);
    this.shown = img;
  }

  private present(img: Shown): boolean {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return false;
    try {
      if (canvas.width !== img.width || canvas.height !== img.height) {
        canvas.width = img.width;
        canvas.height = img.height;
      }
      // The backing store is the rendered size; CSS shows it at the full-resolution size so the proxy is invisible.
      if (this.size) {
        canvas.style.width = `${this.size.width}px`;
        canvas.style.height = `${this.size.height}px`;
      }
      this.gpu.blit(img, ctx.getCurrentTexture(), true);
      return true;
    } catch (err) {
      this.errors = new Map([['canvas', errorMessage(err)]]);
      return false;
    }
  }

  private clearOutput(): void {
    this.setShown(null);
    this.size = null;
    this.rendered = null;
    this.shownFrame = -1;
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const enc = this.gpu.device.createCommandEncoder();
      enc
        .beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] })
        .end();
      this.gpu.device.queue.submit([enc.finish()]);
    } catch {
      /* nothing to clear */
    }
  }

  private onDeviceLost(message: string): void {
    this.lostMessage = `The GPU device was lost (${message || 'unknown reason'}). Reload the page to continue.`;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.errors = new Map([['device', this.lostMessage]]);
    this.markChanged();
  }

  /* ------------------------------ notifications ---------------------------- */

  /** At most one notification per animation frame. */
  private markChanged(): void {
    if (this.notifyQueued || this.listeners.size === 0) return;
    this.notifyQueued = true;
    const fire = () => {
      this.notifyQueued = false;
      if (this.disposed) return;
      const state = this.buildState();
      for (const l of this.listeners) l(state);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fire);
    else setTimeout(fire, 16);
  }

  private measuredFps(): number {
    const now = performance.now();
    let n = 0;
    for (let i = 0; i < this.fpsCount; i++) if (now - this.fpsRing[i] <= 1000) n++;
    return n;
  }

  private buildState(): PlayerState {
    const fps = this.fps();
    return {
      playing: this.playing,
      seconds: this.frame / fps,
      frame: this.frame,
      totalFrames: this.totalFrames,
      measuredFps: this.measuredFps(),
      proxy: this.shown ? this.shownProxy : this.currentProxy(),
      fullRes: this.fullReq ? (this.fullReq.done ? 'shown' : 'rendering') : 'off',
      cachedFrames: this.cache.frames,
      errors: this.errors,
      timings: this.timings,
      imageSize: this.size,
      renderedSize: this.rendered,
      pixelSize: this.curPixel,
      memory: this.deps.memory?.snapshot() ?? { allocatedBytes: this.gpu.allocatedBytes, budgetBytes: 0, pressure: 'ok' },
      audio: { needed: this.audioNeeded, running: this.deps.audio.running, micNodes: this.micNodes },
    };
  }
}
