/**
 * The seam between the UI (src/ui) and everything that touches files, decoding,
 * playback and export (src/io). The UI only imports from this file and `createIo`.
 * Implementations live in the other files of src/io.
 */
import type { Engine } from '../engine/engine';
import type { AudioDevice } from '../engine/audio/api';
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
  /**
   * Create an image-sequence asset: a 'video' asset whose frames are stills (frame = floor(seconds x fps)).
   * Persisted like other assets, so scanned frames can feed a Media In node as an animation.
   */
  addSequence(name: string, frames: Blob[] | ImageBitmap[], fps: number): Promise<AssetInfo>;
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
  /**
   * Size of the image at FULL resolution (proxy 1), independent of the playback proxy. Show this to the user and
   * lay the canvas out at exactly this size (the player also sets the canvas CSS width/height to it); the browser
   * scales the lower-resolution backing store, so the picture never changes size on screen when the proxy changes.
   * Taken from the last proxy-1 render of the viewed node; until one exists it is rendered size / proxy.
   */
  imageSize: { width: number; height: number } | null;
  /** Actual size of the texture currently drawn (smaller than imageSize at a lowered proxy), or null. For diagnostics only. */
  renderedSize: { width: number; height: number } | null;
  /**
   * Audio status. `needed`: the graph has an audio output or sound-to-picture analysis taps, so the audio engine
   * must run. `running`: it has been started (needs a user gesture via enableAudio()). `micNodes`: microphone nodes
   * in the graph (starting audio asks for microphone permission).
   */
  audio: { needed: boolean; running: boolean; micNodes: number };
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
  /**
   * `activeOutput`: id of the Output node whose frame (aspect ratio / size) non-output views should use, so previews
   * of intermediate nodes match what that output will export. Viewing an Output node always uses its own frame.
   */
  setView(view: { graph: GraphDoc; node: string | null; port?: string; item: number; itemCount: number; activeOutput?: string | null }): void;
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

/** Hardware devices and the on-screen keyboard; passes straight through to the audio engine. */
export interface AudioApi {
  /** Works before audio is started. Never throws; [] when unsupported or denied. */
  listDevices(kind: "audio-input" | "midi-input"): Promise<AudioDevice[]>;
  /** Returns an unsubscribe function. */
  onDevicesChanged(listener: () => void): () => void;
  sendNote(nodeId: string, note: number, velocity: number, on: boolean): void;
}

export interface Io {
  engine: Engine;
  registry: Registry;
  library: MediaLibrary;
  player: Player;
  exporter: Exporter;
  plugins: PluginManager;
  projects: ProjectStore;
  /** Print-and-scan-back: photos of printed sheets to an animation asset. */
  scan: ScanApi;
  audio: AudioApi;
  /** Evaluate once, outside the player (thumbnails, node previews). */
  evaluate(graph: GraphDoc, node: string, opts?: { port?: string; seconds?: number; item?: number; proxy?: number }): Promise<Value | null>;
}

/** Implemented in src/io/index.ts. Throws a readable error when WebGPU is unavailable. */
export type CreateIo = () => Promise<Io>;

/* ---------------------------------------------------------------------------------------------- */
/* Print and scan back                                                                              */
/* ---------------------------------------------------------------------------------------------- */

/** A point in photo pixels (origin top-left of the decoded photo, x right, y down). */
export interface ScanPoint {
  x: number;
  y: number;
}

/** The four page corner finder patterns, named after the PRINTED page (not the photo): `tl` is the distinctive top-left one. */
export interface ScanCorners {
  tl: ScanPoint;
  tr: ScanPoint;
  br: ScanPoint;
  bl: ScanPoint;
}

/** Layout of one printed page, as decoded from its data strip or supplied manually. */
export interface ScanLayoutInfo {
  paper: 'a4' | 'a3' | 'letter' | 'a5' | 'legal';
  landscape: boolean;
  pageWidthMm: number;
  pageHeightMm: number;
  /** 0-based page number within the printed set. */
  pageIndex: number;
  pageCount: number;
  columns: number;
  rows: number;
  cellWidthMm: number;
  cellHeightMm: number;
  gutterMm: number;
  /** Index of the first frame on this page (0-based, counting printed frames). */
  firstFrame: number;
  /** Frames on this page (the last page may be partly empty). */
  framesOnPage: number;
  /** Frames in the whole printed set. */
  totalFrames: number;
  /** Playback rate recorded at print time. */
  fps: number;
  /** Size in pixels of the original frames (0 when unknown, e.g. manual layout). */
  frameWidthPx: number;
  frameHeightPx: number;
  /** How the frames were printed. 'faded' uses `guideOpacity` (percent ink kept). */
  guide: 'full' | 'faded' | 'outline' | 'blank';
  guideOpacity: number;
  /** 8 hex digits identifying the printed project; pages of one set share it. */
  projectId: string;
}

/** Result for one "+" registration mark of a page (marks form a (columns+1) x (rows+1) grid). */
export interface ScanMarkResult {
  column: number;
  row: number;
  /** True when the mark was located by template matching; false when its position was interpolated from neighbours. */
  found: boolean;
  /** Match quality 0..1 (normalised cross-correlation). */
  score: number;
  /** Distance in photo pixels between the refined mark and where the page perspective alone predicted it. Large = paper curl or lens distortion. */
  residualPx: number;
}

/** Result for one frame cell of a page. */
export interface ScanCellResult {
  /** Absolute frame index. */
  frame: number;
  column: number;
  row: number;
  /** How many of the four surrounding marks were found (0..4). */
  marksFound: number;
  /** Largest residual among the four surrounding marks (photo pixels). */
  maxResidualPx: number;
}

/** Everything the Scan tab needs to know about one photo / scan. */
export interface ScanPageReport {
  /** Position of this page in the list given to `analyze` (use it with `reanalyzePage`). */
  index: number;
  fileName: string;
  /** Pixel size of the decoded photo. */
  photoWidth: number;
  photoHeight: number;
  /**
   * 'ok': fully registered. 'warning': usable but something was off (see `warnings`: missing marks, high distortion,
   * ambiguous orientation). 'failed': no frames were produced from this photo.
   */
  status: 'ok' | 'warning' | 'failed';
  /** Corner finders in photo pixels (null when fewer than four were found). */
  corners: ScanCorners | null;
  /** Finder candidates that WERE found even when the set is incomplete (for drawing hints). */
  foundCorners: ScanPoint[];
  cornersSource: 'auto' | 'manual' | null;
  /** Clockwise rotation of the printed page inside the photo, snapped to a quarter turn. */
  rotation: 0 | 90 | 180 | 270;
  /** Remaining tilt in degrees after removing the quarter-turn rotation (-45..45). */
  skewDeg: number;
  layout: ScanLayoutInfo | null;
  /** 'strip' = decoded from the printed data strip; 'manual' = supplied via `reanalyzePage`. */
  layoutSource: 'strip' | 'manual' | null;
  /** 0-based page number (from the layout), or null when unknown. */
  pageIndex: number | null;
  /** Inclusive range of frame indices on this page, or null. */
  frameRange: [number, number] | null;
  /** RMS distance (photo pixels) between the refined marks and one best-fit perspective: how far from a flat sheet the photo is. */
  reprojectionErrorPx: number | null;
  marksFound: number;
  marksExpected: number;
  marks: ScanMarkResult[];
  cells: ScanCellResult[];
  /** True when this page's frames are in the result. False for the worse of two photos of the same page, or pages of another project. */
  used: boolean;
  /** Object URL of a small image of the page: the rectified page when detection worked, else the photo. Null when unavailable. */
  thumbnailUrl: string | null;
  thumbnailKind: 'rectified' | 'photo';
  /** Object URL of the photo downsized to `photoScale` x its size, for drawing `corners` on top. Multiply photo coordinates by `photoScale`. */
  photoUrl: string | null;
  photoScale: number;
  warnings: string[];
}

/** Summary of a whole scan session. */
export interface ScanReport {
  pages: ScanPageReport[];
  /** Project id of the set the frames belong to (8 hex digits), or null when no page decoded. */
  projectId: string | null;
  /** Frames in the printed set (from the strips). */
  totalFrames: number;
  pageCount: number;
  fps: number;
  /** Pixel size of the recovered frames. */
  frameWidthPx: number;
  frameHeightPx: number;
  recoveredFrames: number;
  /** 0-based page numbers that were never supplied (or failed). */
  missingPages: number[];
  /** Frame indices without an image. */
  missingFrames: number[];
  /** True when every frame of the set was recovered and no page failed. */
  complete: boolean;
  warnings: string[];
}

/** One recovered frame. */
export interface ScanFrame {
  /** Absolute frame index within the printed set. */
  index: number;
  width: number;
  height: number;
  /** Straight-alpha RGBA. */
  data: Uint8ClampedArray;
}

/** A page layout to use when the data strip cannot be read: the same settings that were used for printing. */
export interface ScanManualLayout {
  paper: 'a4' | 'a3' | 'letter' | 'a5' | 'legal';
  landscape?: boolean;
  columns: number;
  rows: number;
  /** Gutter in mm (default 5). */
  gutterMm?: number;
  /** Margin in mm (default 10). */
  marginMm?: number;
  /** Width / height of one frame (default 1). */
  frameAspect?: number;
}

/** Manual help for one page: any combination of corner points and layout. */
export interface ScanManualInput {
  /** Corner finders in photo pixels. Order them as they are on the PRINTED page (tl = the page's top-left finder). */
  corners?: ScanCorners;
  layout?: ScanManualLayout;
  /** 0-based page number (default: position in the supplied list). */
  pageIndex?: number;
  /** Index of the first frame on the page (default: pageIndex x columns x rows). */
  firstFrame?: number;
  /** Frames in the whole set (default: columns x rows x pages supplied). */
  totalFrames?: number;
  fps?: number;
  /** Frame pixel size to cut to (default: cell size at 300 dpi). */
  frameWidthPx?: number;
  frameHeightPx?: number;
}

export interface ScanAnalyzeOptions {
  /** Cut frames to this size instead of the original frame size recorded in the strip. */
  outputWidth?: number;
  outputHeight?: number;
  /** Divide out uneven lighting using the blank paper (default true). */
  flatten?: boolean;
}

/** Outcome of `Io.scan.analyze`. Holds object URLs: call `dispose()` when the Scan tab closes. */
export interface ScanResult {
  report: ScanReport;
  /** Recovered frames, indexed by frame number; null where a frame is missing. */
  frames: (ScanFrame | null)[];
  /** Object URL (PNG) of each frame, same indexing. */
  frameUrls: (string | null)[];
  /**
   * Re-run one page with manual corners and/or layout, keeping the other pages. `pageIndex` is
   * `ScanPageReport.index`. Returns a new result (the old one stays valid until disposed).
   */
  reanalyzePage(pageIndex: number, manual: ScanManualInput): Promise<ScanResult>;
  /** Revoke all object URLs. */
  dispose(): void;
}

export interface ScanCommitOptions {
  /** Name of the new asset. */
  name: string;
  /** Playback rate (default: the printed fps, else 12). */
  fps?: number;
  /** Output the ink only, on transparent (default false). */
  drawingOnly?: boolean;
  /** Drawing extraction: darkness (0..1) treated as paper. Default 0.12. */
  threshold?: number;
  /** Drawing extraction: softness of the edge. Default 0.1. */
  softness?: number;
  /** Original frames in print order; with `removeGuide` the printed guide is divided out of the scans. */
  originals?: Blob[];
  removeGuide?: boolean;
  /** What to do with frames that could not be recovered (default 'repeat' the previous one). */
  missing?: 'repeat' | 'blank' | 'skip';
}

/** Scan-back: turn photos of printed sheets into an animation asset. */
export interface ScanApi {
  /** Decode photos / scans, find the page markers, align, and cut the frames. Pages may be given in any order. */
  analyze(files: File[], options?: ScanAnalyzeOptions): Promise<ScanResult>;
  /** Same as `result.reanalyzePage`. */
  reanalyzePage(result: ScanResult, pageIndex: number, manual: ScanManualInput): Promise<ScanResult>;
  /** Create an image-sequence asset in the library from the recovered frames. */
  commit(result: ScanResult, options: ScanCommitOptions): Promise<AssetInfo>;
}
