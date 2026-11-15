/**
 * Public surface of the audio engine. src/io (player, exporter) uses only this file.
 * Implemented by the other files in src/engine/audio; see README.md there.
 */
import type { Registry } from '../define';
import type { GraphDoc } from '../types';

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
