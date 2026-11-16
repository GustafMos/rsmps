/** Messages between the main-thread engine (engine.ts) and the AudioWorklet (worklet.ts). */
import type { GraphDoc } from '../types';
import type { RecordedTake, RecordingState } from './api';
import type { MidiEvent } from './types';

export type ToWorklet =
  | { type: 'graph'; doc: GraphDoc }
  /** Decoded PCM at the context sample rate. One channel = mono. Buffers are transferred. */
  | { type: 'asset'; id: string; sampleRate: number; channels: Float32Array[]; video?: { duration: number; fps: number } }
  | { type: 'transport'; playing: boolean; seconds: number; duration: number; loop: boolean; item?: number }
  | { type: 'midi'; events: MidiEvent[] }
  /** Which worklet input carries which microphone node. */
  | { type: 'micSlots'; slots: Record<string, number> }
  | { type: 'arm'; nodeId: string; target: { track: string; kind: 'audio' | 'midi' } | null }
  | { type: 'recStart'; latency: number }
  | { type: 'recStop' }
  | { type: 'note'; nodeId: string; note: number; velocity: number; on: boolean };

export type FromWorklet =
  | { type: 'meters'; meters: Record<string, [number, number]> }
  | { type: 'signals'; signals: Record<string, Record<string, number>> }
  | { type: 'recState'; state: RecordingState }
  | { type: 'take'; take: RecordedTake | null }
  | { type: 'error'; message: string };

export const WORKLET_NAME = 'rsmps-audio';

/** Number of microphone nodes that can be live at once (one worklet input each). */
export const MAX_MICS = 4;
