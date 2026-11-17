/**
 * AI depth runtime: one onnxruntime-web session (WebGPU, with a slow CPU/WASM fallback) that the AI Depth node's job uses through
 * `DepthAiService` (src/engine/lib/depth-ai-bridge.ts).
 *
 *  - LAZY. Nothing here loads until a job calls `open()`: the ort module (~70 KB of JS) and its WebAssembly (~30 MB) are copied next to the
 *    app at build time (`ort/`, see vite-plugins/ort-files.ts) and imported only then. The model file comes from the model store
 *    (src/io/models.ts) and is never downloaded from here.
 *  - ONE session, reused for every frame, jobs serialised, released after a while idle, on request (`dispose`) and when the GPU device is lost.
 *  - The model has dynamic height / width axes: the picture is resized to a multiple of 14 with its aspect kept (no letterbox), normalised with
 *    the model's mean / std (CPU, after the engine's own GPU already shrank the frame) and run as NCHW float32.
 *  - If WebGPU is missing or the fp16 model fails on it, the exact error is kept (`note`) and the model runs on the WASM CPU provider instead.
 *    That works everywhere but takes seconds per frame; the job says so.
 */
import { setDepthAiService, type DepthAiService, type DepthEngine, type DepthInferenceResult } from '../engine/lib/depth-ai-bridge';
import { halfToFloat, modelDims, rgbaToInput } from '../engine/lib/depth-ai-math';
import { DEPTH_ANYTHING_V2_SMALL_ID, modelEntry } from './model-catalogue';
import { modelStore, type ModelStore } from './models';

/** The small part of onnxruntime-web this file uses (the module is loaded from a URL, so there are no imported types). */
export interface OrtTensorLike {
  readonly dims: readonly number[];
  readonly type: string;
  getData(): Promise<ArrayLike<number>>;
  dispose?(): void;
}
export interface OrtSessionLike {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensorLike>>;
  release(): Promise<void>;
}
export interface OrtLike {
  env: { wasm: { wasmPaths?: unknown; proxy?: boolean; numThreads?: number }; logLevel?: string };
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => unknown;
  InferenceSession: { create(model: Uint8Array, options: Record<string, unknown>): Promise<OrtSessionLike> };
}

/** Where the build puts the runtime files (relative to the page): see vite-plugins/ort-files.ts. */
export const ORT_DIR = 'ort/';
export const ORT_MODULE = 'ort.webgpu.min.mjs';

async function defaultLoadOrt(): Promise<OrtLike> {
  const base = new URL(ORT_DIR, typeof document !== 'undefined' ? document.baseURI : self.location.href).href;
  const ort = (await import(/* @vite-ignore */ base + ORT_MODULE)) as unknown as OrtLike;
  ort.env.wasm.wasmPaths = base;
  ort.env.wasm.proxy = false; // the WebGPU provider cannot run through the proxy worker
  // Threads need cross-origin isolation (SharedArrayBuffer), which static hosts such as GitHub Pages do not give: one thread there.
  ort.env.wasm.numThreads = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated ? Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))) : 1;
  ort.env.logLevel = 'error';
  return ort;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);

export function isDeviceLost(e: unknown): boolean {
  return /device.*(lost|destroyed)|context lost|GPUDevice.*lost|DXGI_ERROR_DEVICE|device is lost/i.test(e instanceof Error ? e.message : String(e));
}

export interface DepthAiOptions {
  store?: ModelStore;
  loadOrt?: () => Promise<OrtLike>;
  /** Has WebGPU an adapter? Default: ask the browser. */
  hasWebGpu?: () => Promise<boolean>;
  /** Release the session after this many ms without a job (0 = never). Default 30 s. */
  idleMs?: number;
}

export interface DepthAiRuntime extends DepthAiService {
  /** Release the session now (memory and the GPU). The next `open()` loads it again. */
  dispose(): Promise<void>;
  /** What is loaded right now. */
  info(): { loaded: boolean; provider: string | null; note: string | null };
}

export function createDepthAiRuntime(opts: DepthAiOptions = {}): DepthAiRuntime {
  const store = opts.store ?? modelStore();
  const loadOrt = opts.loadOrt ?? defaultLoadOrt;
  const hasWebGpu =
    opts.hasWebGpu ??
    (async () => {
      try {
        return !!(typeof navigator !== 'undefined' && navigator.gpu && (await navigator.gpu.requestAdapter()));
      } catch {
        return false;
      }
    });
  const idleMs = opts.idleMs ?? 30000;
  const entry = modelEntry(DEPTH_ANYTHING_V2_SMALL_ID)!;

  let loading: Promise<{ session: OrtSessionLike; ort: OrtLike; provider: string; note: string | null }> | null = null;
  let current: { session: OrtSessionLike; ort: OrtLike; provider: string; note: string | null } | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const release = async () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const c = current;
    current = null;
    loading = null;
    try {
      await c?.session.release();
    } catch {
      /* the device may already be gone */
    }
  };

  const load = async () => {
    const bytes = await store.read(DEPTH_ANYTHING_V2_SMALL_ID);
    if (!bytes) throw new Error('The AI depth model is not on this computer. Download it from Plugins, AI models.');
    const ort = await loadOrt();
    let note: string | null = null;
    if (await hasWebGpu()) {
      try {
        const session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
        return { session, ort, provider: 'webgpu', note: null };
      } catch (e) {
        note = `WebGPU could not run the model (${errText(e)}), using the CPU`;
      }
    } else {
      note = 'no WebGPU in this browser, using the CPU';
    }
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    return { session, ort, provider: 'wasm', note: `${note}: slow, seconds per frame` };
  };

  const ensure = () => {
    loading ??= load().then(
      (c) => {
        current = c;
        return c;
      },
      (e) => {
        loading = null;
        throw e;
      },
    );
    return loading;
  };

  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleMs > 0) idleTimer = setTimeout(() => void release(), idleMs);
  };

  const engineFor = (c: { session: OrtSessionLike; ort: OrtLike; provider: string; note: string | null }): DepthEngine => ({
    provider: c.provider,
    note: c.note ?? undefined,
    infer(rgba, width, height, long, signal) {
      const job = chain.then(async (): Promise<DepthInferenceResult> => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const live = current ?? (await ensure());
        const dims = modelDims(width, height, long, entry.inputMultiple);
        const input = rgbaToInput(rgba, width, height, dims.width, dims.height, entry.mean, entry.std);
        const tensor = new live.ort.Tensor('float32', input, [1, 3, dims.height, dims.width]);
        try {
          const out = await live.session.run({ [live.session.inputNames[0]]: tensor });
          const t = out[live.session.outputNames[0]];
          const raw = await t.getData();
          const n = dims.width * dims.height;
          if (raw.length !== n) throw new Error(`The model returned ${raw.length} values for a ${dims.width}x${dims.height} picture (expected ${n}).`);
          const data = new Float32Array(n);
          if (t.type === 'float16' && raw instanceof Uint16Array) for (let i = 0; i < n; i++) data[i] = halfToFloat(raw[i]);
          else for (let i = 0; i < n; i++) data[i] = raw[i];
          t.dispose?.();
          touch();
          return { data, width: dims.width, height: dims.height };
        } catch (e) {
          if (isDeviceLost(e)) {
            await release(); // the next job loads a fresh session
            throw new Error('The GPU was reset while the model was running. Press Estimate depth again.');
          }
          throw e;
        }
      });
      chain = job.catch(() => undefined);
      return job;
    },
  });

  return {
    async modelReady() {
      const s = await store.refresh(DEPTH_ANYTHING_V2_SMALL_ID);
      return s.state === 'ready';
    },
    async open(signal) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const c = await ensure();
      touch();
      return engineFor(c);
    },
    dispose: release,
    info: () => ({ loaded: !!current, provider: current?.provider ?? null, note: current?.note ?? null }),
  };
}

let runtime: DepthAiRuntime | null = null;

/** App start: make the runtime available to AI Depth jobs. Creating it fetches and loads nothing. */
export function installDepthAi(): DepthAiRuntime {
  runtime ??= createDepthAiRuntime();
  setDepthAiService(runtime);
  return runtime;
}

export function depthAiRuntime(): DepthAiRuntime | null {
  return runtime;
}
