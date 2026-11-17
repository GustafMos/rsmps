import { defineNode } from '../../define';
import { defineAudio, type AudioAsset, type MidiEvent } from '../../audio/types';
import { dbToLin, panGains } from '../../audio/dsp';
import { adsrStep, allIdle, expCoef, handleController, makeVoices, pickVoice, releaseNote } from '../../audio/instrument';

const MAXV = 24;

/**
 * Sampler: plays an audio asset (a file, or a take you recorded) pitched by the note, with trim, loop points and an
 * envelope. Slice mode cuts the sound into equal pieces mapped to consecutive keys (chop a drum loop or a vocal).
 * Pads mode gives every sound of the list its own key (a drum kit) with optional choke groups (open and closed hat cut each other).
 */
export default defineNode({
  id: 'sampler',
  title: 'Sampler',
  category: 'synth',
  description: 'Turns any sound (a file or something you recorded) into an instrument you can play with notes, chop into slices across the keys, or spread a list of sounds over the keys as pads.',
  keywords: ['sample', 'slice', 'chop', 'one shot', 'one-shot', 'loop', 'recorded', 'record', 'take', 'instrument', 'pitch', 'keyboard', 'vocal', 'pads', 'mpc', 'drum kit', 'choke'],
  inputs: { midi: { type: 'midi', label: 'MIDI' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    assets: { type: 'assets', default: [], accept: 'audio', label: 'Sound' },
    mode: {
      type: 'enum',
      default: 'gated',
      label: 'Play mode',
      options: [
        { value: 'gated', label: 'Pitched hold' },
        { value: 'oneshot', label: 'Pitched one-shot' },
        { value: 'slice', label: 'Slices' },
        { value: 'pads', label: 'One sound per key' },
      ],
    },
    rootNote: { type: 'number', default: 60, min: 0, max: 127, step: 1, integer: true, label: 'Root note', hint: 'The note the sample was recorded at.', visibleIf: (p) => p.mode === 'gated' || p.mode === 'oneshot' },
    tune: { type: 'number', default: 0, min: -1200, max: 1200, step: 1, label: 'Fine tune', hint: 'In cents.' },
    start: { type: 'number', default: 0, min: 0, max: 600, step: 0.001, unit: 's', label: 'Start', group: 'Trim and loop' },
    end: { type: 'number', default: 0, min: 0, max: 600, step: 0.001, unit: 's', label: 'End', hint: '0 = whole sound.', group: 'Trim and loop' },
    reverse: { type: 'bool', default: false, label: 'Reverse', hint: 'Play the sound backwards.', group: 'Trim and loop' },
    loop: { type: 'bool', default: false, label: 'Loop while held', group: 'Trim and loop', visibleIf: (p) => p.mode === 'gated' },
    loopStart: { type: 'number', default: 0, min: 0, max: 600, step: 0.001, unit: 's', label: 'Loop start', group: 'Trim and loop', visibleIf: (p) => p.mode === 'gated' && !!p.loop },
    loopEnd: { type: 'number', default: 0, min: 0, max: 600, step: 0.001, unit: 's', label: 'Loop end', hint: '0 = End.', group: 'Trim and loop', visibleIf: (p) => p.mode === 'gated' && !!p.loop },
    slices: { type: 'number', default: 8, min: 2, max: 64, softMax: 32, step: 1, integer: true, label: 'Slices', group: 'Slices', visibleIf: (p) => p.mode === 'slice' },
    sliceBase: { type: 'number', default: 36, min: 0, max: 100, step: 1, integer: true, label: 'First key', hint: 'The note that plays the first slice, or the first sound of the list in One sound per key.', group: 'Slices', visibleIf: (p) => p.mode === 'slice' || p.mode === 'pads' },
    chokeSize: { type: 'number', default: 0, min: 0, max: 16, step: 1, integer: true, label: 'Choke group size', hint: 'One sound per key: keys in blocks of this many cut each other off, like an open and a closed hi-hat. 0 = off.', group: 'Slices', visibleIf: (p) => p.mode === 'pads' },
    attack: { type: 'number', default: 2, min: 0, max: 5000, step: 1, label: 'Attack ms', group: 'Envelope' },
    decay: { type: 'number', default: 200, min: 1, max: 5000, step: 1, label: 'Decay ms', group: 'Envelope' },
    sustain: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Sustain', group: 'Envelope' },
    release: { type: 'number', default: 80, min: 1, max: 8000, step: 1, label: 'Release ms', group: 'Envelope' },
    velocity: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Velocity', group: 'Output' },
    pan: { type: 'number', default: 0, min: -1, max: 1, step: 0.01, label: 'Pan', group: 'Output' },
    voices: { type: 'number', default: 12, min: 1, max: MAXV, softMax: 16, step: 1, integer: true, label: 'Notes at once', group: 'Output' },
    gain: { type: 'number', default: -3, min: -60, max: 12, step: 0.1, unit: 'db', label: 'Volume', group: 'Output' },
  },
  summary: (p) => `${p.assets.length ? p.assets[0] : 'no sound'} · ${p.mode}`,
  audio: defineAudio({
    create: () => ({
      v: makeVoices(MAXV),
      pos: new Float64Array(MAXV),
      rate: new Float64Array(MAXV),
      end: new Float64Array(MAXV),
      loopS: new Float64Array(MAXV),
      loopE: new Float64Array(MAXV),
      looping: new Uint8Array(MAXV),
      rev: new Uint8Array(MAXV),
      lo: new Float64Array(MAXV),
      group: new Int16Array(MAXV).fill(-1),
      asset: new Array(MAXV).fill(null),
      shot: new Uint8Array(MAXV),
      done: new Uint8Array(MAXV),
    }),
    process(st, io) {
      const p = io.params;
      const ids = p.assets as string[];
      const asset = ids.length ? io.assets.get(ids[0]) : undefined;
      const pads = p.mode === 'pads';
      const n = io.frames;
      const [ol, or] = io.out.audio;
      const events: MidiEvent[] = io.midiIn.midi;
      const v = st.v;
      const sr = io.sampleRate;
      let ei = 0;
      let cursor = 0;
      while (cursor < n) {
        while (ei < events.length && events[ei].offset <= cursor) {
          const ev = events[ei++];
          if (ev.type === 'on') noteOn(st, p, pads ? (io.assets.get(ids[ev.note - p.sliceBase]) ?? undefined) : asset, sr, ev);
          else if (ev.type === 'off') {
            if (p.mode !== 'oneshot' && !pads) releaseNote(v, ev.note);
          } else handleController(v, ev);
        }
        const end = ei < events.length ? Math.min(n, Math.max(cursor + 1, events[ei].offset)) : n;
        render(st, p, sr, ol, or, cursor, end);
        cursor = end;
      }
    },
    reset(st) {
      allIdle(st.v);
    },
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function noteOn(st: any, p: any, asset: AudioAsset | undefined, sr: number, ev: MidiEvent): void {
  if (!asset || asset.frames < 2) return;
  const v = st.v;
  const padIdx = ev.note - p.sliceBase;
  if (p.mode === 'pads') {
    if (padIdx < 0) return;
    if (p.chokeSize > 0) {
      const g = Math.floor(padIdx / p.chokeSize);
      for (let j = 0; j < v.n; j++) if (v.stage[j] !== 0 && v.stage[j] !== 3 && st.group[j] === g) v.stage[j] = 3; // cut the others of the group (fast release: no click)
    }
  }
  const total = asset.frames;
  const a = Math.min(total - 1, Math.round(p.start * sr));
  const e = p.end > 0 ? Math.min(total, Math.round(p.end * sr)) : total;
  let startPos = a;
  let endPos = Math.max(a + 1, e);
  let rate = Math.pow(2, p.tune / 1200);
  if (p.mode === 'slice') {
    const idx = ev.note - p.sliceBase;
    if (idx < 0 || idx >= p.slices) return;
    const len = (endPos - a) / p.slices;
    startPos = a + idx * len;
    endPos = a + (idx + 1) * len;
  } else if (p.mode !== 'pads') rate *= Math.pow(2, (ev.note - p.rootNote) / 12);
  const i = pickVoice(v, ev.note, p.voices);
  v.vel[i] = 1 - p.velocity + p.velocity * ev.velocity;
  const rev = p.reverse ? 1 : 0;
  st.rev[i] = rev;
  st.lo[i] = startPos;
  st.asset[i] = asset;
  st.group[i] = p.mode === 'pads' && p.chokeSize > 0 ? Math.floor(padIdx / p.chokeSize) : -1;
  st.pos[i] = rev ? endPos - 1 : startPos;
  st.rate[i] = rev ? -rate : rate;
  st.end[i] = endPos;
  st.looping[i] = p.mode === 'gated' && p.loop && !rev ? 1 : 0;
  st.loopS[i] = Math.min(endPos - 1, Math.max(a, Math.round(p.loopStart * sr)));
  st.loopE[i] = p.loopEnd > 0 ? Math.min(endPos, Math.round(p.loopEnd * sr)) : endPos;
  if (st.loopE[i] <= st.loopS[i] + 1) st.looping[i] = 0;
  st.shot[i] = p.mode === 'oneshot' || p.mode === 'pads' ? 1 : 0;
  st.done[i] = 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function render(st: any, p: any, sr: number, ol: Float32Array, or: Float32Array, s0: number, s1: number): void {
  const v = st.v;
  const atkInc = 1 / Math.max(1, (p.attack / 1000) * sr);
  const decC = expCoef(p.decay / 1000, sr);
  const relC = expCoef(p.release / 1000, sr);
  const [pl, pr] = panGains(p.pan);
  const gl = dbToLin(p.gain) * pl * Math.SQRT2;
  const gr = dbToLin(p.gain) * pr * Math.SQRT2;
  for (let i = 0; i < v.n; i++) {
    if (v.stage[i] === 0) continue;
    const asset: AudioAsset | null = st.asset[i];
    if (!asset) {
      v.stage[i] = 0;
      continue;
    }
    const L = asset.left;
    const R = asset.right;
    const last = asset.frames - 1;
    const rv = st.rev[i] === 1;
    const lo = st.lo[i];
    let pos = st.pos[i];
    const rate = st.rate[i];
    const endPos = st.end[i];
    const looping = st.looping[i] === 1;
    for (let k = s0; k < s1; k++) {
      const e = adsrStep(v, i, atkInc, decC, p.sustain, relC);
      if (v.stage[i] === 0) break;
      if (!st.done[i]) {
        if (rv ? pos < lo : pos >= endPos) {
          if (looping) pos = st.loopS[i] + ((pos - st.loopS[i]) % (st.loopE[i] - st.loopS[i]));
          else {
            st.done[i] = 1;
            if (v.stage[i] !== 3) v.stage[i] = 3; // ran off the end: fade out
          }
        }
        if (looping && pos >= st.loopE[i]) pos = st.loopS[i] + ((pos - st.loopS[i]) % (st.loopE[i] - st.loopS[i]));
      }
      if (st.done[i]) continue;
      const i1 = Math.max(0, Math.min(last, Math.floor(pos)));
      const t = pos - i1;
      const i0 = i1 > 0 ? i1 - 1 : 0;
      const i2 = Math.min(last, i1 + 1);
      const i3 = Math.min(last, i1 + 2);
      // 4-point Hermite
      const c1l = 0.5 * (L[i2] - L[i0]);
      const c2l = L[i0] - 2.5 * L[i1] + 2 * L[i2] - 0.5 * L[i3];
      const c3l = 0.5 * (L[i3] - L[i0]) + 1.5 * (L[i1] - L[i2]);
      const c1r = 0.5 * (R[i2] - R[i0]);
      const c2r = R[i0] - 2.5 * R[i1] + 2 * R[i2] - 0.5 * R[i3];
      const c3r = 0.5 * (R[i3] - R[i0]) + 1.5 * (R[i1] - R[i2]);
      const sl = ((c3l * t + c2l) * t + c1l) * t + L[i1];
      const sr_ = ((c3r * t + c2r) * t + c1r) * t + R[i1];
      const a = e * v.vel[i];
      ol[k] += sl * a * gl;
      or[k] += sr_ * a * gr;
      pos += rate;
    }
    st.pos[i] = pos;
  }
}
