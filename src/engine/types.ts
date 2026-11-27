/**
 * RSMPS engine v2 — the contract.
 *
 * A node is a pure function of (its params, the values on its input sockets,
 * the frame context). It knows nothing else: not the graph, not other nodes,
 * not the UI. Everything a node needs arrives through `ctx`.
 *
 * Read docs/ENGINE.md before adding a node.
 */
import type { AudioKernel } from './audio/types';

/* ----------------------------------------------------------------------- */
/* Sockets and values                                                       */
/* ----------------------------------------------------------------------- */

export type SocketType = 'image' | 'mask' | 'palette' | 'number' | 'color' | 'vector' | 'regions' | 'camera' | 'material' | 'sdf' | 'audio' | 'midi';

/**
 * A GPU image. RGBA8, sRGB-encoded, PREMULTIPLIED alpha, row 0 = top.
 * `unit` = how many texels one "unit pixel" covers in this image; the kernel
 * uses it to convert `unit: 'px'` params so the same graph looks the same on
 * a 480p and a 4K source (and on a half-resolution playback proxy).
 */
export interface ImageValue {
  kind: 'image';
  texture: GPUTexture;
  width: number;
  height: number;
  unit: number;
  /**
   * Art-grid marker (docs/ENGINE.md rule 28): this image is a crisp (nearest) upscale of an art grid, one art pixel covers
   * `cell` texels (>= 1, may be fractional). Absent or 1 = a normal image. Per-pixel pixel-art nodes work on the grid.
   */
  cell?: number;
}

/** A coverage mask. Same storage as an image; coverage lives in `.r` (rgb = coverage, a = 1). */
export interface MaskValue {
  kind: 'mask';
  texture: GPUTexture;
  width: number;
  height: number;
  unit: number;
}

/** An ordered list of colours, each [r, g, b] in 0..1 sRGB. */
export interface PaletteValue {
  kind: 'palette';
  colors: [number, number, number][];
}

/** One detected / tracked area of the frame. */
export interface Region {
  /** Stable across frames when a tracker assigned it; otherwise the index within the frame. */
  id: number;
  /** Class or tag, e.g. "blob", "red", "person". */
  label: string;
  /** Confidence 0..1. */
  score: number;
  /** Bounding box in normalised frame coordinates: [x0, y0, x1, y1], (0,0) = top-left. */
  box: [number, number, number, number];
}

/** Detected regions of the current frame. Turn them into a mask to drive any maskable effect. */
export interface RegionsValue {
  kind: 'regions';
  items: Region[];
}

/** A virtual camera for 3D generator nodes. Each 3D object can take its own camera. */
export interface CameraValue {
  kind: 'camera';
  /** How rays leave the camera. 'panoramic' = full 360° equirectangular; 'cylindrical' = 360° around, straight verticals. */
  projection: 'orthographic' | 'perspective' | 'fisheye' | 'panoramic' | 'cylindrical';
  /** Field of view in degrees (perspective, fisheye; vertical extent for cylindrical). */
  fov: number;
  /** Visible height in scene units for orthographic. */
  orthoSize: number;
  /** Camera position in scene units (objects sit around the origin, roughly unit-sized). */
  position: [number, number, number];
  /** Point the camera looks at. */
  target: [number, number, number];
  /** Roll around the view axis, degrees. */
  roll: number;
  /** Lens shift in normalised frame units (moves the picture without changing perspective). */
  shift: [number, number];
  /**
   * Where the real floor is, as a y in scene units (y up), when the camera knows (World AR Camera: the surface the object was placed
   * on, lift and height included). 3D nodes with Ground shadow put their floor here instead of at the object's lowest point.
   */
  ground?: number;
  /**
   * The light of the room, when the camera knows it (World AR Camera with light estimation). Angles are those of the 3D nodes'
   * Light azimuth / Light height; `ambient` 0..1 is the share of the light that comes from everywhere; `strength` is the brightness of
   * the main light (1 = as bright as the lamp the nodes assume). 3D nodes use it unless their "Light from camera" is off.
   */
  light?: { azimuth: number; elevation: number; ambient: number; strength: number };
}

/**
 * A surface material for the 3D nodes: plain numbers plus optional pictures. Made by the Material node, read by 3D Object,
 * Image to 3D and SDF 3D (docs/ENGINE.md, pending rules). `a`..`f` are packed uniform vectors, see lib/gen-material.ts.
 * Its pictures are the Material node's own inputs; the kernel keeps them alive as long as the material's cache entry lives.
 */
export interface MaterialValue {
  kind: 'material';
  /** Shading model: lambert (matte, clay), pbr (plastic, metal), glass, toon, emissive, hologram, matcap, wire. */
  model: 'lambert' | 'pbr' | 'glass' | 'toon' | 'emissive' | 'hologram' | 'matcap' | 'wire';
  /** Structure flags that select the generated shader. */
  flags: { clay: boolean; triplanar: boolean; emission: boolean; rim: boolean; sky: boolean; envAmbient: boolean };
  base: [number, number, number];
  a: [number, number, number, number];
  b: [number, number, number, number];
  c: [number, number, number, number];
  d: [number, number, number, number];
  e: [number, number, number, number];
  f: [number, number, number, number];
  skyTop: [number, number, number];
  skyHorizon: [number, number, number];
  skyBottom: [number, number, number];
  maps: { colorMap: ImageValue | null; normalMap: ImageValue | null; roughnessMap: ImageValue | null; emissionMap: ImageValue | null; matcap: ImageValue | null; environment: ImageValue | null; background: ImageValue | null };
}

/** Straight (non-premultiplied) sRGB colour, 0..1. */
export type ColorValue = [number, number, number, number];

/**
 * Three numbers on one wire: [x, y, z]. A plain bundle of numbers with no unit of its own (a position, a rotation in degrees, a
 * scale...): the socket it arrives at gives it meaning. 2D uses read x and y. See "Vector sockets" in docs/ENGINE.md.
 */
export type VectorValue = [number, number, number];

/**
 * A signed-distance scene as pure data (docs/ENGINE.md, "SDF scenes"): a tree of shapes, combines, moves and modifiers whose numbers are
 * already resolved for the current frame. Made by SDF Shape / Combine / Move / Modify, rendered by SDF Scene. Ids are FLAT PATHS of the node
 * that produced each tree node (`scene/shape`, `outer/inner/shape`), so a picked surface point can be mapped back to a node.
 * The only non-data part is an optional picture (for Extruded picture shapes): the kernel keeps it alive like a material's pictures.
 * Helpers: lib/sdf-scene.ts.
 */
export type SdfShapeKind = 'sphere' | 'box' | 'rbox' | 'torus' | 'capsule' | 'cylinder' | 'cone' | 'plane' | 'octa' | 'image2d';
export type SdfModKind = 'mirror' | 'repeat' | 'round' | 'shell' | 'twist' | 'bend' | 'displace';
export type Vec3 = [number, number, number];
export interface SdfShapeNode {
  t: 'shape';
  id: string;
  shape: SdfShapeKind;
  /** Position, scene units. */
  pos: Vec3;
  /** Rotation about x, y, z in degrees (Rz * Ry * Rx, as 3D Object). */
  rot: Vec3;
  /** Half sizes, `lib/sdf-prims.ts` (a = radius or half width, b = half height or tube radius, c = half depth). */
  size: Vec3;
  /** Uniform scale about the shape's own position. */
  scale: number;
  /** Straight sRGB 0..1. */
  color: Vec3;
}
export interface SdfCombineNode {
  t: 'combine';
  id: string;
  op: 'union' | 'subtract' | 'intersect';
  /** Blend radius, 0 = hard. Subtract removes every later child from the first. */
  smooth: number;
  children: SdfNode[];
}
export interface SdfMoveNode {
  t: 'move';
  id: string;
  pos: Vec3;
  rot: Vec3;
  scale: number;
  /** Row-major 3 x 3 rotation that replaces `rot` when present (a spinning scene). */
  matrix?: number[];
  child: SdfNode;
}
export interface SdfModNode {
  t: 'mod';
  id: string;
  mod: SdfModKind;
  /** mirror: which axes. */
  axes: [boolean, boolean, boolean];
  /** twist / bend: the axis (0 x, 1 y, 2 z). */
  axis: 0 | 1 | 2;
  /** Eight numbers; meaning per kind in lib/sdf-scene.ts (`MOD_NUMBERS`). */
  v: number[];
  child: SdfNode;
}
export type SdfNode = SdfShapeNode | SdfCombineNode | SdfMoveNode | SdfModNode;
export interface SdfValue {
  kind: 'sdf';
  /** null = an empty scene. */
  root: SdfNode | null;
  /** The picture Extruded picture shapes use (one per scene). */
  picture?: ImageValue | null;
}

/** Audio and MIDI values live in the stream domain; see src/engine/audio/types.ts. */
export interface AudioValue {
  kind: 'audio';
  node: unknown;
}
export interface MidiValue {
  kind: 'midi';
  bus: unknown;
}

export interface SocketValueMap {
  image: ImageValue;
  mask: MaskValue;
  palette: PaletteValue;
  number: number;
  color: ColorValue;
  vector: VectorValue;
  audio: AudioValue;
  regions: RegionsValue;
  camera: CameraValue;
  material: MaterialValue;
  sdf: SdfValue;
  midi: MidiValue;
}
export type Value = SocketValueMap[SocketType];

/* ----------------------------------------------------------------------- */
/* Node definition                                                          */
/* ----------------------------------------------------------------------- */

export interface InputDef {
  type: SocketType;
  label?: string;
  /** If true and nothing (or null) arrives, the kernel skips the node: `render` never sees null here. */
  required?: boolean;
  /** Accept several wires; the value is an array in wire order. */
  multi?: boolean;
  /**
   * For a `multi` picture input that is a layer stack: show the wires like a layer panel, the LAST wire (drawn on top) first
   * and the first wire (the bottom) last, with "Top" / "Bottom" labels. Presentation only: the wire order stays as it is.
   */
  order?: 'top-first';
  /** What the first wire does, shown after its row label: "Bottom · note" with `order: 'top-first'`, else "1 · note". E.g. "sets size". */
  firstNote?: string;
  /** Text of the drop row of a `multi` input, instead of the default ('+ add on top' / '+ drop wire here'). E.g. '+ add shape'. */
  addLabel?: string;
  /**
   * Do not evaluate this input automatically: `ctx.in` holds null and the node fetches it with `ctx.pull`.
   * Use it for analysis that should run ONCE on a fixed frame (e.g. extracting a palette from the first frame of a
   * video): the node is then not re-rendered when the input changes from frame to frame, only when the upstream
   * nodes are edited. `required` on a lazy input means "must be wired".
   */
  lazy?: boolean;
}

export interface OutputDef {
  type: SocketType;
  label?: string;
}

/**
 * Units for number params. They drive both the inspector label and kernel conversion.
 *  - 'px'    lengths. Authored in unit pixels; `render` receives them ALREADY in texels
 *            of the node's reference image. Never scale them yourself.
 *  - 'norm'  0..1 fraction of the image (positions, sizes).
 *  - 'deg', '%', 's', 'hz', 'db', 'st' (semitones)  display only.
 *  - 'cycles' whole repetitions per loop. Use with `ctx.time.phase` so animations loop by construction.
 */
export type ParamUnit = 'px' | 'norm' | 'deg' | '%' | 's' | 'hz' | 'db' | 'st' | 'cycles';

interface ParamBase {
  label?: string;
  /** Collapsible inspector section. */
  group?: string;
  /** Hide the control unless this returns true. */
  visibleIf?: (params: Record<string, unknown>) => boolean;
  hint?: string;
  /**
   * The value for a node that has NO value stored for this param, where that must differ from `default`. A new node gets every
   * `default` written into it (`addNode`), so a missing value means the node was saved before the param existed. Set it when a new
   * param's default would change what such old nodes do (a new look that is on by default): old projects then stay as they were.
   */
  absent?: unknown;
}
export interface NumberParam extends ParamBase {
  type: 'number';
  default: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: ParamUnit;
  /** Round to an integer. */
  integer?: boolean;
  /**
   * Largest value that is safe and sensible in normal use (sliders stop here). Typing a larger value is allowed
   * up to `max`, but the UI first asks "did you mean that?" because it may be very slow or exhaust memory.
   * Set it on every param whose cost grows with its value (resolutions, counts, iterations, radii).
   */
  softMax?: number;
  /**
   * How much of the value one long drag across the field (about 400 px) should cover, when that is far less than `min`..`max`.
   * Move X of a 3D object may go from -20 to 20, but the picture only shows about 3 units: without this a finger-width of drag
   * throws the object out of view. UI only: it changes no value and no limit.
   */
  scrubSpan?: number;
}
export interface BoolParam extends ParamBase {
  type: 'bool';
  default: boolean;
}
export interface EnumParam<T extends string = string> extends ParamBase {
  type: 'enum';
  default: T;
  options: readonly { value: T; label: string }[];
}
export interface ColorParam extends ParamBase {
  type: 'color';
  default: ColorValue;
}
export interface StringParam extends ParamBase {
  type: 'string';
  default: string;
  /**
   * What the text is, so the UI can offer the right picker instead of a bare text box.
   *  - 'font': a font family name: shown as a dropdown of available fonts, each previewed in itself, still typeable.
   *  - 'code': source code (WGSL): monospace editor that applies on blur / Ctrl+Enter, with an optional examples menu.
   */
  kind?: 'font' | 'code';
  /** For kind 'code': ready-made snippets offered in the editor's Examples menu. */
  examples?: readonly { label: string; code: string }[];
  multiline?: boolean;
}
export interface Vec2Param extends ParamBase {
  type: 'vec2';
  /** The two numbers are the start and end of a range (start ≤ end): the UI shows one bar with two handles. */
  range?: boolean;
  default: [number, number];
  unit?: ParamUnit;
  min?: number;
  max?: number;
  step?: number;
}
/** A list of colours edited with the palette editor. */
export interface PaletteParam extends ParamBase {
  type: 'palette';
  default: [number, number, number][];
}
/** Asset ids chosen by the user (files, folders, recordings). Resolved through `ctx.host`. */
export interface AssetsParam extends ParamBase {
  type: 'assets';
  default: string[];
  accept: 'image-video' | 'audio' | 'midi' | 'model' | 'lut' | 'splat' | 'subtitles' | 'any';
  /** false = the node uses the whole list as ONE set (Splat from Video's photos), so it does not make the project a batch of that many items. */
  batch?: boolean;
}
/** A hardware device chosen from a live list (system microphones, MIDI inputs). Value = device id; '' = system default / all. */
export interface DeviceParam extends ParamBase {
  type: 'device';
  default: string;
  device: 'audio-input' | 'midi-input' | 'video-input';
}
/** One key of an animation curve. */
export interface CurveKey {
  /** Position in the loop, 0..1 (phase), so curves scale with the project duration. */
  t: number;
  /** Value at the key. */
  v: number;
  /** How the segment AFTER this key is interpolated. */
  interp: 'linear' | 'hold' | 'smooth' | 'bezier';
  /** Bezier handles as offsets [dt, dv] from the key (used when interp = 'bezier'; incoming handle belongs to this key's left side). */
  in?: [number, number];
  out?: [number, number];
}
/** A keyframed curve edited with the curve editor. */
export interface CurveValue {
  keys: CurveKey[];
}
export interface CurveParam extends ParamBase {
  type: 'curve';
  default: CurveValue;
  /** Suggested vertical range of the editor. */
  min?: number;
  max?: number;
}
/** Free-form JSON for nodes with a custom inspector (strokes, curves…). Avoid when a typed param works. */
export interface JsonParam extends ParamBase {
  type: 'json';
  default: unknown;
}

export type ParamDef =
  | NumberParam
  | BoolParam
  | EnumParam
  | ColorParam
  | StringParam
  | Vec2Param
  | PaletteParam
  | AssetsParam
  | DeviceParam
  | CurveParam
  | JsonParam;

export type ParamValue<P extends ParamDef> = P extends NumberParam
  ? number
  : P extends BoolParam
    ? boolean
    : P extends EnumParam<infer T>
      ? T
      : P extends ColorParam
        ? ColorValue
        : P extends StringParam
          ? string
          : P extends Vec2Param
            ? [number, number]
            : P extends PaletteParam
              ? [number, number, number][]
              : P extends AssetsParam
                ? string[]
                : P extends DeviceParam
                  ? string
                  : P extends CurveParam
                    ? CurveValue
                    : unknown;

export type ParamSchema = Record<string, ParamDef>;
export type InputSchema = Record<string, InputDef>;
export type OutputSchema = Record<string, OutputDef>;

export type ParamsOf<P extends ParamSchema> = { [K in keyof P]: ParamValue<P[K]> };

type InValue<I extends InputDef> = I extends { multi: true }
  ? SocketValueMap[I['type']][]
  : I extends { required: true }
    ? SocketValueMap[I['type']]
    : SocketValueMap[I['type']] | null;
export type InputsOf<I extends InputSchema> = { [K in keyof I]: InValue<I[K]> };
export type OutputsOf<O extends OutputSchema> = { [K in keyof O]?: SocketValueMap[O[K]['type']] | null };

/** Host capabilities a node may depend on. See `NodeDef.requires`. 'desktop' = the packaged desktop app (it can run add-on programs). */
export type Capability = 'local-server' | 'desktop';

/** Node families, as in Blender's Add menu. The UI groups and colours nodes by category. */
export const CATEGORIES = {
  input: { title: 'Input', color: '#5b8def' },
  output: { title: 'Output', color: '#e0e0e0' },
  generate: { title: 'Generate', color: '#c77dff' },
  color: { title: 'Color', color: '#f2c14e' },
  filter: { title: 'Filter', color: '#f78154' },
  stylize: { title: 'Stylize', color: '#ef6f9c' },
  pixel: { title: 'Pixel Art', color: '#4dd6a8' },
  transform: { title: 'Transform', color: '#58c4dd' },
  composite: { title: 'Composite', color: '#8fd14f' },
  mask: { title: 'Mask', color: '#9aa7b1' },
  track: { title: 'Detect & Track', color: '#e85d75' },
  time: { title: 'Time', color: '#b08968' },
  math: { title: 'Math & Utility', color: '#7f8c9b' },
  'audio-source': { title: 'Audio Source', color: '#2ec4b6' },
  sdf: { title: 'SDF Modelling', color: '#7ad0b5' },
  'audio-fx': { title: 'Audio Effects', color: '#20a39e' },
  synth: { title: 'Synth & MIDI', color: '#ff9f1c' },
} as const;
export type Category = keyof typeof CATEGORIES;

/* ----------------------------------------------------------------------- */
/* Contexts                                                                 */
/* ----------------------------------------------------------------------- */

/** What a node summary may know about the project clock (see lib/loop-snap.ts): lets it say "speed 2 → 3 to loop". */
export interface LoopClockInfo {
  loop: boolean;
  /** Loop length in frames. */
  frames: number;
  fps: number;
}

/** Frame clock. Reading any field marks the node time-dependent (the kernel re-renders it per frame). */
export interface TimeInfo {
  /** Seconds since project start. */
  readonly seconds: number;
  /** Integer frame index. */
  readonly frame: number;
  readonly fps: number;
  /** Project duration in seconds. */
  readonly duration: number;
  /**
   * 0..1 position inside the project loop (frame / totalFrames). ALWAYS animate from
   * `phase` with whole `cycles` (e.g. `sin(phase * TAU * cycles)`) so the result loops seamlessly.
   */
  readonly phase: number;
  /** True when the project is in loop mode. */
  readonly loop: boolean;
}

export interface CanvasInfo {
  /** Project frame size in texels at the current proxy scale. Generators without an image input render at this size. */
  width: number;
  height: number;
  unit: number;
}

export interface PassTextures {
  /** null/undefined entries are skipped (handy for optional inputs: guard the WGSL that uses them). */
  [name: string]: ImageValue | MaskValue | { texture: GPUTexture } | null | undefined;
}
export type UniformValue = number | boolean | readonly number[];

export interface PassOptions {
  label?: string;
  /** Output size. Pass an image to copy its size and unit. */
  size: { width: number; height: number; unit?: number };
  /** Bound as `texture_2d<f32>` globals under these names. Sample with `smp` (linear) or `smpNearest`. */
  textures?: PassTextures;
  /** Exposed as `u.<name>` (number → f32, bool → f32 0/1, arrays of 2/3/4 → vecNf). `u.size` (output size) is always there. */
  uniforms?: Record<string, UniformValue>;
  /**
   * WGSL that defines `fn fx(uv: vec2f, px: vec2f) -> vec4f`.
   * uv = 0..1 with (0,0) top-left; px = output texel centre coordinates. Return PREMULTIPLIED rgba.
   * A prelude with helpers is available: see src/engine/gpu/prelude.ts.
   */
  wgsl: string;
  /** 'rgba16float' for intermediate data that needs range/precision. Default 'rgba8unorm'. */
  format?: 'rgba8unorm' | 'rgba16float';
}

/** GPU services handed to a node. Textures created here are tracked and recycled by the kernel. */
export interface NodeGpu {
  readonly device: GPUDevice;
  /** Run one full-screen fragment pass and get the result as an image. The workhorse. */
  pass(options: PassOptions): ImageValue;
  /** Like `pass`, typed as a mask. */
  passMask(options: PassOptions): MaskValue;
  /** A blank pooled texture wrapped as an image (for compute shaders or copies). */
  alloc(width: number, height: number, unit: number, format?: 'rgba8unorm' | 'rgba16float'): ImageValue;
  /** Upload CPU pixels. `straight: true` (default) = data is non-premultiplied RGBA and gets premultiplied. */
  upload(data: Uint8Array | Uint8ClampedArray, width: number, height: number, unit: number, straight?: boolean): ImageValue;
  /** Read back to CPU as straight RGBA8 (premultiplication undone by default). SLOW: use only for analysis on small images. */
  read(image: ImageValue | MaskValue, straight?: boolean): Promise<Uint8ClampedArray>;
  /** Small lookup texture from float data (palettes, kernels, curves). width*height*4 floats, rgba16float, nearest. */
  dataTexture(data: Float32Array, width: number, height: number): { texture: GPUTexture };
  /**
   * Hand a temporary back to the pool NOW (instead of when the node's render ends). Use it in multi-pass loops
   * (`const prev = rec; rec = pass(...rec...); recycle(prev)`): without it every iteration stays alive until the render
   * returns, which turned a 78-pass sort of a 4K image into 5 GB of textures. Only for textures THIS render created and no longer
   * needs (never inputs, never anything you return). Queued GPU work that still reads it is safe.
   */
  recycle(image: { texture: GPUTexture }): void;
  /** Pooled, tracked buffer of at least `size` bytes (COPY_DST is always added). Contents are undefined unless `clear`. Give it back with `releaseScratch`. */
  scratch(size: number, usage: number, label?: string, opts?: { clear?: boolean }): GPUBuffer;
  releaseScratch(buffer: GPUBuffer): void;
  /** Pooled, tracked texture for attachments (multisampled colour, depth). Give it back with `releaseScratchTexture`. */
  scratchTexture(desc: { width: number; height: number; format: GPUTextureFormat; usage: number; sampleCount?: number; label?: string }): GPUTexture;
  releaseScratchTexture(texture: GPUTexture): void;
  /** Cached default view of a texture (never call `texture.createView()` per frame). */
  view(texture: GPUTexture): GPUTextureView;
  /** Compute pipeline from WGSL, cached (bounded) by label + code. */
  computePipeline(label: string, code: string, entryPoint?: string): GPUComputePipeline;
  /** Tracked buffer that the node owns for a long time (vertex/index data of a model). Free it with `destroyBuffer`. */
  createBuffer(desc: GPUBufferDescriptor, category?: string): GPUBuffer;
  destroyBuffer(buffer: GPUBuffer): void;
}

/**
 * System-RAM tier for expensive cached results. The engine stays DOM-free: the IO layer injects an implementation. Pixels are
 * premultiplied RGBA8, row 0 on top; a store may compress them but MUST return exactly what it was given (lossless), because the
 * engine serves them back as if they had just been rendered.
 */
export interface ColdStore {
  put(key: string, pixels: { data: Uint8Array; width: number; height: number }): Promise<boolean> | boolean;
  get(key: string): Promise<{ data: Uint8Array; width: number; height: number } | null>;
  delete(key: string): void;
  has(key: string): boolean;
}

/** Services the application provides. The engine never touches files, the DOM or the network itself. */
export interface Host {
  /** Metadata for an asset id, or null if it is missing. */
  assetInfo(assetId: string): AssetInfo | null;
  /** Decoded frame of an image/video asset at `seconds`, at most `maxSide` texels on the long side (0 = full). */
  assetFrame(assetId: string, seconds: number, maxSide: number): Promise<{ texture: GPUTexture; width: number; height: number } | null>;
  /** Raw bytes of an asset (3D models and other files a node parses itself). Null when missing. */
  assetBytes?(assetId: string): Promise<ArrayBuffer | null>;
  /** Decode encoded image bytes (PNG/JPEG/WebP), e.g. a texture embedded in a model file. Null when not decodable or unavailable. */
  decodeImageBytes?(bytes: ArrayBuffer, mime: string): Promise<{ texture: GPUTexture; width: number; height: number } | null>;
  /** Decoded PCM of an audio asset or a video's sound track (used by the audio engine, not by render nodes). */
  assetAudio?(assetId: string): Promise<{ sampleRate: number; channels: Float32Array[] } | null>;
  /**
   * Latest frame of a live picture source (webcam, network stream). Live-only: returns null when the source is
   * not running or in headless/export runs unless the host recorded it. `maxSide` as in assetFrame.
   * `at`: the project time (seconds) this render is for. Pass `ctx.time.seconds`: when a time node asks for a moment that is
   * not the present, the host keeps the picture it took for that moment, so stop-motion holds work on a live source.
   */
  liveFrame?(source: LiveSource, maxSide: number, at?: number): Promise<{ texture: GPUTexture; width: number; height: number; nativeZoom?: boolean } | null>;
  /**
   * True while this live source cannot run at the moment (the device camera while the AR view owns it). A node that gets true
   * must not ask `liveFrame`: it gives a fully transparent picture of the canvas size instead, so what is merged over it
   * still shows. Remote sources (a phone link, a network address) are never blocked.
   */
  liveBlocked?(source: LiveSource): boolean;
  /** True while a device camera that takes turns with another has not had its first visit yet: the node gives a transparent picture instead of an error. */
  liveWaiting?(source: LiveSource): boolean;
  /**
   * The AR view's camera picture (World AR Camera's Picture output). Calling it also tells the host the picture is in use, so the
   * AR view only copies camera frames while something asks. `session` false = no AR view is open (use the ordinary camera);
   * `session` true with `access` false = the phone does not hand the camera picture over; `frame` null = none arrived yet.
   */
  arCameraFrame?(): { session: boolean; access: boolean; frame: { texture: GPUTexture; width: number; height: number } | null };
  /**
   * Value of a named signal that a stream-domain (audio/MIDI) node publishes, at `seconds`:
   * loudness, pitch, note, gate… This is the bridge that lets sound drive picture parameters.
   * Live it returns the latest measured value; during export, the value analysed from the rendered audio.
   * Returns 0 when unknown.
   */
  signal?(nodeId: string, name: string, seconds: number): number;
  /** Rasterise text to straight RGBA (browser canvas). Optional: missing in headless runs. */
  rasterizeText?(spec: TextSpec): { data: Uint8ClampedArray; width: number; height: number } | null;
  /**
   * Process mode (see `NodeDef.process`): what the scheduler is doing with this node right now ('queued' | 'running' | 'failed'),
   * or null when it is idle. Optional: a host without a scheduler (tests, a plain render) answers null for every node.
   */
  processLive?(nodeId: string): ProcessLive | null;
  /**
   * Gaussian splat reconstruction with external programs (COLMAP + Brush add-ons), desktop app only (`desktop/addons/splat-train.mjs`,
   * client `src/io/splat-train.ts`). Absent in the web version, the CLI and plain tests. Used by the Splat from Video node's process.
   */
  splatTrain?: SplatTrainHost;
}

/** Settings of one reconstruction (fixed choices only: nothing here reaches a command line as free text). */
export interface SplatTrainSettings {
  input: 'video' | 'photos' | 'scan';
  quality: 'draft' | 'normal' | 'high';
  matcher: 'auto' | 'sequential' | 'exhaustive';
  solver: 'auto' | 'incremental' | 'global';
  /** Keep the solved cameras so a re-run with other training settings skips COLMAP. */
  keepPoses: boolean;
  /** With input 'scan': refine the saved camera positions with a bundle adjustment (off: they are used as they are). */
  refine?: boolean;
}

export interface SplatTrainRequest {
  settings: SplatTrainSettings;
  frameCount: number;
  /** Frame `index` (0-based, in time order) as straight RGBA. Called once per frame, in order; the host encodes and sends it. */
  frame(index: number): Promise<{ pixels: Uint8ClampedArray; width: number; height: number }>;
  /**
   * Input 'scan': the saved camera model (COLMAP text, `scan-export.ts`) for the frames as they were sent, given their real pixel sizes
   * (the camera numbers are scaled to them). Called once, after the last frame.
   */
  known?(sizes: { width: number; height: number }[]): { cameras: string; images: string };
  signal: AbortSignal;
  onProgress(fraction: number, note: string): void;
}

export interface SplatTrainOutput {
  /** The trained cloud as Brush wrote it (standard 3DGS .ply, COLMAP's frame). */
  ply: ArrayBuffer;
  /** The solved model (`desktop/addons/splat-train.mjs` `modelJson`): cameras, image poses (world-to-camera), a sample of sparse points, stats. */
  model: { cameras: { id: number; model: string; width: number; height: number; params: number[] }[]; images: { name: string; q: [number, number, number, number]; t: [number, number, number]; cameraId: number }[]; points: number[]; stats: { cameras: number; points: number; parallax: number } };
  report: Record<string, unknown>;
}

export interface SplatTrainHost {
  /** Are the add-ons there? `missing` lists add-on ids ('colmap', 'brush'). */
  status(): Promise<{ available: boolean; missing: string[] }>;
  train(req: SplatTrainRequest): Promise<SplatTrainOutput>;
}

/**
 * What a Webcam node asks of the camera itself (not part of the stream's identity: it is applied to the live track).
 * Ranges the camera defines for itself are 0..1 (0 = its minimum, 1 = its maximum); zoom is x, exposureComp is EV, colorTemp is K, frameRate is fps.
 */
export interface CameraControls {
  frameRate?: number;
  zoom?: number;
  torch?: boolean;
  focus?: 'auto' | 'manual';
  focusDistance?: number;
  exposure?: 'auto' | 'manual';
  exposureTime?: number;
  exposureComp?: number;
  whiteBalance?: 'auto' | 'manual';
  colorTemp?: number;
  iso?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  sharpness?: number;
}

/** A live picture source for `Host.liveFrame`. */
export type LiveSource =
  | { kind: 'camera'; deviceId: string; width?: number; height?: number; facing?: 'user' | 'environment'; controls?: CameraControls; turns?: { clash: 'turns' | 'always' | 'stop'; role: 'auto' | 'main' | 'visited'; every: number; settle: number } }
  | { kind: 'url'; url: string; mode?: 'auto' | 'image' | 'mjpeg' | 'video'; refresh?: number }
  /** A phone streaming its camera through the LAN phone link (QR code). `session` is the pairing token. */
  | { kind: 'phone'; session: string };

export interface AssetInfo {
  id: string;
  name: string;
  kind: 'image' | 'video' | 'audio' | 'midi' | 'model' | 'lut' | 'splat' | 'subtitles';
  width: number;
  height: number;
  duration: number;
  fps: number;
  hasAudio: boolean;
}

export interface TextSpec {
  text: string;
  font: string;
  sizePx: number;
  weight: number;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  maxWidthPx: number;
}

export interface RenderCtx<P extends ParamSchema, I extends InputSchema> {
  /** Resolved params: defaults applied, wired values substituted, 'px' units converted to texels. */
  readonly params: ParamsOf<P>;
  /** Values on the input sockets at the current frame. */
  readonly in: InputsOf<I>;
  readonly gpu: NodeGpu;
  readonly time: TimeInfo;
  readonly canvas: CanvasInfo;
  /** Batch position. Reading it marks the node item-dependent. */
  readonly item: { readonly index: number; readonly count: number };
  readonly host: Host;
  /** 'final' for export, 'preview' for interactive work. Use only to trade quality for speed (iterations, samples). */
  readonly quality: 'preview' | 'final';
  /** Deterministic per-node seed base (stable across frames and sessions). */
  readonly nodeId: string;
  /** The node's full flat path id (`group/inner`). Reading it makes the result depend on the path (two copies of a node no longer share a cache entry). */
  readonly path: string;
  /** Playback proxy scale (1 = full resolution). Only source nodes need it, to decode smaller frames. */
  readonly proxy: number;
  /** Texels per unit pixel for a fresh image of this size. Source and generator nodes use it to stamp `unit`. */
  unitFor(width: number, height: number): number;
  /** Convert a length in unit pixels to texels of `ref` (rarely needed: 'px' params are already converted). */
  px(unitPixels: number, ref?: { unit: number }): number;
  /**
   * Re-evaluate an input at another time (seconds), or fetch a `lazy` input (omit `at` for the current frame).
   * For temporal nodes (echo, retime, loop cross-fade) and run-once analysis on a fixed frame.
   * `wire` picks one wire of a `multi` input (0 = the first, in wire order; default 0): a lazy multi input is how an editing
   * node evaluates only the sources it actually shows. The result is only valid during this render call.
   */
  pull<K extends keyof I>(input: K, at?: { seconds?: number; wire?: number; proxy?: number }): Promise<SocketValueMap[I[K]['type']] | null>;
  /**
   * The project canvas (width, height, unit) as it is at an absolute proxy factor (1 = full resolution), using the engine's own rounding.
   * With `pull(input, { proxy })`: `proxy` evaluates the input as if the whole evaluation ran at that factor (sources decode that small, lengths
   * follow). It is absolute, not relative to `ctx.proxy`, and clamped to 0.05..1. Cache entries made at a factor are shared by everyone who asks for it.
   */
  canvasAt(proxy: number): CanvasInfo;
  /**
   * Structural signature of everything upstream of an input (node types, stored params, wiring, project settings, frame
   * size). It changes only when the graph is edited, never from frame to frame, and does not evaluate anything. Empty string when
   * the input is not wired. Used by the Cache / Bake node to tell whether its baked sequence is still fresh.
   */
  inputSignature(input: keyof I): string;
  /**
   * Is this output used? True when a wire leaves it or it is the output being evaluated. Only meaningful for outputs listed in
   * `NodeDef.optionalOutputs` (the kernel then keys the cache by the answer); for any other output it is always true.
   */
  wants(output: string): boolean;
  /**
   * True when what is wired to `input` changes with time (so frames differ), false when it is the same picture on every
   * frame (a still, a generator without motion). Valid for a normal input after evaluation and for a `lazy` input after its
   * first `pull`. A temporal node uses it to skip work: a static input needs ONE pull, not one per slice.
   */
  inputVaries(input: keyof I): boolean;
  /**
   * This node's own first image output for the previous frame (frame - 1), when the engine still holds it and it was produced
   * by the same node, params and upstream graph at the same size/quality; otherwise null. Only offered to nodes with
   * `usesPrevious: true`. The node must produce identical pixels whether or not it is given (the fold is the fallback).
   * Reading it makes the node time-dependent. The result is only valid during this render call.
   * `wrap`: with the project's Loop on, frame 0 asks for the LAST frame of the loop (a node whose value is periodic by construction can then
   * continue across the seam). Without it frame 0 never has a previous one (the default: other nodes count on that).
   * `carry`: a second hidden picture the node returned under the output name `carry` last frame (see `usesPrevious`): extra state of the
   * recursion that is not an output. null when the previous frame has none.
   */
  previous(opts?: { wrap?: boolean; carry?: boolean }): ImageValue | null;
  /** Process mode: only present on nodes whose definition has `process`. See `ProcessView`. */
  readonly process?: ProcessView;
}

/* ----------------------------------------------------------------------- */
/* Process mode                                                             */
/* ----------------------------------------------------------------------- */

/**
 * Where a node's process stands. Part of the node's cache key (together with the signature of the stored result), so finishing a job
 * invalidates exactly this node and what is downstream of it. Progress is NOT part of it.
 *  - none     never run (or cleared)
 *  - queued   waiting in the scheduler
 *  - running  the job is running (a previous result, if any, may still be served per the node's rules)
 *  - done     a result exists, its data is stored and it was made for the current params and upstream graph
 *  - stale    a result exists but params or the graph before the node changed since: kept and served per `standIn`, never re-run by itself
 *  - failed   the last job failed or was cancelled by an error (the message is in `ProcessLive.error`); not persisted
 *  - missing  a result is referenced but its stored data is gone (cleared storage, another machine)
 */
export type ProcessState = 'none' | 'queued' | 'running' | 'done' | 'stale' | 'failed' | 'missing';

/** What the node shows until its process is done. */
export type ProcessStandIn = 'bypass' | 'preview' | 'last' | 'placeholder';

/**
 * Does an export need this process to be done?
 *  - 'always'   yes: the stand-in is only an approximation (default)
 *  - 'once-run' only after the user has run it once (a result is referenced): an export must then not fall back to the stand-in
 *  - 'never'    the stand-in is exactly what the node computes anyway (Cache / Bake: live pass-through)
 */
export type ProcessRequired = 'always' | 'once-run' | 'never';

/** One thing a process stored. `id` is the stored asset (the same store as bakes). */
export interface ProcessItemRef {
  kind: 'sequence' | 'blob' | 'array';
  id: string;
  bytes: number;
  /** sequence */
  frames?: number;
  fps?: number;
  width?: number;
  height?: number;
  /** blob / array */
  mime?: string;
  /** array: element type and count */
  dtype?: 'f32' | 'f64' | 'i32' | 'u32' | 'i16' | 'u16' | 'i8' | 'u8';
  length?: number;
}

/** The handle of a finished process: written into the node's params, so it is saved with the project and used by exports. */
export interface ProcessResult {
  /** `ProcessDef.signature(...)` at the time the job started: compared with the current one to detect `stale`. */
  signature: string;
  items: Record<string, ProcessItemRef>;
  /** Small JSON the node wants back (frame size, quality, item...). */
  meta: Record<string, unknown>;
  bytes: number;
  createdAt: number;
  /** How long the job took. */
  seconds: number;
}

/** What the scheduler reports to the engine for a node that is not idle. */
export interface ProcessLive {
  state: 'queued' | 'running' | 'failed';
  /** 0..1. Never part of a cache key. */
  progress: number;
  note?: string;
  error?: string;
}

export type ProcessArray = Float32Array | Float64Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Int8Array | Uint8Array;

/** What `render` sees as `ctx.process` (only on nodes that declare `process`). */
export interface ProcessView {
  state: ProcessState;
  /** The stored result, also when it is stale (so a `last` stand-in can serve it); null when there is none or its data is missing. */
  result: ProcessResult | null;
  /** The stored data may be served: state 'done', or 'stale'/'running' with a result when `standIn` is 'last'. */
  servable: boolean;
  /** Decoded frame `index` of a stored sequence (`maxSide` as in `Host.assetFrame`; 0 = full). */
  frame(name: string, index: number, maxSide?: number): Promise<{ texture: GPUTexture; width: number; height: number } | null>;
  /** Stored bytes of a blob or array item. */
  bytes(name: string): Promise<ArrayBuffer | null>;
  /** A stored blob parsed as JSON (null when absent or not JSON). Memoised per result. */
  json<T = unknown>(name: string): Promise<T | null>;
  /** A stored typed array. */
  array(name: string): Promise<ProcessArray | null>;
  /**
   * The kernel's stand-in outputs: 'placeholder' = a striped "processing" card (one pass, canvas-sized, cached with the node);
   * every other mode = the first image / mask input passed through (a lazy input is pulled). `preview` and `last` nodes call it as
   * their fallback and normally do something better first.
   */
  standIn(): Promise<Record<string, Value | null>>;
}

/** GPU services of a job: read pictures back. Pulled pictures stay valid until `release()`. */
export interface ProcessGpu {
  readonly device: GPUDevice;
  read(image: ImageValue | MaskValue, straight?: boolean): Promise<Uint8ClampedArray>;
}

export interface ProcessPull {
  value: Value | null;
  errors: Map<string, string>;
  /** Give the picture back. Always call it (the scheduler also does when the job ends). */
  release(): void;
}

/** Everything a process job gets. Pure data and functions: no DOM, no UI. */
export interface ProcessCtx<P extends ParamSchema = ParamSchema> {
  /** Resolved params (defaults applied; 'px' lengths in unit pixels, NOT texels: a job has no reference image). */
  readonly params: ParamsOf<P>;
  /** Options of this run (the Bake quality...), chosen by whoever started it. */
  readonly options: Record<string, unknown>;
  readonly nodeId: string;
  /** Project clock. */
  readonly fps: number;
  readonly frames: number;
  readonly duration: number;
  readonly loop: boolean;
  /** Frame size at full resolution. */
  readonly canvas: { width: number; height: number };
  /** Batch item this run is for. */
  readonly item: { index: number; count: number; /** The picture feeding the node can differ between batch items (a Media In with several files, an Item node). */ dependent: boolean };
  /** `ProcessDef.signature(...)` for the graph as it is now. Stored in the result by the scheduler. */
  readonly signature: string;
  readonly host: Host;
  readonly gpu: ProcessGpu;
  readonly signal: AbortSignal;
  /** Report progress (0..1). UI only: never invalidates a cache. `detail` is free-form numbers for panels (frame, frames, bytes). */
  progress(fraction: number, note?: string, detail?: Record<string, number>): void;
  /** Call between units of work: lets the UI breathe and waits while the user plays back or drags (the scheduler decides). Throws AbortError when cancelled. */
  yield(): Promise<void>;
  /**
   * Evaluate what is wired to input `input` of this node at any time, at a chosen size and quality (defaults: frame 0, full size, 'final').
   * `frame` or `seconds` picks the time; `wire` picks one wire of a multi input; `item` picks the BATCH ITEM (default: the item the job runs for),
   * so a job can evaluate the wired chain for every item of the set (Batch Palette, "every batch item"). Process jobs only: a render never sees other items.
   */
  pull(input: string, at?: { frame?: number; seconds?: number; wire?: number; item?: number; proxy?: number; quality?: 'preview' | 'final' }): Promise<ProcessPull>;
  /**
   * Evaluate one of THIS node's own outputs live, ignoring its stored result (a group bakes its outputs this way). Same options as `pull`.
   * Present when the host supports it (the app and the process tests do).
   */
  pullOutput?(output: string, at?: { frame?: number; seconds?: number; item?: number; proxy?: number; quality?: 'preview' | 'final' }): Promise<ProcessPull>;
  /** Encode a pulled picture ('lossless' = PNG, 'compressed' = high-quality WebP). */
  encodeImage(image: { texture: GPUTexture; width: number; height: number }, quality: 'lossless' | 'compressed'): Promise<Blob>;
  /**
   * Write results. Everything is STAGED and only becomes visible when `run` resolves, so a cancelled or failed job changes nothing and
   * the previous result stays. Same store as bakes.
   */
  readonly store: {
    sequence(name: string, frames: Blob[], opts: { fps: number; width: number; height: number; unit?: number }): void;
    blob(name: string, data: Blob | Uint8Array | ArrayBuffer | string, mime?: string): void;
    json(name: string, value: unknown): void;
    array(name: string, data: ProcessArray): void;
    /** Bytes staged so far. */
    readonly bytes: number;
  };
}

/** What `run` hands back: the scheduler builds the `ProcessResult` (signature, refs, size, time) from it and the staged items. */
export interface ProcessOutput {
  meta?: Record<string, unknown>;
}

export interface ProcessDef<P extends ParamSchema = ParamSchema> {
  /** Button / badge title: "Bake", "Analyse clip". */
  title: string;
  /** Verb phrase for the inspector, e.g. "Analyse the whole clip once". */
  description?: string;
  standIn: ProcessStandIn;
  /** Does an export need it? Default 'always'. */
  required?: ProcessRequired;
  /** Start by itself when the node becomes stale or is new. Default false: the user presses Process. */
  auto?: boolean;
  /** One GPU-heavy job runs at a time (default true). Set false for jobs that only do CPU work. */
  gpu?: boolean;
  /** The long job. Must be deterministic in what it stores. */
  run(job: ProcessCtx<P>): Promise<ProcessOutput | void>;
  /**
   * Identity of what the result depends on: a string from the node's params and the structural signature of everything wired to each
   * input (`inputSignatures[inputName]`, the same string `ctx.inputSignature` gives; '' when unwired). Params that do not change the
   * result (display options) must be left out. Pure; called every frame the node renders, keep it cheap.
   */
  signature(params: ParamsOf<P>, inputSignatures: Record<string, string>): string;
  /** Cheap estimate for the panel before the user commits. */
  estimate?(params: ParamsOf<P>, project: ProjectSettings): { frames?: number; bytes?: number; note?: string };
  /**
   * Where the result handle lives in the node's params. Default: the reserved param `__process` (JSON). A node that stored its handle
   * in its own params before process mode (Cache / Bake: `baked*`) maps them here, so old projects keep working.
   */
  handle?: {
    read(params: Record<string, unknown>): ProcessResult | null;
    write(result: ProcessResult): Record<string, unknown>;
    clear(): Record<string, unknown>;
  };
}

export interface NodeDef<
  P extends ParamSchema = ParamSchema,
  I extends InputSchema = InputSchema,
  O extends OutputSchema = OutputSchema,
> {
  /** Unique, stable, kebab-case, namespaced for plugins: 'blur', 'myplugin/glitch'. Saved in graph files. */
  id: string;
  title: string;
  category: Category;
  description: string;
  /** Extra search words. */
  keywords?: string[];
  inputs: I;
  outputs: O;
  params: P;
  /** Frame-domain implementation (images, masks, palettes, numbers). */
  render?: (ctx: RenderCtx<P, I>) => OutputsOf<O> | Promise<OutputsOf<O>>;
  /** Stream-domain implementation (audio, MIDI). See src/engine/audio/types.ts. */
  audio?: AudioKernel;
  /** One line shown on the node body, e.g. "Bayer 8×8 · 16 colours". */
  /** `wired` = names of this node's inputs and param sockets that currently have a wire (when the caller knows). `clock` = the project's loop switch, length and frame rate (when the caller knows). */
  summary?: (params: ParamsOf<P>, wired?: ReadonlySet<string>, clock?: LoopClockInfo) => string;
  /**
   * Display only: a short word appended to the title where the node's name is shown ("SDF Shape" + "Torus"). Never used for ids, search or
   * lookups. `assetName` resolves a Media library asset id to its file name (undefined when it is not there). Null/empty = no suffix.
   */
  titleSuffix?: (params: ParamsOf<P>, lookup: { assetName: (id: string) => string | undefined }) => string | null;
  /**
   * The node accepts notes played by the user. While it is selected, the UI maps the computer keyboard
   * (and an on-screen piano) to MIDI notes and sends them to it.
   */
  playable?: boolean;
  /**
   * Things the node needs from where the app is running. If the host lacks one, the node still appears but the UI
   * marks it with a clear "only works in a local build" warning (e.g. on the hosted web version).
   *  - 'local-server': needs the app started locally with its own server (`npm run dev:lan`), e.g. the phone link.
   */
  requires?: readonly Capability[];
  /**
   * Outputs that cost extra work (a depth pass) and are only produced when something uses them: ask `ctx.wants(name)`.
   * The cache key includes which of them are wanted, so wiring one later re-renders the node once.
   */
  optionalOutputs?: readonly string[];
  /** Set when `render` does heavy CPU work, so the UI can warn. */
  cpu?: boolean;
  /**
   * Fusion-style effect mask. When true the kernel adds a `mask` input and a `mix` param (0..1) and blends
   * the node's first image output over its first image input for you. Do NOT implement masking/mix yourself.
   * Only valid when output and input have the same size.
   */
  maskable?: boolean;
  /**
   * The node may call `ctx.previous()` (its own output for frame - 1). The engine then indexes this node's results by frame.
   * Such a node may also return an extra image under the reserved name `carry` (not declared in `outputs`, never shown or wired): it is kept
   * with the cache entry and handed back by `ctx.previous({ carry: true })`. Feedback keeps its second window there.
   * Not combinable with `maskable` (the cached output would already be mixed).
   */
  usesPrevious?: boolean;
  /**
   * With `usesPrevious`: the only params that identify the chain of previous frames. Changing any OTHER param keeps the history (the node
   * still gets `ctx.previous()`), instead of starting over. For a node whose history is live state that no later evaluation can rebuild
   * (Sweep 360: toggling Paint to Paused must not wipe the canvas). Absent: every param belongs to the chain, as for Feedback.
   */
  previousKey?: string[];
  /** Keep the node working in saved graphs but leave it out of the add menu (it was folded into another node). */
  hidden?: boolean;
  /**
   * Nodes of one family can be converted into each other in place (the UI shows a "Type" dropdown listing the family).
   * The ids of the families and how their inputs map are described in `src/ui/lib/convert.ts`. e.g. 'combine' = Merge, Mix, Stack, Switch.
   */
  family?: string;
  /**
   * Project length contributed by this node, in seconds, or null when it does not set one. When it returns a number the
   * whole project (playback and export) is exactly that long: `projectLength` is read ONLY by `effectiveDuration` in graph.ts,
   * which the editor store and the CLI apply to `project.duration`. Receives the node's resolved params. Must be pure.
   */
  projectLength?: (params: ParamsOf<P>) => number | null;
  /**
   * Batch items this node creates by itself, from its resolved params (a sprite sheet that hands out one item per cell), or null when it
   * does not set a count (then only the `assets` lists decide). Read ONLY by `batchCount` in graph.ts: the batch size is the largest of
   * every `assets` list and every `batchSize`. Must be pure and cheap (it runs on every edit and when the viewer opens): no GPU, no
   * host, no reading of pictures. A count that needs the picture cannot be known here; keep a visible number param the user fills in.
   * A throw counts as null. The result is floored and clamped to 1..100000.
   */
  batchSize?: (params: ParamsOf<P>) => number | null;
  /**
   * Process mode: the node has a long job (analysis, bake, a model) that runs OUTSIDE the per-frame render path. Until it is done
   * `render` shows a stand-in (`ctx.process`). See docs/ENGINE.md (Pending rules, "Process mode") and src/io/processes.ts.
   */
  process?: ProcessDef<P>;
}

/** Type-erased definition as stored in the registry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyNodeDef = NodeDef<any, any, any>;

/* ----------------------------------------------------------------------- */
/* Graph document (what gets saved)                                         */
/* ----------------------------------------------------------------------- */

export interface ProjectSettings {
  /** Canvas for generators and the default export size. */
  width: number;
  height: number;
  fps: number;
  /** Seconds. */
  duration: number;
  /** One-click looping: every built-in animator repeats exactly over `duration`. */
  loop: boolean;
  /**
   * 'relative' (default): 1 unit pixel = 1 texel on an image whose short side is `referenceSide`.
   *   Effects scale with the media, so mixed-resolution batches match.
   * 'absolute': 1 unit pixel = 1 texel always (native pixel-art work).
   */
  lengthMode: 'relative' | 'absolute';
  referenceSide: number;
}

export interface NodeInstance {
  id: string;
  type: string;
  x: number;
  y: number;
  params: Record<string, unknown>;
  bypass?: boolean;
  label?: string;
  collapsed?: boolean;
  /** Id of a frame (visual grouping box) this node sits in. */
  frame?: string;
}

export interface Edge {
  id: string;
  from: { node: string; port: string };
  to: { node: string; port: string };
}

export interface FrameBox {
  id: string;
  label: string;
  color: string;
  collapsed?: boolean;
}

/** A user-made folder in the media panel. `color` indexes the panel's small accent palette (0 = grey). */
export interface MediaBin {
  id: string;
  name: string;
  color: number;
}

/** How a project sorts its media into bins (UI only; the engine never reads it). Assets are referenced by id and may be gone. */
export interface MediaOrg {
  bins: MediaBin[];
  /** asset id -> bin id; an asset that is not listed is "Unsorted". */
  assign: Record<string, string>;
}

export interface GraphDoc {
  schema: 'rsmps/graph';
  version: 2;
  name: string;
  project: ProjectSettings;
  nodes: NodeInstance[];
  edges: Edge[];
  frames?: FrameBox[];
  /** Media panel bins of this project. */
  media?: MediaOrg;
  /** MIDI learn: controls bound to parameters (see lib/midi-map.ts). Carried through load and save; the engine never reads it. */
  midiMap?: import('./lib/midi-map').MidiMap;
}

export const DEFAULT_PROJECT: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 24,
  duration: 4,
  loop: true,
  lengthMode: 'relative',
  referenceSide: 1080,
};
