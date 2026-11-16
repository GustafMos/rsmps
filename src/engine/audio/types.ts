/**
 * Stream-domain contract: audio and MIDI nodes.
 *
 * An audio node is declared with the same `defineNode` as an image node, but instead of `render`
 * it provides `audio: AudioKernel`. A kernel is PURE BLOCK DSP:
 *
 *   state = kernel.create({ sampleRate, blockSize, nodeId })
 *   kernel.process(state, io)          // called once per block of `io.frames` samples
 *
 * Kernels never touch Web Audio, the DOM, the graph, or other nodes. Everything arrives in `io`.
 * The same kernels run inside one AudioWorkletProcessor (live) and in a plain loop (export, tests).
 *
 * Format: stereo float32 at the context sample rate, 128-sample blocks. A "stereo block" is a
 * `[left, right]` pair of Float32Arrays; only the first `io.frames` samples are meaningful.
 */

/** A pair of equally long channel buffers. */
export type StereoBlock = [Float32Array, Float32Array];

/** One MIDI-like event inside a block. */
export interface MidiEvent {
  type: 'on' | 'off' | 'cc' | 'bend';
  /** 0..127 for on/off; controller number for 'cc'; unused for 'bend'. */
  note: number;
  /** 0..1 for on/off. */
  velocity: number;
  /** Controller value 0..1 for 'cc'; -1..1 for 'bend'. Unused for on/off. */
  value: number;
  /** Sample offset inside the current block (0 .. frames-1). */
  offset: number;
  /** 0..15 */
  channel: number;
  /** Hardware device id (set by the live host for Web MIDI events; used by the MIDI Device node filter). */
  device?: string;
  /** Human-readable name of that device (for the legacy name filter). */
  deviceName?: string;
}

/** Transport and clock, identical in live playback, export and tests. */
export interface AudioTime {
  /** Transport position at the START of this block, in seconds. */
  seconds: number;
  /** Transport position at the start of this block, in samples. */
  sample: number;
  /** Project tempo. Nodes with their own `bpm` param may use that instead. */
  bpm: number;
  /** False while the picture is paused. Live sources (mic, synths) keep running; file players are silent. */
  playing: boolean;
  /** Project loop mode. */
  loop: boolean;
  /** Project duration in seconds (0 = unknown). */
  duration: number;
  /** Batch item being previewed or exported (0 when there is no batch). Media In picks its asset with it. */
  item: number;
}

/** Decoded asset PCM, already resampled to the context sample rate and made stereo. */
export interface AudioAsset {
  /** Set for the sound track of a video: the clip's duration and frame rate (Media In maps picture time to sound with them). */
  video?: { duration: number; fps: number };
  sampleRate: number;
  frames: number;
  left: Float32Array;
  right: Float32Array;
}

export interface AudioAssets {
  get(assetId: string): AudioAsset | undefined;
}

/** Live-only services. Offline renders provide silence / nothing. */
export interface AudioLive {
  /** Microphone block for this render quantum, or null when no live input exists (offline, permission denied). */
  mic: StereoBlock | null;
  /** Events from hardware MIDI devices this block (already sorted by offset). Shared by every node. Treat events as immutable. */
  deviceMidi: MidiEvent[];
  /** Events sent to THIS node from the UI (on-screen keyboard, `AudioEngine.sendNote`). */
  uiMidi: MidiEvent[];
}

export interface AudioCtx {
  sampleRate: number;
  blockSize: number;
  /** Stable per-node id: use it to seed random generators so renders are reproducible. */
  nodeId: string;
}

/** Resolved params: defaults applied, clamped to min/max, enums as strings. v1: wired number sockets are NOT applied (stored value is used). */
export type AudioParams = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface AudioIO {
  /** Samples to process this call (<= blockSize). */
  frames: number;
  /** Context sample rate (same as `ctx.sampleRate` given to create). */
  sampleRate: number;
  /**
   * Audio inputs by input name. null when nothing is wired. Several wires into one input are already
   * summed by the host. READ-ONLY: never write into an input buffer (it may be another node's output).
   */
  in: Record<string, StereoBlock | null>;
  /**
   * Only for kernels with `perWire: true`: the blocks of EACH wire of every audio input, in wire order (empty array when unwired).
   * `in` still holds their sum. Lets an editing node gate, fade and mix wires individually. READ-ONLY.
   */
  inWires?: Record<string, StereoBlock[]>;
  /** MIDI inputs by name: all events for this block from all wires, sorted by `offset`. Empty array when unwired. READ-ONLY. */
  midiIn: Record<string, MidiEvent[]>;
  /**
   * Audio outputs by output name, PRE-ZEROED: write (or add into) them. Sink nodes (category 'output')
   * additionally get `out.master`, the buffer the host plays.
   */
  out: Record<string, StereoBlock>;
  /** MIDI outputs by name. Push events with `offset` inside the block. The array is cleared by the host each block. */
  midiOut: Record<string, MidiEvent[]>;
  params: AudioParams;
  /**
   * Publish a named scalar for the picture side (sound -> picture bridge). Latest value per block wins.
   * Frame-domain bridge nodes read it back through `Host.signal(nodeId, name, seconds)`.
   * Allocation-free after the first call with a given name; call it every block.
   */
  signal(name: string, value: number): void;
  time: AudioTime;
  assets: AudioAssets;
  live: AudioLive;
}

export interface AudioKernel<S = any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Allocate ALL buffers and state here (delay lines, voices, tables). `process` must not allocate. */
  create(ctx: AudioCtx): S;
  /** Process one block. Handle null inputs. Keep every piece of state inside `state`. */
  process(state: S, io: AudioIO): void;
  /**
   * Run this node (and everything upstream) whenever any of its stream inputs is wired, even if nothing downstream
   * consumes its outputs. For nodes with a side effect on the host (the Timeline records what is wired to it).
   */
  runWhenFed?: boolean;
  /** Fill `io.inWires` (one block per wire) in addition to the summed `io.in`. Costs nothing for other kernels. */
  perWire?: boolean;
  /**
   * Host command channel (arm / start / stop recording ...). Called between blocks, never from process().
   * The return value goes back to the caller of `AudioGraphRunner.control`.
   */
  control?(state: S, message: any, params: AudioParams): any;
  /** Asset ids this node plays, for hosts that must load them first (beyond 'assets'-type params). */
  assets?(params: AudioParams, item: number): string[];
  /** With `assets()` or 'assets' params: only request them when something is wired to one of this node's audio outputs. */
  loadAssetsOnlyWhenWired?: boolean; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Clear tails and held notes (called on transport seek / stop where meaningful). Optional. */
  reset?(state: S): void;
}

/** Identity helper that infers the state type `S` from `create`. */
export function defineAudio<S>(kernel: AudioKernel<S>): AudioKernel<S> {
  return kernel;
}

export const BLOCK_SIZE = 128;

export function stereoBlock(frames: number): StereoBlock {
  return [new Float32Array(frames), new Float32Array(frames)];
}

export function midiEvent(
  type: MidiEvent['type'],
  note: number,
  velocity: number,
  offset: number,
  channel = 0,
  value = 0,
): MidiEvent {
  return { type, note, velocity, value, offset, channel };
}
