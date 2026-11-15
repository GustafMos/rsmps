/**
 * Public surface of the audio engine. src/io (player, exporter) uses only this file.
 * Implemented by the other files in src/engine/audio; see README.md there.
 */
import type { Registry } from '../define';
import type { GraphDoc } from '../types';
import type { TimelineNote } from './timeline';

export interface PcmAudio {
  sampleRate: number;
  /** One Float32Array per channel (1 or 2), equal lengths. */
  channels: Float32Array[];
}

/** Decoded audio for an asset id (audio file, or the sound track of a video), or null. */
export type AudioAssetProvider = (assetId: string) => Promise<PcmAudio | null>;

export interface TransportState {
  playing: boolean;
  seconds: number;
  duration: number;
  loop: boolean;
}

export interface AudioDevice {
  /** Value stored in a 'device' param. */
  id: string;
  /** Name to show in the dropdown. */
  label: string;
}

/** One loop pass (or the single pass) of a recording. `pcm` here is a VIEW into the take's buffer: copy before keeping. */
export interface RecordedPass {
  /** Project seconds where this pass starts on the timeline. */
  start: number;
  length: number;
  pcm?: PcmAudio;
  /** Seconds relative to `start`. */
  notes?: TimelineNote[];
}

/** What `stopRecording()` hands back. Turn it into clips with `applyTake` (timeline.ts) after storing the PCM as assets. */
export interface RecordedTake {
  nodeId: string;
  /** Timeline track id the take was armed for. */
  track: string;
  kind: 'audio' | 'midi';
  /** Project seconds where the take starts on the timeline (input latency already compensated). */
  start: number;
  /** Seconds. */
  length: number;
  /** Audio takes: the whole recording as lossless float32 stereo at the context rate. */
  pcm?: PcmAudio;
  /** MIDI takes: notes in seconds from `start` (every loop pass merged, times modulo the loop, only when loopPasses <= 1). */
  notes?: TimelineNote[];
  /** Number of loop passes recorded (1 = no loop wrap happened). */
  loopPasses?: number;
  /** One entry per pass (only when the transport looped while recording). Pass 0 starts at `start`; later passes at the loop start. */
  passes?: RecordedPass[];
  /** Input latency that was compensated, seconds (device latency + the node's latency offset). */
  latency: number;
  /** Set when recording ended early (for example the maximum length was reached). */
  error?: string;
}

export interface RecordingState {
  /** A node is armed for recording. */
  armed: boolean;
  /** Capturing right now. */
  recording: boolean;
  /** idle: nothing armed; armed: waiting for startRecording; count-in: clicks before capture; recording: capturing. */
  phase: 'idle' | 'armed' | 'count-in' | 'recording';
  /** Seconds captured so far. */
  seconds: number;
  /** Seconds of count-in left (0 when not counting in). Start the transport when this reaches 0. */
  countIn: number;
  /** Peak level 0..1 per channel of the audio being recorded (0 for MIDI-only). */
  level: [number, number];
  nodeId: string | null;
  /** Message to show the user (maximum length reached ...), or null. */
  error: string | null;
}

export interface AudioEngine {
  /** True if the graph contains an audio output that something is wired to. */
  hasAudio(graph: GraphDoc, registry: Registry): boolean;
  /**
   * Give the engine the current graph. Param-only changes are applied smoothly without rebuilding;
   * topology changes rebuild with a short cross-fade. Cheap to call on every edit.
   */
  setGraph(graph: GraphDoc, registry: Registry): void;
  setAssets(provider: AudioAssetProvider): void;
  /** Create/resume the AudioContext. Must be called from a user gesture. Requests the microphone only if a mic node is in the graph. */
  start(): Promise<void>;
  stop(): void;
  /** Keep file players and tempo-synced effects in step with the picture. Call on play, pause, seek and loop wrap. */
  setTransport(state: TransportState): void;
  setVolume(volume: number): void;
  /**
   * True if the graph has analysis taps (sound-to-picture bridge nodes such as Sound to Numbers) with something wired in.
   * They produce `signal()` values and need the engine started even when there is no audio output.
   */
  hasSignals(graph: GraphDoc, registry: Registry): boolean;
  /** Latest value of a signal published by a stream node (loudness, pitch, note...), or 0 when unknown. Feeds `Host.signal` while playing. */
  signal(nodeId: string, name: string): number;
  /**
   * Available hardware inputs for a 'device' param dropdown. Microphone names are only known after the user has
   * granted microphone permission: before that you get generic labels ("Microphone 1"). Never throws: [] when
   * unsupported or denied. Does not include the "System default" / "All devices" entry (that is the empty id).
   */
  listDevices(kind: 'audio-input' | 'midi-input'): Promise<AudioDevice[]>;
  /** Call `listener` when devices are plugged or unplugged (or labels become available). Returns an unsubscribe function. */
  onDevicesChanged(listener: () => void): () => void;
  /**
   * Choose what the Timeline node `nodeId` records, or pass null to disarm. One node can be armed at a time (arming
   * another disarms the first). What is wired into the node's `recordAudio` / `recordMidi` input is what gets captured.
   */
  armRecording(nodeId: string, target: { track: string; kind: 'audio' | 'midi' } | null): void;
  /**
   * Begin capturing on the armed node. If the node has a count-in, `recordingState().phase` is 'count-in' (with clicks)
   * first: start the transport when it reaches 'recording'. Capture only advances while the transport is playing.
   */
  startRecording(): void;
  /**
   * Stop and resolve with the take (null if nothing was armed or nothing was captured). The capture runs inside the
   * worklet, sample accurate and lossless; the whole take arrives here when you stop. Input latency
   * (`audioContext.baseLatency + outputLatency`, plus the node's latencyOffsetMs) is already compensated.
   */
  stopRecording(): Promise<RecordedTake | null>;
  /** Poll (or after each message) for record meters and the count-in. Updated ~30 Hz while armed. */
  recordingState(): RecordingState;
  /** Peak level 0..1 per channel at a node's first audio output, or null when unknown. */
  meter(nodeId: string): [number, number] | null;
  /** Send a note from the UI (on-screen keyboard) into a MIDI-producing node. */
  sendNote(nodeId: string, note: number, velocity: number, on: boolean): void;
  dispose(): void;
}

export type CreateAudioEngine = () => AudioEngine;

/**
 * Render the graph's audio output for export, faster than real time, with the same DSP code
 * as live playback. Live-only sources (microphone, MIDI devices) render as silence.
 * Returns null when the graph has no audio output.
 */
export type RenderAudioOffline = (
  graph: GraphDoc,
  registry: Registry,
  assets: AudioAssetProvider,
  options: { duration: number; sampleRate?: number; loop: boolean },
) => Promise<PcmAudio | null>;

/** Signals sampled once per video frame (export). */
export interface SignalTracks {
  /** Number of video frames covered. */
  readonly frames: number;
  readonly fps: number;
  /** Value of a published signal for a frame index (clamped to the range); 0 when the node or signal is unknown. */
  value(nodeId: string, name: string, frameIndex: number): number;
  /** Every (node, signal) pair that was published. */
  keys(): { nodeId: string; name: string }[];
}

/**
 * Run the audio graph faster than real time (same runner as renderAudioOffline, taps included) and sample each
 * published signal once per video frame f: the value held at the END of that frame's sample span, i.e. at
 * sample round((f + 1) * sampleRate / fps). Kernels smooth their own measurements (attack/release), so the last value
 * is the smoothed loudness at that moment. Live-only sources (microphone, MIDI devices) are silent offline, so signals
 * driven by them come out as their "silent" values; use an audio-file (a recording) for exports.
 */
export type AnalyzeSignalsOffline = (
  graph: GraphDoc,
  registry: Registry,
  assets: AudioAssetProvider,
  options: { duration: number; fps: number; sampleRate?: number; loop: boolean },
) => Promise<SignalTracks>;

/**
 * True if exporting would produce audio: some audio-out that is included in export (its "Include in export" switch is on and
 * it is not bypassed) has something wired in. Use this, not `AudioEngine.hasAudio` (which means "there is something to hear
 * live"), to decide whether an export gets an audio track. `renderAudioOffline` returns null in exactly the other case.
 */
export type HasExportAudio = (graph: GraphDoc, registry: Registry) => boolean;
