/**
 * AI style transfer runtime: the two onnxruntime-web sessions (encoder and decoder of AdaIN) that the AI Style Transfer node's job
 * uses through `StyleAiService` (src/engine/lib/style-ai-bridge.ts). The same rules as the depth runtime (src/io/depth-ai.ts):
 *
 *  - LAZY. Nothing loads until a job calls `open()`. The runtime files are the ones the build already ships for AI Depth (`ort/`);
 *    the model files come from the model store (src/io/models.ts) and are never downloaded from here.
 *  - ONE pair of sessions, reused for every frame, calls serialised, released after a while idle, on request and when the GPU is lost.
 *  - WebGPU when the browser has it. If the model cannot be created there, or a run fails there (some drivers lack an operator), the
 *    exact error is kept in `note` and everything runs on the WASM CPU provider instead: slow, but it works everywhere.
 *  - All arithmetic that makes the style transfer (tiles, statistics, blending) is the engine's; this file only runs the two networks
 *    with the fixed layout measured on the pinned files, and packs finished frames for the process store.
 */
import { STYLE_AI_MESSAGES, STYLE_AI_MODEL, setStyleAiService, type StyleAiService, type StyleEngine } from '../engine/lib/style-ai-bridge';
import { defaultLoadOrt, isDeviceLost, type OrtLike, type OrtSessionLike } from './depth-ai';
import { modelStore, type ModelStore } from './models';

const T = STYLE_AI_MODEL.tile;
const CELLS = T / STYLE_AI_MODEL.stride;
/** Number of floats of a picture (3 planes) and of its features. */
export const STYLE_PICTURE_FLOATS = 3 * T * T;
export const STYLE_FEATURE_FLOATS = STYLE_AI_MODEL.channels * CELLS * CELLS;
const PICTURE_DIMS = [1, 3, T, T] as const;
const FEATURE_DIMS = [1, STYLE_AI_MODEL.channels, CELLS, CELLS] as const;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);

export function isOutOfMemory(e: unknown): boolean {
  return /out of memory|bad_alloc|allocation failed|failed to allocate|memory access out of bounds|Array buffer allocation|OOM/i.test(e instanceof Error ? e.message : String(e));
}

/** The frame as a compressed picture: the same form as a compressed bake (the painting is far coarser than what WebP at this quality adds). */
async function canvasBlob(rgba: Uint8ClampedArray, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d')!;
  g.putImageData(new ImageData(rgba as unknown as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.92 });
}

export interface StyleAiOptions {
  store?: ModelStore;
  loadOrt?: () => Promise<OrtLike>;
  /** Has WebGPU an adapter? Default: ask the browser. */
  hasWebGpu?: () => Promise<boolean>;
  /** Release the sessions after this many ms without a call (0 = never). Default 30 s. */
  idleMs?: number;
  /** Pack a finished frame for the process store. Default: WebP through an OffscreenCanvas. */
  toBlob?: (rgba: Uint8ClampedArray, width: number, height: number) => Promise<Blob>;
}

export interface StyleAiRuntime extends StyleAiService {
  /** Release the sessions now (memory and the GPU). The next `open()` loads them again. */
  dispose(): Promise<void>;
  /** What is loaded right now. */
  info(): { loaded: boolean; provider: string | null; note: string | null };
}

interface Loaded {
  ort: OrtLike;
  encoder: OrtSessionLike;
  decoder: OrtSessionLike;
  provider: string;
  note: string | null;
}

export function createStyleAiRuntime(opts: StyleAiOptions = {}): StyleAiRuntime {
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
  const toBlob = opts.toBlob ?? canvasBlob;

  let loading: Promise<Loaded> | null = null;
  let current: Loaded | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once WebGPU failed while running: the sessions are then made on the processor, also after an idle release. */
  let cpuOnly: string | null = null;

  const release = async () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const c = current;
    current = null;
    loading = null;
    for (const s of [c?.encoder, c?.decoder]) {
      try {
        await s?.release();
      } catch {
        /* the device may already be gone */
      }
    }
  };

  const load = async (): Promise<Loaded> => {
    const enc = await store.read(STYLE_AI_MODEL.encoder);
    const dec = await store.read(STYLE_AI_MODEL.decoder);
    if (!enc || !dec) throw new Error(STYLE_AI_MESSAGES.noModel);
    const ort = await loadOrt();
    const pair = async (provider: string) => {
      const encoder = await ort.InferenceSession.create(enc, { executionProviders: [provider], graphOptimizationLevel: 'all' });
      try {
        return { encoder, decoder: await ort.InferenceSession.create(dec, { executionProviders: [provider], graphOptimizationLevel: 'all' }) };
      } catch (e) {
        await encoder.release().catch(() => undefined);
        throw e;
      }
    };
    let note = cpuOnly;
    if (!note) {
      if (await hasWebGpu()) {
        try {
          return { ort, ...(await pair('webgpu')), provider: 'webgpu', note: null };
        } catch (e) {
          if (isOutOfMemory(e)) throw new Error(STYLE_AI_MESSAGES.memory);
          note = `WebGPU could not run the model (${errText(e)}), using the processor`;
        }
      } else {
        note = 'no WebGPU in this browser, using the processor';
      }
    }
    try {
      return { ort, ...(await pair('wasm')), provider: 'wasm', note: `${note}: slow, seconds per frame` };
    } catch (e) {
      throw isOutOfMemory(e) ? new Error(STYLE_AI_MESSAGES.memory) : new Error(`The style transfer model could not be started: ${errText(e)}`);
    }
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

  /** One run of one of the two networks, with the checks that turn a wrong model into a sentence instead of a wrong picture. */
  const once = async (c: Loaded, which: 'encoder' | 'decoder', data: Float32Array): Promise<Float32Array> => {
    const session = c[which];
    const expect = which === 'encoder' ? STYLE_FEATURE_FLOATS : STYLE_PICTURE_FLOATS;
    const out = await session.run({ [session.inputNames[0]]: new c.ort.Tensor('float32', data, which === 'encoder' ? PICTURE_DIMS : FEATURE_DIMS) });
    const t = out[session.outputNames[0]];
    const raw = await t.getData();
    if (raw.length !== expect) throw new Error(`The style transfer ${which} returned ${raw.length} values (expected ${expect}). The model file does not fit this version of the app.`);
    // A copy: the runtime may reuse or free its own buffer once the tensor is disposed.
    const copy = Float32Array.from(raw as ArrayLike<number>);
    t.dispose?.();
    return copy;
  };

  const call = (which: 'encoder' | 'decoder', data: Float32Array, signal?: AbortSignal): Promise<Float32Array> => {
    const need = which === 'encoder' ? STYLE_PICTURE_FLOATS : STYLE_FEATURE_FLOATS;
    const job = chain.then(async () => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (data.length !== need) throw new Error(`The style transfer ${which} was given ${data.length} values (it takes ${need}).`);
      const live = current ?? (await ensure());
      try {
        const r = await once(live, which, data);
        touch();
        return r;
      } catch (e) {
        if (isDeviceLost(e)) {
          await release(); // the next job loads fresh sessions
          throw new Error('The GPU was reset while the model was running. Press Render again.');
        }
        if (isOutOfMemory(e)) {
          await release();
          throw new Error(STYLE_AI_MESSAGES.memory);
        }
        if (live.provider !== 'webgpu') throw new Error(`The style transfer model stopped: ${errText(e)}`);
        // WebGPU made the sessions but cannot run them (a missing operator, a driver bug): the processor can. Said in the progress note.
        cpuOnly = `WebGPU could not run the model (${errText(e)}), using the processor`;
        await release();
        const cpu = await ensure();
        const r = await once(cpu, which, data).catch((e2) => {
          throw new Error(`The style transfer model stopped: ${errText(e2)}`);
        });
        touch();
        return r;
      }
    });
    chain = job.catch(() => undefined);
    return job;
  };

  const engine: StyleEngine = {
    get provider() {
      return current?.provider ?? 'wasm';
    },
    get note() {
      return current?.note ?? cpuOnly ?? undefined;
    },
    encode: (rgb, signal) => call('encoder', rgb, signal),
    decode: (features, signal) => call('decoder', features, signal),
    toBlob,
  };

  return {
    async modelReady() {
      const a = await store.refresh(STYLE_AI_MODEL.encoder);
      const b = await store.refresh(STYLE_AI_MODEL.decoder);
      return a.state === 'ready' && b.state === 'ready';
    },
    async open(signal) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      await ensure();
      touch();
      return engine;
    },
    dispose: release,
    info: () => ({ loaded: !!current, provider: current?.provider ?? null, note: current?.note ?? null }),
  };
}

let runtime: StyleAiRuntime | null = null;

/** App start: make the runtime available to AI Style Transfer jobs. Creating it fetches and loads nothing. */
export function installStyleAi(): StyleAiRuntime {
  runtime ??= createStyleAiRuntime();
  setStyleAiService(runtime);
  return runtime;
}

export function styleAiRuntime(): StyleAiRuntime | null {
  return runtime;
}
