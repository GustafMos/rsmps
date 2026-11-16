/**
 * The seam between the UI (src/ui) and everything that touches files, decoding,
 * playback and export (src/io). The UI only imports from this file and `createIo`.
 * Implementations live in the other files of src/io.
 */
import type { Engine } from '../engine/engine';
import type { AudioDevice, PcmAudio, RecordedTake, RecordingState } from '../engine/audio/api';
import type { Registry } from '../engine/define';
import type { AssetInfo, GraphDoc, Host, Value } from '../engine/types';

/** The user's media. Implements the engine `Host`, persists files in IndexedDB so a reload keeps them. */
export interface MediaLibrary extends Host {
  /** Assets for the media panel. Working assets owned by a scan project are hidden unless `includeHidden`. */
  add(files: File[]): Promise<AssetInfo[]>;
  remove(assetId: string): Promise<void>;
  list(opts?: { includeHidden?: boolean }): AssetInfo[];
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
  /**
   * The hidden working sequence owned by `owner` (a scan project id): created on first call, then REPLACED in place under
   * the same asset id. Hidden from `list()`; removed by `removeOwned`.
   */
  attachSequence(owner: string, name: string, frames: Blob[], fps: number, meta?: Record<string, unknown>): Promise<AssetInfo>;
  /** Set when decoding this asset failed for good (null otherwise, and until something has tried to decode it). */
  assetProblem(assetId: string): AssetProblem | null;
  /** Store a recorded take as an audio asset (lossless 32-bit float WAV). Persisted; `assetAudio` serves it immediately. */
  addRecording(name: string, pcm: PcmAudio): Promise<AssetInfo>;
  /** Delete every asset owned by `owner`. */
  removeOwned(owner: string): Promise<void>;
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
   * GPU memory: bytes allocated, the budget the app keeps itself under, and how close it is (ok below 75 %, high, critical at or
   * over the budget). Show it as a meter with a "Free memory" button (`Io.freeMemory()`).
   */
  memory: { allocatedBytes: number; budgetBytes: number; pressure: 'ok' | 'high' | 'critical' };
  /**
   * Size of the image at FULL resolution (proxy 1), independent of the playback proxy. Show this to the user and
   * lay the canvas out at exactly this size (the player also sets the canvas CSS width/height to it); the browser
   * scales the lower-resolution backing store, so the picture never changes size on screen when the proxy changes.
   * Taken from the last proxy-1 render of the viewed node; until one exists it is rendered size / proxy.
   */
  imageSize: { width: number; height: number } | null;
  /**
   * Output "Pixel size" in effect for the current view (1 = off). When > 1 the player renders the graph at exactly
   * 1/pixelSize and enlarges with hard pixels, so `imageSize` / the canvas are already the final frame size.
   */
  pixelSize: number;
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
/**
 * VIEWER RULE for the UI: draw the canvas with nearest-neighbour scaling (CSS `image-rendering: pixelated`) when the
 * zoom is >= 100 %, and with smooth scaling (`image-rendering: auto`) when the zoom is below 100 %. Shrinking a
 * dithered image with nearest-neighbour is what made the preview look different from the export.
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
  /**
   * Desktop app, FFmpeg formats: the file was already written where the user chose in a native Save dialog. `blob` is empty and
   * `exporter.download` skips it; show this path instead.
   */
  savedPath?: string;
}

export interface ExportRequest {
  graph: GraphDoc;
  /** Output node ids to render; empty = every output that is not switched off (`enabled` param) or bypassed. */
  outputs: string[];
  /** 'current' = only `item`; 'all' = the whole batch. */
  items: 'current' | 'all';
  item: number;
  /** Pack results into one ZIP when more than one file is produced. */
  zip: boolean;
  onProgress?: (p: ExportProgress) => void;
  /**
   * Sound-only export (when `outputs` names an `audio-out` node, or the graph has no picture output at all): 'wav' (default,
   * 32-bit float), 'm4a' (AAC) or 'webm' (Opus). Falls back to WAV with a note in errors.txt when the browser cannot encode it.
   * Videos always get their audio from the enabled Audio Out(s); with every Audio Out disabled they have no audio track.
   */
  audioFormat?: 'wav' | 'm4a' | 'webm';
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
/** A library entry as stored: `AssetInfo` plus ownership. Hidden working assets belong to a scan project (`owner` = its id). */
export type LibraryAsset = AssetInfo & { owner?: string; hidden?: boolean; /** Video codec as read from the file, e.g. "HEVC (H.265) 10-bit". */ codec?: string };

/**
 * Why an asset cannot be used, for a "How to fix" box. `unsupported-codec`: neither WebCodecs nor the browser's own player can
 * decode the video. `hint` is plain text with a copy-pasteable ffmpeg command.
 */
export interface AssetProblem {
  code: 'unsupported-codec';
  codec: string;
  hint: string;
}

/**
 * Everything a scan tab needs to come back after a reload. Results (recovered frames) are NOT stored: `io.scan.restore`
 * recomputes them from the photos and manual corrections.
 */
export interface ScanSession {
  /** The original photo files. */
  photos: { name: string; blob: Blob }[];
  /** Manual corrections per photo index, exactly what `ScanApi.reanalyzePage` takes. */
  manual: Record<number, ScanManualInput>;
  /** What the UI collects: `analyze` (ScanAnalyzeOptions), `commit` (name, fps, drawingOnly, clean-up, last export settings...). Free-form. */
  options: { analyze?: ScanAnalyzeOptions; commit?: Partial<Omit<ScanCommitOptions, 'originals'>> } & Record<string, unknown>;
  /** Id of the hidden working sequence asset created by `ScanApi.attach`. */
  committedAssetId?: string;
  /** The scan project's own node graph (processes the recovered frames, e.g. upscale and clean up). */
  graph?: GraphDoc;
}

/** One open project (tab). Metadata only: the graph body is loaded on demand with `loadProject`. */
export interface OpenProject {
  /**
   * 'graph': an ordinary node-graph project. 'scan': a print-and-scan session that ALSO owns a node graph
   * (`loadProject(id)` returns it, or null before it has one; `saveProject(id, graph)` saves it). Stored projects
   * without a kind are graphs.
   */
  kind: 'graph' | 'scan';
  id: string;
  name: string;
  /** ms since epoch of the last edit. */
  updatedAt: number;
  /** Small preview (object URL) of the last saved thumbnail. */
  thumbnail?: string;
  /** Edited since the last `markSaved(id)` (call it after `saveToFile` succeeded). */
  dirty?: boolean;
}

export interface ProjectStore {
  /**
   * Open projects (tabs), persisted across reloads. Only metadata is held for background tabs; one graph body is
   * read per `loadProject`. On first run after the upgrade the old single autosave becomes the first project.
   */
  listOpen(): Promise<OpenProject[]>;
  activeId(): Promise<string | null>;
  /** Remember which tab is active (does NOT load anything; use `Io.switchProject` to change the live project). */
  setActive(id: string): Promise<void>;
  /** Load ONE graph body on demand, or null. */
  loadProject(id: string): Promise<GraphDoc | null>;
  /** Debounced (~400 ms) like autosave; updates this project's body, name, time and thumbnail only. Call on every edit. */
  saveProject(id: string, graph: GraphDoc, thumbnail?: Blob): void;
  /** Clear the dirty flag (after a successful file save). */
  markSaved(id: string): Promise<void>;
  /** Add a scan project as a new last tab and make it active. Its thumbnail becomes the first photo. */
  createScanProject(name?: string): Promise<OpenProject>;
  /** Debounced like `saveProject`. Photo blobs are only rewritten when the photo list changed. Ignored for graph projects. */
  saveScanSession(id: string, session: ScanSession): void;
  /** The stored session of a scan project (an empty one if nothing was saved yet), or null for a graph project. */
  loadScanSession(id: string): Promise<ScanSession | null>;
  /** Add a project as a new last tab and make it active. */
  createProject(graph: GraphDoc, name?: string): Promise<OpenProject>;
  /** Remove from the tabs. Keeps the graph in the last 10 closed projects. Returns the id that should become active. */
  closeProject(id: string): Promise<string | null>;
  listClosed(): Promise<OpenProject[]>;
  /** Bring a recently closed project back as the last tab (and make it active). */
  reopen(id: string): Promise<OpenProject | null>;
  renameProject(id: string, name: string): Promise<void>;
  /** New tab order; ids not listed keep their order after the listed ones. */
  reorderOpen(ids: string[]): Promise<void>;
  /** Copy placed right after the original (not activated). */
  duplicateProject(id: string): Promise<OpenProject | null>;
  /** Write all pending saves now (await before switching or closing the page yourself). */
  flush(): Promise<void>;

  /** Legacy: the active project's graph, or null. */
  loadAutosave(): Promise<GraphDoc | null>;
  /** Legacy: debounced save into the active project (creates one if there is none). */
  autosave(graph: GraphDoc): void;
  /** Save / open a `.rsmps.json` file through the browser file dialogs. */
  saveToFile(graph: GraphDoc): Promise<void>;
  openFromFile(): Promise<GraphDoc | null>;
  /** User presets (graphs without media), stored in the browser. */
  listPresets(): Promise<{ id: string; name: string; builtin: boolean; thumbnail?: string }[]>;
  loadPreset(id: string): Promise<GraphDoc | null>;
  savePreset(name: string, graph: GraphDoc, thumbnail?: Blob): Promise<void>;
  deletePreset(id: string): Promise<void>;

  /**
   * Rolling backups: the last ~10 GOOD autosaves of a project (snapshots taken after a frame rendered), newest first.
   * `recordBackup` is rate-limited by the caller (see src/ui/safety.ts); identical content is skipped.
   */
  recordBackup(projectId: string, graph: GraphDoc): Promise<boolean>;
  listBackups(projectId: string): Promise<import('./backups').BackupInfo[]>;
  loadBackup(projectId: string, backupId: string): Promise<GraphDoc | null>;
}

/** Hardware devices and the on-screen keyboard; passes straight through to the audio engine. */
/** Result of `Io.audio.stop()`. */
export interface RecordedResult {
  take: RecordedTake;
  /** One stored audio asset per audio pass (same order as the take's passes, or one for a single take); [] for MIDI takes. */
  assets: AssetInfo[];
}

/**
 * Recording flow (for the record button; no need to read the audio engine):
 *  1. `arm(timelineNodeId, { track, kind })` — the Timeline node whose `recordAudio` / `recordMidi` input is wired.
 *  2. `record()` from a click (user gesture): starts the audio engine and recording. During a count-in the player stays paused;
 *     when recording starts the player plays from the current position (a running transport is left alone).
 *  3. Show `recordingState()` / `onRecordingState()`: phase, seconds, countIn (seconds left), level meters, error.
 *  4. `stop()`: pauses, stops, stores each audio pass as a WAV asset ("Take N · track · time") and returns { take, assets }.
 *  5. Call `applyTake(timeline, take, { mode, assetIds: assets.map(a => a.id) })` (src/engine/audio/timeline.ts) and write the
 *     result to the node's `clips` param. MIDI takes need no assets.
 */
export interface AudioApi {
  arm(nodeId: string, target: { track: string; kind: 'audio' | 'midi' } | null): void;
  record(): Promise<void>;
  stop(): Promise<RecordedResult | null>;
  recordingState(): RecordingState;
  /** Called at most ~30 times a second while armed / recording. Returns an unsubscribe function. */
  onRecordingState(listener: (state: RecordingState) => void): () => void;
  /** Works before audio is started. Never throws; [] when unsupported or denied. */
  listDevices(kind: "audio-input" | "midi-input"): Promise<AudioDevice[]>;
  /** Returns an unsubscribe function. */
  onDevicesChanged(listener: () => void): () => void;
  sendNote(nodeId: string, note: number, velocity: number, on: boolean): void;
}

export interface DeviceApi {
  list(kind: 'audio-input' | 'midi-input' | 'video-input'): Promise<AudioDevice[]>;
  /** Returns an unsubscribe function. */
  onChanged(listener: () => void): () => void;
}

/** State of a phone link session (QR code). */
export type PhoneState = 'waiting' | 'connected' | 'disconnected' | 'expired';

/**
 * How far a pairing got, in order: nothing yet, the phone reached this computer, the code was accepted, video is flowing.
 * The progress ticks in the UI come from this value, never from the wording of `detail()`.
 */
export type PhoneProgress = 'waiting' | 'reached' | 'accepted' | 'connected';

export interface PhoneAddress {
  /** Origin to put in the QR code, e.g. https://192.168.0.5:5173 */
  url: string;
  /** For a dropdown: "Wi-Fi 192.168.0.5", "Tailscale 100.x.y.z", "Tailscale name machine.tailnet.ts.net (trusted https)". */
  label: string;
  kind: 'lan' | 'tailscale' | 'other';
}

export interface PhoneSessionInfo {
  /** 128-bit random pairing token (32 hex digits). Store it in the Phone Camera node's `session` param. */
  token: string;
  /** The address inside the QR code: https://<lan-address>:<port>/phone?token=… */
  url: string;
  /** Inline SVG of the QR code (give it a CSS width). */
  qrSvg: string;
  /** ms since epoch: an unused session expires then (5 minutes). */
  expiresAt: number;
}

/**
 * Use a phone as a live camera (opt-in LAN mode, `npm run dev:lan`). UI: if `available` is false show how to enable it
 * (the node's own error says the same); otherwise `createSession()`, show the QR code with this note next to it: "Your phone
 * will warn that the connection is not private: choose Advanced, then Proceed. This is your own computer.", show `state`,
 * and offer Disconnect (`close`). Sessions live in memory: after a page reload the QR code must be made again.
 */
export interface PhoneApi {
  /**
   * True when a phone can be linked: the dev server runs in LAN mode (https, reachable from the network), or this is the desktop
   * app, which starts its phone server on demand (see `startServer`). Decided once at start-up.
   */
  available: boolean;
  /**
   * Desktop app: start the phone server (the first time the user is asked to allow it; later it only starts). Call it before
   * `createSession`; `createSession` also calls it when the server is not running. `declined` = the user said no (offer a retry).
   * Elsewhere (dev LAN mode) the server is already running and this resolves `{ ok: true }`. Absent on older implementations.
   */
  startServer?(): Promise<{ ok: boolean; declined?: boolean; error?: string }>;
  /** Addresses a phone could use to reach this computer, best first (physical Wi-Fi, then Tailscale, then others). Offer them in a dropdown. */
  addresses(): Promise<PhoneAddress[]>;
  /** `address` = the `url` of one of `addresses()` (default: the first). The QR code always uses the protocol and port of THIS page's server. */
  createSession(opts?: { address?: string }): Promise<PhoneSessionInfo>;
  state(token: string): PhoneState;
  /** One plain sentence about what is happening or what to try ("Your phone reached this computer...", the firewall checklist, why it closed). */
  detail(token: string): string;
  /** How far the pairing got (typed; drives the three progress ticks). */
  progress(token: string): PhoneProgress;
  /** When an unused code expires (ms since epoch), null once a phone joined. Show a countdown. */
  expiresAt(token: string): number | null;
  onState(listener: (token: string, state: PhoneState, detail: string, progress: PhoneProgress) => void): () => void;
  close(token: string): void;
}

export type { AddonInfo, AddonState } from './desktop';

/** Result of an add-on action. `declined`: the user refused the native confirmation. `canceled`: the file picker was closed. */
export interface AddonActionResult {
  ok: boolean;
  info?: import('./desktop').AddonInfo;
  declined?: boolean;
  canceled?: boolean;
  /** Plain words, ready to show. */
  error?: string;
}

/**
 * Official add-ons (optional software the desktop app can fetch on request, e.g. FFmpeg for ProRes-compatible export). Web version:
 * `supported` is false and every call resolves empty / not ok. While something installs the list is polled and `onChange` fires
 * with each update (including download progress); the states and numbers come straight from the desktop app.
 */
export interface AddonsApi {
  supported: boolean;
  list(): Promise<import('./desktop').AddonInfo[]>;
  /** Asks the user in a native dialog first, then downloads in the background: watch `onChange`. */
  install(id: string): Promise<AddonActionResult>;
  cancel(id: string): Promise<AddonActionResult>;
  remove(id: string): Promise<AddonActionResult>;
  /** "Use one I already have": opens a native file picker. */
  locate(id: string): Promise<AddonActionResult>;
  /** Called with the full list after every change. Returns an unsubscribe function. */
  onChange(listener: (list: import('./desktop').AddonInfo[]) => void): () => void;
}

export interface MemoryInfo {
  /** Engine node-result cache (read from a private counter: best effort). */
  engineCacheBytes: number;
  /** All GPU textures the pool has allocated (in use + idle). */
  gpuPoolBytes: number;
  /** Player RAM cache of rendered frames. */
  frameCacheBytes: number;
  /** Library decoded frames and PCM. */
  decodedMediaBytes: number;
  /** Everything the app has live on the GPU: pooled and scratch textures, uniform/storage/vertex/index/readback buffers. */
  gpuTotalBytes?: number;
  /** Highest value gpuTotalBytes has had in this session. */
  gpuPeakBytes?: number;
  /** Per category (pooled-texture, scratch-texture, texture, uniform-buffer, scratch-buffer, readback-buffer, vertex-buffer, index-buffer, ...). */
  gpuByCategory?: Record<string, { count: number; bytes: number; peakBytes: number }>;
  /** Live and cumulative object counts (textures, buffers, views, bind groups, pipelines, submits). */
  gpuObjects?: Record<string, number>;
  gpuCaches?: Record<string, number>;
  /** The node render that held the most texture bytes at once. */
  gpuWorstScope?: { label: string; bytes: number; textures: number };
  /** Idle (reusable) bytes in the pools: what a trim could give back. */
  gpuIdleBytes?: number;
  /** System RAM (not GPU): budget of the spill caches, the packed player frames, the RAM tier of expensive results. */
  ramBudgetBytes?: number;
  ramFrameCacheBytes?: number;
  ramColdBytes?: number;
  /** Compressed size / raw size of the RAM tier. */
  ramColdRatio?: number;
  /** RAM-tier counters: entries, demoted, promoted, savedMs (render time avoided) vs promoteMs (time to bring results back). */
  coldTier?: { entries: number; demoted: number; skippedDemote: number; promoted: number; promoteMs: number; savedMs: number; misses: number; lost: number };
  /** Counters of the player's RAM frame cache. */
  frameCache?: { captured: number; skipped: number; restored: number; restoreMs: number; captureMs: number; rawBytes: number; quality: 'compressed' | 'lossless' };
  /** Decoded sound (system RAM) and cached model/file bytes (system RAM). */
  audioPcmBytes?: number;
  modelBytes?: number;
}

/** Options of Io.bake.bake. */
export interface BakeOptions {
  /** 'lossless' (PNG: exact, used by exports) or 'compressed' (high-quality WebP: much smaller, exports re-render live unless the node says otherwise). */
  quality: 'lossless' | 'compressed';
  onProgress?: (p: { frame: number; frames: number; fraction: number; bytes: number }) => void;
  /** Abort a running bake: nothing is stored and the promise rejects with an AbortError. */
  signal?: AbortSignal;
  /** Batch item to bake when the picture depends on it (default 0). Other items stay live. */
  item?: number;
  /** Project the node belongs to (default: the active project). Used to name and later purge the stored sequence. */
  projectId?: string;
  /** Stop with an error when the encoded frames exceed this many bytes (default 3 GB). */
  maxBytes?: number;
}

export interface BakeResult {
  /** Hidden library sequence that holds the frames. */
  assetId: string;
  /** Structural signature of everything upstream at bake time (what the node compares to detect a stale bake). */
  signature: string;
  frames: number;
  /** Stored size in bytes (encoded frames). */
  bytes: number;
  /** The batch item that was baked, or null when the picture does not depend on the item. */
  item: number | null;
  itemDependent: boolean;
  /** Write EXACTLY these into the Cache / Bake node's params (all strings): baked, bakedSignature, bakedQuality, bakedItem, bakedUnit, bakedWidth, bakedCanvas. */
  params: Record<string, string>;
}

export interface BakeInfo {
  assetId: string;
  signature: string;
  frames: number;
  bytes: number;
  quality: 'lossless' | 'compressed';
  item: number | null;
  fps: number;
  width: number;
  height: number;
  createdAt: number;
  /** A bake of this node is running right now. */
  running: boolean;
}

/** Baking of Cache / Bake nodes. */
export interface BakeApi {
  /** Render every frame of the node's input for the whole project loop at full resolution and store it. Does NOT edit the graph: write result.params into the node. */
  bake(graph: GraphDoc, nodeId: string, opts: BakeOptions): Promise<BakeResult>;
  /** Delete the stored sequence of a node. The UI then clears the node's baked* params (the node serves nothing from a missing sequence and reports stale). */
  unbake(nodeId: string): Promise<void>;
  /** What is stored for a node (also after a reload), or null. */
  info(nodeId: string): BakeInfo | null;
  /** Remove stored sequences of a project whose Cache / Bake node no longer exists. Returns how many were removed. */
  prune(projectId: string, graph: GraphDoc): Promise<number>;
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
  /** Hardware lists. Camera names appear after the user granted camera permission (before that: "Camera 1"…). */
  devices: DeviceApi;
  /** Phone as a camera through a QR code (LAN mode only). */
  phone: PhoneApi;
  /** Official add-ons (desktop app only; `supported` is false in the web version). */
  addons: AddonsApi;
  /**
   * What this running copy of the app can do, for `NodeDef.requires`. The hosted web version has no local
   * server, so 'local-server' is absent there; it is present under `npm run dev:lan` and in the packaged desktop app (which starts
   * its phone server on demand).
   * The UI warns on nodes whose requirements are not met.
   */
  capabilities(): ReadonlySet<import('../engine/types').Capability>;
  /**
   * Switch the live project to tab `id` and release the old one's memory: flushes its pending save, pauses the
   * player and stops audio, clears the engine cache, the player's frame cache and pooled GPU textures, and drops decoded
   * media (frames, PCM, decoder cursors) that the new project does not use. Assets stay in IndexedDB and the asset
   * list stays shared. Returns the new project's graph (null if unknown). The caller must then `player.setView` with it.
   */
  switchProject(id: string): Promise<GraphDoc | null>;
  /** Baked regions (Cache / Bake nodes). */
  bake: BakeApi;
  /** Best-effort memory readout in bytes. */
  memory(): MemoryInfo;
  /** Total GPU memory the app may use (bytes). `set` is remembered across sessions; `auto` goes back to the detected default. */
  memoryBudget: {
    get(): number;
    set(bytes: number): void;
    auto(): void;
    /** System-RAM budget (bytes) of the spill caches: compressed rendered frames for playback and the RAM tier of expensive node results. Remembered across sessions. */
    ramBudget: { get(): number; set(bytes: number): void; auto(): void };
    /** Preview cache quality: 'compressed' (default; exact whenever the picture deflates well, lossy JPEG/WebP otherwise) or 'lossless'. Remembered across sessions. */
    cacheQuality: { get(): 'compressed' | 'lossless'; set(q: 'compressed' | 'lossless'): void };
  };
  /** Release everything that can be rebuilt (frame caches, engine cache, idle textures). The picture on screen stays. */
  freeMemory(): Promise<void>;
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
  /** 'strip' = decoded from the printed data strip; 'manual' = supplied via `reanalyzePage`; 'lattice' = strip unreadable, layout detected from the + marks (confirm page number, frame count and fps). */
  layoutSource: 'strip' | 'manual' | 'lattice' | null;
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
  /**
   * Create or REPLACE the one hidden working sequence owned by scan project `projectId` (same asset id every time, so the
   * project's Media In keeps pointing at it; the player re-renders). Hidden from `library.list()`, survives reloads, deleted
   * when the project is dropped for good. `options.name` is the asset's name.
   */
  attach(projectId: string, result: ScanResult, options: ScanCommitOptions): Promise<AssetInfo>;
  /** Rebuild a stored session: analyse the photos, then re-apply the manual corrections in photo order. */
  restore(session: ScanSession): Promise<ScanResult>;
}
