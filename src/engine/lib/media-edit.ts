/**
 * The edit of the Media Timeline node: clips placed on tracks, and every question the picture and the sound ask about it.
 * Pure (no imports), seconds throughout, so the node, its audio kernel, the editor UI and the tests share one definition.
 *
 *   video clip  picks wire `source` of the `clips` input, shows source time `in + (t - start)` for `duration` seconds
 *   audio clip  either plays `asset` (decoded sound of a file, read at `in + (t - start)`) or, with no asset, passes wire `source`
 *               of the `sounds` input (gated and faded; a live wire cannot be time-shifted)
 *
 * Video tracks stack: a higher `track` is drawn over a lower one; on one track a later clip is drawn over an earlier one. `level` is
 * opacity for video and linear gain for audio. Fades are linear ramps. When a clip starts inside another clip of the same track the
 * overlap is a cross-dissolve: the later clip fades in over the overlap (video), both clips ramp (audio).
 */

/** Node type id the editor and the wire bookkeeping recognise. */
export const MEDIA_TIMELINE_ID = 'media-timeline';

export type EditKind = 'video' | 'audio';

export interface EditClip {
  id: string;
  kind: EditKind;
  /** Wire index of the source (video: `clips` input, audio: `sounds` input). -1 = none (audio that plays its `asset`). */
  source: number;
  /** Lane within its kind, 0 = bottom (video) / first (audio). */
  track: number;
  /** Position on the timeline, seconds. */
  start: number;
  /** Where in the source the clip begins, seconds. */
  in: number;
  duration: number;
  fadeIn: number;
  fadeOut: number;
  /** Opacity (video) or linear gain (audio). 1 = unchanged. */
  level: number;
  /** Audio only: asset whose sound this clip plays. */
  asset?: string;
  /** Clips with the same link move, trim, split and delete together (a video and its own sound). */
  link?: string;
  /** Label shown on the block (the source node's title). */
  name?: string;
  mute?: boolean;
}

export interface MediaEdit {
  clips: EditClip[];
}

export const MIN_DURATION = 0.04;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Make any stored value a valid edit: bad clips are dropped, numbers clamped, ids made unique. Never throws. */
export function normalizeEdit(raw: unknown): MediaEdit {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as MediaEdit).clips) ? (raw as MediaEdit).clips : [];
  const seen = new Set<string>();
  const clips: EditClip[] = [];
  for (const r of list as Partial<EditClip>[]) {
    if (!r || typeof r !== 'object') continue;
    const duration = num(r.duration, 0);
    if (!(duration > 0)) continue;
    let id = typeof r.id === 'string' && r.id ? r.id : 'c';
    if (seen.has(id)) id = `${id}_${seen.size}`;
    seen.add(id);
    const kind: EditKind = r.kind === 'audio' ? 'audio' : 'video';
    const d = Math.max(MIN_DURATION, duration);
    const c: EditClip = {
      id,
      kind,
      source: Math.round(num(r.source, kind === 'audio' ? -1 : 0)),
      track: Math.max(0, Math.round(num(r.track, 0))),
      start: Math.max(0, num(r.start, 0)),
      in: Math.max(0, num(r.in, 0)),
      duration: d,
      fadeIn: Math.min(d, Math.max(0, num(r.fadeIn, 0))),
      fadeOut: Math.min(d, Math.max(0, num(r.fadeOut, 0))),
      level: Math.max(0, num(r.level, 1)),
    };
    if (kind === 'audio' && typeof r.asset === 'string' && r.asset) c.asset = r.asset;
    if (typeof r.link === 'string' && r.link) c.link = r.link;
    if (typeof r.name === 'string' && r.name) c.name = r.name;
    if (r.mute === true) c.mute = true;
    clips.push(c);
  }
  return { clips };
}

export const clipEnd = (c: Pick<EditClip, 'start' | 'duration'>): number => c.start + c.duration;

/** End of the last clip (of one kind, or of everything). 0 for an empty edit. */
export function editEnd(edit: MediaEdit, kind?: EditKind): number {
  let end = 0;
  for (const c of edit.clips) if ((!kind || c.kind === kind) && !c.mute) end = Math.max(end, clipEnd(c));
  return end;
}

/** Effective fades per clip: the stored fades, extended by the cross-dissolve rule for clips that overlap on the same track. */
export function resolveFades(edit: MediaEdit): Map<string, { fadeIn: number; fadeOut: number }> {
  const out = new Map<string, { fadeIn: number; fadeOut: number }>();
  for (const c of edit.clips) out.set(c.id, { fadeIn: c.fadeIn, fadeOut: c.fadeOut });
  for (const b of edit.clips) {
    for (const a of edit.clips) {
      if (a === b || a.kind !== b.kind || a.track !== b.track || a.mute || b.mute) continue;
      // b starts strictly inside a: the stretch both are present is a dissolve from a to b.
      if (!(b.start > a.start + 1e-9 && b.start < clipEnd(a) - 1e-9)) continue;
      const overlap = Math.min(clipEnd(a), clipEnd(b)) - b.start;
      const fb = out.get(b.id)!;
      fb.fadeIn = Math.min(b.duration, Math.max(fb.fadeIn, overlap));
      if (b.kind === 'audio' && clipEnd(b) > clipEnd(a)) {
        const fa = out.get(a.id)!;
        fa.fadeOut = Math.min(a.duration, Math.max(fa.fadeOut, overlap));
      }
    }
  }
  return out;
}

/** Opacity / gain of a clip at timeline time t: level times the fade ramps. 0 outside the clip. */
export function weightAt(c: EditClip, t: number, fades: { fadeIn: number; fadeOut: number } = c): number {
  if (t < c.start || t >= clipEnd(c)) return 0;
  const up = fades.fadeIn > 0 ? Math.min(1, (t - c.start) / fades.fadeIn) : 1;
  const down = fades.fadeOut > 0 ? Math.min(1, (clipEnd(c) - t) / fades.fadeOut) : 1;
  return c.level * Math.max(0, Math.min(up, down));
}

/** Source seconds shown / heard at timeline time t. */
export const sourceTime = (c: EditClip, t: number): number => c.in + Math.max(0, t - c.start);

export interface ActiveClip {
  clip: EditClip;
  /** Seconds into the source to pull / read. */
  local: number;
  /** Opacity / gain right now (> 0). */
  weight: number;
}

/** Clips of one kind present at time t, bottom first (track ascending, then start ascending). Zero-weight clips are left out. */
export function activeAt(edit: MediaEdit, kind: EditKind, t: number): ActiveClip[] {
  const fades = resolveFades(edit);
  const list: ActiveClip[] = [];
  for (const clip of edit.clips) {
    if (clip.kind !== kind || clip.mute) continue;
    const weight = weightAt(clip, t, fades.get(clip.id));
    if (weight > 0) list.push({ clip, local: sourceTime(clip, t), weight });
  }
  list.sort((a, b) => a.clip.track - b.clip.track || a.clip.start - b.clip.start);
  return list;
}

/** Clips whose source is needed at t (video clips with a wire). Used by the node to pull ONLY these. */
export const activeVideo = (edit: MediaEdit, t: number): ActiveClip[] => activeAt(edit, 'video', t);

/** "00:12.5": minutes:seconds with one decimal. */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(1).padStart(4, '0')}`;
}

/* ----------------------------------------------------------------------- */
/* Editing (pure: every function returns a new edit)                         */
/* ----------------------------------------------------------------------- */

export function nextId(edit: MediaEdit): string {
  let n = 0;
  for (const c of edit.clips) {
    const m = /^c(\d+)$/.exec(c.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return `c${n + 1}`;
}

/** The clip and everything linked to it. */
export function groupOf(edit: MediaEdit, id: string): EditClip[] {
  const c = edit.clips.find((x) => x.id === id);
  if (!c) return [];
  return c.link ? edit.clips.filter((x) => x.link === c.link) : [c];
}

const mapGroup = (edit: MediaEdit, id: string, fn: (c: EditClip) => EditClip): MediaEdit => {
  const ids = new Set(groupOf(edit, id).map((c) => c.id));
  return { clips: edit.clips.map((c) => (ids.has(c.id) ? fn(c) : c)) };
};

export function updateClip(edit: MediaEdit, id: string, patch: Partial<EditClip>): MediaEdit {
  return {
    clips: edit.clips.map((c) => {
      if (c.id !== id) return c;
      const n = { ...c, ...patch };
      n.duration = Math.max(MIN_DURATION, n.duration);
      n.fadeIn = Math.min(Math.max(0, n.fadeIn), n.duration);
      n.fadeOut = Math.min(Math.max(0, n.fadeOut), n.duration);
      n.level = Math.max(0, n.level);
      return n;
    }),
  };
}

/** Move a clip (with its linked clips) so it starts at `start`; `track` puts only the grabbed clip on another lane. */
export function moveClip(edit: MediaEdit, id: string, start: number, track?: number): MediaEdit {
  const c = edit.clips.find((x) => x.id === id);
  if (!c) return edit;
  const group = groupOf(edit, id);
  const dt = Math.max(start - c.start, -Math.min(...group.map((g) => g.start)));
  return {
    clips: edit.clips.map((x) => {
      if (!group.includes(x)) return x;
      const moved = { ...x, start: x.start + dt };
      if (x.id === id && track !== undefined) moved.track = Math.max(0, Math.round(track));
      return moved;
    }),
  };
}

/** Drag the left edge to `newStart`: the source in point moves with it. Linked clips follow. Clamped by the source start and the minimum length. */
export function trimStart(edit: MediaEdit, id: string, newStart: number): MediaEdit {
  const c = edit.clips.find((x) => x.id === id);
  if (!c) return edit;
  const group = groupOf(edit, id);
  const lo = Math.max(...group.map((g) => Math.max(-g.in, -g.start)));
  const hi = Math.min(...group.map((g) => g.duration - MIN_DURATION));
  const d = Math.min(hi, Math.max(lo, newStart - c.start));
  return mapGroup(edit, id, (x) => ({ ...x, start: x.start + d, in: x.in + d, duration: x.duration - d, fadeIn: Math.min(x.fadeIn, x.duration - d), fadeOut: Math.min(x.fadeOut, x.duration - d) }));
}

/** Drag the right edge to `newEnd`. Linked clips follow. */
export function trimEnd(edit: MediaEdit, id: string, newEnd: number): MediaEdit {
  const c = edit.clips.find((x) => x.id === id);
  if (!c) return edit;
  const group = groupOf(edit, id);
  const lo = Math.max(...group.map((g) => MIN_DURATION - g.duration));
  const d = Math.max(lo, newEnd - clipEnd(c));
  return mapGroup(edit, id, (x) => ({ ...x, duration: x.duration + d, fadeIn: Math.min(x.fadeIn, x.duration + d), fadeOut: Math.min(x.fadeOut, x.duration + d) }));
}

/** Cut the clip (and its linked clips) at timeline time t. Returns the new edit and the ids of the right-hand halves. */
export function splitAt(edit: MediaEdit, id: string, t: number): { edit: MediaEdit; right: string[] } {
  const group = groupOf(edit, id).filter((g) => t > g.start + MIN_DURATION / 2 && t < clipEnd(g) - MIN_DURATION / 2);
  if (group.length === 0) return { edit, right: [] };
  let counter = Number(nextId(edit).slice(1));
  const relink = new Map<string, string>();
  const clips: EditClip[] = [];
  const right: string[] = [];
  for (const c of edit.clips) {
    if (!group.includes(c)) {
      clips.push(c);
      continue;
    }
    const cut = t - c.start;
    const rid = `c${counter++}`;
    let link = c.link;
    if (link) {
      if (!relink.has(link)) relink.set(link, `${link}s${counter}`);
      link = relink.get(link);
    }
    clips.push({ ...c, duration: cut, fadeOut: 0, fadeIn: Math.min(c.fadeIn, cut) });
    clips.push({ ...c, id: rid, start: t, in: c.in + cut, duration: c.duration - cut, fadeIn: 0, fadeOut: Math.min(c.fadeOut, c.duration - cut), link });
    right.push(rid);
  }
  return { edit: { clips }, right };
}

/** Delete a clip and everything linked to it. */
export function removeClip(edit: MediaEdit, id: string): MediaEdit {
  const gone = new Set(groupOf(edit, id).map((c) => c.id));
  return { clips: edit.clips.filter((c) => !gone.has(c.id)) };
}

/** Closest of `targets` to t within `threshold` seconds, else t unchanged. */
export function snapTime(t: number, targets: readonly number[], threshold: number): number {
  let best = t;
  let bd = threshold;
  for (const x of targets) {
    const d = Math.abs(x - t);
    if (d <= bd) {
      bd = d;
      best = x;
    }
  }
  return best;
}

/** Edges worth snapping to: starts and ends of the other clips, zero, and the playhead. */
export function snapTargets(edit: MediaEdit, except: ReadonlySet<string>, playhead: number): number[] {
  const out = [0, playhead];
  for (const c of edit.clips) {
    if (except.has(c.id)) continue;
    out.push(c.start, clipEnd(c));
  }
  return out;
}

export interface SourceInfo {
  /** Label for the block. */
  name: string;
  /** Natural length in seconds (5 when unknown). */
  duration: number;
  /** The file this source reads (Media In): its sound can then be played directly with a time offset. */
  asset?: string;
  /** Where the file's sound starts for the source's own time 0 (Media In's trim start), seconds. */
  assetIn?: number;
  /** The asset has a sound track. */
  hasAudio?: boolean;
  /**
   * The source is a sequence of shots (Stop Motion): one cut per part, in order. `start` and `duration` are seconds of the SOURCE's own
   * time, so each cut shows `in = start` for `duration`.
   */
  parts?: { start: number; duration: number }[];
}

export const DEFAULT_CLIP_SECONDS = 5;

/**
 * A new source was wired: append it at the end of the timeline. `clips` wires make a video clip (plus a linked sound clip when the
 * source is a file with sound); `sounds` wires make a sound clip.
 */
export function appendSource(edit: MediaEdit, port: 'clips' | 'sounds', wire: number, info: SourceInfo): MediaEdit {
  const duration = info.duration > 0 ? info.duration : DEFAULT_CLIP_SECONDS;
  const clips = [...edit.clips];
  let counter = Number(nextId(edit).slice(1));
  const base = { in: 0, duration, fadeIn: 0, fadeOut: 0, level: 1, name: info.name };
  if (port === 'clips' && info.parts && info.parts.length > 0) {
    // a sequence of shots: one cut per shot, laid end to end, each reading its own span of the source
    let start = editEnd(edit, 'video');
    info.parts.forEach((part, k) => {
      clips.push({ ...base, id: `c${counter++}`, kind: 'video', source: wire, track: 0, start, in: part.start, duration: Math.max(MIN_DURATION, part.duration), name: `${info.name} ${k + 1}` });
      start += Math.max(MIN_DURATION, part.duration);
    });
    return { clips: clips.map((c) => (c.link === undefined ? stripLink(c) : c)) };
  }
  if (port === 'clips') {
    const start = editEnd(edit, 'video');
    const link = info.asset && info.hasAudio ? `l${counter}` : undefined;
    clips.push({ ...base, id: `c${counter++}`, kind: 'video', source: wire, track: 0, start, link });
    if (link) clips.push({ ...base, id: `c${counter++}`, kind: 'audio', source: -1, track: 0, start, in: info.assetIn ?? 0, asset: info.asset, link });
  } else {
    // A file whose sound already plays through its picture clip is not added a second time.
    if (info.asset && edit.clips.some((c) => c.kind === 'audio' && c.asset === info.asset)) return edit;
    const start = editEnd(edit, 'audio');
    clips.push({ ...base, id: `c${counter++}`, kind: 'audio', source: wire, track: 0, start, in: info.asset ? (info.assetIn ?? 0) : 0, asset: info.asset });
  }
  return { clips: clips.map((c) => (c.link === undefined ? stripLink(c) : c)) };
}
function stripLink(c: EditClip): EditClip {
  const { link: _l, ...rest } = c;
  return rest as EditClip;
}

/**
 * The wires of an input changed (ids in wire order before and after): keep every clip pointing at the same source. Wires that are gone
 * take their clips (and linked clips) with them; reordered wires renumber the clips; new wires are NOT handled here (see `appendSource`).
 */
export function remapSources(edit: MediaEdit, port: 'clips' | 'sounds', before: readonly string[], after: readonly string[]): MediaEdit {
  const kind: EditKind = port === 'clips' ? 'video' : 'audio';
  const gone = new Set<string>();
  const clips: EditClip[] = [];
  for (const c of edit.clips) {
    if (c.kind !== kind || c.source < 0) {
      clips.push(c);
      continue;
    }
    const wireId = before[c.source];
    const now = wireId === undefined ? -1 : after.indexOf(wireId);
    if (now < 0) {
      gone.add(c.id);
      if (c.link) gone.add(`link:${c.link}`);
    } else clips.push(now === c.source ? c : { ...c, source: now });
  }
  const kept = clips.filter((c) => !(c.link && gone.has(`link:${c.link}`)));
  return { clips: kept };
}

/**
 * Bring the cuts of a sequence source (Stop Motion wired into `clips` as wire `wire`) in step with its shots, keeping what was edited:
 * a part that still has a cut (any clip of this wire whose `in` lies inside the part's span: trimmed, moved or split cuts count) keeps
 * it; a part without one gets a new cut at the end of the video track; a cut that reads outside every part (its shot was deleted or
 * moved) is removed. Pure.
 */
export function syncParts(edit: MediaEdit, wire: number, info: Pick<SourceInfo, 'name' | 'parts'>): MediaEdit {
  const parts = info.parts ?? [];
  const eps = 1e-6;
  const inPart = (t: number) => parts.findIndex((p) => t >= p.start - eps && t < p.start + p.duration - eps);
  const clips = edit.clips.filter((c) => !(c.kind === 'video' && c.source === wire && inPart(c.in) < 0));
  const have = new Set<number>();
  for (const c of clips) if (c.kind === 'video' && c.source === wire) have.add(inPart(c.in));
  let counter = Number(nextId({ clips }).slice(1));
  let start = editEnd({ clips }, 'video');
  parts.forEach((part, k) => {
    if (have.has(k)) return;
    const duration = Math.max(MIN_DURATION, part.duration);
    clips.push({ id: `c${counter++}`, kind: 'video', source: wire, track: 0, start, in: part.start, duration, fadeIn: 0, fadeOut: 0, level: 1, name: `${info.name} ${k + 1}` });
    start += duration;
  });
  return { clips };
}
