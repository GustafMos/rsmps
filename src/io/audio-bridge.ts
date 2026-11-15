/**
 * The ONLY file in src/io that imports the audio engine. Everything else talks to the `AudioBridge`,
 * which never throws: if the audio engine is missing or fails, picture playback and export keep working.
 */
import type { Registry } from '../engine/define';
import type { GraphDoc } from '../engine/types';
import type { AudioAssetProvider, AudioEngine, PcmAudio, RenderAudioOffline, TransportState } from '../engine/audio/api';
import * as audioModule from '../engine/audio';

export interface AudioBridge {
  /** False when the audio engine could not be created. */
  readonly available: boolean;
  hasAudio(graph: GraphDoc, registry: Registry): boolean;
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
};

export function createAudioBridge(): AudioBridge {
  const mod = audioModule as unknown as AudioModule;
  let engine: AudioEngine | null = null;
  try {
    engine = mod.createAudioEngine ? mod.createAudioEngine() : null;
  } catch (err) {
    console.warn('Audio engine could not be created:', err);
  }
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
    hasAudio: (g, r) => guard(false, (e) => e.hasAudio(g, r)),
    setGraph: (g, r) => guard(undefined, (e) => e.setGraph(g, r)),
    setAssets: (p) => guard(undefined, (e) => e.setAssets(p)),
    async start() {
      if (!engine) return;
      try {
        await engine.start();
      } catch (err) {
        console.warn('Audio could not start:', err);
        throw err;
      }
    },
    stop: () => guard(undefined, (e) => e.stop()),
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
