/**
 * Timeline data model and pure editing helpers for the `audio-timeline` node (Ableton-style clip arranger).
 * No DOM, no Web Audio: the UI edits the node's `clips` param ONLY through these functions, the kernel reads it
 * through `normalizeTimeline`.
 *
 * ## The `clips` param (JSON, version 1)
 *
 * ```json
 * {
 *   "version": 1,
 *   "tracks": [
 *     { "id": "t1", "name": "Audio 1", "kind": "audio", "gain": 0, "pan": 0, "mute": false, "solo": false },
 *     { "id": "t2", "name": "MIDI 1",  "kind": "midi",  "gain": 0, "pan": 0, "mute": false, "solo": false }
 *   ],
 *   "clips": [
 *     { "id": "c1", "track": "t1", "start": 2, "length": 4, "offset": 0.5, "loop": false,
 *       "gain": 0, "fadeIn": 0.01, "fadeOut": 0.05, "asset": "asset-id" },
 *     { "id": "c2", "track": "t2", "start": 0, "length": 4, "offset": 0, "loop": true, "srcLength": 2,
 *       "gain": 0, "fadeIn": 0, "fadeOut": 0,
 *       "notes": [ { "t": 0, "d": 0.5, "note": 60, "vel": 0.8 } ],
 *       "cc": [ { "t": 0, "cc": 1, "value": 0.5 } ] }
 *   ]
 * }
 * ```
 *
 * Units: seconds on the project timeline (`start`), seconds into the clip's source (`offset`), seconds (`length`,
 * `fadeIn`, `fadeOut`, `srcLength`), dB (`gain`), -1..1 (`pan`), 0..1 (`vel`, `value`). Note times `t` are seconds from the
 * START OF THE SOURCE (clip start when `offset` is 0). Clips on a track may overlap (they sum / merge).
 * `loop: true` repeats the source region to fill `length`: for audio the region is `offset`..end of the asset, for MIDI it is
 * `offset`..`offset + srcLength` (`srcLength` defaults to `length`). Repeats are phase-locked to the clip start, so a looping
 * clip stays locked to the project loop. `muted: true` on a clip silences just that clip (used for non-active loop takes).
 * Track `gain` and `pan` apply to audio tracks; `mute` / `solo` apply to both kinds (any solo silences all non-solo tracks).
 */
import type { PcmAudio, RecordedTake } from './api';
import { hzToMidi } from './dsp';
import { makePitchTracker, pitchPush } from './pitch-tracker';

export interface TimelineNote {
  /** Seconds from the start of the source. */
  t: number;
  /** Duration in seconds. */
  d: number;
  /** MIDI note 0..127. */
  note: number;
  /** Velocity 0..1. */
  vel: number;
}

export interface TimelineCC {
  t: number;
  /** Controller number. */
  cc: number;
  /** 0..1 */
  value: number;
}

export interface TimelineTrack {
  id: string;
  name: string;
  kind: 'audio' | 'midi';
  /** dB (audio tracks). */
  gain: number;
  /** -1..1 (audio tracks). */
  pan: number;
  mute: boolean;
  solo: boolean;
}

export interface TimelineClip {
  id: string;
  track: string;
  /** Project time where the clip starts, seconds. */
  start: number;
  /** Length on the timeline, seconds. */
  length: number;
  /** Seconds into the source where playback starts. */
  offset: number;
  /** Repeat the source region to fill `length`. */
  loop: boolean;
  /** Length of the MIDI source region when looping (default: `length`). */
  srcLength?: number;
  /** dB */
  gain: number;
  fadeIn: number;
  fadeOut: number;
  muted?: boolean;
  name?: string;
  /** Audio clips: asset id. */
  asset?: string;
  /** MIDI clips. */
  notes?: TimelineNote[];
  cc?: TimelineCC[];
}

export interface TimelineData {
  version: 1;
  tracks: TimelineTrack[];
  clips: TimelineClip[];
}

export type Grid = 'off' | '1/1' | '1/2' | '1/4' | '1/8' | '1/16' | '1/32';
export type LoopRecordMode = 'overdub' | 'takes' | 'replace';

/* ----------------------------------------------------------------------- */
/* Construction and sanitising                                              */
/* ----------------------------------------------------------------------- */

export function emptyTimeline(): TimelineData {
  return {
    version: 1,
    tracks: [
      { id: 'a1', name: 'Audio 1', kind: 'audio', gain: 0, pan: 0, mute: false, solo: false },
      { id: 'm1', name: 'MIDI 1', kind: 'midi', gain: 0, pan: 0, mute: false, solo: false },
    ],
    clips: [],
  };
}

const num = (v: unknown, d: number, lo = -Infinity, hi = Infinity): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

/** Turn anything (saved project, plugin, hand-edited JSON) into a valid TimelineData. Never throws. Clips of unknown tracks are dropped. */
export function normalizeTimeline(raw: unknown): TimelineData {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const tracks: TimelineTrack[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(r.tracks) ? r.tracks : []) {
    if (!t || typeof t !== 'object' || typeof (t as TimelineTrack).id !== 'string' || seen.has((t as TimelineTrack).id)) continue;
    const x = t as Partial<TimelineTrack>;
    seen.add(x.id!);
    tracks.push({
      id: x.id!,
      name: typeof x.name === 'string' ? x.name : x.id!,
      kind: x.kind === 'midi' ? 'midi' : 'audio',
      gain: num(x.gain, 0, -90, 24),
      pan: num(x.pan, 0, -1, 1),
      mute: x.mute === true,
      solo: x.solo === true,
    });
  }
  const clips: TimelineClip[] = [];
  const clipIds = new Set<string>();
  for (const c of Array.isArray(r.clips) ? r.clips : []) {
    if (!c || typeof c !== 'object') continue;
    const x = c as Partial<TimelineClip>;
    if (typeof x.id !== 'string' || clipIds.has(x.id) || typeof x.track !== 'string' || !seen.has(x.track)) continue;
    clipIds.add(x.id);
    const clip: TimelineClip = {
      id: x.id,
      track: x.track,
      start: num(x.start, 0, 0),
      length: num(x.length, 0, 0),
      offset: num(x.offset, 0, 0),
      loop: x.loop === true,
      gain: num(x.gain, 0, -90, 24),
      fadeIn: num(x.fadeIn, 0, 0),
      fadeOut: num(x.fadeOut, 0, 0),
    };
    if (x.srcLength !== undefined) clip.srcLength = num(x.srcLength, clip.length, 0.001);
    if (x.muted) clip.muted = true;
    if (typeof x.name === 'string') clip.name = x.name;
    if (typeof x.asset === 'string') clip.asset = x.asset;
    if (Array.isArray(x.notes)) {
      clip.notes = x.notes
        .filter((n) => n && typeof n === 'object')
        .map((n) => ({ t: num(n.t, 0, 0), d: num(n.d, 0.1, 0.001), note: Math.round(num(n.note, 60, 0, 127)), vel: num(n.vel, 0.8, 0, 1) }))
        .sort((a, b) => a.t - b.t || a.note - b.note);
    }
    if (Array.isArray(x.cc)) {
      clip.cc = x.cc.filter((e) => e && typeof e === 'object').map((e) => ({ t: num(e.t, 0, 0), cc: Math.round(num(e.cc, 1, 0, 127)), value: num(e.value, 0, 0, 1) })).sort((a, b) => a.t - b.t);
    }
    clips.push(clip);
  }
  return { version: 1, tracks, clips };
}

/** First id `${prefix}${n}` not in `used`. Deterministic (no randomness). */
export function uniqueId(prefix: string, used: Iterable<string>): string {
  const set = new Set(used);
  let n = 1;
  while (set.has(prefix + n)) n++;
  return prefix + n;
}

/* ----------------------------------------------------------------------- */
/* Time helpers                                                             */
/* ----------------------------------------------------------------------- */

export const secondsPerBeat = (bpm: number): number => 60 / Math.max(1, bpm);

/** Length of a grid step in seconds (`off` = 0). */
export function gridSeconds(bpm: number, grid: Grid): number {
  if (grid === 'off') return 0;
  const [, den] = grid.split('/').map(Number);
  return (secondsPerBeat(bpm) * 4) / den;
}

/** Snap a time to the nearest grid line (strength 0..1 moves part of the way). */
export function snapTime(t: number, bpm: number, grid: Grid, strength = 1): number {
  const g = gridSeconds(bpm, grid);
  if (g <= 0) return t;
  const snapped = Math.round(t / g) * g;
  return t + (snapped - t) * strength;
}

export const clipEnd = (c: TimelineClip): number => c.start + c.length;

/** End of the last clip, seconds. */
export function timelineDuration(tl: TimelineData): number {
  return tl.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export const isMidiClip = (c: TimelineClip): boolean => c.notes !== undefined;

/* ----------------------------------------------------------------------- */
/* Tracks                                                                   */
/* ----------------------------------------------------------------------- */

export function addTrack(tl: TimelineData, kind: 'audio' | 'midi', name?: string): { timeline: TimelineData; track: TimelineTrack } {
  const id = uniqueId(kind === 'audio' ? 'a' : 'm', tl.tracks.map((t) => t.id));
  const count = tl.tracks.filter((t) => t.kind === kind).length + 1;
  const track: TimelineTrack = { id, name: name ?? `${kind === 'audio' ? 'Audio' : 'MIDI'} ${count}`, kind, gain: 0, pan: 0, mute: false, solo: false };
  return { timeline: { ...tl, tracks: [...tl.tracks, track] }, track };
}

export function updateTrack(tl: TimelineData, id: string, patch: Partial<Omit<TimelineTrack, 'id' | 'kind'>>): TimelineData {
  return { ...tl, tracks: tl.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

/** Removes the track and its clips. */
export function removeTrack(tl: TimelineData, id: string): TimelineData {
  return { ...tl, tracks: tl.tracks.filter((t) => t.id !== id), clips: tl.clips.filter((c) => c.track !== id) };
}

/* ----------------------------------------------------------------------- */
/* Clips                                                                    */
/* ----------------------------------------------------------------------- */

const baseClip = (id: string, track: string, start: number, length: number): TimelineClip => ({ id, track, start, length, offset: 0, loop: false, gain: 0, fadeIn: 0, fadeOut: 0 });

export function addAudioClip(
  tl: TimelineData,
  opts: { track: string; start: number; length: number; asset: string; offset?: number; loop?: boolean; gain?: number; fadeIn?: number; fadeOut?: number; name?: string },
): { timeline: TimelineData; clip: TimelineClip } {
  const id = uniqueId('c', tl.clips.map((c) => c.id));
  const clip: TimelineClip = { ...baseClip(id, opts.track, Math.max(0, opts.start), Math.max(0, opts.length)), asset: opts.asset };
  if (opts.offset !== undefined) clip.offset = Math.max(0, opts.offset);
  if (opts.loop) clip.loop = true;
  if (opts.gain !== undefined) clip.gain = opts.gain;
  if (opts.fadeIn !== undefined) clip.fadeIn = opts.fadeIn;
  if (opts.fadeOut !== undefined) clip.fadeOut = opts.fadeOut;
  if (opts.name) clip.name = opts.name;
  return { timeline: { ...tl, clips: [...tl.clips, clip] }, clip };
}

export function addMidiClip(
  tl: TimelineData,
  opts: { track: string; start: number; length: number; notes?: TimelineNote[]; cc?: TimelineCC[]; offset?: number; loop?: boolean; srcLength?: number; name?: string },
): { timeline: TimelineData; clip: TimelineClip } {
  const id = uniqueId('c', tl.clips.map((c) => c.id));
  const clip: TimelineClip = { ...baseClip(id, opts.track, Math.max(0, opts.start), Math.max(0, opts.length)), notes: [...(opts.notes ?? [])].sort((a, b) => a.t - b.t) };
  if (opts.cc) clip.cc = [...opts.cc];
  if (opts.offset !== undefined) clip.offset = Math.max(0, opts.offset);
  if (opts.loop) clip.loop = true;
  if (opts.srcLength !== undefined) clip.srcLength = opts.srcLength;
  if (opts.name) clip.name = opts.name;
  return { timeline: { ...tl, clips: [...tl.clips, clip] }, clip };
}

export function updateClip(tl: TimelineData, id: string, patch: Partial<Omit<TimelineClip, 'id'>>): TimelineData {
  return { ...tl, clips: tl.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
}

export function removeClip(tl: TimelineData, id: string): TimelineData {
  return { ...tl, clips: tl.clips.filter((c) => c.id !== id) };
}

const find = (tl: TimelineData, id: string): TimelineClip => {
  const c = tl.clips.find((x) => x.id === id);
  if (!c) throw new Error(`No clip "${id}"`);
  return c;
};

/** Move a clip to a new start (and optionally another track of the same kind). */
export function moveClip(tl: TimelineData, id: string, start: number, track?: string): TimelineData {
  const c = find(tl, id);
  if (track && track !== c.track) {
    const to = tl.tracks.find((t) => t.id === track);
    if (!to || (to.kind === 'midi') !== isMidiClip(c)) throw new Error('A clip can only move to a track of the same kind');
  }
  return updateClip(tl, id, { start: Math.max(0, start), ...(track ? { track } : {}) });
}

/** Cut the clip's length (keeps its start). Growing a non-looping clip beyond its source simply plays silence. */
export function setClipLength(tl: TimelineData, id: string, length: number): TimelineData {
  return updateClip(tl, id, { length: Math.max(0.001, length) });
}

/** Drag the left edge: the content stays where it is on the timeline (offset and notes follow). */
export function trimClipStart(tl: TimelineData, id: string, newStart: number): TimelineData {
  const c = find(tl, id);
  const end = clipEnd(c);
  const s = Math.min(Math.max(0, newStart), end - 0.001);
  const delta = s - c.start;
  return updateClip(tl, id, { start: s, length: end - s, offset: Math.max(0, c.offset + delta) });
}

/** Drag the right edge. */
export function trimClipEnd(tl: TimelineData, id: string, newEnd: number): TimelineData {
  const c = find(tl, id);
  return updateClip(tl, id, { length: Math.max(0.001, newEnd - c.start) });
}

/** Split at a project time strictly inside the clip (looping clips cannot be split).  Returns the two new clips' ids. MIDI notes crossing the cut are cut in two. */
export function splitClip(tl: TimelineData, id: string, at: number): { timeline: TimelineData; left: string; right: string } {
  const c = find(tl, id);
  if (!(at > c.start && at < clipEnd(c))) throw new Error('Split point must be inside the clip');
  if (c.loop) throw new Error('Turn looping off before splitting a clip');
  const cut = at - c.start; // seconds into the clip
  const rightId = uniqueId('c', tl.clips.map((x) => x.id));
  const left: TimelineClip = { ...c, length: cut, fadeOut: 0 };
  const right: TimelineClip = { ...c, id: rightId, start: at, length: c.length - cut, fadeIn: 0 };
  if (c.notes) {
    const srcCut = c.offset + cut; // position in the source
    const l: TimelineNote[] = [];
    const r: TimelineNote[] = [];
    for (const n of c.notes) {
      const end = n.t + n.d;
      if (n.t < srcCut) l.push(end > srcCut ? { ...n, d: srcCut - n.t } : n);
      if (end > srcCut) r.push(n.t >= srcCut ? n : { ...n, t: srcCut, d: end - srcCut });
    }
    left.notes = l;
    right.notes = r;
    right.offset = srcCut;
    if (c.cc) {
      left.cc = c.cc.filter((e) => e.t < srcCut);
      right.cc = c.cc.filter((e) => e.t >= srcCut);
    }
  } else right.offset = c.offset + cut;
  const clips = tl.clips.flatMap((x) => (x.id === id ? [left, right] : [x]));
  return { timeline: { ...tl, clips }, left: id, right: rightId };
}

/** Copy a clip. Default: placed right after the original. */
export function duplicateClip(tl: TimelineData, id: string, start?: number): { timeline: TimelineData; clip: TimelineClip } {
  const c = find(tl, id);
  const copy: TimelineClip = { ...c, id: uniqueId('c', tl.clips.map((x) => x.id)), start: start ?? clipEnd(c) };
  if (c.notes) copy.notes = c.notes.map((n) => ({ ...n }));
  if (c.cc) copy.cc = c.cc.map((n) => ({ ...n }));
  return { timeline: { ...tl, clips: [...tl.clips, copy] }, clip: copy };
}

/**
 * Merge several MIDI clips on one track into the first (earliest) one: notes are re-timed to the earliest clip's start and
 * the length covers all of them. Audio clips cannot be merged (throws).
 */
export function mergeClips(tl: TimelineData, ids: string[]): { timeline: TimelineData; clip: TimelineClip } {
  const picked = ids.map((i) => find(tl, i)).sort((a, b) => a.start - b.start);
  if (picked.length < 2) throw new Error('Select at least two clips');
  if (picked.some((c) => !c.notes)) throw new Error('Only MIDI clips can be merged');
  const first = picked[0];
  const notes: TimelineNote[] = [];
  const cc: TimelineCC[] = [];
  let end = 0;
  for (const c of picked) {
    const shift = c.start - first.start - c.offset;
    for (const n of c.notes!) if (n.t >= c.offset) notes.push({ ...n, t: n.t + shift });
    for (const e of c.cc ?? []) if (e.t >= c.offset) cc.push({ ...e, t: e.t + shift });
    end = Math.max(end, clipEnd(c));
  }
  notes.sort((a, b) => a.t - b.t || a.note - b.note);
  const merged: TimelineClip = { ...first, offset: 0, length: end - first.start, notes, ...(cc.length ? { cc } : {}), loop: false };
  delete merged.srcLength;
  const drop = new Set(ids);
  return { timeline: { ...tl, clips: [...tl.clips.filter((c) => !drop.has(c.id)), merged] }, clip: merged };
}

/**
 * Make a clip loop cleanly: shorten its source region to a whole number of beats (at least one), switch looping on, and keep
 * its length. Audio: the loop region is `offset`..`offset + beats` (the clip is then played from a trimmed copy of the source
 * region via `srcLength`, which both kinds honour). Returns the number of beats used.
 */
export function makeClipLoopCleanly(tl: TimelineData, id: string, bpm: number, sourceLength?: number): { timeline: TimelineData; beats: number } {
  const c = find(tl, id);
  const spb = secondsPerBeat(bpm);
  const region = sourceLength ?? c.srcLength ?? c.length;
  const beats = Math.max(1, Math.round(region / spb));
  return { timeline: updateClip(tl, id, { srcLength: beats * spb, loop: true }), beats };
}

/* ----------------------------------------------------------------------- */
/* MIDI note editing                                                        */
/* ----------------------------------------------------------------------- */

/** Move note starts (and optionally ends) to the grid. `strength` 0..1 moves part of the way (humanise-friendly). */
export function quantizeNotes(notes: TimelineNote[], bpm: number, grid: Grid, strength = 1, quantizeEnds = false): TimelineNote[] {
  const g = gridSeconds(bpm, grid);
  if (g <= 0) return notes.map((n) => ({ ...n }));
  return notes
    .map((n) => {
      const t = snapTime(n.t, bpm, grid, strength);
      const end = quantizeEnds ? snapTime(n.t + n.d, bpm, grid, strength) : t + n.d; // otherwise keep the duration
      return { ...n, t: Math.max(0, t), d: Math.max(g * 0.05, quantizeEnds ? end - t : n.d) };
    })
    .sort((a, b) => a.t - b.t || a.note - b.note);
}

export function transposeNotes(notes: TimelineNote[], semitones: number): TimelineNote[] {
  return notes.map((n) => ({ ...n, note: Math.max(0, Math.min(127, n.note + semitones)) }));
}

/** Set every note's length (seconds). */
export function setNoteLengths(notes: TimelineNote[], length: number): TimelineNote[] {
  return notes.map((n) => ({ ...n, d: Math.max(0.001, length) }));
}

export function quantizeClip(tl: TimelineData, id: string, bpm: number, grid: Grid, strength = 1, quantizeEnds = false): TimelineData {
  const c = find(tl, id);
  if (!c.notes) return tl;
  return updateClip(tl, id, { notes: quantizeNotes(c.notes, bpm, grid, strength, quantizeEnds) });
}

export function transposeClip(tl: TimelineData, id: string, semitones: number): TimelineData {
  const c = find(tl, id);
  if (!c.notes) return tl;
  return updateClip(tl, id, { notes: transposeNotes(c.notes, semitones) });
}

/** Union of several note lists, sorted. Exact duplicates (same time, pitch) are dropped. */
export function mergeNotes(...lists: TimelineNote[][]): TimelineNote[] {
  const out: TimelineNote[] = [];
  for (const l of lists) for (const n of l) if (!out.some((m) => m.note === n.note && Math.abs(m.t - n.t) < 1e-6)) out.push({ ...n });
  return out.sort((a, b) => a.t - b.t || a.note - b.note);
}

/* ----------------------------------------------------------------------- */
/* Recorded takes                                                           */
/* ----------------------------------------------------------------------- */

/**
 * Put a finished take on the timeline.
 *
 * * No loop passes (or a single one): one clip at `take.start`.
 * * Loop recording, mode `overdub`: MIDI notes of all passes are merged into ONE looping clip as long as the loop;
 *   audio: each pass becomes its own clip stacked on the same track (layers accumulate).
 * * Mode `takes` / `replace`: each pass becomes its own clip, all muted except the last (`replace` additionally drops
 *   earlier clips that were already on the track over the same time range).
 *
 * `assetIds[k]` is the asset id the caller stored the k-th piece of PCM under (`passes[k].pcm`, or `take.pcm` for index 0
 * when there are no passes). Audio takes need them; MIDI takes ignore them.
 */
export function applyTake(
  tl: TimelineData,
  take: RecordedTake,
  opts: { mode: LoopRecordMode; assetIds?: string[]; name?: string },
): { timeline: TimelineData; clipIds: string[] } {
  let t = tl;
  const ids: string[] = [];
  const passes = take.passes && take.passes.length ? take.passes : [{ start: take.start, length: take.length, pcm: take.pcm, notes: take.notes }];
  const name = opts.name ?? 'Take';
  if (take.kind === 'midi') {
    if (passes.length > 1 && opts.mode === 'overdub') {
      const loopLen = Math.max(...passes.slice(1).map((p) => p.length), 0.001);
      const loopStart = passes[1].start;
      const notes = mergeNotes(...passes.map((p, i) => (i === 0 ? (p.notes ?? []).map((n) => ({ ...n, t: n.t + (p.start - loopStart) })).filter((n) => n.t >= 0) : (p.notes ?? []))));
      const r = addMidiClip(t, { track: take.track, start: loopStart, length: loopLen, notes, loop: true, srcLength: loopLen, name });
      return { timeline: r.timeline, clipIds: [r.clip.id] };
    }
    passes.forEach((p, i) => {
      const r = addMidiClip(t, { track: take.track, start: p.start, length: p.length, notes: p.notes ?? [], name: `${name} ${i + 1}` });
      t = r.timeline;
      ids.push(r.clip.id);
    });
  } else {
    passes.forEach((p, i) => {
      const asset = opts.assetIds?.[i];
      if (!asset) throw new Error(`Missing asset id for take piece ${i}`);
      const r = addAudioClip(t, { track: take.track, start: p.start, length: p.length, asset, name: passes.length > 1 ? `${name} ${i + 1}` : name });
      t = r.timeline;
      ids.push(r.clip.id);
    });
  }
  if (passes.length > 1 && opts.mode !== 'overdub') {
    t = { ...t, clips: t.clips.map((c) => (ids.includes(c.id) && c.id !== ids[ids.length - 1] ? { ...c, muted: true } : c)) };
    if (opts.mode === 'replace') {
      const from = passes[0].start;
      const to = Math.max(...passes.map((p) => p.start + p.length));
      t = { ...t, clips: t.clips.filter((c) => ids.includes(c.id) || c.track !== take.track || clipEnd(c) <= from || c.start >= to) };
    }
  }
  return { timeline: t, clipIds: ids };
}

/* ----------------------------------------------------------------------- */
/* Audio -> MIDI                                                            */
/* ----------------------------------------------------------------------- */

/**
 * Convert audio (a clip's source range) to MIDI notes by running the pitch tracker over it offline. Monophonic, like the
 * Audio to MIDI node: notes need ~30 ms of steady pitch and end after ~40 ms of silence or an unvoiced stretch.
 * `from`/`to` are seconds into the PCM. Note times are relative to `from`.
 */
export function audioClipToMidi(
  pcm: PcmAudio,
  opts: { from?: number; to?: number; minNote?: number; maxNote?: number; sensitivity?: number; gateDb?: number } = {},
): TimelineNote[] {
  const sr = pcm.sampleRate;
  const a = Math.max(0, Math.round((opts.from ?? 0) * sr));
  const b = Math.min(pcm.channels[0].length, Math.round((opts.to ?? pcm.channels[0].length / sr) * sr));
  const minNote = opts.minNote ?? 36;
  const maxNote = opts.maxNote ?? 96;
  const clarity = 0.92 - 0.35 * (opts.sensitivity ?? 0.5);
  const gate = Math.pow(10, (opts.gateDb ?? -45) / 20);
  const tracker = makePitchTracker(sr);
  const L = pcm.channels[0];
  const R = pcm.channels[1] ?? L;
  const notes: TimelineNote[] = [];
  let cur = -1; // sounding note
  let curStart = 0;
  let curVel = 0;
  let cand = -1;
  let candCount = 0;
  let candStart = 0;
  let quiet = 0;
  let peakLevel = 0;
  const closeNote = (endSample: number) => {
    if (cur >= 0) {
      const t = (curStart - a) / sr;
      const d = (endSample - curStart) / sr;
      if (d >= 0.03) notes.push({ t, d, note: cur, vel: curVel });
    }
    cur = -1;
  };
  for (let i = a; i < b; i++) {
    if (!pitchPush(tracker, (L[i] + R[i]) * 0.5, minNote, maxNote, gate, clarity)) continue;
    // `i` is the sample at which the analysis finished; the window centre is ~30 ms earlier
    const at = Math.max(a, i - Math.round(sr * 0.03));
    if (tracker.note >= 0) {
      quiet = 0;
      const target = Math.round(tracker.note);
      peakLevel = Math.max(peakLevel * 0.9, tracker.level);
      if (cur < 0) {
        if (target === cand) candCount++;
        else {
          cand = target;
          candCount = 1;
          candStart = at;
        }
        if (candCount >= 3) {
          cur = cand;
          curStart = candStart;
          curVel = Math.max(0.15, Math.min(1, 0.3 + (20 * Math.log10(Math.max(tracker.level, 1e-6) / gate)) / 40));
          candCount = 0;
        }
      } else if (Math.abs(tracker.note - cur) > 0.8 && target !== cur) {
        if (target === cand) candCount++;
        else {
          cand = target;
          candCount = 1;
          candStart = at;
        }
        if (candCount >= 3) {
          closeNote(candStart);
          cur = cand;
          curStart = candStart;
          curVel = Math.max(0.15, Math.min(1, 0.3 + (20 * Math.log10(Math.max(tracker.level, 1e-6) / gate)) / 40));
          candCount = 0;
        }
      } else candCount = 0;
    } else {
      candCount = 0;
      cand = -1;
      if (cur >= 0 && ++quiet >= 4) {
        closeNote(i - quiet * 160 * Math.max(1, tracker.D) + Math.round(sr * 0.02));
        quiet = 0;
      }
    }
  }
  closeNote(b);
  return notes;
}

/** MIDI note -> Hz (re-exported so UI code drawing pitch lines does not need dsp.ts). */
export const noteToHz = (note: number): number => 440 * Math.pow(2, (note - 69) / 12);
export const hzToNote = hzToMidi;
