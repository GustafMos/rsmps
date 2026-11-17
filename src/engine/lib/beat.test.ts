import { describe, expect, it } from 'vitest';
import { analyzeTrack, fftInPlace, makeFft, FluxExtractor } from './beat';
import { BeatLive } from './beat-live';
import { asAnalysis, gridAt, lastEvent, pulse, regularPeriod, type GridParams, type GridPos } from './beat-grid';
import { BSR, addKick, clickTrack, drumPattern, matchErrors } from './beat-testutil';

const ms = (x: number) => x * 1000;
const maxErr = (a: number[], b: number[]) => Math.max(...matchErrors(a, b));
const G: GridParams = { offset: 0, bpmOverride: 0, half: false, double: false, snap: false, loop: false, duration: 0 };

function runLive(audio: Float32Array, block = 128): BeatLive {
  const live = new BeatLive(BSR, { sensitivity: 0.5, minGapMs: 70 });
  for (let i = 0; i < audio.length; i += block) live.push(audio, i, Math.min(audio.length, i + block));
  return live;
}

describe('FFT', () => {
  it('puts a sine in the right bin and matches a naive DFT', () => {
    const n = 256;
    const f = makeFft(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 20 * i) / n) + 0.3 * Math.cos((2 * Math.PI * 7 * i) / n);
    const copy = Float64Array.from(re);
    fftInPlace(f, re, im);
    expect(Math.hypot(re[20], im[20])).toBeCloseTo(n / 2, 4);
    expect(Math.hypot(re[7], im[7])).toBeCloseTo(0.3 * (n / 2), 4);
    let nr = 0;
    let ni = 0;
    for (let i = 0; i < n; i++) {
      nr += copy[i] * Math.cos((2 * Math.PI * 7 * i) / n);
      ni -= copy[i] * Math.sin((2 * Math.PI * 7 * i) / n);
    }
    expect(re[7]).toBeCloseTo(nr, 6);
    expect(im[7]).toBeCloseTo(ni, 6);
  });
});

describe('offline analysis (click tracks)', () => {
  for (const bpm of [90, 120, 140]) {
    it(`finds ${bpm} BPM and every click within 15 ms`, () => {
      const t = clickTrack(bpm, 20, 0);
      const a = analyzeTrack(t.audio, BSR);
      expect(Math.abs(a.bpm - bpm)).toBeLessThan(1);
      expect(a.onsets.length).toBe(t.times.length);
      expect(ms(maxErr(t.times, a.onsets))).toBeLessThan(15);
      expect(ms(maxErr(t.times, a.beats))).toBeLessThan(15);
    });
  }
  it('survives +-12 ms of jitter on the clicks', () => {
    for (const bpm of [90, 120, 140]) {
      const t = clickTrack(bpm, 24, 12);
      const a = analyzeTrack(t.audio, BSR);
      expect(Math.abs(a.bpm - bpm)).toBeLessThan(1);
      expect(ms(maxErr(t.times, a.onsets))).toBeLessThan(15);
      // the grid follows the average, not each jittered click
      expect(ms(maxErr(t.times, a.beats))).toBeLessThan(30);
    }
  });
  it('timing bias of detected onsets is under 5 ms', () => {
    const t = clickTrack(120, 12, 0);
    const a = analyzeTrack(t.audio, BSR);
    const d = a.onsets.map((o, i) => o - t.times[i]);
    const mean = d.reduce((s, x) => s + x, 0) / d.length;
    expect(Math.abs(ms(mean))).toBeLessThan(5);
  });
  it('is deterministic', () => {
    const t = clickTrack(120, 8, 8);
    expect(analyzeTrack(t.audio, BSR)).toEqual(analyzeTrack(t.audio, BSR));
  });
});

describe('false positives', () => {
  it('silence, a steady tone and very quiet noise give no onsets and no tempo', () => {
    const sec = 8;
    const silence = new Float32Array(sec * BSR);
    const tone = silence.map((_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / BSR));
    const hiss = silence.map((_, i) => 1e-4 * Math.sin(i * 12.9898) * Math.cos(i * 78.233));
    for (const x of [silence, tone, hiss]) {
      const a = analyzeTrack(x, BSR);
      // a tone that starts at sample 0 has one real attack at the very beginning; nothing after it
      expect(a.onsets.filter((o) => o > 0.15).length).toBe(0);
      expect(a.beats.length).toBe(0);
      expect(a.bpm).toBe(0);
      const live = runLive(x);
      expect(live.ev[0]).toBeLessThan(0.15);
      expect(live.locked).toBe(false);
    }
  });
});

describe('bands', () => {
  it('kick, snare and hat onsets land on their drums; hats never fire the kick band', () => {
    const d = drumPattern(120, 8);
    const a = analyzeTrack(d.audio, BSR);
    expect(Math.abs(a.bpm - 120)).toBeLessThan(1);
    expect(ms(maxErr(d.kick, a.kick))).toBeLessThan(15);
    expect(ms(maxErr(d.snare, a.snare))).toBeLessThan(15);
    expect(ms(maxErr(d.hat, a.hat))).toBeLessThan(15);
    // the tracked beats sit on the kick / snare beats, not on the off-beat hats
    expect(ms(maxErr(d.beats, a.beats))).toBeLessThan(25);
    expect(a.beats.length).toBeGreaterThanOrEqual(d.beats.length - 1);
    // no kick-band onset near a hat that is not also a kick or snare (the off-beat eighths)
    const offHats = d.hat.filter((_, i) => i % 2 === 1);
    for (const h of offHats) expect(a.kick.some((k) => Math.abs(k - h) < 0.03)).toBe(false);
    // and no hat-only events between the true ones
    const stray = a.hat.filter((h) => Math.min(...d.hat.map((x) => Math.abs(x - h))) > 0.03);
    expect(stray.length).toBe(0);
    // every snare is a snare event, and the snare band stays quiet on kicks
    expect(a.snare.length).toBe(d.snare.length);
    for (const k of d.kick) expect(a.snare.some((s) => Math.abs(s - k) < 0.03)).toBe(false);
  });
  it('a kick alone makes a kick onset for every hit and fewer hat onsets', () => {
    const x = new Float32Array(BSR * 6);
    for (let i = 0; i < 8; i++) addKick(x, Math.round((0.3 + i * 0.6) * BSR));
    const a = analyzeTrack(x, BSR);
    expect(a.kick.length).toBe(8);
    // a bare kick's click leaks into the hat band now and then, but far less than the kick itself fires
    expect(a.hat.length).toBeLessThan(a.kick.length);
  });
});

describe('live (causal) detector', () => {
  it('locks to 90 / 120 / 140 BPM on a click track within 1 BPM and beats stay on the clicks', () => {
    for (const bpm of [90, 120, 140]) {
      const t = clickTrack(bpm, 24, 0);
      const live = runLive(t.audio);
      expect(live.locked).toBe(true);
      expect(Math.abs(live.bpm - bpm)).toBeLessThan(1);
      // phase: the latest beat on the grid is within 15 ms of a click
      const near = Math.min(...t.times.map((x) => Math.abs(x - live.lastBeat)));
      expect(ms(near)).toBeLessThan(15);
    }
  });
  it('onsets arrive within 15 ms of the click and within one frame of real time', () => {
    const t = clickTrack(120, 10, 0);
    const live = new BeatLive(BSR, { sensitivity: 0.5, minGapMs: 70 });
    const seen: { at: number; t: number }[] = [];
    let last = 0;
    for (let i = 0; i < t.audio.length; i += 128) {
      live.push(t.audio, i, Math.min(t.audio.length, i + 128));
      if (live.evCount[0] > last) {
        last = live.evCount[0];
        seen.push({ at: live.now, t: live.ev[0] });
      }
    }
    expect(seen.length).toBe(t.times.length);
    expect(ms(maxErr(t.times, seen.map((s) => s.t)))).toBeLessThan(15);
    // detection delay (time between the click and the block that reported it)
    const lat = seen.map((s, i) => s.at - t.times[i]);
    expect(ms(Math.max(...lat))).toBeLessThan(50);
  });
  it('tracks the drum pattern: tempo, kick and hat counts', () => {
    const d = drumPattern(120, 12);
    const live = runLive(d.audio);
    expect(Math.abs(live.bpm - 120)).toBeLessThan(1);
    expect(live.evCount[3]).toBeGreaterThanOrEqual(d.hat.length - 2);
    expect(live.evCount[1]).toBeGreaterThanOrEqual(d.kick.length - 2);
    // the predicted grid sits on the drum beats, not on the off-beat hats
    const rel = (live.lastBeat - d.beats[0]) / 0.5;
    expect(ms(Math.abs(rel - Math.round(rel)) * 0.5)).toBeLessThan(25);
  });
  it('block size does not change the result', () => {
    const t = clickTrack(120, 12, 5);
    const a = runLive(t.audio, 128);
    const b = runLive(t.audio, 480);
    expect(a.evCount[0]).toBe(b.evCount[0]);
    expect(a.bpm).toBeCloseTo(b.bpm, 6);
  });
});

describe('beat grid', () => {
  const an = () => analyzeTrack(clickTrack(120, 16, 0).audio, BSR);
  const pos = (g: GridParams, t: number): GridPos => {
    const out: GridPos = { index: 0, phase: 0, period: 0, time: 0 };
    gridAt(an(), g, t, out);
    return out;
  };
  it('reports index and phase, and offset shifts the beats', () => {
    const a = an();
    const p = pos(G, a.beats[4] + 0.25);
    expect(p.index).toBe(4);
    expect(p.phase).toBeCloseTo(0.5, 1);
    const q = pos({ ...G, offset: 0.1 }, a.beats[4] + 0.25);
    expect(q.phase).toBeCloseTo(0.3, 1);
  });
  it('double and half time change the beat rate', () => {
    const a = an();
    const t = a.beats[6] + 0.01;
    expect(pos({ ...G, double: true }, t).period).toBeCloseTo(0.25, 2);
    expect(pos({ ...G, half: true }, t).period).toBeCloseTo(1, 2);
    expect(pos({ ...G, double: true }, a.beats[6] + 0.01).index).toBe(12);
  });
  it('bpmOverride makes a regular grid; snap divides a loop that nearly fits', () => {
    const a = an();
    expect(regularPeriod(a, { ...G, bpmOverride: 100 })).toBeCloseTo(0.6, 6);
    expect(regularPeriod(a, G)).toBe(0);
    const snapped = regularPeriod(a, { ...G, snap: true, loop: true, duration: 8.04 });
    expect(snapped * 16).toBeCloseTo(8.04, 6); // 16 beats of ~0.5025 s
    const far = regularPeriod(a, { ...G, snap: true, loop: true, duration: 8.25 });
    expect(far).toBeCloseTo(60 / a.bpm, 6); // 8.25 s is 16.5 beats: too far from a whole number, left alone
    expect(regularPeriod(a, { ...G, snap: true, loop: false, duration: 8.04 })).toBeCloseTo(60 / a.bpm, 6);
  });
  it('pulse, last-event lookup and stored-analysis validation', () => {
    expect(pulse(0, 0.2)).toBe(1);
    expect(pulse(0.2, 0.2)).toBeCloseTo(Math.exp(-3), 6);
    expect(pulse(-0.1, 0.2)).toBe(0);
    expect(pulse(5, 0.2)).toBe(0);
    expect(lastEvent([1, 2, 3], 2.5, 0)).toBe(2);
    expect(lastEvent([1, 2, 3], 2.5, 0.6)).toBe(1.6);
    expect(lastEvent([1, 2, 3], 0.5, 0)).toBe(-Infinity);
    expect(asAnalysis(null)).toBeNull();
    expect(asAnalysis({ version: 2 })).toBeNull();
    expect(asAnalysis({ grid: an() })).not.toBeNull();
  });
  it('FluxExtractor frame timing: hop is a quarter window', () => {
    const fx = new FluxExtractor(BSR, () => undefined);
    expect(fx.hop * 4).toBe(fx.size);
  });
});
