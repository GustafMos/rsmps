/**
 * The seam between the AI Style Transfer node (engine) and the model runtime (io). The engine has no model and no network: the app
 * installs a `StyleAiService` at start (src/io/style-ai.ts); the command line installs nothing, so a job there fails with a plain
 * sentence; the tests install a fake one. Nothing in this file downloads, fetches or loads anything.
 *
 * The model is AdaIN (Huang & Belongie 2017, "Arbitrary Style Transfer in Real-time with Adaptive Instance Normalization"), as two
 * files: an ENCODER (the first layers of VGG-19) that turns a picture into 512 feature maps at 1/8 of its size, and a DECODER that
 * paints a picture from such feature maps. The style transfer itself happens BETWEEN the two and is plain arithmetic on the feature
 * maps (lib/style-ai-math.ts): give the content's features the per-channel mean and spread of the style's features. Because that step
 * is ours, a transition can slide the statistics from picture A's to picture B's and blend the two contents, which a network with the
 * style baked in could not do.
 *
 * What was measured on the pinned files (run with onnxruntime-web 1.31 on real pictures):
 *   encoder: input  float32 [1, 3, 512, 512], RGB, planar (NCHW), values 0..1, NO mean / std normalisation (the export has it built in)
 *            output float32 [1, 512, 64, 64], values >= 0 (after a ReLU), typically 0..30
 *   decoder: input  float32 [1, 512, 64, 64]
 *            output float32 [1, 3, 512, 512], RGB planar, about 0..1 but it overshoots (-0.4..1.4 seen): clamp it
 * Both have FIXED sizes, so a larger picture is worked on as overlapping 512 tiles and a smaller side is filled by mirroring.
 */

export const STYLE_AI_MODEL = {
  /** Catalogue ids of the two files (src/io/model-catalogue.ts). */
  encoder: 'adain-vgg-encoder',
  decoder: 'adain-decoder',
  /** Upstream repository commit both files come from. Part of the node's process signature: another model makes a result stale. */
  revision: 'ca79d77e034b14bb99a4b2a6e3670c70cbcfb679',
  /** Side of the square picture both networks take, in pixels. */
  tile: 512,
  /** The encoder shrinks by this factor: 512 pixels become 64 feature cells. */
  stride: 8,
  /** Feature maps per picture. */
  channels: 512,
} as const;

/** One loaded model (both files). Calls are serialised inside the service; call one after the other. */
export interface StyleEngine {
  /** Picture to features. `rgb`: 3 x 512 x 512 planar floats, 0..1. Returns 512 x 64 x 64 floats (a fresh array the caller may keep). */
  encode(rgb: Float32Array, signal?: AbortSignal): Promise<Float32Array>;
  /** Features to picture. Returns 3 x 512 x 512 planar floats, about 0..1 (not clamped). */
  decode(features: Float32Array, signal?: AbortSignal): Promise<Float32Array>;
  /** Pack a finished frame (opaque RGBA) the way the process store keeps sequence frames. */
  toBlob(rgba: Uint8ClampedArray, width: number, height: number): Promise<Blob>;
  /** Which execution provider runs ('webgpu' | 'wasm'), for the panel. */
  readonly provider: string;
  /** Said to the user when the model runs on the processor. */
  readonly note?: string;
}

export interface StyleAiService {
  /** Are both model files on this computer? (Never downloads.) */
  modelReady(): Promise<boolean>;
  /** Load (or reuse) the model. Throws a readable error when it is not downloaded or cannot run. */
  open(signal?: AbortSignal): Promise<StyleEngine>;
}

let service: StyleAiService | null = null;

export function setStyleAiService(s: StyleAiService | null): void {
  service = s;
}

export function getStyleAiService(): StyleAiService | null {
  return service;
}

/** Sentences shown when the job cannot start or stops (the panel and the command line print them as they are). */
export const STYLE_AI_MESSAGES = {
  noRuntime:
    'AI Style Transfer needs the model runtime, which only the app has (the browser or the desktop app). Render it there once: the result is saved with the project, and exports and the command line then use it.',
  noModel: 'The style transfer model is not on this computer yet. Press Download the model in this node’s panel (two files, 27 MB, MIT), or open Plugins, AI models. Nothing is downloaded until you do.',
  noFrames: 'With these settings no frame lies between picture A and picture B, so there is nothing to render. Make the transition longer, or the project.',
  memory: 'The computer ran out of memory while the model was running. Choose a smaller Longest side, close other tabs, and render again.',
} as const;
