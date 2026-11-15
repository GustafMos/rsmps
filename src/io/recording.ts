/**
 * Orchestrates recording: audio engine + player transport + storing takes as assets.
 * Flow: arm -> record (user gesture) -> [count-in, player paused] -> player plays when phase is 'recording' -> stop.
 */
import type { PcmAudio, RecordedTake, RecordingState } from '../engine/audio/api';
import type { AssetInfo } from '../engine/types';
import type { RecordedResult } from './api';
import type { AudioBridge } from './audio-bridge';

export interface TransportLike {
  getState(): { playing: boolean };
  play(): void;
  pause(): void;
}
export interface StoreLike {
  addRecording(name: string, pcm: PcmAudio): Promise<AssetInfo>;
}

const POLL_MS = 33;

/** The audio PCM pieces of a take, in pass order (copies: the take's buffers are views). */
export function takePieces(take: RecordedTake): PcmAudio[] {
  if (take.kind !== 'audio') return [];
  const copy = (p: PcmAudio): PcmAudio => ({ sampleRate: p.sampleRate, channels: p.channels.map((c) => c.slice()) });
  if (take.passes && take.passes.length) return take.passes.filter((p) => p.pcm).map((p) => copy(p.pcm!));
  return take.pcm ? [copy(take.pcm)] : [];
}

export function takeName(n: number, track: string, now: Date = new Date()): string {
  const t = [now.getHours(), now.getMinutes(), now.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
  return `Take ${n} · ${track} · ${t}`;
}

export class RecordingController {
  private listeners = new Set<(s: RecordingState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private playStarted = false;
  private takeCounter = 0;
  private lastPhase = '';

  constructor(
    private audio: AudioBridge,
    private player: TransportLike,
    private library: StoreLike,
  ) {}

  arm(nodeId: string, target: { track: string; kind: 'audio' | 'midi' } | null): void {
    this.audio.armRecording(nodeId, target);
    this.ensurePolling();
  }

  async record(): Promise<void> {
    await this.audio.start(); // must run inside the click that called record()
    this.playStarted = false;
    this.audio.startRecording();
    this.ensurePolling();
    this.tick();
  }

  async stop(): Promise<RecordedResult | null> {
    this.player.pause();
    const take = await this.audio.stopRecording();
    this.playStarted = false;
    this.tick();
    if (!take) return null;
    const assets: AssetInfo[] = [];
    const pieces = takePieces(take);
    const n = ++this.takeCounter;
    for (let i = 0; i < pieces.length; i++) {
      const suffix = pieces.length > 1 ? ` (pass ${i + 1})` : '';
      assets.push(await this.library.addRecording(takeName(n, take.track, new Date()) + suffix, pieces[i]));
    }
    return { take, assets };
  }

  recordingState(): RecordingState {
    return this.audio.recordingState();
  }

  onRecordingState(listener: (s: RecordingState) => void): () => void {
    this.listeners.add(listener);
    this.ensurePolling();
    return () => this.listeners.delete(listener);
  }

  private ensurePolling(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  private tick(): void {
    const s = this.audio.recordingState();
    if (s.phase === 'count-in' && this.player.getState().playing) this.player.pause();
    if (s.phase === 'recording' && !this.playStarted) {
      this.playStarted = true;
      if (!this.player.getState().playing) this.player.play();
    }
    if (s.phase !== 'idle' || this.lastPhase !== 'idle') for (const l of [...this.listeners]) l(s);
    this.lastPhase = s.phase;
    if (s.phase === 'idle' && !s.armed && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
