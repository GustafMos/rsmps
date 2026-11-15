/**
 * Audio engine entry point (imported by src/io/audio-bridge.ts).
 * Types live in api.ts; DSP kernels in src/engine/nodes/{audio-source,audio-fx,synth}.
 */
export { createAudioEngine } from './engine';
export { renderAudioOffline } from './offline';
export type { AudioEngine, AudioAssetProvider, PcmAudio, TransportState, CreateAudioEngine, RenderAudioOffline } from './api';
