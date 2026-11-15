import { defineNode } from '../../define';
import { defineAudio, type AudioIO, type MidiEvent } from '../../audio/types';
import { dbToLin, panGains } from '../../audio/dsp';
import { emptyTimeline, normalizeTimeline, type TimelineData } from '../../audio/timeline';
import type { RecordedPass, RecordedTake, RecordingState } from '../../audio/api';

/**
 * TIMELINE: an Ableton-style multi-track clip arranger in one node, plus recording.
 *
 * Param `clips` is a `TimelineData` (see src/engine/audio/timeline.ts for the exact JSON shape and the editing helpers
 * the UI must use). Outputs:
 *   audio      all audio tracks mixed (clip gain/fades, track gain/pan/mute/solo) + the click while recording
 *   midi       all MIDI tracks merged
 *   soloAudio / soloMidi   only the track named by `outputTrack` (use several Timeline nodes for separate instruments)
 *
 * Playback follows the transport sample-accurately. Seek, pause and loop wrap flush hanging MIDI notes with note-offs.
 * Clips on a track overlap freely (audio sums, MIDI merges). `wrap` lets a clip that runs past the end of the loop
 * continue from the start of the loop. MIDI notes are cut at a custom loop point.
 *
 * Recording: wire Microphone.tap (or any audio) into `recordAudio` and a keyboard / device / Audio to MIDI into
 * `recordMidi`. The host arms a track and starts/stops via AudioGraphRunner.control (AudioEngine.armRecording ...).
 * This file imports only audio code: it is bundled into the AudioWorklet.
 */

const CHUNK = 65536;

interface TrackInfo {
  audible: boolean;
  gain: number;
  panL: number;
  panR: number;
  isOut: boolean;
}
interface AClip {
  startS: number;
  lenS: number;
  offS: number;
  loop: boolean;
  gain: number;
  fiS: number;
  foS: number;
  asset: string;
  t: TrackInfo;
}
interface MClip {
  startS: number;
  lenS: number;
  offS: number;
  srcLenS: number;
  loop: boolean;
  onS: Float64Array; // note starts in source samples
  durS: Float64Array;
  note: Int16Array;
  vel: Float64Array;
  ccT: Float64Array;
  ccN: Int16Array;
  ccV: Float64Array;
  isOut: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function compile(data: TimelineData, sr: number, outputTrack: string): { audio: AClip[]; midi: MClip[] } {
  const anySolo = data.tracks.some((t) => t.solo);
  const info = new Map<string, TrackInfo & { kind: string }>();
  for (const t of data.tracks) {
    const [l, r] = panGains(t.pan);
    info.set(t.id, {
      kind: t.kind,
      audible: !t.mute && (!anySolo || t.solo),
      gain: dbToLin(t.gain),
      panL: l * Math.SQRT2,
      panR: r * Math.SQRT2,
      isOut: outputTrack !== '' && (t.id === outputTrack || t.name === outputTrack),
    });
  }
  const audio: AClip[] = [];
  const midi: MClip[] = [];
  for (const c of data.clips) {
    const t = info.get(c.track);
    if (!t || !t.audible || c.muted || c.length <= 0) continue;
    const startS = Math.round(c.start * sr);
    const lenS = Math.max(1, Math.round(c.length * sr));
    const offS = Math.round(c.offset * sr);
    if (t.kind === 'audio' && c.asset) {
      audio.push({ startS, lenS, offS, loop: c.loop, gain: dbToLin(c.gain), fiS: Math.round(c.fadeIn * sr), foS: Math.round(c.fadeOut * sr), asset: c.asset, t });
    } else if (t.kind === 'midi' && c.notes) {
      const notes = c.notes;
      const cc = c.cc ?? [];
      midi.push({
        startS,
        lenS,
        offS,
        srcLenS: Math.max(1, Math.round((c.srcLength ?? c.length) * sr)),
        loop: c.loop,
        onS: Float64Array.from(notes, (n) => Math.round(n.t * sr)),
        durS: Float64Array.from(notes, (n) => Math.max(1, Math.round(n.d * sr))),
        note: Int16Array.from(notes, (n) => n.note),
        vel: Float64Array.from(notes, (n) => n.vel),
        ccT: Float64Array.from(cc, (e) => Math.round(e.t * sr)),
        ccN: Int16Array.from(cc, (e) => e.cc),
        ccV: Float64Array.from(cc, (e) => e.value),
        isOut: t.isOut,
      });
    }
  }
  return { audio, midi };
}

function allOff(st: any, out: MidiEvent[], soloOut: MidiEvent[]): void {
  for (let n = 0; n < 128; n++) {
    if (st.act[n] > 0) {
      const ev: MidiEvent = { type: 'off', note: n, velocity: 0, value: 0, offset: 0, channel: 0 };
      out.push(ev);
      if (st.actSolo[n] > 0) soloOut.push(ev);
      st.act[n] = 0;
      st.actSolo[n] = 0;
    }
  }
}

/** Collect the MIDI events of one clip that fall in timeline samples [tl0, tl1). */
function collectMidi(c: MClip, shift: number, tl0: number, tl1: number, i0: number, list: any[]): void {
  const base = c.startS + shift;
  const end = base + c.lenS;
  if (tl1 <= base || tl0 > end) return;
  const region = c.loop ? c.srcLenS : Infinity;
  const rLo = c.loop ? Math.max(0, Math.floor((tl0 - base) / region) - 1) : 0;
  const rHi = c.loop ? Math.floor((tl1 - 1 - base) / region) : 0;
  for (let r = rLo; r <= rHi; r++) {
    const rep = base + r * (c.loop ? region : 0);
    const repEnd = c.loop ? rep + region : end;
    const limit = Math.min(end, repEnd);
    for (let k = 0; k < c.note.length; k++) {
      const local = c.onS[k] - c.offS;
      if (local < 0 || (c.loop && local >= region)) continue;
      const on = rep + local;
      if (on >= limit) continue;
      const off = Math.max(on + 1, Math.min(on + c.durS[k], limit));
      if (on >= tl0 && on < tl1) list.push({ off: false, at: i0 + (on - tl0), note: c.note[k], vel: c.vel[k], solo: c.isOut });
      if (off >= tl0 && off < tl1) list.push({ off: true, at: i0 + (off - tl0), note: c.note[k], vel: 0, solo: c.isOut });
    }
    for (let k = 0; k < c.ccT.length; k++) {
      const local = c.ccT[k] - c.offS;
      if (local < 0 || (c.loop && local >= region)) continue;
      const at = rep + local;
      if (at >= limit || at < tl0 || at >= tl1) continue;
      list.push({ cc: true, off: false, at: i0 + (at - tl0), note: c.ccN[k], vel: c.ccV[k], solo: c.isOut });
    }
  }
}

function mixAudio(st: any, io: AudioIO, i0: number, n: number, tl0: number, wrapLen: number, wrap: boolean): void {
  const [ol, or] = io.out.audio;
  const [sl, sr_] = io.out.soloAudio;
  for (let k = 0; k < st.audio.length; k++) {
    const c: AClip = st.audio[k];
    const asset = io.assets.get(c.asset);
    if (!asset || asset.frames === 0) continue;
    const region = asset.frames - c.offS;
    if (region <= 0) continue;
    for (let pass = 0; pass < 2; pass++) {
      let cs = c.startS;
      if (pass === 1) {
        if (!wrap || wrapLen <= 0 || c.startS + c.lenS <= wrapLen) break;
        cs -= wrapLen; // the part past the loop end continues from the loop start
      }
      const a = Math.max(tl0, cs);
      const b = Math.min(tl0 + n, cs + c.lenS);
      if (b <= a) continue;
      const t = c.t;
      const gl = c.gain * t.gain * t.panL;
      const gr = c.gain * t.gain * t.panR;
      for (let i = a; i < b; i++) {
        const u = i - cs;
        let pos = c.offS + u;
        if (c.loop) pos = c.offS + (u % region);
        else if (pos >= asset.frames) continue;
        let g = 1;
        if (u < c.fiS) g = u / c.fiS;
        const rem = c.lenS - u;
        if (rem < c.foS) g *= rem / c.foS;
        const o = i0 + (i - tl0);
        const l = asset.left[pos] * g * gl;
        const r = asset.right[pos] * g * gr;
        ol[o] += l;
        or[o] += r;
        if (t.isOut) {
          sl[o] += l;
          sr_[o] += r;
        }
      }
    }
  }
}

function playSegment(st: any, io: AudioIO, i0: number, n: number, tl0: number, wrapLen: number, wrap: boolean): void {
  mixAudio(st, io, i0, n, tl0, wrapLen, wrap);
  const list: any[] = st.evList;
  list.length = 0;
  const tl1 = tl0 + n;
  for (let k = 0; k < st.midi.length; k++) {
    const c: MClip = st.midi[k];
    collectMidi(c, 0, tl0, tl1, i0, list);
    if (wrap && wrapLen > 0 && c.startS + c.lenS > wrapLen) collectMidi(c, -wrapLen, tl0, tl1, i0, list);
  }
  if (!list.length) return;
  // time order; at the same sample note-offs come before note-ons so retriggered notes restart cleanly
  list.sort((a, b) => a.at - b.at || (a.off === b.off ? 0 : a.off ? -1 : 1));
  const out = io.midiOut.midi;
  const sOut = io.midiOut.soloMidi;
  for (const e of list) {
    if (e.cc) {
      const ev: MidiEvent = { type: 'cc', note: e.note, velocity: 0, value: e.vel, offset: e.at, channel: 0 };
      out.push(ev);
      if (e.solo) sOut.push(ev);
    } else if (e.off) {
      if (st.act[e.note] <= 0) continue; // its note-on was before a seek: nothing to release
      st.act[e.note]--;
      const ev: MidiEvent = { type: 'off', note: e.note, velocity: 0, value: 0, offset: e.at, channel: 0 };
      out.push(ev);
      if (e.solo && st.actSolo[e.note] > 0) {
        st.actSolo[e.note]--;
        sOut.push(ev);
      }
    } else {
      st.act[e.note]++;
      const ev: MidiEvent = { type: 'on', note: e.note, velocity: e.vel, value: 0, offset: e.at, channel: 0 };
      out.push(ev);
      if (e.solo) {
        st.actSolo[e.note]++;
        sOut.push(ev);
      }
    }
  }
}

/* ----------------------------------------------------------------------- */
/* Recording                                                                */
/* ----------------------------------------------------------------------- */

interface RawNote {
  pass: number;
  on: number; // project seconds of arrival
  off: number;
  note: number;
  vel: number;
}

function newRec(): any {
  return {
    phase: 'idle', // idle | armed | count-in | recording
    target: null as { track: string; kind: 'audio' | 'midi' } | null,
    latency: 0,
    countInLeft: 0,
    ciPos: 0,
    chunks: [] as [Float32Array, Float32Array][],
    curL: null as Float32Array | null,
    curR: null as Float32Array | null,
    curPos: 0,
    frames: 0,
    passStartFrame: [] as number[],
    passStartTime: [] as number[],
    expected: -1,
    startProject: 0,
    open: new Map<number, RawNote>(),
    notes: [] as RawNote[],
    level: [0, 0] as [number, number],
    error: null as string | null,
    maxFrames: 0,
    lastProject: 0,
  };
}

function resetCapture(r: any): void {
  r.chunks = [];
  r.curL = r.curR = null;
  r.curPos = 0;
  r.frames = 0;
  r.passStartFrame = [];
  r.passStartTime = [];
  r.expected = -1;
  r.open = new Map();
  r.notes = [];
  r.level = [0, 0];
  r.error = null;
}

function pushFrames(r: any, l: Float32Array | null, rr: Float32Array | null, n: number, store: boolean): void {
  if (!store) {
    r.frames += n;
    return;
  }
  let done = 0;
  while (done < n) {
    if (!r.curL || r.curPos >= CHUNK) {
      if (r.curL) r.chunks.push([r.curL, r.curR]);
      r.curL = new Float32Array(CHUNK); // the one allocation while recording: once per ~1.4 s
      r.curR = new Float32Array(CHUNK);
      r.curPos = 0;
    }
    const m = Math.min(n - done, CHUNK - r.curPos);
    if (l) {
      r.curL.set(l.subarray(done, done + m), r.curPos);
      r.curR.set((rr ?? l).subarray(done, done + m), r.curPos);
    }
    r.curPos += m;
    done += m;
  }
  r.frames += n;
}

function finishTake(st: any, nodeId: string): RecordedTake | null {
  const r = st.rec;
  if (!r.target || r.frames === 0) return null;
  const sr = st.sr as number;
  const kind = r.target.kind as 'audio' | 'midi';
  const latF = Math.max(0, Math.round(r.latency * sr));
  // close notes still held
  const endProject = r.lastProject;
  for (const n of r.open.values()) {
    n.off = endProject;
    r.notes.push(n);
  }
  r.open = new Map();
  const bounds: number[] = [...r.passStartFrame, r.frames];
  const passCount = r.passStartFrame.length;
  const take: RecordedTake = {
    nodeId,
    track: r.target.track,
    kind,
    start: r.passStartTime[0] ?? 0,
    length: Math.max(0, (r.frames - (kind === 'audio' ? latF : 0)) / sr),
    loopPasses: passCount,
    latency: r.latency,
  };
  if (r.error) take.error = r.error;
  let pcmL: Float32Array | null = null;
  let pcmR: Float32Array | null = null;
  if (kind === 'audio') {
    const total = Math.max(0, r.frames - latF);
    pcmL = new Float32Array(total);
    pcmR = new Float32Array(total);
    const all = [...r.chunks, ...(r.curL ? [[r.curL, r.curR] as [Float32Array, Float32Array]] : [])];
    let w = 0; // frames consumed from the recording, skipping the first latF
    let consumed = 0;
    for (const [cl, cr] of all) {
      const len = Math.min(CHUNK, r.frames - consumed);
      for (let i = 0; i < len; i++) {
        const idx = consumed + i - latF;
        if (idx >= 0 && idx < total) {
          pcmL[idx] = cl[i];
          pcmR[idx] = cr[i];
          w++;
        }
      }
      consumed += len;
    }
    void w;
    take.pcm = { sampleRate: sr, channels: [pcmL, pcmR] };
  }
  const passes: RecordedPass[] = [];
  for (let k = 0; k < passCount; k++) {
    const a = bounds[k];
    const b = bounds[k + 1];
    const pass: RecordedPass = { start: r.passStartTime[k], length: (b - a) / sr };
    if (kind === 'audio' && pcmL && pcmR) {
      const total = pcmL.length;
      const pa = Math.min(a, total);
      const pb = Math.min(b, total);
      if (pb <= pa) continue;
      pass.length = (pb - pa) / sr;
      pass.pcm = { sampleRate: sr, channels: [pcmL.subarray(pa, pb), pcmR.subarray(pa, pb)] };
    } else {
      pass.notes = r.notes
        .filter((n: RawNote) => n.pass === k)
        .map((n: RawNote) => ({
          t: Math.max(0, n.on - r.latency - r.passStartTime[k]),
          d: Math.max(0.01, n.off - n.on),
          note: n.note,
          vel: n.vel,
        }))
        .sort((x: any, y: any) => x.t - y.t || x.note - y.note);
    }
    passes.push(pass);
  }
  if (passes.length > 1) take.passes = passes;
  if (kind === 'midi') take.notes = passes.flatMap((p) => p.notes ?? []).sort((x, y) => x.t - y.t);
  if (passes.length === 1 && kind === 'midi') take.notes = passes[0].notes;
  return take;
}

/**
 * Capture this block. `loopLen` (samples, 0 = no loop) is the timeline loop: a block that crosses the loop point is split
 * exactly there and the second part starts a new pass at timeline time 0 (sample accurate).
 */
function recordInput(st: any, io: AudioIO, loopLen: number): void {
  const r = st.rec;
  const n = io.frames;
  const sr = io.sampleRate;
  const p = io.params;
  r.maxFrames = Math.round(p.maxLength * sr);
  const audioIn = io.in.recordAudio;
  if (r.phase === 'count-in') {
    r.ciPos += n;
    r.countInLeft -= n;
    if (r.countInLeft <= 0) {
      r.phase = 'recording';
      resetCapture(r);
    }
    return;
  }
  if (r.phase !== 'recording' || !io.time.playing) {
    r.expected = -1;
    return;
  }
  const isAudio = r.target.kind === 'audio';
  let i0 = 0;
  while (i0 < n) {
    let tl = io.time.sample + i0;
    let len = n - i0;
    if (loopLen > 0) {
      tl = tl % loopLen;
      len = Math.min(len, loopLen - tl);
    }
    const newPass = r.passStartFrame.length === 0 || tl !== r.expected;
    if (r.frames + len > r.maxFrames) {
      r.error = `Recording stopped: the maximum length of ${Math.round(p.maxLength)} s was reached.`;
      r.phase = 'armed';
      return;
    }
    if (newPass) {
      if (r.passStartFrame.length === 0) r.startProject = tl / sr;
      else {
        for (const note of r.open.values()) {
          note.off = r.lastProject;
          r.notes.push(note);
        }
        r.open = new Map();
      }
      r.passStartFrame.push(r.frames);
      r.passStartTime.push(tl / sr);
    }
    const pass = r.passStartFrame.length - 1;
    if (isAudio) {
      if (audioIn) {
        const l = i0 === 0 && len === n ? audioIn[0] : audioIn[0].subarray(i0, i0 + len);
        const rr = i0 === 0 && len === n ? audioIn[1] : audioIn[1].subarray(i0, i0 + len);
        pushFrames(r, l, rr, len, true);
        let pa = 0;
        let pb = 0;
        for (let i = 0; i < len; i++) {
          const x = l[i] < 0 ? -l[i] : l[i];
          const y = rr[i] < 0 ? -rr[i] : rr[i];
          if (x > pa) pa = x;
          if (y > pb) pb = y;
        }
        r.level[0] = Math.max(pa, r.level[0] * 0.9);
        r.level[1] = Math.max(pb, r.level[1] * 0.9);
      } else pushFrames(r, null, null, len, true);
    } else {
      pushFrames(r, null, null, len, false);
      for (const ev of io.midiIn.recordMidi) {
        if (ev.offset < i0 || ev.offset >= i0 + len) continue;
        const t = (tl + (ev.offset - i0)) / sr;
        if (ev.type === 'on') {
          const prev = r.open.get(ev.note);
          if (prev) {
            prev.off = t;
            r.notes.push(prev);
          }
          r.open.set(ev.note, { pass, on: t, off: t, note: ev.note, vel: ev.velocity });
        } else if (ev.type === 'off') {
          const o = r.open.get(ev.note);
          if (o) {
            o.off = t;
            r.notes.push(o);
            r.open.delete(ev.note);
          }
        }
      }
    }
    r.expected = tl + len;
    r.lastProject = (tl + len) / sr;
    i0 += len;
  }
}

/** Metronome click mixed into the audible outputs while armed-and-running (never in exports: nothing arms there). */
function click(st: any, io: AudioIO): void {
  const r = st.rec;
  if (!io.params.metronome || (r.phase !== 'count-in' && r.phase !== 'recording')) {
    st.clickLeft = 0;
    return;
  }
  const sr = io.sampleRate;
  const beatS = (60 / io.params.bpm) * sr;
  const n = io.frames;
  const start = r.phase === 'count-in' ? r.ciPos - n : io.time.sample;
  if (r.phase === 'recording' && !io.time.playing) return;
  const first = Math.ceil(start / beatS - 1e-9);
  const at = first * beatS;
  if (at >= start && at < start + n) {
    st.clickAt = Math.round(at - start);
    st.clickFreq = first % 4 === 0 ? 1500 : 1000;
    st.clickLeft = Math.round(0.03 * sr);
    st.clickLen = st.clickLeft;
  }
  if (st.clickLeft <= 0) return;
  const [ol, or] = io.out.audio;
  const from = st.clickAt >= 0 ? st.clickAt : 0;
  for (let i = from; i < n && st.clickLeft > 0; i++, st.clickLeft--) {
    const k = st.clickLen - st.clickLeft;
    const v = Math.sin((2 * Math.PI * st.clickFreq * k) / sr) * Math.exp((-k / sr) * 150) * 0.35;
    ol[i] += v;
    or[i] += v;
  }
  st.clickAt = -1;
}

export default defineNode({
  id: 'audio-timeline',
  title: 'Timeline',
  category: 'audio-source',
  description: 'Arrange audio and MIDI clips on tracks like in a music app, layer and offset them, loop them, and record new takes into it.',
  keywords: ['arranger', 'clips', 'record', 'daw', 'ableton', 'tracks', 'loop', 'midi clip', 'take', 'overdub', 'sequencer', 'multitrack'],
  inputs: {
    recordAudio: { type: 'audio', label: 'Record audio (e.g. Microphone tap)' },
    recordMidi: { type: 'midi', label: 'Record MIDI (e.g. Keyboard)' },
  },
  outputs: {
    audio: { type: 'audio', label: 'Audio (all tracks)' },
    midi: { type: 'midi', label: 'MIDI (all tracks)' },
    soloAudio: { type: 'audio', label: 'Audio (chosen track)' },
    soloMidi: { type: 'midi', label: 'MIDI (chosen track)' },
  },
  params: {
    clips: { type: 'json', default: emptyTimeline(), label: 'Tracks and clips', hint: 'Edited with the timeline editor.' },
    outputTrack: { type: 'string', default: '', label: 'Chosen track (id or name) for the last two outputs', group: 'Outputs' },
    gain: { type: 'number', default: 0, min: -60, max: 24, step: 0.1, unit: 'db', label: 'Volume', group: 'Outputs' },
    wrap: { type: 'bool', default: true, label: 'Clips continue past the loop end', group: 'Looping' },
    loop: {
      type: 'enum',
      default: 'project',
      label: 'Loop',
      group: 'Looping',
      options: [
        { value: 'project', label: 'With the project loop' },
        { value: 'custom', label: 'Own loop length' },
      ],
    },
    loopBars: { type: 'number', default: 4, min: 1, max: 256, step: 1, integer: true, label: 'Own loop length (bars)', group: 'Looping', visibleIf: (p) => p.loop === 'custom' },
    bpm: { type: 'number', default: 120, min: 30, max: 300, step: 0.1, label: 'Tempo (BPM)', group: 'Looping' },
    quantize: {
      type: 'enum',
      default: '1/16',
      label: 'Snap to grid',
      group: 'Looping',
      hint: 'Used by the editor and quantize tools; playback is never snapped.',
      options: [
        { value: 'off', label: 'Off' },
        { value: '1/1', label: 'Bar' },
        { value: '1/2', label: '1/2' },
        { value: '1/4', label: '1/4 (beat)' },
        { value: '1/8', label: '1/8' },
        { value: '1/16', label: '1/16' },
        { value: '1/32', label: '1/32' },
      ],
    },
    loopRecordMode: {
      type: 'enum',
      default: 'overdub',
      label: 'When the loop repeats while recording',
      group: 'Recording',
      options: [
        { value: 'overdub', label: 'Overdub (layers add up)' },
        { value: 'takes', label: 'Keep every pass as a take (last one plays)' },
        { value: 'replace', label: 'Replace what was there' },
      ],
    },
    countIn: { type: 'number', default: 0, min: 0, max: 8, step: 1, integer: true, label: 'Count-in (bars)', group: 'Recording' },
    metronome: { type: 'bool', default: false, label: 'Click while recording (not in exports)', group: 'Recording' },
    monitor: { type: 'bool', default: true, label: 'Hear what is being recorded', group: 'Recording' },
    latencyOffsetMs: { type: 'number', default: 0, min: -250, max: 500, step: 1, label: 'Latency offset (ms)', group: 'Recording', hint: 'Added to the detected device latency. Raise it if recorded parts land late.' },
    maxLength: { type: 'number', default: 600, min: 5, max: 3600, step: 1, unit: 's', label: 'Longest recording', group: 'Recording' },
  },
  summary: (p) => {
    const n = normalizeTimeline(p.clips);
    return `${n.tracks.length} tracks · ${n.clips.length} clips`;
  },
  audio: defineAudio({
    runWhenFed: true,
    create: (ctx) => ({
      sr: ctx.sampleRate,
      nodeId: ctx.nodeId,
      clipsRef: null as unknown,
      key: '',
      audio: [] as AClip[],
      midi: [] as MClip[],
      act: new Uint8Array(128),
      actSolo: new Uint8Array(128),
      expected: -1,
      evList: [] as any[],
      rec: newRec(),
      params: null as any,
      clickLeft: 0,
      clickAt: -1,
      clickFreq: 1000,
      clickLen: 1,
      dirty: false,
      loopLen: 0,
    }),
    process(st, io) {
      const p = io.params;
      st.params = p;
      const n = io.frames;
      const sr = io.sampleRate;
      const [ol, or] = io.out.audio;
      const outM = io.midiOut.midi;
      const outS = io.midiOut.soloMidi;
      // compile when the clips (or things baked into them) change
      const key = `${p.outputTrack}`;
      if (st.clipsRef !== p.clips || st.key !== key) {
        st.clipsRef = p.clips;
        st.key = key;
        const c = compile(normalizeTimeline(p.clips), sr, p.outputTrack);
        st.audio = c.audio;
        st.midi = c.midi;
        st.dirty = true;
      }
      if (st.dirty) {
        allOff(st, outM, outS);
        st.dirty = false;
      }
      const wrap = p.wrap as boolean;
      const duration = io.time.duration;
      const projectLoop = duration > 0 ? Math.round(duration * sr) : 0;
      // the loop this node follows: its own length, or the project loop when that is on
      const loopLen = p.loop === 'custom' ? Math.max(1, Math.round((p.loopBars * 4 * 60 * sr) / p.bpm)) : io.time.loop ? projectLoop : 0;
      st.loopLen = loopLen;
      // recording happens first so the monitor/pass-through below sees the same block
      if (st.rec.phase !== 'idle' && st.rec.target) recordInput(st, io, loopLen);
      if (!io.time.playing) {
        allOff(st, outM, outS);
        st.expected = -1;
      } else {
        const sample = io.time.sample;
        const here = loopLen > 0 ? sample % loopLen : sample;
        if (st.expected >= 0 && here !== st.expected) allOff(st, outM, outS); // seek, pause/resume or a loop wrap
        let i0 = 0;
        while (i0 < n) {
          let tl = sample + i0;
          let len = n - i0;
          if (loopLen > 0) {
            tl = tl % loopLen;
            len = Math.min(len, loopLen - tl);
            if (i0 > 0 && tl === 0) allOff(st, outM, outS); // the loop point inside this block
          }
          playSegment(st, io, i0, len, tl, loopLen > 0 ? loopLen : projectLoop, wrap);
          i0 += len;
        }
        const end = sample + n;
        st.expected = loopLen > 0 ? end % loopLen : end;
      }
      // master volume on the playback just mixed
      const g = dbToLin(p.gain);
      if (g !== 1) {
        const [sl, sr2] = io.out.soloAudio;
        for (let i = 0; i < n; i++) {
          ol[i] *= g;
          or[i] *= g;
          sl[i] *= g;
          sr2[i] *= g;
        }
      }
      // monitor the record inputs while armed
      if (p.monitor && st.rec.phase !== 'idle') {
        const a = io.in.recordAudio;
        if (a) {
          for (let i = 0; i < n; i++) {
            ol[i] += a[0][i];
            or[i] += a[1][i];
          }
        }
        for (const ev of io.midiIn.recordMidi) outM.push(ev);
      }
      click(st, io);
    },
    assets: (p) => normalizeTimeline(p.clips).clips.flatMap((c) => (c.asset ? [c.asset] : [])),
    control(st, msg, p) {
      const r = st.rec;
      switch (msg.type) {
        case 'arm': {
          const target = msg.target as { track: string; kind: 'audio' | 'midi' } | null;
          if (!target) {
            r.phase = 'idle';
            r.target = null;
          } else {
            r.target = target;
            r.phase = 'armed';
            resetCapture(r);
          }
          return null;
        }
        case 'start': {
          if (!r.target) return null;
          resetCapture(r);
          r.latency = Math.max(0, (msg.latency ?? 0) + p.latencyOffsetMs / 1000);
          const beatS = (60 / p.bpm) * st.sr;
          r.countInLeft = p.countIn * 4 * beatS;
          r.ciPos = 0;
          r.phase = r.countInLeft > 0 ? 'count-in' : 'recording';
          return null;
        }
        case 'stop': {
          const take = r.phase === 'idle' || !r.target ? null : finishTake(st, st.nodeId);
          if (r.target) {
            r.phase = 'armed';
            resetCapture(r);
          }
          return take;
        }
        case 'state': {
          const s: RecordingState = {
            armed: r.phase !== 'idle',
            recording: r.phase === 'recording',
            phase: r.phase,
            seconds: r.frames / st.sr,
            countIn: Math.max(0, r.countInLeft) / st.sr,
            level: [r.level[0], r.level[1]],
            nodeId: st.nodeId,
            error: r.error,
          };
          return s;
        }
      }
      return undefined;
    },
    reset(st) {
      st.act.fill(0);
      st.actSolo.fill(0);
      st.expected = -1;
    },
  }),
});

