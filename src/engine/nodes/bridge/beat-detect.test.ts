import { describe, expect, it } from 'vitest';
import { SR, getDef, makeGraph, audioRegistry, runKernel } from '../../audio/testing';
import { analyzeSignalsOffline } from '../../audio/offline';
import { analyzeTrack } from '../../lib/beat';
import { clickTrack, drumPattern } from '../../lib/beat-testutil';

const def = () => getDef('beat-detect');
const run = (params: Record<string, unknown>, audio: Float32Array | undefined, frames: number, time?: Record<string, unknown>) =>
  runKernel(def(), { params, inputs: audio ? { audio } : {}, frames, time });
const block = (sec: number) => Math.floor((sec * SR) / 128);

describe('beat-detect (live)', () => {
  it('locks to 120 BPM, counts beats, ramps through each beat and pulses on each click', () => {
    const t = clickTrack(120, 16, 0);
    const r = run({ decay: 100 }, t.audio, t.audio.length);
    expect(Math.abs(r.signals.bpm - 120)).toBeLessThan(1);
    const h = r.signalHistory;
    // a pulse jumps to ~1 right after a click and has fallen after 150 ms
    const click = t.times[20];
    expect(Math.max(...h.onset.slice(block(click), block(click + 0.04)))).toBeGreaterThan(0.85);
    expect(h.onset[block(click + 0.2)]).toBeLessThan(0.05);
    // onset pulse count over 16 s: one rising edge per click
    let edges = 0;
    for (let i = 1; i < h.onset.length; i++) if (h.onset[i] > 0.8 && h.onset[i - 1] <= 0.8) edges++;
    expect(edges).toBe(t.times.length);
    // beat count rises by one per beat after the lock; the ramp is a sawtooth with period 0.5 s
    const c0 = h.count[block(8)];
    const c1 = h.count[block(12)];
    expect(c1 - c0).toBe(8);
    const ph = h.phase.slice(block(8), block(10));
    let wraps = 0;
    for (let i = 1; i < ph.length; i++) if (ph[i] < ph[i - 1] - 0.5) wraps++;
    expect(wraps).toBe(4);
    // bar ramp: 4 beats per bar -> a wrap every 2 s
    const bar = h.bar.slice(block(6), block(12));
    let barWraps = 0;
    for (let i = 1; i < bar.length; i++) if (bar[i] < bar[i - 1] - 0.5) barWraps++;
    expect(barWraps).toBe(3);
  });
  it('is silent on silence and keeps level in 0..1', () => {
    const r = run({}, new Float32Array(SR * 4), SR * 4);
    for (const k of ['onset', 'beat', 'kick', 'snare', 'hat', 'phase', 'bar', 'bpm', 'count']) expect(r.signals[k]).toBe(0);
    expect(r.signals.level).toBe(0);
    const loud = run({}, clickTrack(120, 4).audio, SR * 4);
    expect(Math.max(...loud.signalHistory.level)).toBeLessThanOrEqual(1);
    expect(Math.max(...loud.signalHistory.level)).toBeGreaterThan(0.3);
  });
  it('kick and hat outputs follow their drums', () => {
    const d = drumPattern(120, 8);
    const r = run({ decay: 80 }, d.audio, d.audio.length);
    const h = r.signalHistory;
    const at = (k: string, t: number) => Math.max(...h[k].slice(block(t), block(t + 0.03)));
    const kickT = d.kick[3];
    const snareT = d.snare[3];
    expect(at('kick', kickT)).toBeGreaterThan(0.8);
    expect(at('snare', snareT)).toBeGreaterThan(0.8);
    expect(at('hat', d.hat[7] + 0.0)).toBeGreaterThan(0.8);
    // a pure off-beat hat does not fire the kick
    const offHat = d.hat[9];
    expect(at('kick', offHat)).toBeLessThan(0.2);
  });
});

describe('beat-detect (analysed)', () => {
  const t = clickTrack(120, 20, 0);
  const grid = analyzeTrack(t.audio, SR);
  const analysis = { proc: null, grid };
  const aRun = (params: Record<string, unknown>, frames = SR * 12) => run({ analysis, decay: 100, ...params }, undefined, frames);

  it('outputs exact beats without any audio and the same twice', () => {
    const a = aRun({});
    const b = aRun({});
    expect(a.signalHistory.beat).toEqual(b.signalHistory.beat);
    expect(Math.abs(a.signals.bpm - 120)).toBeLessThan(1);
    const beatT = grid.beats[10];
    expect(Math.max(...a.signalHistory.beat.slice(block(beatT), block(beatT) + 2))).toBeGreaterThan(0.9);
    expect(a.signalHistory.beat[block(beatT - 0.1)]).toBeLessThan(0.1);
    // count is the beat index of the current time
    expect(a.signalHistory.count[block(grid.beats[7] + 0.1)]).toBe(7);
  });
  it('offset moves the beats, half and double change the count rate, bpmOverride is a steady grid', () => {
    const base = aRun({});
    const late = aRun({ offset: 100 });
    const b = grid.beats[8];
    const firstRise = (h: number[]) => h.findIndex((v, i) => i > block(b - 0.2) && v > 0.9);
    expect(firstRise(late.signalHistory.beat) - firstRise(base.signalHistory.beat)).toBeCloseTo(Math.round((0.1 * SR) / 128), -1);
    const at = block(10);
    expect(aRun({ double: true }).signalHistory.count[at]).toBeGreaterThanOrEqual(2 * base.signalHistory.count[at] - 2);
    expect(aRun({ half: true }).signalHistory.count[at]).toBeLessThanOrEqual(Math.round(base.signalHistory.count[at] / 2) + 1);
    expect(Math.abs(aRun({ bpmOverride: 100 }).signals.bpm - 100)).toBeLessThan(0.01);
    // always live ignores the analysis: without input there is nothing to hear
    expect(aRun({ mode: 'live' }).signals.beat).toBe(0);
  });
  it('snap makes the beats divide a loop that nearly fits', () => {
    const r = run({ analysis, snap: true, decay: 100 }, undefined, SR * 8, { loop: true, duration: 8.04 });
    expect(r.signals.bpm).toBeCloseTo((60 * 16) / 8.04, 2);
  });
  it('level still comes from the wired sound', () => {
    const r = run({ analysis }, t.audio, SR * 2);
    expect(Math.max(...r.signalHistory.level)).toBeGreaterThan(0.2);
  });
});

describe('beat-detect (process job and export)', () => {
  it('the analyse job stores a grid that the handle round-trips', async () => {
    const t = clickTrack(100, 12, 0);
    const d = def();
    const proc = d.process!;
    const params = { track: ['a'], sensitivity: 0.5 };
    let progress = 0;
    const out = await proc.run({
      params,
      host: { assetAudio: async () => ({ sampleRate: SR, channels: [t.audio, t.audio] }) },
      progress: (f: number) => (progress = f),
      yield: async () => undefined,
    } as never);
    const meta = (out as { meta: { analysis: { bpm: number } } }).meta;
    expect(Math.abs(meta.analysis.bpm - 100)).toBeLessThan(1);
    expect(progress).toBeGreaterThan(0.9);
    const result = { signature: 's', items: {}, meta: meta as Record<string, unknown>, bytes: 0, createdAt: 1, seconds: 1 };
    const patch = proc.handle!.write(result);
    expect(proc.handle!.read(patch)?.signature).toBe('s');
    expect(proc.handle!.read(patch)?.meta.analysis).toBeUndefined(); // the grid lives next to the handle, not inside it
    expect(proc.handle!.read(proc.handle!.clear())).toBeNull();
    await expect(proc.run({ params: { track: [], sensitivity: 0.5 }, host: {}, progress: () => undefined, yield: async () => undefined } as never)).rejects.toThrow(/Choose/);
    expect(proc.signature({ ...params } as never, {})).not.toBe(proc.signature({ ...params, track: ['b'] } as never, {}));
  });
  it('an export replays the beat as per-frame tracks (analysed file wired to the node)', async () => {
    const t = clickTrack(120, 6, 0);
    const grid = analyzeTrack(t.audio, SR);
    const g = makeGraph(
      {
        nodes: [
          { id: 'f', type: 'audio-file', params: { assets: ['song'] } },
          { id: 'b', type: 'beat-detect', params: { analysis: { proc: null, grid }, decay: 200 } },
        ],
        edges: ['f.audio -> b.audio'],
      },
      { fps: 24, duration: 6 },
    );
    const asset = async (id: string) => (id === 'song' ? { sampleRate: SR, channels: [t.audio] } : null);
    const tracks = await analyzeSignalsOffline(g, audioRegistry(), asset, { duration: 6, fps: 24, loop: false });
    const again = await analyzeSignalsOffline(g, audioRegistry(), asset, { duration: 6, fps: 24, loop: false });
    const beatFrames = [...Array(144).keys()].filter((f) => tracks.value('b', 'beat', f) > 0.3);
    expect(beatFrames.length).toBeGreaterThan(10);
    expect([...Array(144).keys()].map((f) => tracks.value('b', 'beat', f))).toEqual([...Array(144).keys()].map((f) => again.value('b', 'beat', f)));
    expect(tracks.value('b', 'count', 100)).toBeGreaterThan(tracks.value('b', 'count', 40));
    // live-only (no analysis) detection is deterministic in an export too
    const g2 = makeGraph({ nodes: g.nodes.map((n) => (n.id === 'b' ? { id: 'b', type: 'beat-detect', params: { decay: 200 } } : { id: n.id, type: n.type, params: n.params })), edges: ['f.audio -> b.audio'] }, { fps: 24, duration: 6 });
    const l1 = await analyzeSignalsOffline(g2, audioRegistry(), asset, { duration: 6, fps: 24, loop: false });
    const l2 = await analyzeSignalsOffline(g2, audioRegistry(), asset, { duration: 6, fps: 24, loop: false });
    expect([...Array(144).keys()].map((f) => l1.value('b', 'onset', f))).toEqual([...Array(144).keys()].map((f) => l2.value('b', 'onset', f)));
    expect(Math.max(...[...Array(144).keys()].map((f) => l1.value('b', 'onset', f)))).toBeGreaterThan(0.5);
  });
});
