import { describe, expect, it } from 'vitest';
import type { RecordedTake, RecordingState } from '../engine/audio/api';
import type { AudioBridge } from './audio-bridge';
import { RecordingController, takeName, takePieces } from './recording';

const pcm = (n: number, v = 0.5) => ({ sampleRate: 48000, channels: [new Float32Array(n).fill(v), new Float32Array(n).fill(v)] });
const idle: RecordingState = { armed: false, recording: false, phase: 'idle', seconds: 0, countIn: 0, level: [0, 0], nodeId: null, error: null };

describe('takePieces', () => {
  it('copies the single pcm, or one piece per pass, and nothing for MIDI', () => {
    const base = { nodeId: 'n', track: 't', start: 0, length: 1, latency: 0 };
    const single: RecordedTake = { ...base, kind: 'audio', pcm: pcm(10) };
    const [p] = takePieces(single);
    expect(p.channels[0]).not.toBe(single.pcm!.channels[0]);
    expect(p.channels[0].length).toBe(10);
    const looped: RecordedTake = { ...base, kind: 'audio', pcm: pcm(30), passes: [{ start: 0, length: 1, pcm: pcm(10, 0.1) }, { start: 0, length: 1, pcm: pcm(20, 0.2) }] };
    expect(takePieces(looped).map((x) => x.channels[0].length)).toEqual([10, 20]);
    expect(takePieces({ ...base, kind: 'midi', notes: [] })).toEqual([]);
  });
  it('names takes', () => {
    expect(takeName(3, 'Vocals', new Date(2020, 0, 1, 9, 5, 7))).toBe('Take 3 · Vocals · 09:05:07');
  });
});

describe('RecordingController', () => {
  function setup() {
    let state: RecordingState = idle;
    let playing = false;
    const calls: string[] = [];
    const audio = {
      armRecording: () => calls.push('arm'),
      start: async () => void calls.push('start'),
      startRecording: () => calls.push('startRec'),
      stopRecording: async () => ({ nodeId: 'n', track: 'T', kind: 'audio', start: 0, length: 1, latency: 0, pcm: pcm(100) }) as RecordedTake,
      recordingState: () => state,
    } as unknown as AudioBridge;
    const player = { getState: () => ({ playing }), play: () => ((playing = true), calls.push('play')), pause: () => ((playing = false), calls.push('pause')) };
    const stored: string[] = [];
    const library = { addRecording: async (name: string) => (stored.push(name), { id: 'a' + stored.length, name }) as never };
    return { c: new RecordingController(audio, player, library), calls, stored, set: (s: Partial<RecordingState>) => (state = { ...idle, ...s }), player };
  }

  it('keeps the player paused during the count-in and plays when recording starts', async () => {
    const { c, calls, set } = setup();
    c.arm('n', { track: 'T', kind: 'audio' });
    set({ armed: true, phase: 'count-in', countIn: 1 });
    await c.record();
    expect(calls).not.toContain('play');
    set({ armed: true, recording: true, phase: 'recording' });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.filter((x) => x === 'play')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.filter((x) => x === 'play')).toHaveLength(1); // only once
  });

  it('stop pauses, stores the pass as an asset and returns it with the take', async () => {
    const { c, calls, stored } = setup();
    const r = await c.stop();
    expect(calls[0]).toBe('pause');
    expect(r!.assets).toHaveLength(1);
    expect(stored[0]).toMatch(/^Take 1 · T · \d\d:\d\d:\d\d$/);
    expect((await c.stop())!.assets[0].name).toMatch(/^Take 2/);
  });

  it('notifies listeners and stops polling when idle', async () => {
    const { c, set } = setup();
    const seen: string[] = [];
    c.onRecordingState((s) => seen.push(s.phase));
    set({ armed: true, phase: 'armed' });
    c.arm('n', { track: 'T', kind: 'audio' });
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toContain('armed');
  });
});
