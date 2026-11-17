import { describe, expect, it } from 'vitest';
import { evalCurve } from './util-curve';
import {
  applyMessage,
  automationCurve,
  controlFor,
  defaultRange,
  describeSource,
  fitNumber,
  makeMapping,
  newState,
  parseMidi,
  parseMidiMap,
  pruneMap,
  scaleControl,
  sourceMatches,
  type MidiMsg,
  type MidiSource,
  type ParamShape,
} from './midi-map';

const cc = (n: number, v: number, ch = 0, device = 'd1'): MidiMsg => ({ kind: 'cc', number: n, channel: ch, value: v / 127, pressed: v >= 64, device });
const note = (n: number, on: boolean, vel = 100, device = 'd1'): MidiMsg => ({ kind: 'note', number: n, channel: 0, value: on ? vel / 127 : 0, pressed: on, device });
const num: ParamShape = { type: 'number', min: 0, max: 100, step: 1, integer: true };
const map = (shape: ParamShape, src: MidiSource = { kind: 'cc', number: 7, channel: -1, device: '' }) => makeMapping('n1', 'p', shape, src);

describe('parseMidi', () => {
  it('decodes notes, CCs and the pitch wheel', () => {
    expect(parseMidi([0x90, 60, 127])).toMatchObject({ kind: 'note', number: 60, pressed: true, value: 1 });
    expect(parseMidi([0x90, 60, 0])).toMatchObject({ kind: 'note', pressed: false }); // note on with velocity 0 is a note off
    expect(parseMidi([0x83, 60, 40])).toMatchObject({ kind: 'note', channel: 3, pressed: false });
    expect(parseMidi([0xb1, 74, 127])).toMatchObject({ kind: 'cc', number: 74, channel: 1, value: 1 });
    expect(parseMidi([0xe0, 0, 0])!.value).toBe(0);
    expect(parseMidi([0xe0, 0x7f, 0x7f])!.value).toBe(1);
    expect(parseMidi([0xe0, 0, 0x40])!.value).toBeCloseTo(0.5, 2);
    expect(parseMidi([0xf8])).toBeNull(); // clock
    expect(parseMidi([0xc0, 5])).toBeNull(); // program change is not mappable
  });
  it('matches by kind, number, channel and device', () => {
    const s = { kind: 'cc' as const, number: 7, channel: 2, device: 'd1' };
    expect(sourceMatches(s, cc(7, 1, 2, 'd1'))).toBe(true);
    expect(sourceMatches(s, cc(7, 1, 3, 'd1'))).toBe(false);
    expect(sourceMatches(s, cc(8, 1, 2, 'd1'))).toBe(false);
    expect(sourceMatches(s, cc(7, 1, 2, 'd2'))).toBe(false);
    expect(sourceMatches({ ...s, channel: -1, device: '' }, cc(7, 1, 9, 'zz'))).toBe(true);
    expect(describeSource(s)).toBe('CC 7 ch 3');
    expect(describeSource({ kind: 'note', number: 60, channel: -1, device: '' })).toBe('Note C4');
  });
});

describe('scaling and curves', () => {
  it('maps the control over min..max and back', () => {
    const m = map(num);
    m.min = 10;
    m.max = 20;
    expect(scaleControl(m, 0)).toBe(10);
    expect(scaleControl(m, 1)).toBe(20);
    expect(scaleControl(m, 0.5)).toBe(15);
    for (const curve of ['linear', 'exp', 'log'] as const) {
      for (const invert of [false, true]) {
        const mm = { ...m, curve, invert };
        for (const x of [0, 0.1, 0.5, 0.9, 1]) expect(controlFor(mm, scaleControl(mm, x))).toBeCloseTo(x, 6);
      }
    }
  });
  it('exp is gentle at the bottom, log at the top, invert flips', () => {
    const m = map(num);
    expect(scaleControl({ ...m, min: 0, max: 1, curve: 'exp' }, 0.5)).toBeLessThan(0.3);
    expect(scaleControl({ ...m, min: 0, max: 1, curve: 'log' }, 0.5)).toBeGreaterThan(0.7);
    expect(scaleControl({ ...m, min: 0, max: 1, invert: true }, 0.25)).toBe(0.75);
  });
  it('a reversed range (min > max) works', () => {
    const m = { ...map(num), min: 100, max: 0 };
    expect(scaleControl(m, 0.25)).toBe(75);
    expect(controlFor(m, 75)).toBeCloseTo(0.25, 6);
  });
  it('snaps to the parameter step, integer and range', () => {
    expect(fitNumber({ type: 'number', min: 0, max: 1, step: 0.25 }, 0.37)).toBe(0.25);
    expect(fitNumber({ type: 'number', min: 0, max: 10, integer: true }, 3.6)).toBe(4);
    expect(fitNumber({ type: 'number', min: 0, max: 10, step: 1 }, 99)).toBe(10);
    expect(fitNumber({ type: 'number', min: -5, max: 5, step: 0.1 }, 0.1 + 0.2)).toBe(0.3);
  });
  it('default range uses the soft range and falls back to 0..1 for unbounded params', () => {
    expect(defaultRange({ type: 'number', min: 0, max: 400, softMax: 64 })).toEqual({ min: 0, max: 64 });
    expect(defaultRange({ type: 'number', min: -1000000, max: 1000000 })).toEqual({ min: 0, max: 1 });
    expect(defaultRange({ type: 'number', min: -24, max: 24 })).toEqual({ min: -24, max: 24 });
    expect(defaultRange({ type: 'bool' })).toEqual({ min: 0, max: 1 });
  });
});

describe('numbers: jump and soft takeover', () => {
  it('jump follows the control at once', () => {
    const m = { ...map(num), pickup: 'jump' as const };
    const st = newState();
    expect(applyMessage(m, st, cc(7, 127), 50, num)!.value).toBe(100);
    expect(applyMessage(m, st, cc(7, 0), 100, num)!.value).toBe(0);
  });
  it('pickup ignores the knob until it reaches the value, then follows (no jump)', () => {
    const m = map(num); // pickup by default
    const st = newState();
    let cur = 50;
    const feed = (v: number) => {
      const r = applyMessage(m, st, cc(7, v), cur, num);
      if (r) cur = r.value as number;
      return r;
    };
    expect(feed(0)).toBeNull(); // knob far below 50
    expect(feed(20)).toBeNull();
    expect(feed(55)).toBeNull(); // 43%: still below 50%
    // crossing 50% picks up
    const r = feed(70);
    expect(r).not.toBeNull();
    expect(cur).toBeCloseTo((70 / 127) * 100, 0);
    expect(feed(127)!.value).toBe(100);
    // another change of the parameter (a hand edit) makes the knob wait again
    cur = 20;
    expect(feed(100)).toBeNull();
    expect(feed(10)).not.toBeNull(); // crossed 20% on the way down
  });
  it('a knob that is already at the value picks up on the first message', () => {
    const m = map(num);
    const st = newState();
    expect(applyMessage(m, st, cc(7, 64), 50, num)!.value).toBe(50);
  });
  it('ignores other controls and notes drive numbers by velocity', () => {
    const m = map(num);
    expect(applyMessage(m, newState(), cc(8, 10), 0, num)).toBeNull();
    const n = map(num, { kind: 'note', number: 60, channel: -1, device: '' });
    expect(applyMessage(n, newState(), note(60, true, 127), 0, num)!.value).toBe(100);
    expect(applyMessage(n, newState(), note(60, false), 0, num)!.value).toBe(0);
  });
});

describe('buttons', () => {
  const bool: ParamShape = { type: 'bool' };
  it('toggle flips on each press and ignores the release', () => {
    const m = map(bool, { kind: 'note', number: 36, channel: -1, device: '' });
    m.mode = 'toggle';
    const st = newState();
    expect(applyMessage(m, st, note(36, true), false, bool)!.value).toBe(true);
    expect(applyMessage(m, st, note(36, false), true, bool)).toBeNull();
    expect(applyMessage(m, st, note(36, true), true, bool)!.value).toBe(false);
  });
  it('momentary is on while held; invert makes it off while held', () => {
    const m = map(bool, { kind: 'note', number: 36, channel: -1, device: '' });
    m.mode = 'momentary';
    const st = newState();
    expect(applyMessage(m, st, note(36, true), false, bool)!.value).toBe(true);
    expect(applyMessage(m, st, note(36, false), true, bool)!.value).toBe(false);
    const inv = { ...m, invert: true };
    const st2 = newState();
    expect(applyMessage(inv, st2, note(36, true), true, bool)!.value).toBe(false);
    expect(applyMessage(inv, st2, note(36, false), false, bool)!.value).toBe(true);
  });
  it('a CC acts as a button at the half way mark, and held repeats do not retrigger', () => {
    const m = map(bool);
    m.mode = 'toggle';
    const st = newState();
    expect(applyMessage(m, st, cc(7, 127), false, bool)!.value).toBe(true);
    expect(applyMessage(m, st, cc(7, 120), true, bool)).toBeNull();
    expect(applyMessage(m, st, cc(7, 0), true, bool)).toBeNull();
    expect(applyMessage(m, st, cc(7, 127), true, bool)!.value).toBe(false);
  });
  it('step walks through the enum options and wraps; invert walks backwards', () => {
    const en: ParamShape = { type: 'enum', options: ['a', 'b', 'c'] };
    const m = map(en, { kind: 'note', number: 40, channel: -1, device: '' });
    expect(m.mode).toBe('step');
    const st = newState();
    expect(applyMessage(m, st, note(40, true), 'a', en)!.value).toBe('b');
    applyMessage(m, st, note(40, false), 'b', en);
    expect(applyMessage(m, st, note(40, true), 'b', en)!.value).toBe('c');
    applyMessage(m, st, note(40, false), 'c', en);
    expect(applyMessage(m, st, note(40, true), 'c', en)!.value).toBe('a');
    const back = { ...m, invert: true };
    const st2 = newState();
    expect(applyMessage(back, st2, note(40, true), 'a', en)!.value).toBe('c');
  });
  it('an unknown enum value starts from the first option', () => {
    const en: ParamShape = { type: 'enum', options: ['a', 'b'] };
    const m = map(en);
    expect(applyMessage(m, newState(), cc(7, 127), 'zzz', en)!.value).toBe('b');
  });
});

describe('storage', () => {
  it('round-trips and drops damaged mappings', () => {
    const good = map(num);
    const raw = JSON.parse(JSON.stringify({ mappings: [good, { id: 'x' }, null, { ...good, id: good.id }, { ...good, id: 'z', curve: 'weird', pickup: 'nope', source: { ...good.source, kind: 'sysex' } }, { ...good, id: 'ok', curve: 'weird', mode: 'nope' }] }));
    const parsed = parseMidiMap(raw)!;
    expect(parsed.mappings.map((m) => m.id)).toEqual([good.id, 'ok']);
    expect(parsed.mappings[0]).toEqual(good);
    expect(parsed.mappings[1].curve).toBe('linear');
    expect(parsed.mappings[1].mode).toBe('toggle');
    expect(parseMidiMap(null)).toBeNull();
    expect(parseMidiMap({ mappings: 5 })).toBeNull();
  });
  it('prunes mappings of deleted nodes', () => {
    const a = makeMapping('a', 'p', num, map(num).source);
    const b = makeMapping('b', 'p', num, map(num).source);
    const m = { mappings: [a, b] };
    expect(pruneMap(m, new Set(['a', 'b']))).toBe(m);
    expect(pruneMap(m, new Set(['a']))!.mappings).toEqual([a]);
    expect(pruneMap(undefined, new Set())).toBeUndefined();
  });
});

describe('automation curve', () => {
  it('turns a knob sweep into a few keys that reproduce it', () => {
    const frames = 96;
    const samples = Array.from({ length: 200 }, (_, i) => ({ t: 0.2 + (0.5 * i) / 199, v: (i / 199) * 80 })); // ramp 0 -> 80 between 20% and 70%
    const c = automationCurve(samples, 0, frames, { min: 0, max: 100 });
    expect(c.keys.length).toBeLessThan(20);
    expect(c.keys[0].t).toBe(0);
    expect(c.keys[c.keys.length - 1].t).toBe(1);
    expect(evalCurve(c, 0.1)).toBeCloseTo(0, 0);
    expect(evalCurve(c, 0.45)).toBeGreaterThan(30);
    expect(evalCurve(c, 0.45)).toBeLessThan(50);
    expect(evalCurve(c, 0.9)).toBeCloseTo(80, 0);
  });
  it('holds the start value before the first movement and the last one after', () => {
    const c = automationCurve([{ t: 0.5, v: 7 }], 3, 48, { min: 0, max: 10 });
    expect(evalCurve(c, 0.2)).toBeCloseTo(3, 1);
    expect(evalCurve(c, 0.8)).toBeCloseTo(7, 1);
    // nothing recorded: a flat curve at the start value
    const flat = automationCurve([], 4, 24, { min: 0, max: 10 });
    expect(evalCurve(flat, 0.5)).toBeCloseTo(4, 3);
  });
});
