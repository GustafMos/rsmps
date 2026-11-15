import { describe, expect, it } from 'vitest';
import type { RecordedTake } from '../api';
import {
  addAudioClip,
  addMidiClip,
  addTrack,
  applyTake,
  audioClipToMidi,
  duplicateClip,
  emptyTimeline,
  gridSeconds,
  makeClipLoopCleanly,
  mergeClips,
  mergeNotes,
  moveClip,
  normalizeTimeline,
  quantizeClip,
  quantizeNotes,
  removeClip,
  removeTrack,
  setClipLength,
  snapTime,
  splitClip,
  timelineDuration,
  transposeClip,
  transposeNotes,
  trimClipEnd,
  trimClipStart,
  updateTrack,
} from '../timeline';
import { SR, sine } from '../testing';

const hz = (note: number) => 440 * Math.pow(2, (note - 69) / 12);

describe('timeline helpers', () => {
  it('normalizeTimeline repairs anything, drops clips of unknown tracks, keeps good data', () => {
    expect(normalizeTimeline(null).tracks).toEqual([]);
    expect(normalizeTimeline('junk').clips).toEqual([]);
    const n = normalizeTimeline({
      tracks: [{ id: 'a', kind: 'midi', gain: 'x', pan: 9 }, { id: 'a' }, { nope: 1 }],
      clips: [
        { id: 'c1', track: 'a', start: -4, length: 'q', notes: [{ t: 1, d: 0.5, note: 200, vel: 5 }, { t: 0.5, note: 60 }] },
        { id: 'c2', track: 'ghost', start: 0, length: 1 },
        { id: 'c1', track: 'a' },
      ],
    });
    expect(n.tracks).toHaveLength(1);
    expect(n.tracks[0]).toMatchObject({ kind: 'midi', gain: 0, pan: 1, mute: false });
    expect(n.clips).toHaveLength(1);
    expect(n.clips[0]).toMatchObject({ start: 0, length: 0 });
    expect(n.clips[0].notes!.map((x) => [x.t, x.note, x.vel])).toEqual([[0.5, 60, 0.8], [1, 127, 1]]);
    const t = addAudioClip(emptyTimeline(), { track: 'a1', start: 1, length: 2, asset: 'x' }).timeline;
    expect(normalizeTimeline(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });

  it('tracks: add, update, remove (clips go with it)', () => {
    let t = emptyTimeline();
    const added = addTrack(t, 'audio');
    t = added.timeline;
    expect(added.track.id).toBe('a2');
    expect(added.track.name).toBe('Audio 2');
    t = addAudioClip(t, { track: 'a2', start: 0, length: 1, asset: 'x' }).timeline;
    t = updateTrack(t, 'a2', { gain: -3, solo: true });
    expect(t.tracks.find((x) => x.id === 'a2')).toMatchObject({ gain: -3, solo: true });
    t = removeTrack(t, 'a2');
    expect(t.tracks.map((x) => x.id)).toEqual(['a1', 'm1']);
    expect(t.clips).toEqual([]);
  });

  it('move, trim, length, duplicate, remove', () => {
    let t = addAudioClip(emptyTimeline(), { track: 'a1', start: 2, length: 4, asset: 'x', offset: 1 }).timeline;
    const id = t.clips[0].id;
    t = moveClip(t, id, 5);
    expect(t.clips[0].start).toBe(5);
    expect(() => moveClip(t, id, 1, 'm1')).toThrow(/same kind/);
    t = trimClipStart(t, id, 6); // content stays: offset moves with the edge
    expect(t.clips[0]).toMatchObject({ start: 6, length: 3, offset: 2 });
    t = trimClipEnd(t, id, 8);
    expect(t.clips[0].length).toBe(2);
    t = setClipLength(t, id, 10);
    expect(t.clips[0].length).toBe(10);
    const d = duplicateClip(t, id);
    expect(d.clip.start).toBe(16);
    expect(d.clip.id).not.toBe(id);
    expect(timelineDuration(d.timeline)).toBe(26);
    expect(removeClip(d.timeline, id).clips).toHaveLength(1);
  });

  it('split: audio keeps content in place; MIDI notes crossing the cut are cut in two; looping clips refuse', () => {
    let t = addAudioClip(emptyTimeline(), { track: 'a1', start: 1, length: 4, asset: 'x', offset: 0.5, fadeIn: 0.1, fadeOut: 0.2 }).timeline;
    const s1 = splitClip(t, t.clips[0].id, 3);
    const [l, r] = s1.timeline.clips;
    expect(l).toMatchObject({ start: 1, length: 2, offset: 0.5, fadeIn: 0.1, fadeOut: 0 });
    expect(r).toMatchObject({ start: 3, length: 2, offset: 2.5, fadeIn: 0, fadeOut: 0.2 });
    expect(() => splitClip(t, t.clips[0].id, 1)).toThrow(/inside/);
    const m = addMidiClip(emptyTimeline(), { track: 'm1', start: 0, length: 4, notes: [{ t: 0.5, d: 1, note: 60, vel: 1 }, { t: 3, d: 0.5, note: 62, vel: 1 }] });
    const s2 = splitClip(m.timeline, m.clip.id, 1);
    const [ml, mr] = s2.timeline.clips;
    expect(ml.notes).toEqual([{ t: 0.5, d: 0.5, note: 60, vel: 1 }]);
    expect(mr.offset).toBe(1);
    expect(mr.notes).toEqual([{ t: 1, d: 0.5, note: 60, vel: 1 }, { t: 3, d: 0.5, note: 62, vel: 1 }]);
    const looping = addMidiClip(emptyTimeline(), { track: 'm1', start: 0, length: 4, loop: true });
    expect(() => splitClip(looping.timeline, looping.clip.id, 1)).toThrow(/looping/);
  });

  it('merge MIDI clips into one, re-timed; audio clips cannot be merged', () => {
    let t = addMidiClip(emptyTimeline(), { track: 'm1', start: 2, length: 1, notes: [{ t: 0, d: 0.5, note: 60, vel: 1 }] }).timeline;
    t = addMidiClip(t, { track: 'm1', start: 3, length: 1, notes: [{ t: 0.25, d: 0.5, note: 64, vel: 1 }] }).timeline;
    const r = mergeClips(t, t.clips.map((c) => c.id));
    expect(r.timeline.clips).toHaveLength(1);
    expect(r.clip.start).toBe(2);
    expect(r.clip.length).toBe(2);
    expect(r.clip.notes!.map((n) => [n.t, n.note])).toEqual([[0, 60], [1.25, 64]]);
    const a = addAudioClip(addAudioClip(emptyTimeline(), { track: 'a1', start: 0, length: 1, asset: 'x' }).timeline, { track: 'a1', start: 1, length: 1, asset: 'x' }).timeline;
    expect(() => mergeClips(a, a.clips.map((c) => c.id))).toThrow(/MIDI/);
    expect(mergeNotes([{ t: 0, d: 1, note: 60, vel: 1 }], [{ t: 0, d: 1, note: 60, vel: 1 }, { t: 1, d: 1, note: 61, vel: 1 }])).toHaveLength(2);
  });

  it('grid, snap and quantize with strength', () => {
    expect(gridSeconds(120, '1/4')).toBeCloseTo(0.5, 9);
    expect(gridSeconds(120, '1/16')).toBeCloseTo(0.125, 9);
    expect(gridSeconds(120, 'off')).toBe(0);
    expect(snapTime(0.61, 120, '1/4')).toBeCloseTo(0.5, 9);
    expect(snapTime(0.76, 120, '1/4')).toBeCloseTo(1, 9);
    const notes = [{ t: 0.07, d: 0.2, note: 60, vel: 1 }, { t: 0.55, d: 0.2, note: 62, vel: 1 }];
    const q = quantizeNotes(notes, 120, '1/8');
    expect(q.map((n) => n.t)).toEqual([0, 0.5]);
    expect(q.map((n) => n.d)).toEqual([0.2, 0.2]);
    const half = quantizeNotes(notes, 120, '1/8', 0.5);
    expect(half[0].t).toBeCloseTo(0.035, 9);
    expect(quantizeNotes(notes, 120, 'off')).toEqual(notes);
    const ends = quantizeNotes([{ t: 0.07, d: 0.2, note: 60, vel: 1 }], 120, '1/8', 1, true);
    expect(ends[0].d).toBeCloseTo(0.25, 9);
    const clip = addMidiClip(emptyTimeline(), { track: 'm1', start: 0, length: 1, notes });
    expect(quantizeClip(clip.timeline, clip.clip.id, 120, '1/8').clips[0].notes![0].t).toBe(0);
  });

  it('transpose clamps to 0..127', () => {
    expect(transposeNotes([{ t: 0, d: 1, note: 125, vel: 1 }], 12)[0].note).toBe(127);
    const c = addMidiClip(emptyTimeline(), { track: 'm1', start: 0, length: 1, notes: [{ t: 0, d: 1, note: 60, vel: 1 }] });
    expect(transposeClip(c.timeline, c.clip.id, -12).clips[0].notes![0].note).toBe(48);
  });

  it('make a clip loop cleanly: whole beats, at least one', () => {
    const c = addMidiClip(emptyTimeline(), { track: 'm1', start: 0, length: 4, notes: [] });
    const r = makeClipLoopCleanly(c.timeline, c.clip.id, 120, 1.9); // 3.8 beats -> 4 beats = 2 s
    expect(r.beats).toBe(4);
    expect(r.timeline.clips[0]).toMatchObject({ loop: true, srcLength: 2 });
    expect(makeClipLoopCleanly(c.timeline, c.clip.id, 120, 0.1).beats).toBe(1);
  });
});

describe('applyTake', () => {
  const audioTake = (passes: number): RecordedTake => ({
    nodeId: 'tl',
    track: 'a1',
    kind: 'audio',
    start: 0.25,
    length: 1,
    latency: 0,
    loopPasses: passes,
    pcm: { sampleRate: SR, channels: [new Float32Array(10)] },
    ...(passes > 1 ? { passes: Array.from({ length: passes }, (_, i) => ({ start: i === 0 ? 0.25 : 0, length: i === 0 ? 0.75 : 1, pcm: { sampleRate: SR, channels: [new Float32Array(4)] } })) } : {}),
  });

  it('a single audio take becomes one clip at its start', () => {
    const r = applyTake(emptyTimeline(), audioTake(1), { mode: 'overdub', assetIds: ['t1'] });
    expect(r.timeline.clips).toHaveLength(1);
    expect(r.timeline.clips[0]).toMatchObject({ track: 'a1', start: 0.25, length: 1, asset: 't1' });
    expect(() => applyTake(emptyTimeline(), audioTake(1), { mode: 'overdub' })).toThrow(/asset/);
  });

  it('audio loop passes: overdub stacks them all audible; takes mutes all but the last; replace also clears what was there', () => {
    const base = addAudioClip(emptyTimeline(), { track: 'a1', start: 0, length: 1, asset: 'old' }).timeline;
    const over = applyTake(base, audioTake(3), { mode: 'overdub', assetIds: ['p0', 'p1', 'p2'] }).timeline;
    expect(over.clips).toHaveLength(4);
    expect(over.clips.some((c) => c.muted)).toBe(false);
    const takes = applyTake(base, audioTake(3), { mode: 'takes', assetIds: ['p0', 'p1', 'p2'] }).timeline;
    expect(takes.clips.filter((c) => c.muted).map((c) => c.asset)).toEqual(['p0', 'p1']);
    const rep = applyTake(base, audioTake(3), { mode: 'replace', assetIds: ['p0', 'p1', 'p2'] }).timeline;
    expect(rep.clips.map((c) => c.asset)).toEqual(['p0', 'p1', 'p2']);
  });
});

describe('audioClipToMidi', () => {
  it('turns a sung melody into notes with the right pitches, onsets and lengths', () => {
    const seg = (note: number, secs: number) => sine(hz(note), Math.round(secs * SR), SR, 0.5);
    const gap = new Float32Array(Math.round(0.15 * SR));
    const parts = [seg(57, 0.4), gap, seg(60, 0.4), seg(64, 0.4), gap];
    const x = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      x.set(p, o);
      o += p.length;
    }
    const notes = audioClipToMidi({ sampleRate: SR, channels: [x] });
    expect(notes.map((n) => n.note)).toEqual([57, 60, 64]);
    expect(notes[0].t).toBeLessThan(0.1);
    expect(notes[0].d).toBeGreaterThan(0.25);
    expect(notes[1].t).toBeGreaterThan(0.5);
    expect(notes[1].t).toBeLessThan(0.7);
    expect(notes[2].t).toBeGreaterThan(notes[1].t + 0.3);
    for (const n of notes) expect(n.vel).toBeGreaterThan(0);
  });
  it('honours the from/to range and returns nothing for silence or noise', () => {
    const x = new Float32Array(SR);
    x.set(sine(hz(60), SR / 2, SR, 0.5), SR / 2);
    expect(audioClipToMidi({ sampleRate: SR, channels: [x] }, { from: 0, to: 0.4 })).toEqual([]);
    const late = audioClipToMidi({ sampleRate: SR, channels: [x] }, { from: 0.4 });
    expect(late.map((n) => n.note)).toEqual([60]);
    expect(late[0].t).toBeGreaterThan(0.08);
    expect(audioClipToMidi({ sampleRate: SR, channels: [new Float32Array(SR)] })).toEqual([]);
  });
});
