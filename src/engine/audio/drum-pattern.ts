/**
 * Step-sequencer pattern of the `drum-machine` node (its `pattern` json param) and pure helpers to edit it.
 * The UI edits the pattern only through these functions.
 *
 * ```json
 * { "steps": 16, "swing": 0, "tracks": { "kick": [1,0,0,0, 1,0,0,0, ...], "snare": [...], ... } }
 * ```
 * `steps` is 16 or 32 (sixteenth notes), each track has `steps` numbers: 0 = no hit, 0..1 = velocity.
 * `swing` (0..0.75) delays every second step by that fraction of a step.
 */

export const DRUM_VOICES = ['kick', 'snare', 'clap', 'chat', 'ohat', 'tom', 'rim', 'cowbell'] as const;
export type DrumVoice = (typeof DRUM_VOICES)[number];

export const DRUM_LABELS: Record<DrumVoice, string> = {
  kick: 'Kick',
  snare: 'Snare',
  clap: 'Clap',
  chat: 'Closed hat',
  ohat: 'Open hat',
  tom: 'Tom',
  rim: 'Rim shot',
  cowbell: 'Cowbell',
};

export interface DrumPattern {
  steps: 16 | 32;
  swing: number;
  tracks: Record<DrumVoice, number[]>;
}

export function emptyPattern(steps: 16 | 32 = 16): DrumPattern {
  const tracks = {} as Record<DrumVoice, number[]>;
  for (const v of DRUM_VOICES) tracks[v] = new Array(steps).fill(0);
  return { steps, swing: 0, tracks };
}

/** A simple rock beat: kick on 1 and 3, snare on 2 and 4, eighth-note hats. */
export function defaultPattern(): DrumPattern {
  let p = emptyPattern(16);
  for (const s of [0, 8]) p = setStep(p, 'kick', s, 1);
  for (const s of [4, 12]) p = setStep(p, 'snare', s, 1);
  for (let s = 0; s < 16; s += 2) p = setStep(p, 'chat', s, s % 4 === 0 ? 0.9 : 0.6);
  return p;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

/** Repair anything into a valid pattern (wrong lengths are cut or padded with rests). Never throws. */
export function normalizePattern(raw: unknown): DrumPattern {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const steps: 16 | 32 = r.steps === 32 ? 32 : 16;
  const out = emptyPattern(steps);
  out.swing = Math.min(0.75, Math.max(0, typeof r.swing === 'number' && Number.isFinite(r.swing) ? r.swing : 0));
  const tracks = (r.tracks && typeof r.tracks === 'object' ? r.tracks : {}) as Record<string, unknown>;
  for (const v of DRUM_VOICES) {
    const t = tracks[v];
    if (Array.isArray(t)) for (let i = 0; i < steps; i++) out.tracks[v][i] = clamp01(Number(t[i] ?? 0));
  }
  return out;
}

const withTrack = (p: DrumPattern, voice: DrumVoice, track: number[]): DrumPattern => ({ ...p, tracks: { ...p.tracks, [voice]: track } });

/** Set one step (velocity 0 clears it). */
export function setStep(p: DrumPattern, voice: DrumVoice, step: number, velocity: number): DrumPattern {
  if (step < 0 || step >= p.steps) return p;
  const t = p.tracks[voice].slice();
  t[step] = clamp01(velocity);
  return withTrack(p, voice, t);
}

/** Click on a step: on (at `velocity`) if it was off, off if it was on. */
export function toggleStep(p: DrumPattern, voice: DrumVoice, step: number, velocity = 1): DrumPattern {
  return setStep(p, voice, step, p.tracks[voice][step] > 0 ? 0 : velocity);
}

export function clearVoice(p: DrumPattern, voice: DrumVoice): DrumPattern {
  return withTrack(p, voice, new Array(p.steps).fill(0));
}

export function clearAll(p: DrumPattern): DrumPattern {
  return { ...emptyPattern(p.steps), swing: p.swing };
}

/** Switch between 16 and 32 steps: growing repeats the pattern, shrinking keeps the first half. */
export function setSteps(p: DrumPattern, steps: 16 | 32): DrumPattern {
  if (steps === p.steps) return p;
  const out = emptyPattern(steps);
  out.swing = p.swing;
  for (const v of DRUM_VOICES) for (let i = 0; i < steps; i++) out.tracks[v][i] = p.tracks[v][i % p.steps];
  return out;
}

export function setSwing(p: DrumPattern, swing: number): DrumPattern {
  return { ...p, swing: Math.min(0.75, Math.max(0, swing)) };
}

/** Rotate a track by `by` steps (positive = later). */
export function rotateVoice(p: DrumPattern, voice: DrumVoice, by: number): DrumPattern {
  const n = p.steps;
  const t = p.tracks[voice];
  return withTrack(p, voice, t.map((_, i) => t[(((i - by) % n) + n) % n]));
}

/** Hit every `every` steps starting at `offset`. */
export function fillEvery(p: DrumPattern, voice: DrumVoice, every: number, offset = 0, velocity = 1): DrumPattern {
  const t = new Array(p.steps).fill(0);
  for (let i = offset; i < p.steps; i += Math.max(1, every)) t[i] = clamp01(velocity);
  return withTrack(p, voice, t);
}

/** Euclidean rhythm: `pulses` hits spread as evenly as possible over the steps. */
export function euclidean(p: DrumPattern, voice: DrumVoice, pulses: number, rotation = 0, velocity = 1): DrumPattern {
  const n = p.steps;
  const k = Math.max(0, Math.min(n, Math.round(pulses)));
  const t = new Array(n).fill(0);
  for (let i = 0; i < k; i++) t[Math.floor((i * n) / k)] = clamp01(velocity);
  return rotateVoice(withTrack(p, voice, t), voice, rotation);
}

/** Random hits (deterministic from `seed`): `density` 0..1 of the steps, velocities 0.5..1. */
export function randomizeVoice(p: DrumPattern, voice: DrumVoice, density: number, seed = 1): DrumPattern {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return withTrack(p, voice, Array.from({ length: p.steps }, () => (rnd() < density ? 0.5 + rnd() * 0.5 : 0)));
}

/** How many steps have a hit. */
export const countHits = (p: DrumPattern): number => DRUM_VOICES.reduce((a, v) => a + p.tracks[v].filter((x) => x > 0).length, 0);

/** Time of step `step` in seconds from the pattern start, for a step length `stepSeconds` (swing delays odd steps). */
export function stepTime(p: DrumPattern, step: number, stepSeconds: number): number {
  return (step + (step % 2 === 1 ? p.swing : 0)) * stepSeconds;
}
