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

export type SocketType = 'image' | 'mask' | 'palette' | 'number' | 'color' | 'regions' | 'camera' | 'audio' | 'midi';

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
}

/** Straight (non-premultiplied) sRGB colour, 0..1. */
export type ColorValue = [number, number, number, number];

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
  audio: AudioValue;
  regions: RegionsValue;
  camera: CameraValue;
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
  multiline?: boolean;
}
export interface Vec2Param extends ParamBase {
  type: 'vec2';
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
  accept: 'image-video' | 'audio' | 'midi' | 'any';
}
/** A hardware device chosen from a live list (system microphones, MIDI inputs). Value = device id; '' = system default / all. */
export interface DeviceParam extends ParamBase {
  type: 'device';
  default: string;
  device: 'audio-input' | 'midi-input';
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
  'audio-fx': { title: 'Audio Effects', color: '#20a39e' },
  synth: { title: 'Synth & MIDI', color: '#ff9f1c' },
} as const;
export type Category = keyof typeof CATEGORIES;

/* ----------------------------------------------------------------------- */
/* Contexts                                                                 */
/* ----------------------------------------------------------------------- */

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
}

/** Services the application provides. The engine never touches files, the DOM or the network itself. */
export interface Host {
  /** Metadata for an asset id, or null if it is missing. */
  assetInfo(assetId: string): AssetInfo | null;
  /** Decoded frame of an image/video asset at `seconds`, at most `maxSide` texels on the long side (0 = full). */
  assetFrame(assetId: string, seconds: number, maxSide: number): Promise<{ texture: GPUTexture; width: number; height: number } | null>;
  /** Decoded PCM of an audio asset or a video's sound track (used by the audio engine, not by render nodes). */
  assetAudio?(assetId: string): Promise<{ sampleRate: number; channels: Float32Array[] } | null>;
  /**
   * Value of a named signal that a stream-domain (audio/MIDI) node publishes, at `seconds`:
   * loudness, pitch, note, gate… This is the bridge that lets sound drive picture parameters.
   * Live it returns the latest measured value; during export, the value analysed from the rendered audio.
   * Returns 0 when unknown.
   */
  signal?(nodeId: string, name: string, seconds: number): number;
  /** Rasterise text to straight RGBA (browser canvas). Optional: missing in headless runs. */
  rasterizeText?(spec: TextSpec): { data: Uint8ClampedArray; width: number; height: number } | null;
}

export interface AssetInfo {
  id: string;
  name: string;
  kind: 'image' | 'video' | 'audio' | 'midi';
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
  /** Playback proxy scale (1 = full resolution). Only source nodes need it, to decode smaller frames. */
  readonly proxy: number;
  /** Texels per unit pixel for a fresh image of this size. Source and generator nodes use it to stamp `unit`. */
  unitFor(width: number, height: number): number;
  /** Convert a length in unit pixels to texels of `ref` (rarely needed: 'px' params are already converted). */
  px(unitPixels: number, ref?: { unit: number }): number;
  /**
   * Re-evaluate an input at another time (seconds), or fetch a `lazy` input (omit `at` for the current frame).
   * For temporal nodes (echo, retime, loop cross-fade) and run-once analysis on a fixed frame.
   * The result is only valid during this render call.
   */
  pull<K extends keyof I>(input: K, at?: { seconds: number }): Promise<SocketValueMap[I[K]['type']] | null>;
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
  summary?: (params: ParamsOf<P>) => string;
  /**
   * The node accepts notes played by the user. While it is selected, the UI maps the computer keyboard
   * (and an on-screen piano) to MIDI notes and sends them to it.
   */
  playable?: boolean;
  /** Set when `render` does heavy CPU work, so the UI can warn. */
  cpu?: boolean;
  /**
   * Fusion-style effect mask. When true the kernel adds a `mask` input and a `mix` param (0..1) and blends
   * the node's first image output over its first image input for you. Do NOT implement masking/mix yourself.
   * Only valid when output and input have the same size.
   */
  maskable?: boolean;
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

export interface GraphDoc {
  schema: 'rsmps/graph';
  version: 2;
  name: string;
  project: ProjectSettings;
  nodes: NodeInstance[];
  edges: Edge[];
  frames?: FrameBox[];
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
