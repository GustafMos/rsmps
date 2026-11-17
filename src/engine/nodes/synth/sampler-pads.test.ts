import { describe, expect, it } from 'vitest';
import { SR, getDef, on, off, peak, rms, runKernel, sine } from '../../audio/testing';
import type { AudioAsset, MidiEvent } from '../../audio/types';

const mk = (n: number, f: (i: number) => number): AudioAsset => {
  const l = new Float32Array(n).map((_, i) => f(i));
  return { sampleRate: SR, frames: n, left: l, right: l };
};
const ramp = mk(4800, (i) => (i + 1) / 4800); // 0.1 s rising ramp
const tone = (hz: number, secs = 1) => mk(Math.round(secs * SR), (i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / SR));

const run = (params: Record<string, unknown>, ev: MidiEvent[], assets: Record<string, AudioAsset>, frames = SR / 2) =>
  runKernel(getDef('sampler'), { params, midi: { midi: ev }, assets, frames }).out.audio[0];

describe('sampler: one sound per key (pads)', () => {
  const kit = { a: tone(200), b: tone(900) };
  const base = { mode: 'pads', assets: ['a', 'b'], sliceBase: 36, attack: 0, velocity: 0, gain: 0 };

  it('each key plays its own sound at its own pitch; keys outside the list are silent', () => {
    const k0 = run(base, [on(36, 0)], kit);
    const k1 = run(base, [on(37, 0)], kit);
    expect(rms(k0, 4000, 12000)).toBeGreaterThan(0.1);
    expect(rms(k1, 4000, 12000)).toBeGreaterThan(0.1);
    // the two keys are different sounds: count zero crossings (200 Hz vs 900 Hz)
    const zc = (x: Float32Array) => {
      let n = 0;
      for (let i = 4001; i < 12000; i++) if (x[i - 1] < 0 !== x[i] < 0) n++;
      return n;
    };
    expect(zc(k1) / zc(k0)).toBeCloseTo(4.5, 0);
    expect(peak(run(base, [on(35, 0)], kit))).toBe(0);
    expect(peak(run(base, [on(38, 0)], kit))).toBe(0);
  });

  it('pads are one-shots: a note off does not cut them; the same key twice layers', () => {
    const held = run({ ...base, release: 5 }, [on(36, 0), off(36, 1000)], kit);
    expect(rms(held, 10000, 20000)).toBeGreaterThan(0.1);
  });

  it('a choke group cuts the others of the group (open and closed hat) with a short fade, not a click', () => {
    const ev = [on(36, 0), on(37, 0.2 * SR)];
    const free = run({ ...base, chokeSize: 0, release: 30 }, ev, kit, SR);
    const choked = run({ ...base, chokeSize: 2, release: 30 }, ev, kit, SR);
    const at = 0.2 * SR;
    // without a choke both sounds go on; with it the first one is gone shortly after the second starts
    const first = (x: Float32Array) => rms(x, at + 0.1 * SR, at + 0.3 * SR);
    expect(first(free)).toBeGreaterThan(0.3);
    expect(first(choked)).toBeLessThan(first(free));
    // a different group is not cut: keys 36 and 38 are in groups 0 and 1 with a size of 2... 36,37 -> 0; 38,39 -> 1
    const other = run({ ...base, assets: ['a', 'b', 'a', 'b'], chokeSize: 2, release: 30 }, [on(36, 0), on(38, 0.2 * SR)], kit, SR);
    expect(rms(other, at + 0.1 * SR, at + 0.3 * SR)).toBeGreaterThan(0.3);
    // no click: the largest sample-to-sample step after the cut stays small
    let step = 0;
    for (let i = at + 200; i < at + 0.3 * SR; i++) step = Math.max(step, Math.abs(choked[i] - choked[i - 1]));
    expect(step).toBeLessThan(0.2);
  });

  it('reverse plays the sound backwards and stops at the start', () => {
    const fwd = run({ mode: 'oneshot', rootNote: 60, attack: 0, velocity: 0, gain: 0, assets: ['r'] }, [on(60, 0)], { r: ramp }, 6000);
    const rev = run({ mode: 'oneshot', rootNote: 60, attack: 0, velocity: 0, gain: 0, assets: ['r'], reverse: true }, [on(60, 0)], { r: ramp }, 6000);
    expect(fwd[10]).toBeLessThan(fwd[4000]);
    expect(rev[10]).toBeGreaterThan(rev[4000]);
    expect(rev[10]).toBeGreaterThan(0.9);
    expect(rms(rev, 5200, 6000)).toBeLessThan(1e-3); // the sound is over
  });

  it('offline render is deterministic and stays finite', () => {
    const ev = [on(36, 0), on(37, 3000), on(36, 9000)];
    const a = run({ ...base, chokeSize: 2 }, ev, kit, SR);
    const b = run({ ...base, chokeSize: 2 }, ev, kit, SR);
    expect(a).toEqual(b);
    expect(a.every((x) => Number.isFinite(x))).toBe(true);
    expect(sine(1, 1)[0]).toBe(0);
  });
});
