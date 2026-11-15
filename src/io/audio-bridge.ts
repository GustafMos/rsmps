/**
 * The ONLY file in src/io that imports the audio engine. Everything else talks to the `AudioBridge`,
 * which never throws: if the audio engine is missing or fails, picture playback and export keep working.
 */
import type { Registry } from '../engine/define';
import type { GraphDoc } from '../engine/types';
import type { AnalyzeSignalsOffline, AudioAssetProvider, AudioDevice, AudioEngine, HasExportAudio, PcmAudio, RecordedTake, RecordingState, RenderAudioOffline, SignalTracks, TransportState } from '../engine/audio/api';
import * as audioModule from '../engine/audio';

export interface AudioBridge {
  /** False when the audio engine could not be created. */
  readonly available: boolean;
  /** True after start() succeeded (until stop()). */
  readonly running: boolean;
  hasSignals(graph: GraphDoc, registry: Registry): boolean;
  signal(nodeId: string, name: string): number;
  listDevices(kind: 'audio-input' | 'midi-input'): Promise<AudioDevice[]>;
  onDevicesChanged(listener: () => void): () => void;
  sendNote(nodeId: string, note: number, velocity: number, on: boolean): void;
  analyzeSignals(graph: GraphDoc, registry: Registry, assets: AudioAssetProvider, options: { duration: number; fps: number; sampleRate?: number; loop: boolean }): Promise<SignalTracks | null>;
  hasAudio(graph: GraphDoc, registry: Registry): boolean;
  /** True when an export should render and mux graph audio (an enabled, wired Audio Out exists). */
  hasExportAudio(graph: GraphDoc, registry: Registry): boolean;
  armRecording(nodeId: string, target: { track: string; kind: 'audio' | 'midi' } | null): void;
  startRecording(): void;
  stopRecording(): Promise<RecordedTake | null>;
  recordingState(): RecordingState;
  setGraph(graph: GraphDoc, registry: Registry): void;
  setAssets(provider: AudioAssetProvider): void;
  start(): Promise<void>;
  stop(): void;
  setTransport(state: TransportState): void;
  setVolume(volume: number): void;
  meter(nodeId: string): [number, number] | null;
  renderOffline(
    graph: GraphDoc,
    registry: Registry,
    assets: AudioAssetProvider,
    options: { duration: number; sampleRate?: number; loop: boolean },
  ): Promise<PcmAudio | null>;
  dispose(): void;
}

type AudioModule = {
  createAudioEngine?: () => AudioEngine;
  renderAudioOffline?: RenderAudioOffline;
  hasExportAudio?: HasExportAudio;
  analyzeSignalsOffline?: AnalyzeSignalsOffline;
};

const IDLE_RECORDING: RecordingState = { armed: false, recording: false, phase: 'idle', seconds: 0, countIn: 0, level: [0, 0], nodeId: null, error: null };

export function createAudioBridge(): AudioBridge {
  const mod = audioModule as unknown as AudioModule;
  let engine: AudioEngine | null = null;
  try {
    engine = mod.createAudioEngine ? mod.createAudioEngine() : null;
  } catch (err) {
    console.warn('Audio engine could not be created:', err);
  }
  let running = false;
  const guard = <T>(fallback: T, fn: (e: AudioEngine) => T): T => {
    if (!engine) return fallback;
    try {
      return fn(engine);
    } catch (err) {
      console.warn('Audio engine error:', err);
      return fallback;
    }
  };
  return {
    available: engine !== null,
    get running() {
      return running;
    },
    hasExportAudio: (g, r) => (mod.hasExportAudio ? mod.hasExportAudio(g, r) : guard(false, (e) => e.hasAudio(g, r))),
    armRecording: (id, t) => guard(undefined, (e) => e.armRecording(id, t)),
    startRecording: () => guard(undefined, (e) => e.startRecording()),
    stopRecording: async () => {
      if (!engine) return null;
      return engine.stopRecording();
    },
    recordingState: () =>
      guard(IDLE_RECORDING, (e) => e.recordingState()),
    hasSignals: (g, r) => guard(false, (e) => e.hasSignals(g, r)),
    signal: (id, name) => guard(0, (e) => e.signal(id, name)),
    async listDevices(kind) {
      if (!engine) return [];
      try {
        return await engine.listDevices(kind);
      } catch {
        return [];
      }
    },
    onDevicesChanged: (l) => guard(() => undefined, (e) => e.onDevicesChanged(l)),
    sendNote: (id, n, v, on) => guard(undefined, (e) => e.sendNote(id, n, v, on)),
    async analyzeSignals(graph, registry, assets, options) {
      if (!mod.analyzeSignalsOffline) return null;
      return mod.analyzeSignalsOffline(graph, registry, assets, options);
    },
    hasAudio: (g, r) => guard(false, (e) => e.hasAudio(g, r)),
    setGraph: (g, r) => guard(undefined, (e) => e.setGraph(g, r)),
    setAssets: (p) => guard(undefined, (e) => e.setAssets(p)),
    async start() {
      if (!engine) return;
      try {
        await engine.start();
        running = true;
      } catch (err) {
        console.warn('Audio could not start:', err);
        throw err;
      }
    },
    stop: () => {
      running = false;
      guard(undefined, (e) => e.stop());
    },
    setTransport: (s) => guard(undefined, (e) => e.setTransport(s)),
    setVolume: (v) => guard(undefined, (e) => e.setVolume(v)),
    meter: (id) => guard(null, (e) => e.meter(id)),
    async renderOffline(graph, registry, assets, options) {
      if (!mod.renderAudioOffline) return null;
      return mod.renderAudioOffline(graph, registry, assets, options);
    },
    dispose: () => guard(undefined, (e) => e.dispose()),
  };
}
