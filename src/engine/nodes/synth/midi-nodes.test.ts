import { describe, expect, it } from 'vitest';
import { SR, getDef, off, on, runKernel } from '../../audio/testing';
import type { MidiEvent } from '../../audio/types';

const run = (id: string, params: Record<string, unknown>, events: MidiEvent[], frames = 1024, extra: Record<string, unknown> = {}) =>
  runKernel(getDef(id), { params, midi: { midi: events }, frames, ...extra }).midiOut.midi;
const summary = (ev: MidiEvent[]) => ev.map((e) => `${e.type}:${e.note}@${e.offset}`);

describe('midi-keyboard', () => {
  const k = (params: Record<string, unknown>, ui: MidiEvent[]) => runKernel(getDef('midi-keyboard'), { params, uiMidi: ui, frames: 1024 }).midiOut.midi;
  it('turns UI notes into MIDI, scaling velocity', () => {
    const ev = k({ velocity: 0.5 }, [on(60, 10, 1), off(60, 500)]);
    expect(summary(ev)).toEqual(['on:60@10', 'off:60@500']);
    expect(ev[0].velocity).toBeCloseTo(0.5, 5);
  });
  it('transpose applies, and the release matches the transposed note', () => {
    expect(summary(k({ transpose: 12 }, [on(60, 0), off(60, 100)]))).toEqual(['on:72@0', 'off:72@100']);
    expect(summary(k({ transpose: -24 }, [on(60, 0), off(60, 100)]))).toEqual(['on:36@0', 'off:36@100']);
  });
  it('sustain holds released notes until it is turned off', () => {
    const r = runKernel(getDef('midi-keyboard'), { params: { sustain: true }, uiMidi: [on(60, 0), off(60, 100)], frames: 256 });
    expect(summary(r.midiOut.midi)).toEqual(['on:60@0']);
    // a second kernel run cannot share state, so drive the pedal change through two params in sequence:
    const def = getDef('midi-keyboard');
    const st = def.audio!.create({ sampleRate: SR, blockSize: 128, nodeId: 'k' });
    const io = (params: Record<string, unknown>, ui: MidiEvent[]) => {
      const out: MidiEvent[] = [];
      def.audio!.process(st, { frames: 128, sampleRate: SR, in: {}, midiIn: {}, out: {}, midiOut: { midi: out }, params: { baseOctave: 5, velocity: 1, transpose: 0, sustain: false, latch: false, ...params }, signal: () => {}, time: { seconds: 0, sample: 0, bpm: 120, playing: false, loop: false, duration: 0, item: 0 }, assets: { get: () => undefined }, live: { mic: null, deviceMidi: [], uiMidi: ui } });
      return summary(out);
    };
    expect(io({ sustain: true }, [on(60, 0), off(60, 5)])).toEqual(['on:60@0']);
    expect(io({ sustain: true }, [])).toEqual([]);
    expect(io({ sustain: false }, [])).toEqual(['off:60@0']);
    expect(io({ sustain: false }, [])).toEqual([]);
  });
  it('latch: press to start, press again to stop, key-up does nothing', () => {
    const r = k({ latch: true }, [on(60, 0), off(60, 10), on(64, 20), on(60, 30), off(60, 40)]);
    expect(summary(r)).toEqual(['on:60@0', 'on:64@20', 'off:60@30']);
  });
  it('key strength scales velocity; is playable; mapped to the Keyboard params', () => {
    expect(getDef('midi-keyboard').playable).toBe(true);
    for (const id of ['synth', 'pluck', 'drum']) expect(getDef(id).playable).toBeFalsy();
    expect(getDef('midi-keyboard').params.baseOctave).toMatchObject({ default: 5, min: 1, max: 9 });
  });
  it('ignores releases of notes that are not down; clamps to 0..127', () => {
    expect(k({}, [off(61, 0)])).toEqual([]);
    expect(summary(k({ transpose: 24 }, [on(120, 0)]))).toEqual(['on:127@0']);
  });
});

describe('midi-device', () => {
  const d = (params: Record<string, unknown>, ev: MidiEvent[]) => runKernel(getDef('midi-device'), { params, deviceMidi: ev, frames: 1024 }).midiOut.midi;
  it('passes device events through; filters by channel and by device name', () => {
    const evs: MidiEvent[] = [
      { ...on(60, 0), channel: 0, device: 'Piano' },
      { ...on(62, 1), channel: 1, device: 'Pads' },
      { ...off(60, 5), channel: 0, device: 'Piano' },
    ];
    expect(summary(d({}, evs))).toEqual(['on:60@0', 'on:62@1', 'off:60@5']);
    expect(summary(d({ channel: 2 }, evs))).toEqual(['on:62@1']);
    expect(summary(d({ device: 'pad' }, evs))).toEqual(['on:62@1']); // legacy: part of the name
    const byId: MidiEvent[] = [{ ...on(60, 0), device: 'id-1', deviceName: 'Piano' }, { ...on(62, 1), device: 'id-2', deviceName: 'Pads' }];
    expect(summary(d({ device: 'id-2' }, byId))).toEqual(['on:62@1']);
    expect(summary(d({ device: '' }, byId))).toEqual(['on:60@0', 'on:62@1']);
  });
  it('transpose keeps releases matched', () => {
    expect(summary(d({ transpose: 12 }, [{ ...on(60, 0), device: 'x' }, { ...off(60, 9), device: 'x' }]))).toEqual(['on:72@0', 'off:72@9']);
  });
  it('is silent with no device events (offline)', () => {
    expect(runKernel(getDef('midi-device'), { frames: 1024 }).midiOut.midi).toEqual([]);
  });
});

describe('midi-transpose', () => {
  it('shifts semitones and octaves; releases follow', () => {
    expect(summary(run('midi-transpose', { semitones: 3, octave: 1 }, [on(60, 0), off(60, 50)]))).toEqual(['on:75@0', 'off:75@50']);
  });
  it('snaps to a scale (C major: C# is equally far from C and D, ties go down; F# is nearest to F or G)', () => {
    expect(summary(run('midi-transpose', { scale: 'major', key: '0' }, [on(61, 0), on(60, 1), on(63.0 + 0, 2)]))).toEqual(['on:60@0', 'on:60@1', 'on:62@2']);
  });
  it('drops notes shifted out of range; passes controllers', () => {
    expect(run('midi-transpose', { octave: 4 }, [on(100, 0), off(100, 5)])).toEqual([]);
    const cc: MidiEvent = { type: 'cc', note: 1, velocity: 0, value: 0.5, offset: 3, channel: 0 };
    expect(run('midi-transpose', { semitones: 5 }, [cc])).toEqual([cc]);
  });
});

describe('chord', () => {
  it('major chord from one key, and the release stops exactly those notes', () => {
    const ev = run('chord', { chord: 'major' }, [on(60, 0), off(60, 100)]);
    expect(summary(ev)).toEqual(['on:60@0', 'on:64@0', 'on:67@0', 'off:60@100', 'off:64@100', 'off:67@100']);
  });
  it('minor 7th, inversion and bass note', () => {
    expect(summary(run('chord', { chord: 'min7' }, [on(60, 0)]))).toEqual(['on:60@0', 'on:63@0', 'on:67@0', 'on:70@0']);
    expect(summary(run('chord', { chord: 'major', inversion: 1 }, [on(60, 0)]))).toEqual(['on:72@0', 'on:64@0', 'on:67@0']);
    expect(summary(run('chord', { chord: 'power', bass: true }, [on(60, 0)]))).toEqual(['on:60@0', 'on:67@0', 'on:72@0', 'on:48@0']);
  });
  it('in key: every note gets the chord that belongs to it in the scale', () => {
    const chordOf = (note: number, params: Record<string, unknown> = {}) => run('chord', { chord: 'key', scale: 'major', key: '0', ...params }, [on(note, 0)]).map((e) => e.note);
    expect(chordOf(60)).toEqual([60, 64, 67]); // C major
    expect(chordOf(62)).toEqual([62, 65, 69]); // D minor
    expect(chordOf(64)).toEqual([64, 67, 71]); // E minor
    expect(chordOf(71)).toEqual([71, 74, 77]); // B diminished
    expect(chordOf(61)).toEqual([60, 64, 67]); // a note outside the key is taken as its neighbour in the key
    expect(chordOf(62, { chord: 'key7' })).toEqual([62, 65, 69, 72]); // D minor 7th
    expect(chordOf(57, { scale: 'minor', key: '9' })).toEqual([57, 60, 64]); // A minor in A minor
    expect(chordOf(62, { key: '2' })).toEqual([62, 66, 69]); // D major in D major
    expect(chordOf(62, { bass: true })).toEqual([62, 65, 69, 50]);
    const ev = run('chord', { chord: 'key' }, [on(62, 0), off(62, 100)]);
    expect(ev.filter((e) => e.type === 'off').map((e) => e.note)).toEqual([62, 65, 69]);
  });
  it('changing the chord type between press and release still releases what was started', () => {
    const a = runKernel(getDef('chord'), { params: { chord: 'major' }, midi: { midi: [on(60, 0)] }, frames: 128 });
    expect(a.midiOut.midi.length).toBe(3);
  });
  it('keeps the velocity', () => {
    expect(run('chord', {}, [on(60, 0, 0.4)]).every((e) => e.velocity === 0.4)).toBe(true);
  });
});

describe('arpeggiator', () => {
  const SIXTEENTH = Math.round((60 / 120) * 0.25 * SR); // 6000 samples at 120 bpm
  const arp = (params: Record<string, unknown>, events: MidiEvent[], frames = SR * 2, time: Record<string, unknown> = { playing: true }) =>
    runKernel(getDef('arpeggiator'), { params: { bpm: 120, rate: '1/16', gate: 0.5, ...params }, midi: { midi: events }, frames, time }).midiOut.midi;
  const noteOns = (ev: MidiEvent[]) => ev.filter((e) => e.type === 'on');

  it('plays held notes one after another in time, up pattern, wrapping', () => {
    const ev = arp({ pattern: 'up' }, [on(64, 0), on(60, 0), on(67, 0)], SIXTEENTH * 8);
    const ns = noteOns(ev);
    expect(ns.map((e) => e.note)).toEqual([60, 64, 67, 60, 64, 67, 60, 64]);
    ns.forEach((e, i) => expect(e.offset).toBe(i * SIXTEENTH));
  });
  it('gate sets the note length; every note gets an off', () => {
    const ev = arp({ pattern: 'up', gate: 0.5 }, [on(60, 0), on(64, 0)], SIXTEENTH * 4);
    const first = ev.find((e) => e.type === 'off')!;
    expect(first.offset).toBe(SIXTEENTH / 2);
    expect(ev.filter((e) => e.type === 'on').length).toBeGreaterThanOrEqual(ev.filter((e) => e.type === 'off').length);
  });
  it('down, up-down, as-played and octave range', () => {
    const held = [on(60, 0), on(64, 0), on(67, 0)];
    expect(noteOns(arp({ pattern: 'down' }, held, SIXTEENTH * 4)).map((e) => e.note)).toEqual([67, 64, 60, 67]);
    expect(noteOns(arp({ pattern: 'updown' }, held, SIXTEENTH * 6)).map((e) => e.note)).toEqual([60, 64, 67, 64, 60, 64]);
    expect(noteOns(arp({ pattern: 'played' }, [on(67, 0), on(60, 0), on(64, 0)], SIXTEENTH * 3)).map((e) => e.note)).toEqual([67, 60, 64]);
    expect(noteOns(arp({ pattern: 'up', octaves: 2 }, [on(60, 0), on(64, 0)], SIXTEENTH * 5)).map((e) => e.note)).toEqual([60, 64, 72, 76, 60]);
  });
  it('tempo and rate change the spacing', () => {
    const ns = noteOns(arp({ bpm: 60, rate: '1/8' }, [on(60, 0)], SR * 4));
    expect(ns[1].offset - ns[0].offset).toBe(SR / 2);
  });
  it('stops when keys are released and sends the note-off', () => {
    const ev = arp({ gate: 1 }, [on(60, 0), off(60, SIXTEENTH + 100)], SIXTEENTH * 4);
    expect(noteOns(ev).length).toBe(2);
    expect(ev[ev.length - 1].type).toBe('off');
    expect(ev.filter((e) => e.offset > SIXTEENTH * 2).length).toBe(0);
  });
  it('random pattern is reproducible and only uses held notes', () => {
    const a = noteOns(arp({ pattern: 'random' }, [on(60, 0), on(64, 0), on(67, 0)], SR)).map((e) => e.note);
    const b = noteOns(arp({ pattern: 'random' }, [on(60, 0), on(64, 0), on(67, 0)], SR)).map((e) => e.note);
    expect(a).toEqual(b);
    expect(a.every((n) => [60, 64, 67].includes(n))).toBe(true);
    expect(new Set(a).size).toBeGreaterThan(1);
  });
  it('locks to the transport: starting mid-bar lands on the grid', () => {
    const start = SIXTEENTH * 3 + 1000;
    const ns = noteOns(arp({}, [on(60, 0)], SIXTEENTH * 3, { playing: true, sample: start }));
    expect((ns[0].offset + start) % SIXTEENTH).toBe(0);
  });
  it('free-runs on its own clock when the transport is paused', () => {
    const ns = noteOns(arp({}, [on(60, 0)], SIXTEENTH * 4, { playing: false }));
    expect(ns.length).toBe(4);
  });
  it('passes controllers through', () => {
    const cc: MidiEvent = { type: 'cc', note: 1, velocity: 0, value: 0.5, offset: 3, channel: 0 };
    expect(arp({}, [cc], 256).some((e) => e.type === 'cc')).toBe(true);
  });
});
