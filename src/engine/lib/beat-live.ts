/**
 * Causal beat detector for live input (microphone, phone audio) and for audio whose file is not analysed (pure, no imports but beat.ts).
 * Everything is allocated in the constructor; `push` never allocates.
 */
import { FluxExtractor, OnsetPicker, acLagRange, estimateTempo, fitGrid, pickerOpts, BAND_REL, type FluxFrame, type GridFit, type TempoEstimate } from './beat';

export interface LiveOptions {
  sensitivity: number;
  minGapMs: number;
}

const ENV_SECONDS = 8;
const ONSET_RING = 96;
const UPDATE_SECONDS = 0.5;
const STREAMS = 5; // all, low (kick), mid (snare), high (hat), and the equal-band stream tempo and phase are fitted on

export class BeatLive {
  readonly fx: FluxExtractor;
  private pickers: OnsetPicker[] = [];
  /** Last two event times per stream (seconds of the input clock): [stream*2] newest, [stream*2+1] the one before. */
  readonly ev = new Float64Array(STREAMS * 2).fill(-1e9);
  /** Counts of detected events per stream. */
  readonly evCount = new Int32Array(STREAMS);
  /** Input-clock time at which the newest event of each stream was DETECTED (pulses start here, so they jump to full height when the hit is reported). */
  readonly evSeen = new Float64Array(STREAMS).fill(-1e9);
  /** Same for the event before it. */
  readonly evSeenPrev = new Float64Array(STREAMS).fill(-1e9);
  /** Seconds of input seen. */
  now = 0;
  samples = 0;
  /** Smoothed RMS (linear). */
  level = 0;
  private relCoef: number;
  private env: Float32Array;
  private envLin: Float32Array;
  private envN = 0;
  private ac: Float64Array;
  private onsetT = new Float64Array(ONSET_RING);
  private onsetW = new Float64Array(ONSET_RING);
  private onsetN = 0;
  private fitT = new Float64Array(ONSET_RING);
  private fitW = new Float64Array(ONSET_RING);
  private updateEvery: number;
  private sinceUpdate = 0;
  private est: TempoEstimate = { bpm: 0, conf: 0 };
  private fit: GridFit = { period: 0, phase: 0, strength: 0, beatness: 0 };
  /** Running loudest onset strength (weights are relative to it). */
  private refStrength = 1;
  private weak = 0;
  private strong = 0;
  /** Tempo lock. */
  locked = false;
  period = 0.5;
  /** Time of one beat of the live grid. */
  beatRef = 0;
  /** Concentration of recent onsets on the grid (0..1). */
  quality = 0;
  /** Beats counted since the first lock. */
  beatCount = 0;
  /** Time of the latest beat on the grid (<= now), and the one before. */
  lastBeat = -1e9;
  prevBeat = -1e9;
  private lastIdx = 0;
  private haveIdx = false;
  /** Grid shift in seconds (applied to beats; may be negative: the grid is predicted). */
  gridOffset = 0;

  constructor(readonly sampleRate: number, opts: LiveOptions) {
    this.fx = new FluxExtractor(sampleRate, (f: FluxFrame) => this.onFrame(f));
    const hop = this.fx.hopSec;
    const mk = (stream: number, minGap: number, delta: number, rel: number) =>
      new OnsetPicker(pickerOpts(hop, opts.sensitivity, false, minGap, delta, rel), (fr, strength) => this.onOnset(stream, fr, strength));
    this.pickers.push(mk(0, opts.minGapMs, 1, 0.12), mk(1, Math.max(opts.minGapMs, 120), 0.5, BAND_REL), mk(2, Math.max(opts.minGapMs, 120), 0.5, BAND_REL), mk(3, Math.min(opts.minGapMs, 50), 0.5, BAND_REL), mk(4, opts.minGapMs, 1, 0.12));
    const n = Math.ceil(ENV_SECONDS / hop);
    this.env = new Float32Array(n);
    this.envLin = new Float32Array(n);
    this.ac = new Float64Array(acLagRange(hop).max + 4);
    this.updateEvery = Math.round(UPDATE_SECONDS / hop);
    this.relCoef = 1 - Math.exp(-hop / 0.15);
  }

  reset(): void {
    this.fx.reset();
    for (const p of this.pickers) p.reset();
    this.ev.fill(-1e9);
    this.evSeen.fill(-1e9);
    this.evSeenPrev.fill(-1e9);
    this.evCount.fill(0);
    this.now = 0;
    this.samples = 0;
    this.level = 0;
    this.env.fill(0);
    this.envN = 0;
    this.onsetN = 0;
    this.sinceUpdate = 0;
    this.weak = 0;
    this.strong = 0;
    this.locked = false;
    this.quality = 0;
    this.beatCount = 0;
    this.lastBeat = this.prevBeat = -1e9;
    this.haveIdx = false;
    this.refStrength = 1;
  }

  private onFrame(f: FluxFrame): void {
    this.env[this.envN % this.env.length] = f.eq;
    this.envN++;
    const p = this.pickers;
    p[0].push(f.total);
    p[1].push(f.low);
    p[2].push(f.mid);
    p[3].push(f.high);
    p[4].push(f.eq);
    this.level += (f.rms - this.level) * (f.rms > this.level ? 1 : this.relCoef);
    if (++this.sinceUpdate >= this.updateEvery) {
      this.sinceUpdate = 0;
      this.updateTempo();
    }
  }

  private onOnset(stream: number, frame: number, strength: number): void {
    const t = this.fx.onsetTime(frame);
    const i = stream * 2;
    this.ev[i + 1] = this.ev[i];
    this.ev[i] = t;
    this.evSeenPrev[stream] = this.evSeen[stream];
    this.evSeen[stream] = this.now;
    this.evCount[stream]++;
    if (stream === 4) {
      const k = this.onsetN % ONSET_RING;
      this.onsetT[k] = t;
      this.refStrength = Math.max(strength, this.refStrength * 0.999);
      this.onsetW[k] = Math.max(0.05, strength / this.refStrength);
      this.onsetN++;
    }
  }

  private updateTempo(): void {
    const len = this.env.length;
    const count = Math.min(this.envN, len);
    if (count < acLagRange(this.fx.hopSec).max * 2.2) return;
    const start = this.envN > len ? this.envN % len : 0;
    for (let i = 0; i < count; i++) this.envLin[i] = this.env[(start + i) % len];
    if (!estimateTempo(this.envLin, 0, count, this.fx.hopSec, this.ac, this.est)) return this.noteWeak();
    const have = Math.min(this.onsetN, ONSET_RING);
    let m = 0;
    const tMin = this.now - ENV_SECONDS;
    for (let i = 0; i < have; i++) {
      const k = (this.onsetN - have + i) % ONSET_RING;
      if (this.onsetT[k] >= tMin) {
        this.fitT[m] = this.onsetT[k];
        this.fitW[m] = this.onsetW[k];
        m++;
      }
    }
    const spread = this.locked ? 0.03 : 0.04;
    const keep = this.locked && this.est.bpm > 0 && Math.abs(60 / this.period / this.est.bpm - 1) < 0.08;
    const bpm0 = keep ? 60 / this.period : this.est.bpm;
    if (!fitGrid(this.fitT, this.fitW, m, bpm0, this.fit, spread)) return this.noteWeak();
    this.quality = this.fit.strength;
    if (this.fit.strength < 0.45) return this.noteWeak();
    this.weak = 0;
    const T = this.fit.period;
    const nearBeat = this.fit.phase + Math.floor((this.now - this.fit.phase) / T) * T;
    if (!this.locked) {
      if (++this.strong < 2) return; // two good estimates in a row
      this.locked = true;
      this.period = T;
      this.beatRef = nearBeat;
      this.haveIdx = false;
      return;
    }
    if (Math.abs(T / this.period - 1) > 0.06) {
      // a different tempo: take it only when it stays
      if (++this.strong < 4) return;
      this.period = T;
      this.beatRef = nearBeat;
      this.haveIdx = false;
      this.strong = 2;
      return;
    }
    this.strong = 2;
    this.period += (T - this.period) * 0.35;
    let err = nearBeat - this.beatRef;
    err -= Math.round(err / this.period) * this.period;
    this.beatRef += err * 0.35;
  }

  private noteWeak(): void {
    this.strong = 0;
    if (++this.weak >= 8) {
      this.locked = false;
      this.haveIdx = false;
    }
  }

  push(x: ArrayLike<number>, from: number, to: number): void {
    this.fx.push(x, from, to);
    this.samples += to - from;
    this.now = this.samples / this.sampleRate;
    this.advanceGrid();
  }

  private advanceGrid(): void {
    if (!this.locked) return;
    const x = (this.now - this.beatRef - this.gridOffset) / this.period;
    const idx = Math.floor(x);
    if (!this.haveIdx) {
      this.haveIdx = true;
      this.lastIdx = idx;
      this.lastBeat = this.beatRef + this.gridOffset + idx * this.period;
      return;
    }
    if (idx > this.lastIdx) {
      this.beatCount += 1;
      this.prevBeat = this.lastBeat;
      this.lastBeat = this.beatRef + this.gridOffset + idx * this.period;
    }
    this.lastIdx = idx;
  }

  /** 0..1 through the current beat (0 when not locked). */
  get phase(): number {
    if (!this.locked) return 0;
    const x = (this.now - this.beatRef - this.gridOffset) / this.period;
    return x - Math.floor(x);
  }

  get bpm(): number {
    return this.locked ? 60 / this.period : 0;
  }
}
