import { describe, expect, it } from 'vitest';
import { defineNode } from '../../define';
import { Registry } from '../../define';
import { analyzeSignalsOffline, renderAudioOffline } from '../offline';
import { registerAudioNodes } from '../nodes';
import { AudioGraphRunner, audioAssetIds, hasAudioOutput, hasExportAudio } from '../runner';
import { SR, allFinite, audioRegistry, db, makeGraph, noise, off, on, peak, renderGraph, rms, sine, toneAmp, zeroCrossFreq } from '../testing';
import { defineAudio } from '../types';

describe('graph compile and layering', () => {
  it('a source wired to audio-out is heard at the right level', () => {
    const g = makeGraph({ nodes: [{ id: 'o', type: 'oscillator', params: { wave: 'sine', frequency: 440, level: -6 } }, { id: 'out', type: 'audio-out', params: { limiter: false } }], edges: ['o.audio -> out.audio'] });
    const { left, right } = renderGraph(g, 0.5);
    expect(db(peak(left, 2000))).toBeCloseTo(-6, 1);
    expect(left).toEqual(right);
  });

  it('several wires into one input are summed (layering): two equal tones are +6 dB', () => {
    const one = renderGraph(makeGraph({ nodes: [{ id: 'a', type: 'oscillator', params: { frequency: 300, level: -12 } }, { id: 'out', type: 'audio-out', params: { limiter: false } }], edges: ['a.audio -> out.audio'] }), 0.3).left;
    const two = renderGraph(
      makeGraph({
        nodes: [
          { id: 'a', type: 'oscillator', params: { frequency: 300, level: -12 } },
          { id: 'b', type: 'oscillator', params: { frequency: 300, level: -12 } },
          { id: 'out', type: 'audio-out', params: { limiter: false } },
        ],
        edges: ['a.audio -> out.audio', 'b.audio -> out.audio'],
      }),
      0.3,
    ).left;
    expect(peak(two, 2000) / peak(one, 2000)).toBeCloseTo(2, 3);
  });

  it('mixer layers different sources: both frequencies present, master gain applies', () => {
    const g = makeGraph({
      nodes: [
        { id: 'a', type: 'oscillator', params: { frequency: 400, level: -12 } },
        { id: 'b', type: 'oscillator', params: { frequency: 1000, level: -12 } },
        { id: 'c', type: 'oscillator', params: { frequency: 2500, level: -12 } },
        { id: 'mix', type: 'mixer', params: { gain: -6.0206 } },
        { id: 'out', type: 'audio-out', params: { limiter: false } },
      ],
      edges: ['a.audio -> mix.audio', 'b.audio -> mix.audio', 'c.audio -> mix.audio', 'mix.audio -> out.audio'],
    });
    const { left } = renderGraph(g, 1);
    const single = Math.pow(10, -12 / 20) * 0.5;
    for (const f of [400, 1000, 2500]) expect(toneAmp(left, f, SR, 9600, 40000)).toBeCloseTo(single, 2);
  });

  it('effect chains process the previous effect output (gain then filter)', () => {
    const g = makeGraph({
      nodes: [
        { id: 'o', type: 'oscillator', params: { frequency: 8000, level: -6 } },
        { id: 'f', type: 'filter', params: { type: 'lowpass', cutoff: 500 } },
        { id: 'out', type: 'audio-out', params: { limiter: false } },
      ],
      edges: ['o.audio -> f.audio', 'f.audio -> out.audio'],
    });
    expect(peak(renderGraph(g, 0.3).left, 4000)).toBeLessThan(0.01);
  });

  it('microphone → audio-to-midi → synth → out: renders silent offline (live sources are silent)', () => {
    const g = makeGraph({
      nodes: [
        { id: 'mic', type: 'microphone', params: { monitor: true } },
        { id: 'a2m', type: 'audio-to-midi' },
        { id: 'syn', type: 'synth' },
        { id: 'mon', type: 'gain' },
        { id: 'out', type: 'audio-out' },
      ],
      edges: ['mic.tap -> a2m.audio', 'a2m.midi -> syn.midi', 'syn.audio -> out.audio', 'mic.audio -> mon.audio', 'mon.audio -> out.audio'],
    });
    const { left, right, runner } = renderGraph(g, 2);
    expect(peak(left)).toBe(0);
    expect(peak(right)).toBe(0);
    expect(runner.nodeCount).toBe(5);
  });

  it('live microphone → audio-to-midi → synth sounds the sung pitch (end to end)', () => {
    const g = makeGraph({
      nodes: [
        { id: 'mic', type: 'microphone' },
        { id: 'a2m', type: 'audio-to-midi' },
        { id: 'syn', type: 'synth', params: { wave1: 'sine', mix: 0, cutoff: 20000, attack: 0.005, release: 0.05, gain: 0 } },
        { id: 'out', type: 'audio-out', params: { limiter: false } },
      ],
      edges: ['mic.tap -> a2m.audio', 'a2m.midi -> syn.midi', 'syn.audio -> out.audio'],
    });
    const f = 440 * Math.pow(2, (60 - 69) / 12) * Math.pow(2, 20 / 1200); // a slightly sharp C4 sung into the mic
    const mic = new Float32Array(SR);
    mic.set(sine(f, Math.round(SR * 0.7), SR, 0.5));
    const { left } = renderGraph(g, 1, { mic });
    const c4 = 440 * Math.pow(2, -9 / 12);
    expect(zeroCrossFreq(left, SR, Math.round(0.4 * SR), Math.round(0.65 * SR)) / c4).toBeCloseTo(1, 2); // re-sung exactly in tune
    expect(rms(left, SR - 6000, SR)).toBeLessThan(1e-3); // and released after the singing stops
  });

  it('keyboard → arpeggiator → chord → synth works through MIDI wires', () => {
    const g = makeGraph({
      nodes: [
        { id: 'kb', type: 'midi-keyboard' },
        { id: 'arp', type: 'arpeggiator', params: { rate: '1/8', bpm: 120 } },
        { id: 'syn', type: 'synth', params: { wave1: 'sine', mix: 0, cutoff: 20000, gain: 0 } },
        { id: 'out', type: 'audio-out', params: { limiter: false } },
      ],
      edges: ['kb.midi -> arp.midi', 'arp.midi -> syn.midi', 'syn.audio -> out.audio'],
    });
    const runner = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    runner.setGraph(g);
    runner.setTransport({ playing: true, seconds: 0, duration: 4, loop: false });
    runner.sendMidi('kb', on(69, 0));
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    const all = new Float32Array(SR);
    for (let p = 0; p < SR; p += 128) {
      runner.process(L, R, Math.min(128, SR - p));
      all.set(L.subarray(0, Math.min(128, SR - p)), p);
    }
    expect(rms(all, 6000, 24000)).toBeGreaterThan(0.05);
    runner.sendMidi('kb', off(69, 0));
    for (let p = 0; p < SR; p += 128) runner.process(L, R, 128);
    expect(peak(L)).toBe(0);
  });

  it('only nodes upstream of an output run', () => {
    const g = makeGraph({
      nodes: [
        { id: 'o', type: 'oscillator' },
        { id: 'unused', type: 'reverb' },
        { id: 'out', type: 'audio-out' },
        { id: 'orphan', type: 'oscillator' },
      ],
      edges: ['o.audio -> out.audio', 'orphan.audio -> unused.audio'],
    });
    const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR });
    r.setGraph(g);
    expect(r.nodeCount).toBe(2);
    expect(r.hasNode('unused')).toBe(false);
  });

  it('hasAudioOutput / audioAssetIds', () => {
    const reg = audioRegistry();
    const none = makeGraph({ nodes: [{ id: 'o', type: 'oscillator' }, { id: 'out', type: 'audio-out' }], edges: [] });
    expect(hasAudioOutput(none, reg)).toBe(false);
    const yes = makeGraph({ nodes: [{ id: 'o', type: 'oscillator' }, { id: 'out', type: 'audio-out' }], edges: ['o.audio -> out.audio'] });
    expect(hasAudioOutput(yes, reg)).toBe(true);
    const f = makeGraph({ nodes: [{ id: 'f', type: 'audio-file', params: { assets: ['x1', 'x2'] } }], edges: [] });
    expect(audioAssetIds(f, reg).sort()).toEqual(['x1', 'x2']);
  });
});

describe('bypass', () => {
  it('a bypassed effect passes audio through untouched; a bypassed source is silent', () => {
    const mk = (bypass: boolean) =>
      makeGraph({
        nodes: [
          { id: 'o', type: 'oscillator', params: { frequency: 6000, level: -6 } },
          { id: 'f', type: 'filter', params: { type: 'lowpass', cutoff: 200 }, bypass },
          { id: 'out', type: 'audio-out', params: { limiter: false } },
        ],
        edges: ['o.audio -> f.audio', 'f.audio -> out.audio'],
      });
    expect(peak(renderGraph(mk(false), 0.3).left, 4000)).toBeLessThan(0.01);
    expect(db(peak(renderGraph(mk(true), 0.3).left, 4000))).toBeCloseTo(-6, 1);
    const src = makeGraph({ nodes: [{ id: 'o', type: 'oscillator', bypass: true }, { id: 'out', type: 'audio-out' }], edges: ['o.audio -> out.audio'] });
    expect(peak(renderGraph(src, 0.2).left)).toBe(0);
  });
  it('a bypassed MIDI effect passes notes through', () => {
    const g = makeGraph({
      nodes: [
        { id: 'kb', type: 'midi-keyboard' },
        { id: 'tr', type: 'midi-transpose', params: { semitones: 12 }, bypass: true },
        { id: 'syn', type: 'synth', params: { wave1: 'sine', mix: 0, cutoff: 20000, gain: 0 } },
        { id: 'out', type: 'audio-out', params: { limiter: false } },
      ],
      edges: ['kb.midi -> tr.midi', 'tr.midi -> syn.midi', 'syn.audio -> out.audio'],
    });
    const runner = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    runner.setGraph(g);
    runner.sendMidi('kb', on(69, 0));
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    const out = new Float32Array(128 * 180);
    for (let p = 0; p < out.length; p += 128) {
      runner.process(L, R, 128);
      out.set(L, p);
    }
    expect(zeroCrossFreq(out, SR, 6000, out.length - 100)).toBeCloseTo(440, -1);
  });
});

describe('updates keep state', () => {
  const base = () =>
    makeGraph({
      nodes: [
        { id: 'o', type: 'oscillator', params: { frequency: 440, level: -6 } },
        { id: 'd', type: 'delay', params: { time: 300, feedback: 0.5, mix: 0.5 } },
        { id: 'out', type: 'audio-out', params: { limiter: false } },
      ],
      edges: ['o.audio -> d.audio', 'd.audio -> out.audio'],
    });

  it('param-only update: no rebuild, same state objects, new value takes effect', () => {
    const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    const g = base();
    expect(r.setGraph(g)).toBe(true);
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let i = 0; i < 100; i++) r.process(L, R, 128);
    const delayState = r.stateOf('d');
    const oscState = r.stateOf('o');
    const g2 = { ...g, nodes: g.nodes.map((n) => (n.id === 'o' ? { ...n, params: { ...n.params, level: -20 } } : n)) };
    expect(r.setGraph(g2)).toBe(false);
    expect(r.stateOf('d')).toBe(delayState);
    expect(r.stateOf('o')).toBe(oscState);
    for (let i = 0; i < 400; i++) r.process(L, R, 128);
    expect(db(peak(L))).toBeLessThan(-14); // quieter now (delay tail included)
  });

  it('topology change keeps the state of nodes that stay (same id and type)', () => {
    const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR });
    const g = base();
    r.setGraph(g);
    const dState = r.stateOf('d');
    const g2 = {
      ...g,
      nodes: [...g.nodes, { id: 'g', type: 'gain', x: 0, y: 0, params: {} }],
      edges: [{ id: 'e0', from: { node: 'o', port: 'audio' }, to: { node: 'd', port: 'audio' } }, { id: 'e1', from: { node: 'd', port: 'audio' }, to: { node: 'g', port: 'audio' } }, { id: 'e2', from: { node: 'g', port: 'audio' }, to: { node: 'out', port: 'audio' } }],
    };
    expect(r.setGraph(g2)).toBe(true);
    expect(r.stateOf('d')).toBe(dState);
    expect(r.nodeCount).toBe(4);
  });

  it('a node whose type changed gets fresh state', () => {
    const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR });
    const g = base();
    r.setGraph(g);
    const before = r.stateOf('d');
    r.setGraph({ ...g, nodes: g.nodes.map((n) => (n.id === 'd' ? { ...n, type: 'reverb' } : n)) });
    expect(r.stateOf('d')).not.toBe(before);
  });

  it('rebuild fades in instead of starting at full level', () => {
    const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: true });
    r.setGraph(makeGraph({ nodes: [{ id: 'o', type: 'oscillator', params: { frequency: 1000, level: 0 } }, { id: 'out', type: 'audio-out', params: { limiter: false } }], edges: ['o.audio -> out.audio'] }));
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    r.process(L, R, 128);
    expect(Math.abs(L[0])).toBeLessThan(0.01);
    for (let i = 0; i < 20; i++) r.process(L, R, 128);
    expect(peak(L)).toBeGreaterThan(0.9);
  });
});

describe('robustness', () => {
  it('a kernel that produces NaN is contained and reset, the rest of the mix survives', () => {
    const reg = registerAudioNodes(new Registry());
    let calls = 0;
    reg.register(
      defineNode({
        id: 'bad-source',
        title: 'Bad',
        category: 'audio-source',
        description: 'x',
        inputs: {},
        outputs: { audio: { type: 'audio' } },
        params: {},
        audio: defineAudio({
          create: () => ({}),
          process(_s, io) {
            calls++;
            io.out.audio[0].fill(NaN);
            io.out.audio[1].fill(Infinity);
          },
        }),
      }),
    );
    const g = makeGraph({
      nodes: [
        { id: 'bad', type: 'bad-source' },
        { id: 'ok', type: 'oscillator', params: { level: -6 } },
        { id: 'out', type: 'audio-out', params: { limiter: false } },
      ],
      edges: ['bad.audio -> out.audio', 'ok.audio -> out.audio'],
    });
    const r = new AudioGraphRunner(reg, { sampleRate: SR, fadeOnRebuild: false });
    r.setGraph(g);
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let i = 0; i < 10; i++) r.process(L, R, 128);
    expect(calls).toBe(10);
    expect(r.faultCount).toBe(10);
    expect(allFinite(L) && allFinite(R)).toBe(true);
    expect(peak(L)).toBeGreaterThan(0.3);
  });

  it('10 s through a long chain of every effect: finite, bounded, no denormal blow-up, silent input decays to exact silence', () => {
    const types = ['gain', 'eq', 'compressor', 'filter', 'distortion', 'chorus', 'flanger', 'delay', 'tremolo', 'pitch-shift', 'gate', 'stereo-width', 'reverb', 'limiter'];
    const nodes = [
      { id: 'src', type: 'oscillator', params: { wave: 'saw', frequency: 220, level: -6 } },
      ...types.map((t) => ({ id: t, type: t, params: t === 'eq' ? { lowGain: 6, m1Gain: -6 } : t === 'gain' ? {} : {} as Record<string, unknown> })),
      { id: 'out', type: 'audio-out', params: {} },
    ];
    const edges = ['src.audio -> gain.audio'];
    for (let i = 1; i < types.length; i++) edges.push(`${types[i - 1]}.audio -> ${types[i]}.audio`);
    edges.push(`${types[types.length - 1]}.audio -> out.audio`);
    const { left, right, runner } = renderGraph(makeGraph({ nodes, edges }), 10);
    expect(allFinite(left) && allFinite(right)).toBe(true);
    expect(peak(left)).toBeLessThan(1.0001);
    expect(peak(left, 8 * SR)).toBeGreaterThan(0.01);
    expect(runner.faultCount).toBe(0);
  });

  it('feedback tails fall to true zero or below 1e-9 (no denormal plateau)', () => {
    const g = makeGraph({
      nodes: [
        { id: 'a', type: 'oscillator', params: { wave: 'noise', level: -6 } },
        { id: 'rev', type: 'reverb', params: { decay: 1, mix: 1 } },
        { id: 'dly', type: 'delay', params: { time: 100, feedback: 0.6, mix: 1 } },
        { id: 'out', type: 'audio-out', params: { limiter: false } },
      ],
      edges: ['a.audio -> rev.audio', 'rev.audio -> dly.audio', 'dly.audio -> out.audio'],
    });
    const runner = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    runner.setGraph(g);
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let i = 0; i < 1000; i++) runner.process(L, R, 128);
    runner.setGraph({ ...g, nodes: g.nodes.map((n) => (n.id === 'a' ? { ...n, bypass: true } : n)) });
    for (let i = 0; i < 48 * 375; i++) runner.process(L, R, 128); // 48 s of silence in
    expect(peak(L)).toBeLessThan(1e-7);
  });

  it('fuzz: every node at random param values on noise stays finite', () => {
    const reg = audioRegistry();
    let seed = 99;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (const def of reg.list()) {
      if (def.category !== 'audio-fx') continue;
      for (let trial = 0; trial < 3; trial++) {
        const params: Record<string, unknown> = {};
        for (const [k, p] of Object.entries(def.params as Record<string, { type: string; min?: number; max?: number; options?: { value: string }[] }>)) {
          if (p.type === 'number') params[k] = (p.min ?? 0) + rnd() * ((p.max ?? 1) - (p.min ?? 0));
          else if (p.type === 'bool') params[k] = rnd() > 0.5;
          else if (p.type === 'enum') params[k] = p.options![Math.floor(rnd() * p.options!.length)].value;
        }
        const g = makeGraph({
          nodes: [{ id: 'n', type: 'oscillator', params: { wave: 'noise', level: 0 } }, { id: 'fx', type: def.id, params }, { id: 'out', type: 'audio-out', params: { limiter: false } }],
          edges: ['n.audio -> fx.audio', 'fx.audio -> out.audio'],
        });
        const { left, runner } = renderGraph(g, 1);
        expect(allFinite(left), `${def.id} ${JSON.stringify(params)}`).toBe(true);
        expect(runner.faultCount, `${def.id} fault`).toBe(0);
      }
    }
  });
});

describe('transport', () => {
  it('audio-file follows seeks: block starting at 1 s plays from 1 s', async () => {
    const reg = audioRegistry();
    const r = new AudioGraphRunner(reg, { sampleRate: SR, fadeOnRebuild: false });
    const ramp = new Float32Array(3 * SR).map((_, i) => i / (3 * SR));
    r.setAsset('clip', { sampleRate: SR, channels: [ramp] });
    r.setGraph(makeGraph({ nodes: [{ id: 'f', type: 'audio-file', params: { assets: ['clip'] } }, { id: 'out', type: 'audio-out', params: { limiter: false } }], edges: ['f.audio -> out.audio'] }));
    r.setTransport({ playing: true, seconds: 1, duration: 3, loop: false });
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let i = 0; i < 20; i++) r.process(L, R, 128);
    expect(L[127]).toBeCloseTo(ramp[SR + 20 * 128 - 1 + 0] ?? 0, 3);
    r.setTransport({ playing: false });
    r.process(L, R, 128);
    expect(peak(L)).toBe(0);
  });

  it('resamples assets to the context rate (44.1 kHz file at 48 kHz keeps its pitch)', () => {
    const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    r.setAsset('t', { sampleRate: 44100, channels: [sine(1000, 44100, 44100, 0.5)] });
    r.setGraph(makeGraph({ nodes: [{ id: 'f', type: 'audio-file', params: { assets: ['t'] } }, { id: 'out', type: 'audio-out', params: { limiter: false } }], edges: ['f.audio -> out.audio'] }));
    r.setTransport({ playing: true, seconds: 0, duration: 1, loop: false });
    const out = new Float32Array(SR);
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let p = 0; p + 128 <= SR; p += 128) {
      r.process(L, R, 128);
      out.set(L, p);
    }
    expect(zeroCrossFreq(out, SR, 2000, SR - 2000)).toBeCloseTo(1000, 0);
  });

  it('meters report the peak since last read', () => {
    const { runner } = renderGraph(makeGraph({ nodes: [{ id: 'o', type: 'oscillator', params: { level: -6 } }, { id: 'out', type: 'audio-out', params: { limiter: false } }], edges: ['o.audio -> out.audio'] }), 0.2);
    const m = runner.takeMeters();
    expect(m.o[0]).toBeCloseTo(0.5, 1);
    expect(runner.takeMeters().o[0]).toBe(0);
  });
});

describe('export switch on audio-out', () => {
  const two = (a: Record<string, unknown>, b: Record<string, unknown>, bypassB = false) =>
    makeGraph({
      nodes: [
        { id: 'o1', type: 'oscillator', params: { frequency: 300, level: -12 } },
        { id: 'o2', type: 'oscillator', params: { frequency: 900, level: -12 } },
        { id: 'out1', type: 'audio-out', params: { limiter: false, ...a } },
        { id: 'out2', type: 'audio-out', params: { limiter: false, ...b }, bypass: bypassB },
      ],
      edges: ['o1.audio -> out1.audio', 'o2.audio -> out2.audio'],
    });
  const render = (g: ReturnType<typeof two>) => renderAudioOffline(g, audioRegistry(), async () => null, { duration: 0.5, loop: false });

  it('a disabled audio-out is left out of the export but still heard live', async () => {
    const g = two({}, { enabled: false });
    expect(hasExportAudio(g, audioRegistry())).toBe(true);
    const pcm = (await render(g))!;
    expect(toneAmp(pcm.channels[0], 300, SR, 4800, 20000)).toBeGreaterThan(0.2);
    expect(toneAmp(pcm.channels[0], 900, SR, 4800, 20000)).toBeLessThan(0.01);
    // live playback (the normal runner) plays both
    const live = renderGraph(g, 0.5).left;
    expect(toneAmp(live, 300, SR, 4800, 20000)).toBeGreaterThan(0.2);
    expect(toneAmp(live, 900, SR, 4800, 20000)).toBeGreaterThan(0.2);
    expect(hasAudioOutput(g, audioRegistry())).toBe(true);
  });
  it('a bypassed audio-out is not exported either', async () => {
    const pcm = (await render(two({}, {}, true)))!;
    expect(toneAmp(pcm.channels[0], 900, SR, 4800, 20000)).toBeLessThan(0.01);
    expect(toneAmp(pcm.channels[0], 300, SR, 4800, 20000)).toBeGreaterThan(0.2);
  });
  it('everything disabled: nothing to export (null, no audio track) although there is still something to hear', async () => {
    const g = two({ enabled: false }, { enabled: false });
    expect(hasExportAudio(g, audioRegistry())).toBe(false);
    expect(hasAudioOutput(g, audioRegistry())).toBe(true);
    expect(await render(g)).toBeNull();
    expect(audioRegistry().get('audio-out')!.params.enabled).toMatchObject({ type: 'bool', default: true, label: 'Include in export' });
  });
  it('analysis taps are unaffected by the export switch', async () => {
    const g = makeGraph({
      nodes: [{ id: 'o', type: 'oscillator', params: { level: -12 } }, { id: 'lv', type: 'audio-level', params: { floor: -60, ceiling: 0 } }, { id: 'out', type: 'audio-out', params: { enabled: false } }],
      edges: ['o.audio -> lv.audio', 'o.audio -> out.audio'],
    });
    const t = await analyzeSignalsOffline(g, audioRegistry(), async () => null, { duration: 0.5, fps: 24, loop: false });
    expect(t.value('lv', 'level', 10)).toBeGreaterThan(0.5);
  });
});

describe('offline render', () => {
  it('renders an audio-file graph to PCM at the requested rate with effects applied, and null without an output', async () => {
    const reg = audioRegistry();
    const tone = sine(500, 2 * 44100, 44100, 0.5);
    const g = makeGraph({
      nodes: [
        { id: 'f', type: 'audio-file', params: { assets: ['a1'] } },
        { id: 'g', type: 'gain', params: { gain: -6.0206 } },
        { id: 'out', type: 'audio-out', params: { limiter: false } },
      ],
      edges: ['f.audio -> g.audio', 'g.audio -> out.audio'],
    });
    const pcm = await renderAudioOffline(g, reg, async (id) => (id === 'a1' ? { sampleRate: 44100, channels: [tone] } : null), { duration: 1.5, sampleRate: 48000, loop: false });
    expect(pcm!.sampleRate).toBe(48000);
    expect(pcm!.channels.length).toBe(2);
    expect(pcm!.channels[0].length).toBe(72000);
    expect(peak(pcm!.channels[0], 1000)).toBeCloseTo(0.25, 2);
    expect(zeroCrossFreq(pcm!.channels[0], 48000, 1000, 70000)).toBeCloseTo(500, 0);
    const noOut = makeGraph({ nodes: [{ id: 'f', type: 'oscillator' }], edges: [] });
    expect(await renderAudioOffline(noOut, reg, async () => null, { duration: 1, loop: false })).toBeNull();
  });

  it('is deterministic, starts at sample 0 without a fade, and loops deterministic noise identically', async () => {
    const reg = audioRegistry();
    const g = makeGraph({ nodes: [{ id: 'n', type: 'oscillator', params: { wave: 'noise', level: -6 } }, { id: 'out', type: 'audio-out', params: { limiter: false } }], edges: ['n.audio -> out.audio'] });
    const a = await renderAudioOffline(g, reg, async () => null, { duration: 0.5, loop: true });
    const b = await renderAudioOffline(g, reg, async () => null, { duration: 0.5, loop: true });
    expect(a!.channels[0]).toEqual(b!.channels[0]);
    expect(Math.abs(a!.channels[0][0])).toBeGreaterThan(0);
    expect(a!.sampleRate).toBe(48000);
  });

  it('offline render of a missing asset is silent, not an error', async () => {
    const g = makeGraph({ nodes: [{ id: 'f', type: 'audio-file', params: { assets: ['gone'] } }, { id: 'out', type: 'audio-out' }], edges: ['f.audio -> out.audio'] });
    const pcm = await renderAudioOffline(g, audioRegistry(), async () => null, { duration: 0.3, loop: false });
    expect(peak(pcm!.channels[0])).toBe(0);
  });
});

/**
 * Real-time factor of a runner: audio seconds processed per CPU second. Best of several short runs, because other
 * processes on the machine (parallel test workers, editors) only ever make a run slower, never faster.
 */
function realtimeFactor(runner: AudioGraphRunner, mic?: Float32Array): number {
  const L = new Float32Array(128);
  const R = new Float32Array(128);
  for (let i = 0; i < 300; i++) runner.process(L, R, 128, mic); // warm up the JIT
  const seconds = 2;
  const blocks = Math.round((seconds * SR) / 128);
  let best = Infinity;
  for (let rep = 0; rep < 5; rep++) {
    const t0 = performance.now();
    for (let i = 0; i < blocks; i++) runner.process(L, R, 128, mic);
    best = Math.min(best, performance.now() - t0);
  }
  return seconds / (best / 1000);
}

describe('performance', () => {
  it('a 10-node chain at 48 kHz runs comfortably faster than real time (>5x even on a loaded machine)', () => {
    const chain = ['gain', 'eq', 'compressor', 'filter', 'delay', 'chorus', 'distortion', 'reverb', 'limiter'];
    const nodes = [
      { id: 'src', type: 'oscillator', params: { wave: 'saw', frequency: 110, level: -9 } },
      ...chain.map((t) => ({ id: t, type: t, params: t === 'eq' ? { lowGain: 3, m1Gain: 3, m2Gain: -3, highGain: 2 } : ({} as Record<string, unknown>) })),
      { id: 'out', type: 'audio-out', params: {} },
    ];
    const edges = ['src.audio -> gain.audio'];
    for (let i = 1; i < chain.length; i++) edges.push(`${chain[i - 1]}.audio -> ${chain[i]}.audio`);
    edges.push(`${chain[chain.length - 1]}.audio -> out.audio`);
    const runner = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    runner.setGraph(makeGraph({ nodes, edges }));
    const speed = realtimeFactor(runner);
    console.log(`10-node chain: ${speed.toFixed(0)}x real time`);
    expect(speed).toBeGreaterThan(5);
  });

  it('a polyphonic synth patch (8 voices, unison 3, two oscillators, filter envelope) runs comfortably faster than real time (>3x under load)', () => {
    const g = makeGraph({
      nodes: [{ id: 'kb', type: 'midi-keyboard' }, { id: 'syn', type: 'synth', params: { unison: 3, voices: 8, wave2: 'square', envAmount: 2, resonance: 0.5 } }, { id: 'out', type: 'audio-out' }],
      edges: ['kb.midi -> syn.midi', 'syn.audio -> out.audio'],
    });
    const runner = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    runner.setGraph(g);
    for (const n of [48, 52, 55, 59, 62, 65, 67, 71]) runner.sendMidi('kb', on(n, 0));
    const speed = realtimeFactor(runner);
    console.log(`8-voice unison synth: ${speed.toFixed(0)}x real time`);
    expect(speed).toBeGreaterThan(3);
  });

  it('microphone -> audio-to-midi -> synth on a continuous voiced signal runs comfortably faster than real time (>5x under load)', () => {
    const g = makeGraph({ nodes: [{ id: 'mic', type: 'microphone' }, { id: 'a', type: 'audio-to-midi' }, { id: 's', type: 'synth' }, { id: 'out', type: 'audio-out' }], edges: ['mic.tap -> a.audio', 'a.midi -> s.midi', 's.audio -> out.audio'] });
    const runner = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    runner.setGraph(g);
    const speed = realtimeFactor(runner, noise(128, 3, 0.3));
    console.log(`mic -> pitch -> synth: ${speed.toFixed(0)}x real time`);
    expect(speed).toBeGreaterThan(5);
  });
});
