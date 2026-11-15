/**
 * Shared plumbing for the MIDI instruments (chip-synth, fm-synth, organ, strings-pad, bass, sampler, drum-machine):
 * voice allocation with stealing, a per-voice ADSR, and "preset = parameter bundle" support.
 */
import type { AudioParams, MidiEvent } from './types';

export interface Voices {
  n: number;
  note: Int16Array;
  /** 0 idle, 1 attack, 2 decay/sustain, 3 release */
  stage: Int8Array;
  held: Uint8Array;
  vel: Float64Array;
  env: Float64Array;
  age: Float64Array;
  clock: number;
  pedal: boolean;
  /** Set by `pickVoice`: the voice was idle (true) or reused/stolen (false). */
  fresh: boolean;
}

export function makeVoices(n: number): Voices {
  return {
    n,
    note: new Int16Array(n).fill(-1),
    stage: new Int8Array(n),
    held: new Uint8Array(n),
    vel: new Float64Array(n),
    env: new Float64Array(n),
    age: new Float64Array(n),
    clock: 0,
    pedal: false,
    fresh: true,
  };
}

/** Choose a voice for a new note: the same note again, else an idle voice, else steal (quietest releasing, else oldest). */
export function pickVoice(v: Voices, note: number, maxVoices: number): number {
  const max = Math.min(v.n, Math.max(1, maxVoices));
  let idx = -1;
  for (let i = 0; i < max; i++) if (v.note[i] === note && v.stage[i] !== 0) idx = i;
  if (idx < 0) for (let i = 0; i < max; i++) if (v.stage[i] === 0) { idx = i; break; }
  if (idx < 0) {
    let best = Infinity;
    for (let i = 0; i < max; i++) {
      const score = v.stage[i] === 3 ? v.env[i] - 10 : -v.age[i] + 1e9;
      if (score < best) {
        best = score;
        idx = i;
      }
    }
  }
  if (idx < 0) idx = 0;
  v.fresh = v.stage[idx] === 0;
  v.note[idx] = note;
  v.held[idx] = 1;
  v.stage[idx] = 1;
  v.age[idx] = v.clock++;
  if (v.fresh) v.env[idx] = 0;
  return idx;
}

/** Key released: voices holding `note` go to release (or wait for the sustain pedal). */
export function releaseNote(v: Voices, note: number): void {
  for (let i = 0; i < v.n; i++) {
    if (v.note[i] === note && v.stage[i] !== 0 && v.stage[i] !== 3 && v.held[i]) {
      v.held[i] = 0;
      if (!v.pedal) v.stage[i] = 3;
    }
  }
}

/** CC 64 sustain pedal, CC 120/123 all notes off. Returns true if the event was a controller it handled. */
export function handleController(v: Voices, ev: MidiEvent): boolean {
  if (ev.type !== 'cc') return false;
  if (ev.note === 64) {
    const down = ev.value >= 0.5;
    if (!down && v.pedal) for (let i = 0; i < v.n; i++) if (!v.held[i] && v.stage[i] !== 0 && v.stage[i] !== 3) v.stage[i] = 3;
    v.pedal = down;
    return true;
  }
  if (ev.note === 123 || ev.note === 120) {
    for (let i = 0; i < v.n; i++) if (v.stage[i] !== 0) { v.stage[i] = 3; v.held[i] = 0; }
    return true;
  }
  return false;
}

export function allIdle(v: Voices): void {
  v.stage.fill(0);
  v.env.fill(0);
  v.note.fill(-1);
  v.held.fill(0);
}

/** Exponential time-constant coefficient reaching ~99% in `seconds`. */
export const expCoef = (seconds: number, sr: number): number => 1 - Math.exp(-4.6 / Math.max(1, seconds * sr));

/**
 * Advance voice i's ADSR by one sample. `atkInc` = 1/(attack samples), `decC`/`relC` from `expCoef`.
 * Returns the new envelope value (also stored). The voice goes idle (stage 0) when the release has faded out.
 */
export function adsrStep(v: Voices, i: number, atkInc: number, decC: number, sustain: number, relC: number): number {
  let e = v.env[i];
  switch (v.stage[i]) {
    case 1:
      e += atkInc;
      if (e >= 1) {
        e = 1;
        v.stage[i] = 2;
      }
      break;
    case 2:
      e += (sustain - e) * decC;
      break;
    case 3:
      e -= e * relC;
      if (e < 1e-4) {
        e = 0;
        v.stage[i] = 0;
        v.note[i] = -1;
      }
      break;
  }
  v.env[i] = e;
  return e;
}

/**
 * Presets as parameter bundles. Returns an object that reads the bundle's values first and falls back to the node's
 * own params for everything else (volume, ...). Cached in `cache` per preset name so nothing is allocated per block.
 * 'custom' returns the params themselves.
 */
export function presetView(cache: { name: string; view: AudioParams | null; src: AudioParams | null }, params: AudioParams, bundles: Record<string, Record<string, unknown>>): AudioParams {
  const name = params.preset as string;
  if (name === 'custom' || !bundles[name]) return params;
  if (cache.name !== name || cache.src !== params || !cache.view) {
    cache.name = name;
    cache.src = params;
    cache.view = Object.assign(Object.create(params), bundles[name]);
  }
  return cache.view!;
}

export const newPresetCache = (): { name: string; view: AudioParams | null; src: AudioParams | null } => ({ name: '', view: null, src: null });

/** Option list for a `preset` enum param: Custom plus the bundle names (with display labels). */
export function presetOptions(labels: Record<string, string>): readonly { value: string; label: string }[] {
  return [{ value: 'custom', label: 'Custom (use the settings below)' }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))];
}

/** Sine by table lookup with linear interpolation, `phase` in cycles (any real). */
const SINE = new Float32Array(2049);
for (let i = 0; i <= 2048; i++) SINE[i] = Math.sin((2 * Math.PI * i) / 2048);
export function fastSin(phase: number): number {
  const x = (phase - Math.floor(phase)) * 2048;
  const i = x | 0;
  return SINE[i] + (SINE[i + 1] - SINE[i]) * (x - i);
}
