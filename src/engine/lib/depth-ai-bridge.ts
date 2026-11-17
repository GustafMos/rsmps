/**
 * The seam between the AI Depth node (engine) and the model runtime (io). The engine has no model and no network: the app installs a
 * `DepthAiService` at start (src/io/depth-ai.ts); the command line installs nothing, so a job there fails with a plain sentence; the
 * tests install a fake one. Nothing in this file downloads, fetches or loads anything.
 */

/** The one model the node uses. Pinned: the revision is part of the node's process signature, so a different model makes a result stale. */
export const DEPTH_AI_MODEL = {
  id: 'depth-anything-v2-small',
  /** Upstream repository commit the downloaded file comes from (see src/io/model-catalogue.ts). */
  revision: '4472b7362082ad9968fee890ca0f1e5aca36b93d',
} as const;

export interface DepthInferenceResult {
  /** Raw model output, larger = nearer, `width * height` values (relative, affine-invariant: never compare two frames' numbers directly). */
  data: Float32Array;
  width: number;
  height: number;
}

/** One loaded model. Jobs are serialised inside the service; call `infer` one after the other. */
export interface DepthEngine {
  /**
   * Run the model on a picture. `rgba` is straight sRGB RGBA, `width x height`; the engine resizes it to a size the model takes
   * (long side about `long`, multiples of 14), runs it and returns the raw output at that size.
   */
  infer(rgba: Uint8ClampedArray, width: number, height: number, long: number, signal?: AbortSignal): Promise<DepthInferenceResult>;
  /** Which execution provider ran ('webgpu' | 'wasm'), for the panel. */
  readonly provider: string;
  /** Said to the user when the model runs on the CPU. */
  readonly note?: string;
}

export interface DepthAiService {
  /** Is the model file on this computer? (Never downloads.) */
  modelReady(): Promise<boolean>;
  /** Load (or reuse) the model. Throws a readable error when it is not downloaded or cannot run. */
  open(signal?: AbortSignal): Promise<DepthEngine>;
}

let service: DepthAiService | null = null;

export function setDepthAiService(s: DepthAiService | null): void {
  service = s;
}

export function getDepthAiService(): DepthAiService | null {
  return service;
}

/** Sentences shown when the job cannot start (the panel and the command line print them as they are). */
export const DEPTH_AI_MESSAGES = {
  noRuntime:
    'AI Depth needs the model runtime, which only the app has (the browser or the desktop app). Run it there once: the result is saved with the project, and exports and the command line then use it.',
  noModel: 'The AI depth model is not on this computer yet. Open Plugins, find "AI models", and press Download (50 MB, Apache-2.0). Nothing is downloaded until you do.',
} as const;
