/**
 * MIDI learn: the pure maths (no DOM, no Web MIDI). A mapping binds one MIDI control (a CC, a note or the pitch wheel) to one parameter
 * of one node. The mapped value is written INTO the parameter, so the project saves it like a hand edit and exports are deterministic.
 */
import { rdp } from './motion-take';
import type { CurveKey, CurveValue } from '../types';

export type MidiKind = 'cc' | 'note' | 'bend';
export type MidiCurve = 'linear' | 'exp' | 'log';
export type MidiButtonMode = 'toggle' | 'momentary' | 'step';
export type MidiPickup = 'pickup' | 'jump';

/** The control a mapping listens to. */
export interface MidiSource {
  kind: MidiKind;
  /** CC number or note number; 0 for the pitch wheel. */
  number: number;
  /** 0..15, or -1 for any channel. */
  channel: number;
  /** Hardware device id; '' = any device. */
  device: string;
}

export interface MidiMapping {
  id: string;
  node: string;
  param: string;
  source: MidiSource;
  /** Value at the bottom / top of the control (defaults to the parameter's soft range). */
  min: number;
  max: number;
  curve: MidiCurve;
  invert: boolean;
  /** For bool and enum parameters (and note buttons). */
  mode: MidiButtonMode;
  /** 'pickup': ignore the control until it reaches the current value (no jump). 'jump': follow at once. */
  pickup: MidiPickup;
  /** Display name of the device when it was learned. */
  deviceName?: string;
}

export interface MidiMap {
  mappings: MidiMapping[];
}

/** A decoded incoming message. `value` is 0..1 (pitch wheel: 0..1 with 0.5 at rest); `pressed` for note on/off. */
export interface MidiMsg {
  kind: MidiKind;
  number: number;
  channel: number;
  value: number;
  /** Notes: true on note on, false on note off. CCs: value >= 0.5. */
  pressed: boolean;
  device: string;
  deviceName?: string;
}

/** What the mapping needs to know about the parameter. */
export type ParamShape =
  | { type: 'number'; min: number; max: number; step?: number; integer?: boolean; softMax?: number }
  | { type: 'bool' }
  | { type: 'enum'; options: string[] };

export function parseMidi(data: ArrayLike<number>, device = '', deviceName?: string): MidiMsg | null {
  if (!data || data.length < 2) return null;
  const status = data[0] & 0xf0;
  const channel = data[0] & 0x0f;
  const a = data[1] & 0x7f;
  const b = data.length > 2 ? data[2] & 0x7f : 0;
  if (status === 0x90 && b > 0) return { kind: 'note', number: a, channel, value: b / 127, pressed: true, device, deviceName };
  if (status === 0x80 || (status === 0x90 && b === 0)) return { kind: 'note', number: a, channel, value: 0, pressed: false, device, deviceName };
  if (status === 0xb0) return { kind: 'cc', number: a, channel, value: b / 127, pressed: b >= 64, device, deviceName };
  if (status === 0xe0) {
    const v = (a | (b << 7)) / 16383;
    return { kind: 'bend', number: 0, channel, value: v, pressed: v > 0.5, device, deviceName };
  }
  return null;
}

export function sourceMatches(s: MidiSource, m: MidiMsg): boolean {
  return s.kind === m.kind && s.number === m.number && (s.channel < 0 || s.channel === m.channel) && (!s.device || s.device === m.device);
}

export const sourceOf = (m: MidiMsg, anyDevice = false): MidiSource => ({ kind: m.kind, number: m.number, channel: m.channel, device: anyDevice ? '' : m.device });

export function describeSource(s: MidiSource): string {
  const ch = s.channel >= 0 ? ` ch ${s.channel + 1}` : '';
  if (s.kind === 'cc') return `CC ${s.number}${ch}`;
  if (s.kind === 'bend') return `Pitch wheel${ch}`;
  return `Note ${noteName(s.number)}${ch}`;
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (n: number): string => `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;

/** Lowest/highest value a control sweeps over by default: the parameter's own soft range, or 0..1 when it is effectively unbounded. */
export function defaultRange(shape: ParamShape): { min: number; max: number } {
  if (shape.type !== 'number') return { min: 0, max: 1 };
  const top = shape.softMax ?? shape.max;
  const ok = (v: number) => Number.isFinite(v) && Math.abs(v) < 100000;
  const min = ok(shape.min) ? shape.min : 0;
  const max = ok(top) && top > min ? top : ok(shape.max) && shape.max > min ? shape.max : min + 1;
  return { min, max };
}

let counter = 0;
export function newMappingId(): string {
  counter++;
  return `mm${Date.now().toString(36)}${counter.toString(36)}`;
}

export function makeMapping(node: string, param: string, shape: ParamShape, source: MidiSource, deviceName?: string): MidiMapping {
  const r = defaultRange(shape);
  return {
    id: newMappingId(),
    node,
    param,
    source,
    min: r.min,
    max: r.max,
    curve: 'linear',
    invert: false,
    mode: shape.type === 'enum' ? 'step' : shape.type === 'bool' ? (source.kind === 'note' ? 'momentary' : 'toggle') : 'toggle',
    pickup: 'pickup',
    ...(deviceName ? { deviceName } : {}),
  };
}

const EXP = 2.2;
const shape01 = (c: MidiCurve, x: number): number => (c === 'exp' ? Math.pow(x, EXP) : c === 'log' ? Math.pow(x, 1 / EXP) : x);
const unshape01 = (c: MidiCurve, y: number): number => (c === 'exp' ? Math.pow(y, 1 / EXP) : c === 'log' ? Math.pow(y, EXP) : y);
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Control position 0..1 -> parameter value (before snapping to the parameter's step). */
export function scaleControl(m: Pick<MidiMapping, 'min' | 'max' | 'curve' | 'invert'>, x: number): number {
  const u = m.invert ? 1 - clamp01(x) : clamp01(x);
  return m.min + (m.max - m.min) * shape01(m.curve, u);
}

/** Parameter value -> where the control would have to be (0..1); the inverse of `scaleControl`. */
export function controlFor(m: Pick<MidiMapping, 'min' | 'max' | 'curve' | 'invert'>, value: number): number {
  const span = m.max - m.min;
  const c = span === 0 ? 0 : clamp01((value - m.min) / span);
  const u = unshape01(m.curve, c);
  return m.invert ? 1 - u : u;
}

/** Snap and clamp a number to what the parameter accepts. */
export function fitNumber(shape: Extract<ParamShape, { type: 'number' }>, v: number): number {
  let n = Math.max(Math.min(shape.min, shape.max), Math.min(Math.max(shape.min, shape.max), v));
  if (shape.integer) n = Math.round(n);
  else if (shape.step && shape.step > 0) {
    const decimals = Math.max(0, Math.min(6, Math.ceil(-Math.log10(shape.step)) + 1));
    n = Number((Math.round(n / shape.step) * shape.step).toFixed(decimals));
    n = Math.max(shape.min, Math.min(shape.max, n));
  }
  return n;
}

/** Per mapping runtime state (never saved). */
export interface MapState {
  /** The control has reached the parameter (soft takeover done). */
  picked: boolean;
  /** Last control position seen (0..1), to detect a crossing. */
  last: number;
  /** The value this mapping wrote last, to notice when the parameter was changed by something else. */
  written: number | null;
  /** Last button level for edge detection. */
  down: boolean;
}

export const newState = (): MapState => ({ picked: false, last: -1, written: null, down: false });

/** Distance (in 0..1 of the control) within which a control counts as "at" the parameter. */
export const PICKUP_WINDOW = 0.03;

export interface Applied {
  value: number | boolean | string;
  /** Control position 0..1 shown to the user (for the live dot), after takeover. */
  position: number;
}

/**
 * Feed one message through a mapping. Returns the value to write into the parameter, or null when the message changes nothing
 * (it is not for this mapping, the control has not picked up yet, a button was released...).
 */
export function applyMessage(m: MidiMapping, st: MapState, msg: MidiMsg, current: unknown, shape: ParamShape): Applied | null {
  if (!sourceMatches(m.source, msg)) return null;
  if (shape.type === 'number') {
    if (m.source.kind === 'note') {
      // a key on a number: sweeps the range with its velocity while held, goes to the bottom on release
      const x = msg.pressed ? msg.value : 0;
      return { value: fitNumber(shape, scaleControl(m, x)), position: x };
    }
    const x = msg.value;
    const cur = typeof current === 'number' && Number.isFinite(current) ? current : m.min;
    const at = controlFor(m, cur);
    if (st.written !== null && Math.abs(cur - st.written) > 1e-9 && m.pickup === 'pickup') st.picked = false; // changed by hand or by another mapping: wait for the knob again
    if (m.pickup === 'pickup' && !st.picked) {
      const crossed = st.last >= 0 && (st.last - at) * (x - at) <= 0;
      if (Math.abs(x - at) <= PICKUP_WINDOW || crossed) st.picked = true;
      st.last = x;
      if (!st.picked) return null;
    } else {
      st.picked = true;
      st.last = x;
    }
    const v = fitNumber(shape, scaleControl(m, x));
    st.written = v;
    return { value: v, position: x };
  }
  // bool and enum: buttons. A CC or the wheel is a button at the half way mark.
  const pressed = msg.kind === 'note' ? msg.pressed : msg.value >= 0.5;
  const edgeDown = pressed && !st.down;
  const edgeUp = !pressed && st.down;
  st.down = pressed;
  if (shape.type === 'bool') {
    if (m.mode === 'momentary') {
      if (edgeDown) return { value: !m.invert, position: 1 };
      if (edgeUp) return { value: m.invert, position: 0 };
      return null;
    }
    if (m.mode === 'toggle' && edgeDown) return { value: !(current === true), position: 1 };
    if (m.mode === 'step' && (edgeDown || edgeUp)) return { value: pressed !== m.invert, position: pressed ? 1 : 0 };
    return null;
  }
  const opts = shape.options;
  if (!opts.length) return null;
  const idx = Math.max(0, opts.indexOf(String(current)));
  if (m.mode === 'step' || m.mode === 'toggle') {
    if (!edgeDown) return null;
    const next = (idx + (m.invert ? opts.length - 1 : 1)) % opts.length;
    return { value: opts[next], position: next / Math.max(1, opts.length - 1) };
  }
  // momentary: the second option while held, the first on release
  if (edgeDown) return { value: opts[Math.min(1, opts.length - 1)], position: 1 };
  if (edgeUp) return { value: opts[0], position: 0 };
  return null;
}

/** Control sweeps an enum directly (a knob picks an option): used when the mapping is an absolute CC and mode is 'toggle' is not wanted. */
export function enumAt(options: string[], x: number): string {
  const i = Math.min(options.length - 1, Math.floor(clamp01(x) * options.length));
  return options[Math.max(0, i)];
}

/* ---------------------------------------------------------------- storage */

const KINDS = ['cc', 'note', 'bend'];
const CURVES = ['linear', 'exp', 'log'];
const MODES = ['toggle', 'momentary', 'step'];
const PICKUPS = ['pickup', 'jump'];

/** Validate a stored map (project files can hold anything). Bad mappings are dropped, not repaired. */
export function parseMidiMap(raw: unknown): MidiMap | null {
  if (!raw || typeof raw !== 'object') return null;
  const list = (raw as { mappings?: unknown }).mappings;
  if (!Array.isArray(list)) return null;
  const out: MidiMapping[] = [];
  const seen = new Set<string>();
  for (const x of list) {
    if (!x || typeof x !== 'object') continue;
    const m = x as Partial<MidiMapping> & { source?: Partial<MidiSource> };
    const s = m.source;
    if (typeof m.id !== 'string' || typeof m.node !== 'string' || typeof m.param !== 'string' || !s || typeof s !== 'object') continue;
    if (seen.has(m.id)) continue;
    if (!KINDS.includes(String(s.kind)) || !Number.isFinite(s.number) || !Number.isFinite(s.channel)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      node: m.node,
      param: m.param,
      source: { kind: s.kind as MidiKind, number: Math.round(s.number as number), channel: Math.round(s.channel as number), device: typeof s.device === 'string' ? s.device : '' },
      min: Number.isFinite(m.min) ? (m.min as number) : 0,
      max: Number.isFinite(m.max) ? (m.max as number) : 1,
      curve: CURVES.includes(String(m.curve)) ? (m.curve as MidiCurve) : 'linear',
      invert: m.invert === true,
      mode: MODES.includes(String(m.mode)) ? (m.mode as MidiButtonMode) : 'toggle',
      pickup: PICKUPS.includes(String(m.pickup)) ? (m.pickup as MidiPickup) : 'pickup',
      ...(typeof m.deviceName === 'string' ? { deviceName: m.deviceName } : {}),
    });
  }
  return { mappings: out };
}

/** Drop mappings of nodes that no longer exist (call after edits; returns the same object when nothing changed). */
export function pruneMap(map: MidiMap | undefined, nodeIds: Set<string>): MidiMap | undefined {
  if (!map) return map;
  const kept = map.mappings.filter((m) => nodeIds.has(m.node));
  return kept.length === map.mappings.length ? map : { mappings: kept };
}

/* ------------------------------------------------------------ automation */

export interface AutoSample {
  /** Position in the loop, 0..1. */
  t: number;
  v: number;
}

/**
 * Recorded movements -> a Keyframes curve. The samples are held between messages (a knob keeps its value), resampled to the
 * frame grid and simplified with Ramer-Douglas-Peucker so the result is a handful of editable keys. Starts at the value the
 * parameter had when recording began (`start`).
 */
export function automationCurve(samples: AutoSample[], start: number, frames: number, range: { min: number; max: number }): CurveValue {
  const n = Math.max(2, Math.round(frames));
  const pts = [...samples].filter((s) => Number.isFinite(s.t) && Number.isFinite(s.v)).sort((a, b) => a.t - b.t);
  const dense = new Float64Array(n);
  let j = 0;
  let cur = start;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    while (j < pts.length && pts[j].t <= t + 1e-9) cur = pts[j++].v;
    dense[i] = cur;
  }
  const tol = Math.max(1e-6, (range.max - range.min) * 0.004);
  const idx = rdp(dense, tol);
  const keys: CurveKey[] = idx.map((i) => ({ t: i / n, v: Number(dense[i].toFixed(6)), interp: 'linear' as const }));
  // a held value must stay flat until the next change: insert the key just before each jump
  const out: CurveKey[] = [];
  for (let k = 0; k < keys.length; k++) {
    out.push(keys[k]);
    const nx = keys[k + 1];
    if (nx && k + 1 < keys.length && Math.abs(nx.v - keys[k].v) > tol * 4 && (nx.t - keys[k].t) * n <= 1.5) out[out.length - 1] = { ...keys[k], interp: 'hold' };
  }
  const last = out[out.length - 1];
  if (last.t < 1 - 1e-9) out.push({ t: 1, v: last.v, interp: 'linear' });
  return { keys: out };
}

/** What a mapping needs to know about a parameter definition; null for parameters MIDI cannot drive (colors, text, curves...). */
export function shapeOf(p: import('../types').ParamDef | undefined): ParamShape | null {
  if (!p) return null;
  if (p.type === 'number') return { type: 'number', min: p.min ?? -1e6, max: p.max ?? 1e6, step: p.step, integer: p.integer, softMax: p.softMax };
  if (p.type === 'bool') return { type: 'bool' };
  if (p.type === 'enum') return { type: 'enum', options: p.options.map((o) => o.value) };
  return null;
}
