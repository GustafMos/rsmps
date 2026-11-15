/**
 * The seam between the UI (src/app) and everything that touches files, decoding,
 * playback and export (src/io). The UI only imports from this file and `createIo`.
 * Implementations live in the other files of src/io.
 */
import type { Engine } from '../engine/engine';
import type { Registry } from '../engine/define';
import type { AssetInfo, GraphDoc, Host, Value } from '../engine/types';

/** The user's media. Implements the engine `Host`, persists files in IndexedDB so a reload keeps them. */
export interface MediaLibrary extends Host {
  /** Import files (images, videos, audio, MIDI). Returns the new assets in order. */
  add(files: File[]): Promise<AssetInfo[]>;
  remove(assetId: string): Promise<void>;
  list(): AssetInfo[];
  /** Small preview as an object URL (cached). */
  thumbnail(assetId: string): Promise<string | null>;
  /** Load previously imported assets after a page reload. */
  restore(): Promise<void>;
  /** Called whenever the asset list changes. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface PlayerState {
  playing: boolean;
  /** Current time in seconds (frame-snapped). */
  seconds: number;
  frame: number;
  totalFrames: number;
  /** Frames per second actually achieved over the last second. */
  measuredFps: number;
  /** Current proxy scale chosen by the player (1 = full resolution). */
  proxy: number;
  /** Frame indices that are RAM-cached and will play back instantly. */
  cachedFrames: ReadonlySet<number>;
  /** Node id → error message from the last evaluation. */
  errors: ReadonlyMap<string, string>;
  /** Node id → milliseconds in the last evaluation. */
  timings: ReadonlyMap<string, number>;
  /** Size of the image currently shown, or null. */
  imageSize: { width: number; height: number } | null;
}

/**
 * Owns the render loop. Evaluates the viewed node and blits the result to the canvas with
 * no React involvement per frame. Coalesces requests: at most one evaluation in flight,
 * always the latest state.
 */
export interface Player {
  /** Attach the WebGPU canvas to draw into (null to detach). */
  setCanvas(canvas: HTMLCanvasElement | null): void;
  /** What to show. Call on every graph/selection change; cheap. */
  setView(view: { graph: GraphDoc; node: string | null; port?: string; item: number; itemCount: number }): void;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(seconds: number): void;
  /** Step by whole frames (pauses). */
  step(frames: number): void;
  /** Proxy policy: 'auto' lowers resolution while playing to hold the project fps; a number forces it. */
  setProxy(mode: 'auto' | number): void;
  getState(): PlayerState;
  /** Fires at most once per animation frame while something changes. */
  subscribe(listener: (state: PlayerState) => void): () => void;
  /** Copy the currently shown image to a PNG blob (for thumbnails / "save frame"). */
  snapshot(): Promise<Blob | null>;
  /** Mute/unmute and volume for the live audio graph. */
  setVolume(volume: number): void;
  /** Resume audio (must be called from a user gesture) and start microphone capture if a mic node exists. */
  enableAudio(): Promise<void>;
  /** Live meter for an audio node output (peak 0..1 per channel), or null. */
  meter(nodeId: string): [number, number] | null;
  dispose(): void;
}

export interface ExportProgress {
  /** 0..1 overall. */
  fraction: number;
  /** e.g. "sprite_03.png · frame 12/96". */
  label: string;
}

export interface ExportedFile {
  name: string;
  blob: Blob;
}

export interface ExportRequest {
  graph: GraphDoc;
  /** Output node ids to render; empty = every output node in the graph. */
  outputs: string[];
  /** 'current' = only `item`; 'all' = the whole batch. */
  items: 'current' | 'all';
  item: number;
  /** Pack results into one ZIP when more than one file is produced. */
  zip: boolean;
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
}

export interface Exporter {
  /** Render and encode. Never blocks the UI thread for long: yields between frames. */
  run(request: ExportRequest): Promise<ExportedFile[]>;
  /** Trigger browser downloads for exported files. */
  download(files: ExportedFile[]): void;
}

export interface PluginInfo {
  /** Stable id of the stored plugin file. */
  id: string;
  fileName: string;
  /** Node ids the module registered. */
  nodeIds: string[];
  error?: string;
}

/** Loads plugin modules, registers their nodes and remembers them across reloads. */
export interface PluginManager {
  install(file: File): Promise<PluginInfo>;
  remove(id: string): Promise<void>;
  list(): PluginInfo[];
  /** Re-register every stored plugin (call once at start-up, before loading a graph). */
  restore(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** Project persistence: the graph document itself (assets are referenced by id). */
export interface ProjectStore {
  /** Last autosaved graph, or null. */
  loadAutosave(): Promise<GraphDoc | null>;
  /** Debounced internally; safe to call on every edit. */
  autosave(graph: GraphDoc): void;
  /** Save / open a `.rsmps.json` file through the browser file dialogs. */
  saveToFile(graph: GraphDoc): Promise<void>;
  openFromFile(): Promise<GraphDoc | null>;
  /** User presets (graphs without media), stored in the browser. */
  listPresets(): Promise<{ id: string; name: string; builtin: boolean; thumbnail?: string }[]>;
  loadPreset(id: string): Promise<GraphDoc | null>;
  savePreset(name: string, graph: GraphDoc, thumbnail?: Blob): Promise<void>;
  deletePreset(id: string): Promise<void>;
}

export interface Io {
  engine: Engine;
  registry: Registry;
  library: MediaLibrary;
  player: Player;
  exporter: Exporter;
  plugins: PluginManager;
  projects: ProjectStore;
  /** Evaluate once, outside the player (thumbnails, node previews). */
  evaluate(graph: GraphDoc, node: string, opts?: { port?: string; seconds?: number; item?: number; proxy?: number }): Promise<Value | null>;
}

/** Implemented in src/io/index.ts. Throws a readable error when WebGPU is unavailable. */
export type CreateIo = () => Promise<Io>;
