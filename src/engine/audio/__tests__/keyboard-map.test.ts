import { describe, expect, it } from 'vitest';
import {
  KEY_NOTES,
  MAPPED_CODES,
  clampOctave,
  keyAction,
  keyLabelForNote,
  keyToNote,
  keyboardRange,
  noteName,
  octaveBaseNote,
  octaveForKey,
  stepVelocity,
} from '../keyboard-map';
import { audioRegistry } from '../testing';

describe('keyboard map', () => {
  it('the home row plays C D E F G A B with sharps on the row above (Ableton layout), octave 5 starts at middle C', () => {
    const play = (codes: string[], oct = 5) => codes.map((c) => keyToNote(c, oct));
    expect(play(['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ'])).toEqual([60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71]);
    expect(play(['KeyK', 'KeyO', 'KeyL', 'KeyP', 'Semicolon', 'Quote'])).toEqual([72, 73, 74, 75, 76, 77]);
  });
  it('octave moves the whole layout by 12 semitones, 1..9', () => {
    expect(keyToNote('KeyA', 1)).toBe(12);
    expect(keyToNote('KeyA', 9)).toBe(108);
    expect(keyToNote('KeyA', 4)).toBe(48);
    expect(octaveBaseNote(5)).toBe(60);
    expect(clampOctave(0)).toBe(1);
    expect(clampOctave(12)).toBe(9);
    expect(keyToNote('KeyA', 99)).toBe(108); // clamped
  });
  it('is layout independent (uses KeyboardEvent.code) and ignores everything else', () => {
    expect(keyToNote('KeyQ', 5)).toBeNull();
    expect(keyToNote('Space', 5)).toBeNull();
    expect(keyToNote('Digit5', 5)).toBeNull();
    expect(keyToNote('a', 5)).toBeNull(); // `key` values are not codes
    expect(keyAction('Space')).toBeNull();
  });
  it('digits choose the octave; Z/X step it; C/V step the velocity', () => {
    for (let d = 1; d <= 9; d++) {
      expect(octaveForKey(`Digit${d}`)).toBe(d);
      expect(octaveForKey(`Numpad${d}`)).toBe(d);
      expect(keyAction(`Digit${d}`)).toEqual({ kind: 'octave', value: d });
    }
    expect(octaveForKey('Digit0')).toBeNull();
    expect(keyAction('KeyZ')).toEqual({ kind: 'octave-step', delta: -1 });
    expect(keyAction('KeyX')).toEqual({ kind: 'octave-step', delta: 1 });
    expect(keyAction('KeyC')).toEqual({ kind: 'velocity-step', delta: -1 });
    expect(keyAction('KeyV')).toEqual({ kind: 'velocity-step', delta: 1 });
    expect(keyAction('KeyG')).toEqual({ kind: 'note', semitone: 7 });
  });
  it('velocity stepping stays in 0.1..1', () => {
    expect(stepVelocity(0.8, 1)).toBe(0.9);
    expect(stepVelocity(0.95, 1)).toBe(1);
    expect(stepVelocity(1, 1)).toBe(1);
    expect(stepVelocity(0.1, -1)).toBe(0.1);
    expect(stepVelocity(0.8, -1)).toBe(0.7);
  });
  it('no key plays two notes, every note key is in MAPPED_CODES, steppers do not collide with notes', () => {
    const codes = KEY_NOTES.map((k) => k.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(KEY_NOTES.map((k) => k.semitone)).size).toBe(KEY_NOTES.length);
    for (const c of codes) expect(MAPPED_CODES).toContain(c);
    for (const c of ['KeyZ', 'KeyX', 'KeyC', 'KeyV']) expect(codes).not.toContain(c);
    expect(KEY_NOTES.filter((k) => k.black).map((k) => k.semitone % 12)).toEqual([1, 3, 6, 8, 10, 1, 3]);
  });
  it('helpers for drawing: note names, labels, range', () => {
    expect(noteName(60)).toBe('C5');
    expect(noteName(61)).toBe('C#5');
    expect(noteName(0)).toBe('C0');
    expect(keyLabelForNote(60, 5)).toBe('A');
    expect(keyLabelForNote(64, 5)).toBe('D');
    expect(keyLabelForNote(40, 5)).toBeNull();
    expect(keyboardRange(5)).toEqual([60, 77]);
    expect(keyboardRange(9)).toEqual([108, 125]);
  });
  it('the keyboard node is playable and all other instruments are not', () => {
    const reg = audioRegistry();
    expect(reg.list().filter((d) => d.playable).map((d) => d.id)).toEqual(['midi-keyboard']);
  });
});
