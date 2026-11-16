import { describe, expect, it } from 'vitest';
import { AudioGraphRunner } from '../runner';
import { SlotAllocator } from '../slots';
import { MAX_MICS } from '../protocol';
import { SR, audioRegistry, makeGraph, peak, rms, sine, toneAmp } from '../testing';

const L = new Float32Array(128);
const R = new Float32Array(128);

/** Runner with Phone Camera (id "ph") on a synthetic live slot, tap -> Audio to MIDI -> Synth -> Audio Out, audio -> Mixer -> Audio Out. */
function rig(phoneParams: Record<string, unknown> = {}) {
  const g = makeGraph(
    {
      nodes: [
        { id: 'ph', type: 'phone-camera', params: phoneParams },
        { id: 'out', type: 'audio-out', params: { limiter: false } },
        { id: 'lv', type: 'audio-level', params: { floor: -60, ceiling: 0 } },
      ],
      edges: ['ph.audio -> out.audio', 'ph.tap -> lv.audio'],
    },
    { duration: 5, loop: false },
  );
  const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
  r.setGraph(g);
  r.setTransport({ playing: true, seconds: 0, duration: 5, loop: false });
  return r;
}
/** Feed `x` through the phone slot (worklet input 3) and return what reaches the Audio Out. */
function feed(r: AudioGraphRunner, x: Float32Array): Float32Array {
  const out = new Float32Array(x.length);
  for (let p = 0; p < x.length; p += 128) {
    const blk = x.subarray(p, p + 128);
    r.process(L, R, 128, undefined, undefined, [null, null, null, [blk, blk]]);
    out.set(L, p);
  }
  return out;
}

describe('Phone Camera as a microphone', () => {
  const tone = sine(440, SR, SR, 0.25);

  it('tap is always live; the audio output follows "Hear the phone" (off by default)', () => {
    const r = rig();
    r.setMicSlots({ ph: 3 });
    const heard = feed(r, tone);
    expect(peak(heard)).toBe(0); // monitor off: nothing reaches the speakers
    expect(r.signal('lv', 'level')).toBeGreaterThan(0.6); // but the tap feeds analysis
    const on = rig({ monitor: true });
    on.setMicSlots({ ph: 3 });
    const loud = feed(on, tone);
    expect(toneAmp(loud, 440, SR, 4800, SR - 100)).toBeCloseTo(0.25, 2);
  });

  it('gain and noise gate apply', () => {
    const r = rig({ monitor: true, gain: 6.0206 });
    r.setMicSlots({ ph: 3 });
    expect(toneAmp(feed(r, tone), 440, SR, 4800, SR - 100)).toBeCloseTo(0.5, 2);
    const hiss = sine(300, SR, SR, 0.002);
    const gated = rig({ monitor: true, gate: true, gateThreshold: -40 });
    gated.setMicSlots({ ph: 3 });
    expect(rms(feed(gated, hiss), 8000, SR)).toBeLessThan(2e-4);
    const open = rig({ monitor: true, gate: true, gateThreshold: -40 });
    open.setMicSlots({ ph: 3 });
    expect(rms(feed(open, sine(300, SR, SR, 0.5)), 8000, SR)).toBeGreaterThan(0.3);
  });

  it('silent without a stream, in another slot, and offline', () => {
    const r = rig({ monitor: true });
    r.setMicSlots({ ph: 3 });
    for (let i = 0; i < 20; i++) r.process(L, R, 128, undefined, undefined, [null, null, null, null]); // slot has no audio (stream without a track)
    expect(peak(L)).toBe(0);
    const wrong = rig({ monitor: true });
    wrong.setMicSlots({ ph: 1 });
    const y = feed(wrong, tone); // audio arrives on slot 3 but the node listens to slot 1
    expect(peak(y)).toBe(0);
    const offline = rig({ monitor: true });
    for (let i = 0; i < 20; i++) offline.process(L, R, 128); // no mic at all
    expect(peak(L)).toBe(0);
  });

  it('phone sound -> Audio to MIDI -> Synth sounds the sung pitch', () => {
    const g = makeGraph(
      {
        nodes: [
          { id: 'ph', type: 'phone-camera' },
          { id: 'a2m', type: 'audio-to-midi' },
          { id: 'syn', type: 'synth', params: { wave1: 'sine', mix: 0, cutoff: 20000, attack: 0.005, release: 0.05, gain: 0 } },
          { id: 'out', type: 'audio-out', params: { limiter: false } },
        ],
        edges: ['ph.tap -> a2m.audio', 'a2m.midi -> syn.midi', 'syn.audio -> out.audio'],
      },
      { duration: 5, loop: false },
    );
    const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    r.setGraph(g);
    r.setMicSlots({ ph: 2 });
    r.setTransport({ playing: true, seconds: 0, duration: 5, loop: false });
    const sung = sine(220, Math.round(0.6 * SR), SR, 0.5);
    const out = new Float32Array(SR);
    for (let p = 0; p < SR; p += 128) {
      const blk = new Float32Array(128);
      if (p < sung.length) blk.set(sung.subarray(p, Math.min(sung.length, p + 128)));
      r.process(L, R, 128, undefined, undefined, [null, null, [blk, blk]]);
      out.set(L, p);
    }
    expect(toneAmp(out, 220, SR, 0.3 * SR, 0.55 * SR)).toBeGreaterThan(0.2);
    expect(rms(out, 0.9 * SR, SR)).toBeLessThan(1e-3);
  });

  it('is silent offline and still registers its picture output', () => {
    const def = audioRegistry().get('phone-camera')!;
    expect(Object.keys(def.outputs)).toEqual(['image', 'audio', 'tap']);
    expect(def.params.monitor).toMatchObject({ default: false, group: 'Sound' });
    expect(def.params.gain.group).toBe('Sound');
    expect(def.params.gate.group).toBe('Sound');
    expect(typeof def.render).toBe('function');
  });
});

describe('recording from the phone compensates its link delay', () => {
  it('latencyMs of the source node is added to the recording latency', () => {
    const g = makeGraph(
      { nodes: [{ id: 'ph', type: 'phone-camera', params: { latencyMs: 200 } }, { id: 'tl', type: 'audio-timeline' }, { id: 'out', type: 'audio-out' }], edges: ['ph.tap -> tl.recordAudio', 'tl.audio -> out.audio'] },
      { duration: 10, loop: false },
    );
    const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    r.setGraph(g);
    r.setMicSlots({ ph: 0 });
    r.setTransport({ playing: true, seconds: 0, duration: 10, loop: false });
    r.armRecording('tl', { track: 'a1', kind: 'audio' });
    r.startRecording(0.01);
    const x = new Float32Array(128);
    for (let b = 0; b < 200; b++) r.process(L, R, 128, undefined, undefined, [[x, x]]);
    const take = r.stopRecording()!;
    expect(take.latency).toBeCloseTo(0.21, 6);
    expect(take.pcm!.channels[0].length).toBe(200 * 128 - Math.round(0.21 * SR));
    // a source without latencyMs adds nothing
    const g2 = makeGraph({ nodes: [{ id: 'mic', type: 'microphone' }, { id: 'tl', type: 'audio-timeline' }], edges: ['mic.tap -> tl.recordAudio'] }, { duration: 10, loop: false });
    const r2 = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    r2.setGraph(g2);
    r2.setTransport({ playing: true, seconds: 0, duration: 10, loop: false });
    r2.armRecording('tl', { track: 'a1', kind: 'audio' });
    r2.startRecording(0.01);
    for (let b = 0; b < 20; b++) r2.process(L, R, 128, x);
    expect(r2.stopRecording()!.latency).toBeCloseTo(0.01, 9);
  });
});

describe('live input slots are shared by microphones and live streams', () => {
  it('hands out the lowest free slot, keeps it stable, reuses freed ones and refuses beyond the limit', () => {
    const s = new SlotAllocator(MAX_MICS);
    expect(MAX_MICS).toBe(8);
    expect(s.alloc('mic1')).toBe(0);
    expect(s.alloc('phone')).toBe(1);
    expect(s.alloc('mic2')).toBe(2);
    expect(s.alloc('phone')).toBe(1); // stable
    s.free('mic1');
    expect(s.alloc('phone2')).toBe(0); // lowest free
    expect(s.toRecord()).toEqual({ phone: 1, mic2: 2, phone2: 0 });
    for (let i = 0; i < 5; i++) expect(s.alloc('x' + i)).toBeGreaterThanOrEqual(0);
    expect(s.size).toBe(8);
    expect(s.alloc('too-many')).toBe(-1);
    s.free('phone');
    expect(s.get('phone')).toBeUndefined();
    expect(s.alloc('too-many')).toBe(1);
    s.clear();
    expect(s.size).toBe(0);
  });

  it('a phone node and a microphone node can both be live at once on different slots', () => {
    const g = makeGraph(
      { nodes: [{ id: 'mic', type: 'microphone' }, { id: 'ph', type: 'phone-camera' }, { id: 'a', type: 'audio-level', params: { floor: -60, ceiling: 0 } }, { id: 'b', type: 'audio-level', params: { floor: -60, ceiling: 0 } }], edges: ['mic.tap -> a.audio', 'ph.tap -> b.audio'] },
      { duration: 5, loop: false },
    );
    const r = new AudioGraphRunner(audioRegistry(), { sampleRate: SR, fadeOnRebuild: false });
    r.setGraph(g);
    r.setMicSlots({ mic: 0, ph: 1 });
    r.setTransport({ playing: true, seconds: 0, duration: 5, loop: false });
    const loud = sine(300, 128, SR, 0.5);
    const quiet = sine(300, 128, SR, 0.01);
    for (let i = 0; i < 300; i++) r.process(L, R, 128, undefined, undefined, [[loud, loud], [quiet, quiet]]);
    expect(r.signal('a', 'level')).toBeGreaterThan(r.signal('b', 'level') + 0.3);
  });
});
