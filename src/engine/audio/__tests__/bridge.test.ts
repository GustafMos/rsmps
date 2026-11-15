import { describe, expect, it } from 'vitest';
import { analyzeSignalsOffline } from '../offline';
import { AudioGraphRunner, hasAudioOutput, hasSignalTap } from '../runner';
import { SR, audioRegistry, makeGraph, on, sine } from '../testing';

describe('analysis taps in the runner', () => {
  const tapGraph = () =>
    makeGraph({
      nodes: [
        { id: 'o', type: 'oscillator', params: { wave: 'sine', frequency: 440, level: -12 } },
        { id: 'lv', type: 'audio-level', params: { floor: -60, ceiling: 0 } },
      ],
      edges: ['o.audio -> lv.audio'],
    });

  it('a tap with no audio-out is compiled and processed, and publishes signals', () => {
    const reg = audioRegistry();
    const g = tapGraph();
    expect(hasAudioOutput(g, reg)).toBe(false);
    expect(hasSignalTap(g, reg)).toBe(true);
    const r = new AudioGraphRunner(reg, { sampleRate: SR, fadeOnRebuild: false });
    r.setGraph(g);
    expect(r.nodeCount).toBe(2); // oscillator is pulled in because the tap needs it
    expect(r.hasOutput()).toBe(false);
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let i = 0; i < 400; i++) r.process(L, R, 128);
    expect(r.signal('lv', 'level')).toBeCloseTo((60 - 15.05) / 60, 1);
    expect(r.signalSnapshot().lv.level).toBe(r.signal('lv', 'level'));
    expect(r.signal('lv', 'nope')).toBe(0);
    expect(r.signal('missing', 'level')).toBe(0);
    expect(Math.max(...L)).toBe(0); // nothing is audible
  });

  it('an unwired tap is not run; taps work alongside an audio-out', () => {
    const reg = audioRegistry();
    const idle = makeGraph({ nodes: [{ id: 'lv', type: 'audio-level' }], edges: [] });
    expect(hasSignalTap(idle, reg)).toBe(false);
    const r = new AudioGraphRunner(reg, { sampleRate: SR });
    r.setGraph(idle);
    expect(r.nodeCount).toBe(0);
    const both = makeGraph({
      nodes: [{ id: 'o', type: 'oscillator' }, { id: 'lv', type: 'audio-level' }, { id: 'out', type: 'audio-out' }],
      edges: ['o.audio -> lv.audio', 'o.audio -> out.audio'],
    });
    r.setGraph(both);
    expect(r.nodeCount).toBe(3);
    expect(r.hasOutput()).toBe(true);
  });

  it('MIDI taps work: keyboard -> midi-value with no audio at all', () => {
    const g = makeGraph({ nodes: [{ id: 'kb', type: 'midi-keyboard' }, { id: 'mv', type: 'midi-value' }], edges: ['kb.midi -> mv.midi'] });
    const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR });
    r.setGraph(g);
    r.sendMidi('kb', on(60, 0));
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let i = 0; i < 50; i++) r.process(L, R, 128);
    expect(r.signal('mv', 'count')).toBe(1);
    expect(r.signal('mv', 'gate')).toBeGreaterThan(0.9);
  });
});

describe('analyzeSignalsOffline', () => {
  const FPS = 24;
  it('samples each published signal once per video frame from an audio file (quiet first half, loud second half)', async () => {
    const reg = audioRegistry();
    const quiet = sine(440, SR, SR, 0.005);
    const loud = sine(440, SR, SR, 0.5);
    const file = new Float32Array(2 * SR);
    file.set(quiet, 0);
    file.set(loud, SR);
    const g = makeGraph({
      nodes: [
        { id: 'f', type: 'audio-file', params: { assets: ['take'] } },
        { id: 'lv', type: 'audio-level', params: { floor: -60, ceiling: 0, attack: 10, release: 100 } },
      ],
      edges: ['f.audio -> lv.audio'],
    });
    const tracks = await analyzeSignalsOffline(g, reg, async (id) => (id === 'take' ? { sampleRate: SR, channels: [file] } : null), { duration: 2, fps: FPS, loop: false });
    expect(tracks.frames).toBe(48);
    expect(tracks.fps).toBe(FPS);
    expect(tracks.keys().filter((k) => k.nodeId === 'lv').map((k) => k.name).sort()).toEqual(['high', 'level', 'low', 'mid', 'peak', 'pitch']);
    const quietExpect = (60 + 20 * Math.log10(0.005 / Math.SQRT2)) / 60; // 0.5 in dB terms
    const loudExpect = (60 + 20 * Math.log10(0.5 / Math.SQRT2)) / 60;
    expect(Math.abs(tracks.value('lv', 'level', 10) - quietExpect)).toBeLessThan(0.02);
    expect(Math.abs(tracks.value('lv', 'level', 40) - loudExpect)).toBeLessThan(0.02);
    // the step happens at frame 24 (1.0 s): the values just before and just after differ a lot
    expect(tracks.value('lv', 'level', 23)).toBeLessThan(0.55);
    expect(tracks.value('lv', 'level', 27)).toBeGreaterThan(0.8);
    // monotone rise through the step, then flat
    for (let f = 25; f < 30; f++) expect(tracks.value('lv', 'level', f)).toBeGreaterThanOrEqual(tracks.value('lv', 'level', f - 1) - 1e-6);
    // out-of-range frame indexes clamp; unknown signals are 0
    expect(tracks.value('lv', 'level', 999)).toBe(tracks.value('lv', 'level', 47));
    expect(tracks.value('lv', 'level', -3)).toBe(tracks.value('lv', 'level', 0));
    expect(tracks.value('lv', 'bogus', 3)).toBe(0);
    expect(tracks.value('nobody', 'level', 3)).toBe(0);
  });

  it('samples at the END of each frame span (frame 0 has only seen 1/24 s of sound)', async () => {
    const g = makeGraph({
      nodes: [{ id: 'o', type: 'oscillator', params: { frequency: 300, level: -6 } }, { id: 'lv', type: 'audio-level', params: { floor: -60, ceiling: 0, attack: 200, release: 200 } }],
      edges: ['o.audio -> lv.audio'],
    });
    const t = await analyzeSignalsOffline(g, audioRegistry(), async () => null, { duration: 1, fps: FPS, loop: false });
    // slow attack: the level climbs frame by frame
    expect(t.value('lv', 'level', 0)).toBeLessThan(t.value('lv', 'level', 5));
    expect(t.value('lv', 'level', 5)).toBeLessThan(t.value('lv', 'level', 23));
  });

  it('live-only sources are silent offline: a microphone-driven bridge exports its quiet values', async () => {
    const g = makeGraph({
      nodes: [{ id: 'mic', type: 'microphone' }, { id: 'lv', type: 'audio-level', params: { from: 2, to: 8 } }],
      edges: ['mic.tap -> lv.audio'],
    });
    const t = await analyzeSignalsOffline(g, audioRegistry(), async () => null, { duration: 0.5, fps: FPS, loop: false });
    for (let f = 0; f < t.frames; f++) {
      expect(t.value('lv', 'level', f)).toBe(2);
      expect(t.value('lv', 'pitch', f)).toBe(2);
    }
  });

  it('no taps and no frames are fine', async () => {
    const g = makeGraph({ nodes: [{ id: 'o', type: 'oscillator' }], edges: [] });
    const t = await analyzeSignalsOffline(g, audioRegistry(), async () => null, { duration: 0.5, fps: FPS, loop: false });
    expect(t.keys()).toEqual([]);
    expect(t.value('o', 'x', 0)).toBe(0);
    const z = await analyzeSignalsOffline(g, audioRegistry(), async () => null, { duration: 0, fps: FPS, loop: false });
    expect(z.frames).toBe(0);
  });
});

describe('several microphones', () => {
  it('each microphone node reads its own worklet input slot', () => {
    const g = makeGraph({
      nodes: [
        { id: 'm1', type: 'microphone' },
        { id: 'm2', type: 'microphone' },
        { id: 'a', type: 'audio-level', params: { floor: -60, ceiling: 0 } },
        { id: 'b', type: 'audio-level', params: { floor: -60, ceiling: 0 } },
      ],
      edges: ['m1.tap -> a.audio', 'm2.tap -> b.audio'],
    });
    const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    r.setGraph(g);
    r.setMicSlots({ m1: 0, m2: 1 });
    const loud = sine(300, 128, SR, 0.5);
    const quiet = sine(300, 128, SR, 0.01);
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    const loudPhase = new Float32Array(128);
    for (let i = 0; i < 300; i++) {
      for (let k = 0; k < 128; k++) loudPhase[k] = loud[k];
      r.process(L, R, 128, undefined, undefined, [[loudPhase, loudPhase], [quiet, quiet]]);
    }
    expect(r.signal('a', 'level')).toBeGreaterThan(r.signal('b', 'level') + 0.3);
    // a slot with no stream is silent (nothing leaks in from the default input)
    r.setMicSlots({ m1: 0, m2: 3 });
    for (let i = 0; i < 300; i++) r.process(L, R, 128, undefined, undefined, [[loudPhase, loudPhase], null]);
    expect(r.signal('b', 'level')).toBe(0);
  });
});
