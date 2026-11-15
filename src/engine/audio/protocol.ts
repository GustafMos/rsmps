/** Messages between the main-thread engine (engine.ts) and the AudioWorklet (worklet.ts). */
import type { GraphDoc } from '../types';
import type { MidiEvent } from './types';

export type ToWorklet =
  | { type: 'graph'; doc: GraphDoc }
  /** Decoded PCM at the context sample rate. One channel = mono. Buffers are transferred. */
  | { type: 'asset'; id: string; sampleRate: number; channels: Float32Array[] }
  | { type: 'transport'; playing: boolean; seconds: number; duration: number; loop: boolean }
  | { type: 'midi'; events: MidiEvent[] }
  | { type: 'note'; nodeId: string; note: number; velocity: number; on: boolean };

export type FromWorklet =
  | { type: 'meters'; meters: Record<string, [number, number]> }
  | { type: 'signals'; signals: Record<string, Record<string, number>> }
  | { type: 'error'; message: string };

export const WORKLET_NAME = 'rsmps-audio';
