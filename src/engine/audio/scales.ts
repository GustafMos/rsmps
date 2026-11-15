/** Musical scale helpers shared by audio-to-midi, midi-transpose and the arpeggiator. */

export const SCALES: Record<string, number[]> = {
  off: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'pentatonic-major': [0, 2, 4, 7, 9],
  'pentatonic-minor': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
};

export const SCALE_OPTIONS = [
  { value: 'off', label: 'Off (any note)' },
  { value: 'major', label: 'Major' },
  { value: 'minor', label: 'Minor' },
  { value: 'pentatonic-major', label: 'Pentatonic major' },
  { value: 'pentatonic-minor', label: 'Pentatonic minor' },
  { value: 'blues', label: 'Blues' },
  { value: 'dorian', label: 'Dorian' },
  { value: 'harmonic-minor', label: 'Harmonic minor' },
] as const;

export const KEY_OPTIONS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((label, i) => ({ value: String(i), label }));

/** Nearest in-scale integer MIDI note to `note` (which may be fractional). Ties go down. */
export function snapToScale(note: number, scale: string, key: number): number {
  const degrees = SCALES[scale] ?? SCALES.off;
  const base = Math.round(note);
  if (scale === 'off') return base;
  let best = base;
  let bestDist = Infinity;
  for (let n = base - 6; n <= base + 6; n++) {
    const pc = (((n - key) % 12) + 12) % 12;
    if (!degrees.includes(pc)) continue;
    const d = Math.abs(n - note);
    if (d < bestDist - 1e-9) {
      bestDist = d;
      best = n;
    }
  }
  return best;
}

/** Move `note` by `steps` scale degrees (steps may be negative). Notes outside the scale are snapped first. */
export function stepInScale(note: number, steps: number, scale: string, key: number): number {
  let n = snapToScale(note, scale, key);
  const dir = steps < 0 ? -1 : 1;
  for (let s = Math.abs(steps); s > 0; s--) {
    do {
      n += dir;
    } while (!(SCALES[scale] ?? SCALES.off).includes((((n - key) % 12) + 12) % 12));
  }
  return n;
}
