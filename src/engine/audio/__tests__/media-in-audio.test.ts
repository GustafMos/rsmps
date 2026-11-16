import { describe, expect, it } from 'vitest';
import { clipLocal, clipMap, clipSourceTime } from '../../lib/media-time';
import { analyzeSignalsOffline, renderAudioOffline } from '../offline';
import { audioAssetIds, hasExportAudio } from '../runner';
import { SR, audioRegistry, getDef, makeGraph, peak, renderGraph, runKernel, sine } from '../testing';
import type { AudioAsset, AudioIO } from '../types';

const FRAMES = 2 * SR;
/** A 2 s "video sound track" whose sample value is its own position: value * FRAMES = sample index. */
const ramp = new Float32Array(FRAMES).map((_, i) => i / FRAMES);
const clip = (video = { duration: 2, fps: 24 }): AudioAsset => ({ sampleRate: SR, frames: FRAMES, left: ramp, right: ramp, video });
const base = { assets: ['clip'], trim: [0, 1], fps: 0, offset: 0, loopVideo: true, volume: 0, mute: false };
const run = (params: Record<string, unknown>, frames: number, time: Record<string, unknown> = {}, asset: AudioAsset | null = clip()) =>
  runKernel(getDef('media-in'), { params: { ...base, ...params }, assets: asset ? { clip: asset } : {}, frames, time: { playing: true, ...time } }).out.audio[0];
/** Source sample index read out of a ramp sample. */
const at = (x: Float32Array, i: number) => x[i] * FRAMES;

describe('clip-time mapping (shared by picture and sound)', () => {
  const info = { duration: 10, fps: 24 };
  const p = (o: Record<string, unknown> = {}) => ({ trim: [0, 1] as [number, number], fps: 0, offset: 0, loopVideo: true, ...o });
  it('plain playback, loop and clamp', () => {
    expect(clipSourceTime(info, p(), 3.5)).toBeCloseTo(3.5, 9);
    expect(clipSourceTime(info, p(), 12)).toBeCloseTo(2, 9); // looped
    expect(clipSourceTime(info, p({ loopVideo: false }), 12)).toBeCloseTo(10 - 1e-4, 9); // holds the last frame
    expect(clipSourceTime(info, p({ loopVideo: false }), -3)).toBe(0);
  });
  it('trim: in/out in either order, looping stays inside', () => {
    const t = p({ trim: [0.2, 0.6] }); // 2 s .. 6 s
    expect(clipSourceTime(info, t, 0)).toBeCloseTo(2, 9);
    expect(clipSourceTime(info, t, 3)).toBeCloseTo(5, 9);
    expect(clipSourceTime(info, t, 4)).toBeCloseTo(2, 9); // wrapped after the 4 s span
    expect(clipSourceTime(info, p({ trim: [0.6, 0.2] }), 3)).toBeCloseTo(5, 9);
    expect(clipMap(info, t)).toMatchObject({ a: 2, span: 4, rate: 1 });
  });
  it('offset shifts the start, also backwards (loop wraps)', () => {
    expect(clipSourceTime(info, p({ offset: 1.5 }), 0)).toBeCloseTo(1.5, 9);
    expect(clipSourceTime(info, p({ offset: -1 }), 0)).toBeCloseTo(9, 9);
    expect(clipLocal(clipMap(info, p({ offset: 2 })), p({ offset: 2 }), 1)).toBeCloseTo(3, 9);
  });
  it('frame-rate reinterpretation is a playback speed', () => {
    expect(clipMap(info, p({ fps: 12 })).rate).toBe(0.5);
    expect(clipSourceTime(info, p({ fps: 12 }), 4)).toBeCloseTo(2, 9);
    expect(clipSourceTime(info, p({ fps: 48 }), 4)).toBeCloseTo(8, 9);
    expect(clipMap({ duration: 10, fps: 0 }, p({ fps: 12 })).rate).toBe(1); // unknown native rate: no change
  });
  it('clips without a duration map to 0 and a degenerate trim keeps at least one frame', () => {
    expect(clipSourceTime({ duration: 0, fps: 24 }, p(), 5)).toBe(0);
    expect(clipMap(info, p({ trim: [0.5, 0.5] })).span).toBeCloseTo(1 / 24, 9);
  });
});

describe('Media In sound', () => {
  it('plays the track in sync with the transport', () => {
    const x = run({}, 1024, { sample: 4800 });
    expect(at(x, 500)).toBeCloseTo(5300, 0);
    expect(at(x, 900)).toBeCloseTo(5700, 0);
  });
  it('trim: starts at the in point and wraps at the out point', () => {
    const x = run({ trim: [0.25, 0.75] }, 2000); // 0.5 s .. 1.5 s
    expect(at(x, 1000)).toBeCloseTo(24000 + 1000, 0);
    const w = run({ trim: [0.25, 0.75] }, 4000, { sample: 47000 }); // 1 s into the span of 48000 samples: wraps after 1000 samples
    expect(at(w, 500)).toBeCloseTo(24000 + 47500, 0);
    expect(at(w, 1500)).toBeCloseTo(24000 + 500, 0); // past the wrap, past the fade
  });
  it('offset moves the sound earlier or later; without loop it is silent outside the clip', () => {
    expect(at(run({ offset: 0.1 }, 2000), 1000)).toBeCloseTo(4800 + 1000, 0);
    const late = run({ offset: -0.05, loopVideo: false }, 6000); // starts 0.05 s (2400 samples) late
    expect(peak(late.subarray(0, 2400))).toBe(0);
    expect(at(late, 3000)).toBeCloseTo(600, 0);
    const past = run({ loopVideo: false }, 2000, { sample: FRAMES + 100 });
    expect(peak(past)).toBe(0); // after the end of the clip
  });
  it('speed: fps 12 on a 24 fps clip is half speed (pitch follows), 48 is double', () => {
    const half = run({ fps: 12 }, 3000);
    expect(at(half, 1200) - at(half, 1000)).toBeCloseTo(100, 0);
    expect(at(half, 1000)).toBeCloseTo(500, 0);
    const dbl = run({ fps: 48 }, 3000);
    expect(at(dbl, 1200) - at(dbl, 1000)).toBeCloseTo(400, 0);
    const tone: AudioAsset = { ...clip(), left: sine(440, FRAMES, SR, 0.5), right: sine(440, FRAMES, SR, 0.5) };
    const y = run({ fps: 12 }, 24000, { sample: 1000 }, tone);
    let crossings = 0;
    for (let i = 1; i < y.length; i++) if (y[i - 1] < 0 && y[i] >= 0) crossings++;
    expect(crossings / (24000 / SR)).toBeCloseTo(220, -1); // an octave down
  });
  it('the batch item picks the asset', () => {
    const a = { ...clip(), left: new Float32Array(FRAMES).fill(0.25), right: new Float32Array(FRAMES).fill(0.25) };
    const b = { ...clip(), left: new Float32Array(FRAMES).fill(0.5), right: new Float32Array(FRAMES).fill(0.5) };
    const get = (item: number) => runKernel(getDef('media-in'), { params: { ...base, assets: ['a', 'b'] }, assets: { a, b }, frames: 1024, time: { playing: true, item, sample: 2000 } }).out.audio[0][600];
    expect(get(0)).toBeCloseTo(0.25, 5);
    expect(get(1)).toBeCloseTo(0.5, 5);
    expect(get(2)).toBeCloseTo(0.25, 5); // wraps around the list
  });
  it('is silent without sound, for missing assets, when muted, paused or with no media; volume applies', () => {
    expect(peak(run({}, 1024, {}, null))).toBe(0); // image, image sequence, video without sound: the host has no PCM
    expect(peak(run({ mute: true }, 1024))).toBe(0);
    expect(peak(run({}, 1024, { playing: false }))).toBe(0);
    expect(peak(run({ assets: [] }, 1024))).toBe(0);
    const loud = peak(run({}, 2000, { sample: 20000 }));
    expect(peak(run({ volume: -6.0206 }, 2000, { sample: 20000 })) / loud).toBeCloseTo(0.5, 2);
  });
  it('fades hide the click at loop wraps, trim edges and seeks', () => {
    const tone: AudioAsset = { ...clip(), left: sine(440, FRAMES, SR, 0.5), right: sine(440, FRAMES, SR, 0.5) };
    const maxJump = (x: Float32Array) => {
      let m = 0;
      for (let i = 1; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
      return m;
    };
    const natural = 0.5 * 2 * Math.PI * 440 / SR; // fastest step of the sine itself
    // a 0.1013 s loop is not a whole number of cycles: without fades each wrap would jump
    const looped = run({ trim: [0, 0.05065] }, SR, {}, tone);
    expect(maxJump(looped)).toBeLessThan(natural * 1.3);
    expect(peak(looped)).toBeGreaterThan(0.45);
    // non-loop trim edges
    const edge = run({ trim: [0.1, 0.2], loopVideo: false }, SR, {}, tone);
    expect(maxJump(edge)).toBeLessThan(natural * 1.3);
    // seeks: drive the kernel by hand with a jump in the middle
    const kernel = getDef('media-in').audio!;
    const st = kernel.create({ sampleRate: SR, blockSize: 128, nodeId: 'm' });
    const out = [new Float32Array(128), new Float32Array(128)] as [Float32Array, Float32Array];
    const trace: number[] = [];
    for (const sample of [0, 128, 256, 30000, 30128, 30256]) {
      out[0].fill(0);
      kernel.process(st, { frames: 128, sampleRate: SR, in: {}, midiIn: {}, out: { audio: out }, midiOut: {}, params: { ...base }, signal: () => {}, time: { seconds: sample / SR, sample, bpm: 120, playing: true, loop: false, duration: 0, item: 0 }, assets: { get: () => tone }, live: { mic: null, deviceMidi: [], uiMidi: [] } } as unknown as AudioIO);
      trace.push(...out[0]);
    }
    expect(maxJump(Float32Array.from(trace))).toBeLessThan(natural * 1.3);
  });
});

describe('Media In sound in the graph', () => {
  const graph = (mediaParams: Record<string, unknown> = {}, outParams: Record<string, unknown> = {}, wired = true) =>
    makeGraph(
      {
        nodes: [
          { id: 'm', type: 'media-in', params: { assets: ['clip'], ...mediaParams } },
          { id: 'g', type: 'gain', params: { gain: -6.0206 } },
          { id: 'out', type: 'audio-out', params: { limiter: false, ...outParams } },
        ],
        edges: wired ? ['m.audio -> g.audio', 'g.audio -> out.audio'] : [],
      },
      { duration: 1, loop: false },
    );
  const pcm = { sampleRate: SR, channels: [sine(300, FRAMES, SR, 0.8)], video: { duration: 2, fps: 24 } };

  it('only requests the decoding of assets whose Sound output is wired, and only the current item', () => {
    const reg = audioRegistry();
    expect(audioAssetIds(graph({}, {}, false), reg)).toEqual([]);
    expect(audioAssetIds(graph(), reg)).toEqual(['clip']);
    expect(audioAssetIds(graph({ assets: ['a', 'b', 'c'] }), reg, 1)).toEqual(['b']);
    expect(audioAssetIds(graph({ assets: ['a', 'b', 'c'] }), reg, 4)).toEqual(['b']);
    expect(audioAssetIds(graph({ assets: [] }), reg)).toEqual([]);
  });
  it('counts as export audio when it reaches an enabled Audio Out (and not otherwise)', async () => {
    const reg = audioRegistry();
    expect(hasExportAudio(graph(), reg)).toBe(true);
    expect(hasExportAudio(graph({}, { enabled: false }), reg)).toBe(false);
    expect(await renderAudioOffline(graph({}, { enabled: false }), reg, async () => pcm, { duration: 1, loop: false })).toBeNull();
  });
  it('offline render equals the realtime runner and applies the effects in between', async () => {
    const g = graph({ trim: [0.1, 0.6], fps: 12 });
    const off = await renderAudioOffline(g, audioRegistry(), async (id) => (id === 'clip' ? pcm : null), { duration: 1, loop: false });
    const live = renderGraph(g, 1, { assets: { clip: pcm } }).left;
    expect(off!.channels[0]).toEqual(live);
    expect(peak(live)).toBeGreaterThan(0.2);
    expect(peak(live)).toBeLessThan(0.45); // 0.8 through -6 dB
  });
  it('the item reaches the render', async () => {
    const quiet = { sampleRate: SR, channels: [new Float32Array(FRAMES).fill(0.1)], video: { duration: 2, fps: 24 } };
    const g = graph({ assets: ['clip', 'q'] });
    const get = async (item: number) => (await renderAudioOffline(g, audioRegistry(), async (id) => (id === 'q' ? quiet : id === 'clip' ? pcm : null), { duration: 0.5, loop: false, item }))!;
    expect(peak((await get(0)).channels[0])).toBeGreaterThan(0.3);
    expect(peak((await get(1)).channels[0])).toBeLessThan(0.06);
  });
  it('feeds the Timeline recordAudio and analysis taps like any other audio source', async () => {
    const g = makeGraph(
      { nodes: [{ id: 'm', type: 'media-in', params: { assets: ['clip'] } }, { id: 'lv', type: 'audio-level', params: { floor: -60, ceiling: 0 } }, { id: 'tl', type: 'audio-timeline' }], edges: ['m.audio -> lv.audio', 'm.audio -> tl.recordAudio'] },
      { duration: 1, loop: false },
    );
    const t = await analyzeSignalsOffline(g, audioRegistry(), async () => pcm, { duration: 1, fps: 24, loop: false });
    expect(t.value('lv', 'level', 12)).toBeGreaterThan(0.6);
  });
});

describe('registry and worklet bundle', () => {
  it('media-in still registers with its picture output and params, plus the Sound output and group', () => {
    const def = getDef('media-in');
    expect(Object.keys(def.outputs)).toEqual(['image', 'audio']);
    expect(typeof def.render).toBe('function');
    expect(def.params.volume).toMatchObject({ type: 'number', default: 0, group: 'Sound' });
    expect(def.params.mute).toMatchObject({ type: 'bool', default: false, group: 'Sound' });
    for (const k of ['assets', 'trim', 'fps', 'fullRes', 'loopVideo', 'offset']) expect(def.params[k], k).toBeDefined();
  });
  it('the AudioWorklet bundle contains Media In and no GPU or DOM code', async () => {
    const { build } = await import('vite');
    const res = (await build({
      configFile: false,
      publicDir: false,
      logLevel: 'silent',
      root: process.cwd(),
      build: { write: false, minify: false, lib: { entry: 'src/engine/audio/worklet.ts', formats: ['es'], fileName: 'worklet' } },
    })) as unknown as { output: { type: string; code?: string }[] }[] | { output: { type: string; code?: string }[] };
    const outputs = Array.isArray(res) ? res.flatMap((r) => r.output) : res.output;
    const code = outputs.map((o) => o.code ?? '').join('\n');
    expect(code).toContain('media-in');
    expect(code).toContain('registerProcessor');
    for (const bad of ['GPUDevice', 'GPUTexture', 'createTexture', 'document.', 'navigator.', 'window.']) expect(code, bad).not.toContain(bad);
  }, 60000);
});
