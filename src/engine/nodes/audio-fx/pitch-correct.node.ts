import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin, midiToHz } from '../../audio/dsp';
import { makePitchTracker, pitchPush } from '../../audio/pitch-tracker';
import { KEY_OPTIONS, SCALE_OPTIONS, snapToScale } from '../../audio/scales';

const RING = 16384; // samples of input and output kept (power of two)
const MASK = RING - 1;
const LOW_NOTE = 36; // C2, 65 Hz: the lowest voice the effect follows
const HIGH_NOTE = 88; // E6
const HOLD_HOPS = 4; // pitch analyses (10 ms each) the last pitch is kept through a consonant

/**
 * Pitch correction for a single voice or instrument ("auto-tune"): hears which note is sung, moves it onto the nearest
 * note of a scale, and keeps the character of the voice.
 *
 * How: the pitch tracker (same one as Audio to MIDI) gives the sung pitch every 10 ms. The sound is rebuilt from short
 * pieces, each two periods of the voice long (pitch-synchronous overlap-add): the pieces are cut one period apart, so they
 * are copies of the same wave, and laid down closer together (higher) or further apart (lower). Because each piece is the
 * voice's own wave, the vowel (formants) stays the same: no chipmunk effect, unlike a plain pitch shifter. Sound without a
 * pitch (consonants, breath, noise) is laid down as it came, so it passes unchanged.
 *
 * The correction in semitones is smoothed by `speed`: 0 snaps at once (the hard, robotic sound), slower lets vibrato and
 * slides through and only pulls the note's centre in tune.
 * Latency: 2.75 periods of the lowest note (about 45 ms) plus 30 ms so the pitch reading has caught up with the sound it
 * corrects ("Low delay" drops the 30 ms). The dry signal is delayed the same, so Mix stays in phase.
 */
export default defineNode({
  id: 'pitch-correct',
  title: 'Pitch Correct',
  category: 'audio-fx',
  description: 'Tunes a voice or a single instrument to the nearest note of a scale, from gentle correction to the hard robotic effect. Keeps the character of the voice.',
  keywords: ['autotune', 'auto-tune', 'auto tune', 'tune', 'retune', 'vocal', 'voice', 'singing', 'pitch correction', 'in tune', 't-pain', 'robot voice', 'harmony', 'formant'],
  inputs: { audio: { type: 'audio', required: true, label: 'Audio' } },
  outputs: { audio: { type: 'audio', label: 'Audio' } },
  params: {
    scale: { type: 'enum', default: 'off', options: SCALE_OPTIONS.map((o) => (o.value === 'off' ? { value: 'off', label: 'All notes' } : o)), label: 'Scale', hint: 'The notes the voice is moved onto. All notes = the nearest semitone.' },
    key: { type: 'enum', default: '0', options: KEY_OPTIONS, label: 'Key', visibleIf: (p) => p.scale !== 'off' },
    speed: { type: 'number', default: 60, min: 0, max: 500, step: 1, label: 'Retune ms', hint: 'How quickly a note is pulled in tune. 0 snaps at once: the hard, robotic effect. 50 to 150 sounds natural and keeps vibrato.' },
    amount: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Amount', hint: 'How much of the correction is applied. 0 leaves the pitch as sung.' },
    shift: { type: 'number', default: 0, min: -12, max: 12, step: 1, integer: true, unit: 'st', label: 'Shift', hint: 'Move the whole voice up or down in semitones after tuning. The voice keeps its character (no chipmunk).' },
    gate: { type: 'number', default: -50, min: -80, max: -10, step: 0.5, unit: 'db', label: 'Gate level', hint: 'Sound quieter than this is not tuned.' },
    lowDelay: { type: 'bool', default: false, label: 'Low delay', hint: 'For singing live with headphones: the sound comes back about 30 ms sooner (45 instead of 75 ms). Tuning of fast notes and vibrato is a little looser.' },
    mix: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Mix', hint: 'Below 1 the untuned voice is heard too: a doubling effect.' },
  },
  summary: (p) => `${p.scale === 'off' ? 'all notes' : `${KEY_OPTIONS[Number(p.key)]?.label ?? 'C'} ${p.scale}`} · ${p.speed} ms${p.shift ? ` · ${p.shift > 0 ? '+' : ''}${p.shift} st` : ''}`,
  audio: defineAudio({
    create: (ctx) => {
      const maxPeriod = ctx.sampleRate / midiToHz(LOW_NOTE);
      return {
        tracker: makePitchTracker(ctx.sampleRate),
        inL: new Float32Array(RING),
        inR: new Float32Array(RING),
        outL: new Float32Array(RING),
        outR: new Float32Array(RING),
        /** Samples processed so far (the write position of the input and the read position of the output). */
        n: 0,
        /** Fixed delay between input and output, samples. */
        delay: Math.ceil(2.75 * maxPeriod) + 2,
        /** How far behind the newest sound the pitch reading is (half its window plus the median), samples. */
        look: Math.round(ctx.sampleRate * 0.03),
        envIn: 0,
        envOut: 0,
        gain: 1,
        maxPeriod,
        /** Period of the unpitched lay-down, samples (8 ms). */
        restPeriod: Math.round(ctx.sampleRate * 0.008),
        /** Centre of the next output piece (output time, samples). */
        oNext: 0,
        /** Centre of the last input piece (input time, samples). */
        mark: 0,
        /** Sung pitch as a fractional MIDI note, -1 when there is none. */
        note: -1,
        prev0: -1,
        prev1: -1,
        hold: 0,
        /** The scale note the voice is being moved to, -1 when none. */
        target: -1,
        /** Smoothed correction in semitones. */
        corr: 0,
        started: false,
      };
    },
    process(st, io) {
      const src = io.in.audio;
      if (!src) return;
      const p = io.params;
      const n = io.frames;
      const sr = io.sampleRate;
      const [ol, or] = io.out.audio;
      const gateLin = dbToLin(p.gate);
      const key = Number(p.key);
      const mix = p.mix as number;
      const amount = p.amount as number;
      // per pitch analysis (10 ms): how far the smoothed correction moves toward the wanted one
      const k = p.speed <= 0 ? 1 : 1 - Math.exp(-10 / p.speed);
      // Normally each piece waits until the pitch reading has caught up with it, so the correction fits the sound it is
      // applied to. Low delay skips the wait.
      const look = p.lowDelay ? 0 : st.look;
      const delay = st.delay + look;
      const envK = 1 - Math.exp(-1 / (0.03 * sr));
      for (let i = 0; i < n; i++) {
        const xl = src[0][i];
        const xr = src[1][i];
        const at = st.n & MASK;
        st.inL[at] = xl;
        st.inR[at] = xr;

        // 1. The sung pitch (every 10 ms), a median of three so one wrong estimate does not yank the voice.
        if (pitchPush(st.tracker, (xl + xr) * 0.5, LOW_NOTE, HIGH_NOTE, gateLin, 0.8)) {
          const raw = st.tracker.note;
          if (raw >= 0) {
            const a = st.prev0;
            const b = st.prev1;
            st.prev0 = b < 0 ? raw : b;
            st.prev1 = raw;
            st.note = a < 0 || b < 0 ? raw : Math.max(Math.min(a, b), Math.min(Math.max(a, b), raw));
            st.hold = HOLD_HOPS;
            // The note to tune to changes only when the voice is clearly nearer another one (no flicker halfway between two).
            const snapped = p.scale === 'off' ? Math.round(st.note) : snapToScale(st.note, p.scale as string, key);
            if (st.target < 0 || (snapped !== st.target && Math.abs(st.note - snapped) + 0.2 < Math.abs(st.note - st.target))) st.target = snapped;
            st.corr += ((st.target - st.note) * amount - st.corr) * k;
          } else if (st.hold > 0) st.hold--;
          else {
            st.note = -1;
            st.target = -1;
            st.prev0 = -1;
            st.prev1 = -1;
            st.corr *= 0.5;
          }
        }

        // 2. Lay down every piece whose centre is close enough to need its input by now.
        const voiced = st.note >= 0;
        const period = voiced ? Math.min(st.maxPeriod, sr / midiToHz(st.note)) : st.restPeriod;
        const ratio = voiced ? Math.pow(2, (st.corr + p.shift) / 12) : 1;
        if (!st.started) {
          st.started = true;
          st.oNext = st.n + delay;
          st.mark = st.n;
        }
        while (st.oNext <= st.n + st.delay - 1.6 * period) { // (the piece reads sound `look` older than the newest)
          // where this piece would come from if nothing were moved; then the nearest point a whole number of periods
          // from the last piece, so consecutive pieces are copies of the same wave
          const want = st.oNext - delay;
          if (voiced) st.mark += Math.round((want - st.mark) / period) * period;
          else st.mark = want;
          const half = Math.max(2, Math.ceil(period));
          // The piece sits on whole output samples; what it reads and its window are shifted by the same fraction,
          // so the spacing of the pieces is exact (no half-sample jitter, which would be heard as roughness).
          const centreOut = Math.round(st.oNext);
          const d = centreOut - st.oNext;
          const pos = st.mark + d;
          const m0 = Math.floor(pos);
          const fr = pos - m0;
          for (let j = -half; j <= half; j++) {
            const w = 0.5 + 0.5 * Math.cos((Math.PI * (j + d)) / period);
            if (Math.abs(j + d) >= period) continue;
            const a = (m0 + j) & MASK;
            const b = (m0 + j + 1) & MASK;
            const o = (centreOut + j) & MASK;
            st.outL[o] += (st.inL[a] + (st.inL[b] - st.inL[a]) * fr) * w;
            st.outR[o] += (st.inR[a] + (st.inR[b] - st.inR[a]) * fr) * w;
          }
          st.oNext += period / ratio;
        }

        // 3. Read the finished output; the dry voice is delayed by the same amount so Mix stays in phase.
        const dry = (st.n - delay) & MASK;
        const dl = st.n >= delay ? st.inL[dry] : 0;
        const dr = st.n >= delay ? st.inR[dry] : 0;
        // Pieces of a moved voice do not add up to the level they were cut from (closer together is not simply louder):
        // the tuned voice follows the level of the untuned one.
        const wl = st.outL[at];
        const wr = st.outR[at];
        st.envIn += (dl * dl + dr * dr - st.envIn) * envK;
        st.envOut += (wl * wl + wr * wr - st.envOut) * envK;
        const wantGain = st.envOut > 1e-9 && st.envIn > 1e-9 ? Math.min(3, Math.max(0.5, Math.sqrt(st.envIn / st.envOut))) : 1;
        st.gain += (wantGain - st.gain) * envK;
        ol[i] = wl * st.gain * mix + dl * (1 - mix);
        or[i] = wr * st.gain * mix + dr * (1 - mix);
        st.outL[at] = 0;
        st.outR[at] = 0;
        st.n++;
      }
    },
  }),
});
