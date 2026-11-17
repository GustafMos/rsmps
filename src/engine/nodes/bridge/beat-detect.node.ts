import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { BeatLive } from '../../lib/beat-live';
import { TrackAnalyzer, type BeatAnalysis } from '../../lib/beat';
import { asAnalysis, gridAt, hasGrid, lastEvent, pulse, type GridParams, type GridPos } from '../../lib/beat-grid';
import type { ProcessResult } from '../../types';

/**
 * Beat Detect: sound in, beat numbers out. Two sources of truth, same outputs:
 *  - ANALYSED: "Analyse sound file" listens to the whole file once (process mode) and stores onsets and a beat grid in the node.
 *    Outputs are then a pure function of the time, exact, look-ahead accurate and identical in every export. Needs the Sound input wired
 *    (so the audio engine runs the node) to the same sound; the grid is looked up by transport time, so seeking and looping work.
 *  - LIVE: a causal detector on whatever arrives (microphone, phone). Locks onto a tempo after a few seconds.
 * Stream side (`audio`): publishes signals. Picture side (`render`): reads them back through `Host.signal`.
 * This file must only import audio code and pure lib code: it is bundled into the AudioWorklet.
 */
const OUTPUTS = ['onset', 'beat', 'phase', 'bar', 'bpm', 'kick', 'snare', 'hat', 'level', 'count'] as const;

const HANDLE_KEY = 'analysis';

/** Seconds since the latest event of a stream was reported (so a live pulse starts at full height); an event that a positive offset has not reached yet falls back to the one before it. */
function liveSince(live: BeatLive, stream: number, offset: number): number {
  let e = live.evSeen[stream] + offset;
  if (e > live.now) e = live.evSeenPrev[stream] + offset;
  return live.now - e;
}

export default defineNode({
  id: 'beat-detect',
  title: 'Beat Detect',
  category: 'math',
  description: 'Finds the beat of a sound and gives you numbers that pulse on every hit, ramp through every beat and count the beats, so cuts and effects land on the music.',
  keywords: ['beat', 'onset', 'tempo', 'bpm', 'kick', 'snare', 'hat', 'transient', 'rhythm', 'sync', 'audio reactive', 'music', 'pulse', 'trigger', 'drum', 'metronome'],
  inputs: { audio: { type: 'audio', label: 'Sound' } },
  outputs: {
    onset: { type: 'number', label: 'Hit' },
    beat: { type: 'number', label: 'Beat pulse' },
    phase: { type: 'number', label: 'Beat ramp' },
    bar: { type: 'number', label: 'Bar ramp' },
    bpm: { type: 'number', label: 'Tempo' },
    kick: { type: 'number', label: 'Kick' },
    snare: { type: 'number', label: 'Snare' },
    hat: { type: 'number', label: 'Hat' },
    level: { type: 'number', label: 'Loudness' },
    count: { type: 'number', label: 'Beat count' },
  },
  params: {
    mode: {
      type: 'enum',
      default: 'auto',
      label: 'Source',
      hint: 'Auto uses the analyzed file when there is one, and listens live otherwise.',
      options: [
        { value: 'auto', label: 'Analyzed if any' },
        { value: 'live', label: 'Always live' },
      ],
    },
    track: { type: 'assets', default: [], accept: 'audio', label: 'Sound file', hint: 'The file to analyze. Wire the same sound into the Sound input.' },
    sensitivity: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Sensitivity', hint: 'Higher finds softer hits (and a few false ones).' },
    minGap: { type: 'number', default: 70, min: 20, max: 400, step: 1, label: 'Min gap ms', hint: 'Hits closer than this count as one.' },
    decay: { type: 'number', default: 150, min: 10, max: 2000, step: 1, label: 'Pulse ms', hint: 'How long a pulse takes to fade out after a hit.' },
    beatsPerBar: { type: 'number', default: 4, min: 1, max: 16, step: 1, integer: true, label: 'Beats per bar' },
    floor: { type: 'number', default: -50, min: -100, max: -10, step: 0.5, unit: 'db', label: 'Quietest', group: 'Loudness' },
    ceiling: { type: 'number', default: -6, min: -40, max: 6, step: 0.5, unit: 'db', label: 'Loudest', group: 'Loudness' },
    offset: { type: 'number', default: 0, min: -500, max: 500, step: 1, label: 'Offset ms', hint: 'Shift every hit and beat. Negative = earlier (analyzed file and live grid), positive = later.', group: 'Nudge' },
    bpmOverride: { type: 'number', default: 0, min: 0, max: 300, step: 0.1, label: 'Fixed tempo', hint: '0 = the analyzed beats. Otherwise a steady grid at this tempo, lined up on the first analyzed beat. Analyzed file only.', group: 'Nudge' },
    double: { type: 'bool', default: false, label: 'Double time', hint: 'Twice as many beats. Analyzed file only.', group: 'Nudge' },
    half: { type: 'bool', default: false, label: 'Half time', hint: 'Every second beat. Analyzed file only.', group: 'Nudge' },
    snap: { type: 'bool', default: false, label: 'Snap to loop', hint: 'With Loop on: make the beats divide the loop evenly when the tempo nearly fits. Analyzed file only.', group: 'Nudge' },
    analysis: { type: 'json', default: null, label: 'Analysis', visibleIf: () => false },
  },
  summary: (p) => {
    const a = asAnalysis(p.analysis);
    return a && a.bpm > 0 ? `analyzed ${Math.round(a.bpm)} BPM` : 'live';
  },
  process: {
    title: 'Analyze sound file',
    description: 'Listen to the whole file once. Beats and hits are then exact, and identical in every export.',
    standIn: 'preview',
    required: 'never', // without it the node listens live, which an export reproduces deterministically too
    gpu: false,
    signature: (p) => JSON.stringify([p.track, Math.round(p.sensitivity * 100)]),
    handle: {
      read: (params) => ((params[HANDLE_KEY] as { proc?: ProcessResult } | null)?.proc ?? null),
      write: (result) => {
        const { analysis, ...meta } = result.meta as { analysis?: BeatAnalysis };
        return { [HANDLE_KEY]: { proc: { ...result, meta }, grid: analysis ?? null } };
      },
      clear: () => ({ [HANDLE_KEY]: null }),
    },
    async run(job) {
      const id = job.params.track[0];
      if (!id) throw new Error('Choose the sound file to analyze first.');
      const pcm = await job.host.assetAudio?.(id);
      if (!pcm || !pcm.channels.length || !pcm.channels[0].length) throw new Error('That sound could not be read.');
      const an = new TrackAnalyzer(pcm.sampleRate, job.params.sensitivity);
      const total = pcm.channels[0].length;
      const chunk = Math.round(pcm.sampleRate * 2);
      const mono = new Float32Array(chunk);
      for (let at = 0; at < total; at += chunk) {
        const n = Math.min(chunk, total - at);
        for (let i = 0; i < n; i++) {
          let s = 0;
          for (const c of pcm.channels) s += c[at + i];
          mono[i] = s / pcm.channels.length;
        }
        an.push(mono, 0, n);
        job.progress((at + n) / (total + 1), 'Listening');
        await job.yield();
      }
      return { meta: { analysis: an.finish() } };
    },
  },
  audio: defineAudio({
    create: (ctx) => ({
      live: null as BeatLive | null,
      liveSr: ctx.sampleRate,
      liveKey: '',
      mono: new Float32Array(ctx.blockSize),
      env: 0,
      anRef: undefined as unknown,
      an: null as BeatAnalysis | null,
      grid: { offset: 0, bpmOverride: 0, half: false, double: false, snap: false, loop: false, duration: 0 } as GridParams,
      pos: { index: 0, phase: 0, period: 0.5, time: 0 } as GridPos,
    }),
    process(st, io) {
      const p = io.params;
      const n = io.frames;
      const sr = io.sampleRate;
      const src = io.in.audio;
      if (st.anRef !== p.analysis) {
        st.anRef = p.analysis;
        st.an = asAnalysis(p.analysis);
      }
      // loudness follower, same for both sources
      let level = 0;
      if (src) {
        let ms = 0;
        for (let i = 0; i < n; i++) {
          const x = (src[0][i] + src[1][i]) * 0.5;
          st.mono[i] = x;
          ms += x * x;
        }
        const r = Math.sqrt(ms / Math.max(1, n));
        const c = 1 - Math.exp(-n / (sr * (r > st.env ? 0.005 : 0.15)));
        st.env += (r - st.env) * c;
        level = st.env;
      } else st.env *= Math.exp(-n / (sr * 0.15));
      const range = Math.max(0.1, p.ceiling - p.floor);
      const lv = Math.min(1, Math.max(0, (20 * Math.log10(level + 1e-6) - p.floor) / range));
      const decay = p.decay / 1000;
      const offset = p.offset / 1000;
      const bpb = Math.max(1, p.beatsPerBar);

      const g: GridParams = st.grid;
      g.offset = offset;
      g.bpmOverride = p.bpmOverride;
      g.double = p.double;
      g.half = p.half;
      g.snap = p.snap;
      g.loop = io.time.loop;
      g.duration = io.time.duration;
      const an: BeatAnalysis | null = st.an;
      if (p.mode === 'auto' && hasGrid(an, g)) {
        const t = io.time.seconds + n / sr;
        const pos: GridPos = st.pos;
        gridAt(an, g, t, pos);
        const idx = Math.max(0, pos.index);
        io.signal('onset', pulse(t - lastEvent(an.onsets, t, offset), decay));
        io.signal('kick', pulse(t - lastEvent(an.kick, t, offset), decay));
        io.signal('snare', pulse(t - lastEvent(an.snare, t, offset), decay));
        io.signal('hat', pulse(t - lastEvent(an.hat, t, offset), decay));
        io.signal('beat', pos.index < 0 ? 0 : pulse(t - pos.time, decay));
        io.signal('phase', pos.index < 0 ? 0 : pos.phase);
        io.signal('bar', pos.index < 0 ? 0 : ((idx % bpb) + pos.phase) / bpb);
        io.signal('bpm', 60 / pos.period);
        io.signal('count', idx);
        io.signal('level', lv);
        return;
      }
      // live
      const key = `${p.sensitivity}|${p.minGap}`;
      if (!st.live || st.liveKey !== key || st.liveSr !== sr) {
        st.live = new BeatLive(sr, { sensitivity: p.sensitivity, minGapMs: p.minGap }); // only when the sensitivity changes or the rate does
        st.liveKey = key;
        st.liveSr = sr;
      }
      const live: BeatLive = st.live;
      live.gridOffset = offset;
      if (src) live.push(st.mono, 0, n);
      const now = live.now;
      // an event that a positive offset has not reached yet falls back to the one before it
      io.signal('onset', pulse(liveSince(live, 0, offset), decay));
      io.signal('kick', pulse(liveSince(live, 1, offset), decay));
      io.signal('snare', pulse(liveSince(live, 2, offset), decay));
      io.signal('hat', pulse(liveSince(live, 3, offset), decay));
      const locked = live.locked;
      io.signal('beat', locked ? pulse(now - Math.max(live.lastBeat, 0), decay) : 0);
      io.signal('phase', locked ? live.phase : 0);
      io.signal('bar', locked ? ((live.beatCount % bpb) + live.phase) / bpb : 0);
      io.signal('bpm', live.bpm);
      io.signal('count', locked ? live.beatCount : 0);
      io.signal('level', lv);
    },
    reset(st) {
      st.live?.reset();
      st.env = 0;
    },
  }),
  render(ctx) {
    const t = ctx.time.seconds; // reading the clock makes this node re-render every frame
    const out: Record<string, number> = {};
    for (const k of OUTPUTS) out[k] = ctx.host.signal?.(ctx.nodeId, k, t) ?? 0;
    return out;
  },
});
