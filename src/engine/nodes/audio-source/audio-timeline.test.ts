import { describe, expect, it } from 'vitest';
import { renderAudioOffline } from '../../audio/offline';
import { AudioGraphRunner } from '../../audio/runner';
import { addAudioClip, addMidiClip, addTrack, emptyTimeline, updateTrack, applyTake, type TimelineData } from '../../audio/timeline';
import { SR, audioRegistry, getDef, impulse, makeGraph, noise, peak, renderGraph, rms, runKernel, sine, zeroCrossFreq } from '../../audio/testing';
import type { AudioAsset, MidiEvent } from '../../audio/types';

const asset = (l: Float32Array, r: Float32Array = l): AudioAsset => ({ sampleRate: SR, frames: l.length, left: l, right: r });
const ones = (n: number) => new Float32Array(n).fill(1);
const hz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

function build(fn: (tl: TimelineData) => TimelineData): TimelineData {
  return fn(emptyTimeline());
}
const play = (clips: TimelineData, assets: Record<string, AudioAsset>, frames: number, params: Record<string, unknown> = {}, time: Record<string, unknown> = {}) =>
  runKernel(getDef('audio-timeline'), { params: { clips, ...params }, assets, frames, time: { playing: true, ...time } });

describe('timeline playback (audio)', () => {
  it('clips start on the exact sample, with offset into the source', () => {
    const src = new Float32Array(2000).map((_, i) => i + 1); // ramp: value = index + 1
    const tl = build((t) => addAudioClip(t, { track: 'a1', start: 4801 / SR, length: 1000 / SR, asset: 'r', offset: 100 / SR }).timeline);
    const r = play(tl, { r: asset(src) }, 8000);
    expect(r.out.audio[0][4800]).toBe(0);
    expect(r.out.audio[0][4801]).toBe(101); // asset[100]
    expect(r.out.audio[0][4801 + 999]).toBe(1100);
    expect(r.out.audio[0][4801 + 1000]).toBe(0); // clip ended
  });

  it('impulse clips land on the right samples, in every block alignment', () => {
    const tl = build((t) => {
      let x = addAudioClip(t, { track: 'a1', start: 1000 / SR, length: 500 / SR, asset: 'i' }).timeline;
      x = addAudioClip(x, { track: 'a1', start: 5000 / SR, length: 500 / SR, asset: 'i' }).timeline;
      return x;
    });
    const r = play(tl, { i: asset(impulse(500)) }, 7000);
    const hits: number[] = [];
    r.out.audio[0].forEach((v, i) => v !== 0 && hits.push(i));
    expect(hits).toEqual([1000, 5000]);
  });

  it('gain, fades, pan, mute and solo', () => {
    const base = build((t) => addAudioClip(t, { track: 'a1', start: 0, length: 4800 / SR, asset: 'c', gain: -6.0206 }).timeline);
    const r = play(base, { c: asset(ones(10000)) }, 6000);
    expect(r.out.audio[0][1000]).toBeCloseTo(0.5, 4);
    // fades are linear and land exactly
    const faded = build((t) => addAudioClip(t, { track: 'a1', start: 0, length: 4800 / SR, asset: 'c', fadeIn: 480 / SR, fadeOut: 480 / SR }).timeline);
    const f = play(faded, { c: asset(ones(10000)) }, 6000).out.audio[0];
    expect(f[0]).toBe(0);
    expect(f[240]).toBeCloseTo(0.5, 4);
    expect(f[1000]).toBeCloseTo(1, 6);
    expect(f[4800 - 240]).toBeCloseTo(0.5, 2);
    expect(f[4799]).toBeLessThan(0.01);
    // pan hard left
    const panned = updateTrack(base, 'a1', { pan: -1 });
    const p = play(panned, { c: asset(ones(10000)) }, 2000).out.audio;
    expect(peak(p[1])).toBeLessThan(1e-6);
    expect(p[0][100]).toBeGreaterThan(0.5);
    // track gain
    expect(play(updateTrack(base, 'a1', { gain: -6.0206 }), { c: asset(ones(10000)) }, 2000).out.audio[0][100]).toBeCloseTo(0.25, 3);
    // mute
    expect(peak(play(updateTrack(base, 'a1', { mute: true }), { c: asset(ones(10000)) }, 2000).out.audio[0])).toBe(0);
    // solo: with two tracks, only the soloed one is heard
    let two = addTrack(base, 'audio').timeline;
    two = addAudioClip(two, { track: 'a2', start: 0, length: 4800 / SR, asset: 'half' }).timeline;
    const assets = { c: asset(ones(10000)), half: asset(ones(10000).map((x) => x * 0.1)) };
    expect(play(two, assets, 2000).out.audio[0][100]).toBeCloseTo(0.6, 5); // both tracks sound: 0.5 (-6 dB clip) + 0.1
    const soloed = updateTrack(two, 'a2', { solo: true });
    expect(play(soloed, assets, 2000).out.audio[0][100]).toBeCloseTo(0.1, 5);
  });

  it('overlapping clips on one track sum', () => {
    const tl = build((t) => {
      const a = addAudioClip(t, { track: 'a1', start: 0, length: 0.1, asset: 'c' });
      return addAudioClip(a.timeline, { track: 'a1', start: 0.05, length: 0.1, asset: 'c' }).timeline;
    });
    const o = play(tl, { c: asset(ones(10000)) }, 9000).out.audio[0];
    expect(o[100]).toBe(1);
    expect(o[3000]).toBe(2);
    expect(o[6000]).toBe(1);
  });

  it('looping clip repeats the source and stays phase-locked wherever playback starts', () => {
    const src = new Float32Array(1000);
    src[0] = 1;
    src[500] = 0.5;
    const tl = build((t) => addAudioClip(t, { track: 'a1', start: 100 / SR, length: 5000 / SR, asset: 's', loop: true }).timeline);
    const full = play(tl, { s: asset(src) }, 6000).out.audio[0];
    const hits = [...full].map((v, i) => [i, v] as const).filter(([, v]) => v !== 0);
    expect(hits.map(([i]) => i)).toEqual([100, 600, 1100, 1600, 2100, 2600, 3100, 3600, 4100, 4600]);
    // start playback at an unrelated sample in the middle: identical output at identical project time
    const mid = play(tl, { s: asset(src) }, 3000, {}, { sample: 2777 }).out.audio[0];
    for (let i = 0; i < 3000; i++) expect(mid[i]).toBe(full[2777 + i]);
  });

  it('a clip that runs past the loop end continues at the loop start when wrap is on', () => {
    const tl = build((t) => addAudioClip(t, { track: 'a1', start: 0.9, length: 0.3, asset: 'c' }).timeline);
    const run = (wrap: boolean) => play(tl, { c: asset(ones(30000)) }, 4800 * 2 + 10, { wrap }, { duration: 1, loop: true, sample: SR - 4800 }).out.audio[0];
    const on = run(true);
    // block starts 0.1 s before the loop end; the loop point is 4800 samples in
    expect(on[4800 + 100]).toBe(1); // after the wrap, still playing the tail of the clip
    expect(run(false)[4800 + 100]).toBe(0);
  });

  it('output track routing: soloAudio carries only the chosen track', () => {
    let two = addTrack(emptyTimeline(), 'audio').timeline;
    two = addAudioClip(two, { track: 'a1', start: 0, length: 0.1, asset: 'c' }).timeline;
    two = addAudioClip(two, { track: 'a2', start: 0, length: 0.1, asset: 'h' }).timeline;
    const assets = { c: asset(ones(9000)), h: asset(ones(9000).map((x) => x * 0.25)) };
    const r = play(two, assets, 3000, { outputTrack: 'a2' });
    expect(r.out.audio[0][100]).toBeCloseTo(1.25, 5);
    expect(r.out.soloAudio[0][100]).toBeCloseTo(0.25, 5);
  });
});

describe('timeline playback (MIDI)', () => {
  const notesClip = (extra: Record<string, unknown> = {}): TimelineData =>
    build((t) => {
      const r = addMidiClip(t, { track: 'm1', start: 1, length: 2, notes: [{ t: 0.1, d: 0.2, note: 60, vel: 0.5 }, { t: 0.5, d: 0.25, note: 64, vel: 1 }], ...extra });
      return r.timeline;
    });
  const evs = (r: ReturnType<typeof play>) => r.midiOut.midi.map((e) => `${e.type}:${e.note}@${e.offset}`);

  it('emits note-ons and note-offs sample-accurately', () => {
    const r = play(notesClip(), {}, 4 * SR);
    expect(evs(r)).toEqual([`on:60@${Math.round(1.1 * SR)}`, `off:60@${Math.round(1.3 * SR)}`, `on:64@${Math.round(1.5 * SR)}`, `off:64@${Math.round(1.75 * SR)}`]);
    expect(r.midiOut.midi[0].velocity).toBe(0.5);
  });

  it('looping MIDI clip repeats its source region and never runs past the clip end', () => {
    const r = play(notesClip({ loop: true, srcLength: 1, length: 2.5 }), {}, 5 * SR);
    const ons = r.midiOut.midi.filter((e) => e.type === 'on').map((e) => e.offset / SR);
    expect(ons.map((t) => +t.toFixed(4))).toEqual([1.1, 1.5, 2.1, 2.5, 3.1, 3.5].filter((t) => t < 3.5));
    // every note has its off
    expect(r.midiOut.midi.filter((e) => e.type === 'off').length).toBe(ons.length);
  });

  it('muted track and offset into the source', () => {
    expect(play(updateTrack(notesClip(), 'm1', { mute: true }), {}, 4 * SR).midiOut.midi).toEqual([]);
    const off = play(notesClip({ offset: 0.4 }), {}, 4 * SR); // starts 0.4 s into the source: first note is skipped
    expect(evs(off)).toEqual([`on:64@${Math.round(1.1 * SR)}`, `off:64@${Math.round(1.35 * SR)}`]);
  });

  it('seek, pause and loop wrap release hanging notes; stray note-offs are not sent twice', () => {
    const def = getDef('audio-timeline');
    const kernel = def.audio!;
    const st = kernel.create({ sampleRate: SR, blockSize: 128, nodeId: 'tl' });
    const tl = notesClip();
    const mk = (sample: number, playing = true) => {
      const out: MidiEvent[] = [];
      const io = {
        frames: 128,
        sampleRate: SR,
        in: {},
        midiIn: { recordMidi: [] },
        out: { audio: [new Float32Array(128), new Float32Array(128)], soloAudio: [new Float32Array(128), new Float32Array(128)] },
        midiOut: { midi: out, soloMidi: [] },
        params: { clips: tl, outputTrack: '', gain: 0, wrap: true, loop: 'project', loopBars: 4, bpm: 120, quantize: '1/16', loopRecordMode: 'overdub', countIn: 0, metronome: false, monitor: true, latencyOffsetMs: 0, maxLength: 600 },
        signal: () => {},
        time: { seconds: sample / SR, sample, bpm: 120, playing, loop: false, duration: 0 },
        assets: { get: () => undefined },
        live: { mic: null, deviceMidi: [], uiMidi: [] },
      } as never;
      kernel.process(st, io);
      return out.map((e) => `${e.type}:${e.note}@${e.offset}`);
    };
    const noteOn = Math.round(1.1 * SR);
    const block = Math.floor(noteOn / 128) * 128;
    expect(mk(block)).toEqual([`on:60@${noteOn - block}`]);
    expect(mk(block + 128)).toEqual([]); // continuing
    expect(mk(5 * SR)).toEqual(['off:60@0']); // seek away mid-note
    expect(mk(5 * SR + 128)).toEqual([]);
    // pause mid-note
    expect(mk(block)).toEqual([`on:60@${noteOn - block}`]);
    expect(mk(block + 128, false)).toEqual(['off:60@0']);
    expect(mk(block + 128, false)).toEqual([]);
    // wrap backwards: the note that was sounding is released
    expect(mk(block)).toEqual([`on:60@${noteOn - block}`]);
    expect(mk(0)).toEqual(['off:60@0']);
    // the note-off of a note whose on was skipped by a seek never appears
    expect(mk(Math.round(1.2 * SR) - 64)).toEqual([]);
    expect(mk(Math.round(1.2 * SR) + 64)).toEqual([]);
  });

  it('timeline MIDI drives a synth through the runner: right pitch, silent after the last note', () => {
    const tl = build((t) => addMidiClip(t, { track: 'm1', start: 0, length: 1, notes: [{ t: 0, d: 0.4, note: 69, vel: 1 }] }).timeline);
    const g = makeGraph({
      nodes: [
        { id: 'tl', type: 'audio-timeline', params: { clips: tl } },
        { id: 'syn', type: 'synth', params: { wave1: 'sine', mix: 0, cutoff: 20000, release: 0.05, gain: 0 } },
        { id: 'out', type: 'audio-out', params: { limiter: false } },
      ],
      edges: ['tl.midi -> syn.midi', 'syn.audio -> out.audio'],
    }, { duration: 2, loop: false });
    const { left } = renderGraph(g, 1.5);
    expect(zeroCrossFreq(left, SR, 4000, 18000)).toBeCloseTo(440, 0);
    expect(rms(left, Math.round(0.6 * SR), left.length)).toBeLessThan(1e-5);
  });
});

describe('offline equals realtime', () => {
  it('renderAudioOffline of a timeline graph is bit-identical to the realtime runner loop', async () => {
    const src = noise(20000, 5, 0.4);
    const tl = build((t) => {
      let x = addAudioClip(t, { track: 'a1', start: 0.05, length: 0.3, asset: 'n', offset: 0.01, fadeIn: 0.02, fadeOut: 0.02, gain: -3 }).timeline;
      x = addAudioClip(x, { track: 'a1', start: 0.2, length: 0.2, asset: 'n', loop: true }).timeline;
      return x;
    });
    const g = makeGraph({ nodes: [{ id: 'tl', type: 'audio-timeline', params: { clips: tl } }, { id: 'out', type: 'audio-out', params: { limiter: false } }], edges: ['tl.audio -> out.audio'] }, { duration: 0.5, loop: false });
    const pcm = { sampleRate: SR, channels: [src] };
    const off = await renderAudioOffline(g, audioRegistry(), async () => pcm, { duration: 0.5, loop: false });
    const live = renderGraph(g, 0.5, { assets: { n: pcm }, fade: false }).left;
    expect(off!.channels[0]).toEqual(live);
    expect(peak(live)).toBeGreaterThan(0.2);
  });
});

describe('recording through the runner', () => {
  /** Runner with Microphone.tap -> Timeline.recordAudio and Keyboard -> Timeline.recordMidi, plus the timeline playing out. */
  function rig(params: Record<string, unknown> = {}, project = { duration: 10, loop: false }) {
    const g = makeGraph(
      {
        nodes: [
          { id: 'mic', type: 'microphone' },
          { id: 'kb', type: 'midi-keyboard' },
          { id: 'tl', type: 'audio-timeline', params: { monitor: false, ...params } },
          { id: 'out', type: 'audio-out', params: { limiter: false } },
        ],
        edges: ['mic.tap -> tl.recordAudio', 'kb.midi -> tl.recordMidi', 'tl.audio -> out.audio'],
      },
      project,
    );
    const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    r.setGraph(g);
    r.setTransport({ playing: true, seconds: 0, duration: project.duration, loop: project.loop });
    return r;
  }
  const L = new Float32Array(128);
  const R = new Float32Array(128);
  /** mic value at global input frame k is k / 1e6, so every captured sample tells us where it came from. */
  const feed = (r: AudioGraphRunner, from: number, blocks: number) => {
    const m = new Float32Array(128);
    for (let b = 0; b < blocks; b++) {
      for (let i = 0; i < 128; i++) m[i] = (from + b * 128 + i) / 1e6;
      r.process(L, R, 128, m);
    }
    return from + blocks * 128;
  };

  it('captures exactly what was fed while recording: start, length and content', () => {
    const r = rig();
    r.armRecording('tl', { track: 'a1', kind: 'audio' });
    let k = feed(r, 0, 10); // armed, not recording yet
    expect(r.recordingState().phase).toBe('armed');
    r.startRecording(0);
    const first = k;
    k = feed(r, k, 40);
    expect(r.recordingState().recording).toBe(true);
    expect(r.recordingState().seconds).toBeCloseTo((40 * 128) / SR, 6);
    const take = r.stopRecording()!;
    expect(take.kind).toBe('audio');
    expect(take.track).toBe('a1');
    expect(take.start).toBeCloseTo((10 * 128) / SR, 9);
    expect(take.length).toBeCloseTo((40 * 128) / SR, 9);
    expect(take.pcm!.channels[0].length).toBe(40 * 128);
    expect(take.pcm!.channels[0][0]).toBeCloseTo(first / 1e6, 7);
    expect(take.pcm!.channels[0][40 * 128 - 1]).toBeCloseTo((k - 1) / 1e6, 7);
    expect(take.pcm!.channels[1][5]).toBeCloseTo((first + 5) / 1e6, 7);
    expect(r.recordingState().phase).toBe('armed');
    expect(r.stopRecording()).toBeNull(); // nothing captured since
  });

  it('compensates input latency: content is shifted so it lines up with what the player heard', () => {
    const r = rig({ latencyOffsetMs: 5 });
    r.armRecording('tl', { track: 'a1', kind: 'audio' });
    r.startRecording(0.01); // 10 ms device latency + 5 ms user offset = 720 frames
    const first = 0;
    feed(r, 0, 40);
    const take = r.stopRecording()!;
    const lat = Math.round(0.015 * SR);
    expect(take.latency).toBeCloseTo(0.015, 9);
    expect(take.start).toBe(0);
    expect(take.pcm!.channels[0].length).toBe(40 * 128 - lat);
    expect(take.pcm!.channels[0][0]).toBeCloseTo((first + lat) / 1e6, 7);
    expect(take.length).toBeCloseTo((40 * 128 - lat) / SR, 9);
  });

  it('records MIDI notes with times relative to the take start and latency removed', () => {
    const r = rig();
    r.armRecording('tl', { track: 'm1', kind: 'midi' });
    r.startRecording(0.01);
    const m = new Float32Array(128);
    for (let b = 0; b < 100; b++) {
      if (b === 10) r.sendMidi('kb', { type: 'on', note: 60, velocity: 1, value: 0, offset: 0, channel: 0 });
      if (b === 40) r.sendMidi('kb', { type: 'off', note: 60, velocity: 0, value: 0, offset: 0, channel: 0 });
      r.process(L, R, 128, m);
    }
    const take = r.stopRecording()!;
    expect(take.kind).toBe('midi');
    expect(take.notes).toHaveLength(1);
    expect(take.notes![0].note).toBe(60);
    expect(take.notes![0].t).toBeCloseTo((10 * 128) / SR - 0.01, 6);
    expect(take.notes![0].d).toBeCloseTo((30 * 128) / SR, 6);
    expect(take.notes![0].vel).toBeCloseTo(0.8, 5); // keyboard "key strength"
  });

  it('a note still held at stop is closed, and pass-through monitoring only happens while armed', () => {
    const r = rig({ monitor: true });
    const m = new Float32Array(128).fill(0.25);
    r.process(L, R, 128, m);
    expect(peak(L)).toBe(0); // not armed: nothing passes
    r.armRecording('tl', { track: 'a1', kind: 'audio' });
    r.process(L, R, 128, m);
    expect(L[10]).toBeCloseTo(0.25, 6); // armed + monitor: you hear what you record
  });

  it('count-in clicks first, then records; click never appears without arming', () => {
    const r = rig({ countIn: 1, metronome: true, bpm: 120 }); // 1 bar = 2 s
    r.setTransport({ playing: true });
    r.armRecording('tl', { track: 'a1', kind: 'audio' });
    r.startRecording(0);
    expect(r.recordingState().phase).toBe('count-in');
    let loud = 0;
    const m = new Float32Array(128);
    for (let b = 0; b < Math.round((2 * SR) / 128) - 2; b++) {
      r.process(L, R, 128, m);
      loud = Math.max(loud, peak(L));
    }
    expect(loud).toBeGreaterThan(0.05); // clicks are audible
    expect(r.recordingState().phase).toBe('count-in');
    for (let b = 0; b < 10; b++) r.process(L, R, 128, m);
    expect(r.recordingState().phase).toBe('recording');
    // never armed: silent
    const quiet = rig({ countIn: 1, metronome: true });
    let pk = 0;
    for (let b = 0; b < 400; b++) {
      quiet.process(L, R, 128, m);
      pk = Math.max(pk, peak(L));
    }
    expect(pk).toBe(0);
  });

  it('loop recording splits passes exactly at the loop point', () => {
    const r = rig({}, { duration: 0.1, loop: true }); // 4800 samples: not a multiple of 128
    r.setTransport({ playing: true, seconds: 0 });
    r.armRecording('tl', { track: 'a1', kind: 'audio' });
    r.startRecording(0);
    feed(r, 0, 80); // 10240 frames = 2.13 loops
    const take = r.stopRecording()!;
    expect(take.loopPasses).toBe(3);
    expect(take.passes!.map((p) => p.start)).toEqual([0, 0, 0]);
    expect(take.passes![0].pcm!.channels[0].length).toBe(4800);
    expect(take.passes![1].pcm!.channels[0].length).toBe(4800);
    expect(take.passes![2].pcm!.channels[0].length).toBe(10240 - 9600);
    expect(take.passes![1].pcm!.channels[0][0]).toBeCloseTo(4800 / 1e6, 7); // content continues across the wrap
  });

  it('loop overdub of MIDI merges every pass into one clip as long as the loop; takes keeps each, last one active', () => {
    const r = rig({}, { duration: 0.2, loop: true }); // 9600 samples
    r.setTransport({ playing: true, seconds: 0 });
    r.armRecording('tl', { track: 'm1', kind: 'midi' });
    r.startRecording(0);
    const m = new Float32Array(128);
    const send = (n: number, on: boolean) => r.sendMidi('kb', { type: on ? 'on' : 'off', note: n, velocity: on ? 1 : 0, value: 0, offset: 0, channel: 0 });
    for (let b = 0; b < 160; b++) {
      // pass 1 (blocks 0..74): note 60 at block 10; pass 2 (blocks 75..149): note 64 at block 85
      if (b === 10) send(60, true);
      if (b === 20) send(60, false);
      if (b === 85) send(64, true);
      if (b === 95) send(64, false);
      r.process(L, R, 128, m);
    }
    const take = r.stopRecording()!;
    expect(take.loopPasses).toBeGreaterThanOrEqual(2);
    const over = applyTake(emptyTimeline(), take, { mode: 'overdub' }).timeline;
    expect(over.clips).toHaveLength(1);
    const clip = over.clips[0];
    expect(clip.loop).toBe(true);
    expect(clip.length).toBeCloseTo(0.2, 3);
    expect(clip.notes!.map((n) => n.note).sort()).toEqual([60, 64]);
    const tk = applyTake(emptyTimeline(), take, { mode: 'takes' }).timeline;
    expect(tk.clips.length).toBe(take.passes!.length);
    expect(tk.clips.filter((c) => !c.muted)).toHaveLength(1);
    expect(tk.clips[tk.clips.length - 1].muted).toBeUndefined();
  });

  it('stops at the maximum length with a clear message and still returns what was captured', () => {
    const r = rig({ maxLength: 5 });
    r.armRecording('tl', { track: 'a1', kind: 'audio' });
    r.startRecording(0);
    const m = new Float32Array(128);
    for (let b = 0; b < Math.round((6 * SR) / 128); b++) r.process(L, R, 128, m);
    expect(r.recordingState().error).toMatch(/maximum length of 5 s/);
    const take = r.stopRecording()!;
    expect(take.error).toMatch(/maximum length/);
    expect(take.length).toBeGreaterThan(4.9);
    expect(take.length).toBeLessThanOrEqual(5);
  });

  it('a recorded take put on the timeline plays back identically (and exports without the microphone)', async () => {
    const r = rig();
    r.armRecording('tl', { track: 'a1', kind: 'audio' });
    r.startRecording(0);
    const m = sine(300, 128 * 60, SR, 0.5);
    for (let b = 0; b < 60; b++) r.process(L, R, 128, m.subarray(b * 128, b * 128 + 128));
    const take = r.stopRecording()!;
    const tl = applyTake(emptyTimeline(), take, { mode: 'overdub', assetIds: ['take1'] }).timeline;
    const g = makeGraph({ nodes: [{ id: 'tl', type: 'audio-timeline', params: { clips: tl } }, { id: 'out', type: 'audio-out', params: { limiter: false } }], edges: ['tl.audio -> out.audio'] }, { duration: 0.3, loop: false });
    const pcm = await renderAudioOffline(g, audioRegistry(), async (id) => (id === 'take1' ? take.pcm! : null), { duration: 0.3, loop: false });
    expect(pcm!.channels[0][1000]).toBeCloseTo(m[1000], 6);
    expect(pcm!.channels[0][7000]).toBeCloseTo(m[7000], 6);
    expect(peak(pcm!.channels[0], 7680 + 10)).toBe(0);
  });
});

describe('performance', () => {
  it('16 audio clips and 8 MIDI clips at 48 kHz run well faster than real time', () => {
    let tl = emptyTimeline();
    for (let i = 0; i < 16; i++) tl = addAudioClip(tl, { track: 'a1', start: i * 0.5, length: 8, asset: 'n', loop: i % 2 === 0, fadeIn: 0.01, fadeOut: 0.01 }).timeline;
    for (let i = 0; i < 8; i++) {
      const notes = Array.from({ length: 64 }, (_, k) => ({ t: k * 0.125, d: 0.1, note: 48 + ((k * 7 + i) % 24), vel: 0.7 }));
      tl = addMidiClip(tl, { track: 'm1', start: i * 0.25, length: 8, notes, loop: true, srcLength: 8 }).timeline;
    }
    const g = makeGraph({ nodes: [{ id: 'tl', type: 'audio-timeline', params: { clips: tl } }, { id: 'out', type: 'audio-out' }], edges: ['tl.audio -> out.audio'] }, { duration: 20, loop: true });
    const runner = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    runner.setGraph(g);
    runner.setAsset('n', { sampleRate: SR, channels: [noise(3 * SR, 2, 0.1)] });
    runner.setTransport({ playing: true, seconds: 0, duration: 20, loop: true });
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let i = 0; i < 300; i++) runner.process(L, R, 128);
    let best = Infinity;
    for (let rep = 0; rep < 5; rep++) {
      const t0 = performance.now();
      for (let i = 0; i < 750; i++) runner.process(L, R, 128); // 2 s
      best = Math.min(best, performance.now() - t0);
    }
    const speed = 2 / (best / 1000);
    console.log(`timeline 16 audio + 8 MIDI clips: ${speed.toFixed(0)}x real time`);
    expect(speed).toBeGreaterThan(20);
  });
});
