/**
 * Computer keyboard -> musical notes. ONE place for the layout; the UI imports this (do not re-invent it).
 * Pure, no DOM: pass `KeyboardEvent.code` (physical key, so it works on any keyboard layout).
 *
 * Layout (Ableton / GarageBand style, one octave and a bit on the home row, sharps on the row above):
 *
 *      W E   T Y U   O P          black keys: C# D#  F# G# A#  C# D#
 *     A S D F G H J K L ; '       white keys: C D E F G A B C D E F
 *
 * Digits 1-9 choose the octave (5 is the normal middle range; the bottom A key plays MIDI 60 = middle C at octave 5,
 * i.e. the A key plays note `octave * 12`). Z / X step the octave down / up, C / V step the velocity down / up.
 */

export const MIN_OCTAVE = 1;
export const MAX_OCTAVE = 9;
export const DEFAULT_OCTAVE = 5;
/** Velocity (key strength) change per C / V press. */
export const VELOCITY_STEP = 0.1;

export interface KeyNote {
  /** KeyboardEvent.code */
  code: string;
  /** Semitones above the C of the current octave. */
  semitone: number;
  /** What to print on the key cap (the letter). */
  label: string;
  /** True for the sharps/flats (draw as a black key). */
  black: boolean;
}

/** Every key that plays a note, in pitch order. */
export const KEY_NOTES: readonly KeyNote[] = [
  { code: 'KeyA', semitone: 0, label: 'A', black: false },
  { code: 'KeyW', semitone: 1, label: 'W', black: true },
  { code: 'KeyS', semitone: 2, label: 'S', black: false },
  { code: 'KeyE', semitone: 3, label: 'E', black: true },
  { code: 'KeyD', semitone: 4, label: 'D', black: false },
  { code: 'KeyF', semitone: 5, label: 'F', black: false },
  { code: 'KeyT', semitone: 6, label: 'T', black: true },
  { code: 'KeyG', semitone: 7, label: 'G', black: false },
  { code: 'KeyY', semitone: 8, label: 'Y', black: true },
  { code: 'KeyH', semitone: 9, label: 'H', black: false },
  { code: 'KeyU', semitone: 10, label: 'U', black: true },
  { code: 'KeyJ', semitone: 11, label: 'J', black: false },
  { code: 'KeyK', semitone: 12, label: 'K', black: false },
  { code: 'KeyO', semitone: 13, label: 'O', black: true },
  { code: 'KeyL', semitone: 14, label: 'L', black: false },
  { code: 'KeyP', semitone: 15, label: 'P', black: true },
  { code: 'Semicolon', semitone: 16, label: ';', black: false },
  { code: 'Quote', semitone: 17, label: "'", black: false },
];

const BY_CODE = new Map(KEY_NOTES.map((k) => [k.code, k]));

/** Every KeyboardEvent.code the keyboard node reacts to (notes, octave digits, steppers). */
export const MAPPED_CODES: readonly string[] = [
  ...KEY_NOTES.map((k) => k.code),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((d) => [`Digit${d}`, `Numpad${d}`]),
  'KeyZ',
  'KeyX',
  'KeyC',
  'KeyV',
];

/** MIDI note of the C that the bottom key plays, for an octave 1..9 (octave 5 = 60 = middle C). Clamped. */
export function octaveBaseNote(octave: number): number {
  return clampOctave(octave) * 12;
}

export function clampOctave(octave: number): number {
  return Math.min(MAX_OCTAVE, Math.max(MIN_OCTAVE, Math.round(octave)));
}

/** MIDI note for a key code at an octave, or null if the key plays no note (or the note would exceed 127). */
export function keyToNote(code: string, octave: number): number | null {
  const k = BY_CODE.get(code);
  if (!k) return null;
  const note = octaveBaseNote(octave) + k.semitone;
  return note > 127 ? null : note;
}

/** Octave chosen by a digit key (Digit1..Digit9, Numpad1..Numpad9), or null. */
export function octaveForKey(code: string): number | null {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
  return m ? Number(m[1]) : null;
}

export type KeyAction =
  | { kind: 'note'; semitone: number }
  | { kind: 'octave'; value: number }
  | { kind: 'octave-step'; delta: -1 | 1 }
  | { kind: 'velocity-step'; delta: -1 | 1 };

/** What a key does, or null if the keyboard node ignores it. Ignore events with modifier keys (Ctrl/Cmd/Alt) yourself. */
export function keyAction(code: string): KeyAction | null {
  const k = BY_CODE.get(code);
  if (k) return { kind: 'note', semitone: k.semitone };
  const o = octaveForKey(code);
  if (o !== null) return { kind: 'octave', value: o };
  if (code === 'KeyZ') return { kind: 'octave-step', delta: -1 };
  if (code === 'KeyX') return { kind: 'octave-step', delta: 1 };
  if (code === 'KeyC') return { kind: 'velocity-step', delta: -1 };
  if (code === 'KeyV') return { kind: 'velocity-step', delta: 1 };
  return null;
}

/** New velocity after pressing C (-1) or V (+1), kept in 0.1..1 and rounded to one decimal. */
export function stepVelocity(velocity: number, delta: -1 | 1): number {
  return Math.min(1, Math.max(0.1, Math.round((velocity + delta * VELOCITY_STEP) * 10) / 10));
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** "C5" for MIDI 60 (middle C is C5 in this scheme, matching octave 5 as the normal range). */
export function noteName(note: number): string {
  return `${NAMES[((note % 12) + 12) % 12]}${Math.floor(note / 12)}`;
}

/** The key cap letter that plays `note` at `octave`, or null when that note is not reachable (for drawing an on-screen keyboard). */
export function keyLabelForNote(note: number, octave: number): string | null {
  const k = KEY_NOTES.find((n) => octaveBaseNote(octave) + n.semitone === note);
  return k ? k.label : null;
}

/** Notes the computer keys currently cover: [lowest, highest]. */
export function keyboardRange(octave: number): [number, number] {
  const base = octaveBaseNote(octave);
  return [base, Math.min(127, base + KEY_NOTES[KEY_NOTES.length - 1].semitone)];
}
