import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import type { Host } from '../../types';
import def, { SCOPE_POINTS } from './oscilloscope.node';

/** Run the sound side on a mono signal and return the last published screenful. */
function scopeOf(signal: (i: number) => number, seconds: number, params: Record<string, unknown> = {}): number[] {
  const sr = 48000;
  const audio = def.audio!;
  const st = audio.create({ sampleRate: sr, blockSize: 128, nodeId: 'n' } as never);
  const out: Record<string, number> = {};
  const p = { gain: 0, window: 25, steady: true, ...params };
  const total = Math.round(seconds * sr);
  for (let at = 0; at < total; at += 128) {
    const block = new Float32Array(128);
    for (let i = 0; i < 128; i++) block[i] = signal(at + i);
    audio.process(st as never, { params: p, frames: 128, sampleRate: sr, in: { audio: [block, block] }, out: {}, signal: (name: string, v: number) => (out[name] = v) } as never);
  }
  return Array.from({ length: SCOPE_POINTS }, (_, k) => out[`p${k}`] ?? NaN);
}

describe('oscilloscope, sound side', () => {
  it('shows a sine at its full height, starting at an upward zero crossing when Steady is on', () => {
    const sine = (i: number) => 0.5 * Math.sin((2 * Math.PI * 200 * i) / 48000);
    const a = scopeOf(sine, 0.5);
    expect(Math.max(...a)).toBeGreaterThan(0.48);
    expect(Math.min(...a)).toBeLessThan(-0.48);
    expect(Math.abs(a[0])).toBeLessThan(0.2); // starts near zero...
    expect(a[3]).toBeGreaterThan(a[0]); // ...going up
    // the same note a little later gives the same picture: it stands still
    const b = scopeOf(sine, 0.537);
    let diff = 0;
    for (let k = 0; k < SCOPE_POINTS; k++) diff += Math.abs(a[k] - b[k]);
    expect(diff / SCOPE_POINTS).toBeLessThan(0.08);
  });
  it('input boost scales the wave and never leaves -1..1; silence is a flat line', () => {
    const sine = (i: number) => 0.5 * Math.sin((2 * Math.PI * 200 * i) / 48000);
    const loud = scopeOf(sine, 0.3, { gain: 24 });
    expect(Math.max(...loud)).toBe(1);
    expect(Math.min(...loud)).toBe(-1);
    expect(scopeOf(() => 0, 0.3).every((v) => v === 0)).toBe(true);
  });
});

describe('oscilloscope, picture side', () => {
  it('draws the line where the wave is and leaves the rest to the background', async () => {
    // a wave that is high on the left half and low on the right half
    const host = { signal: (_id: string, name: string) => (Number(name.slice(1)) < SCOPE_POINTS / 2 ? 0.8 : -0.8) } as unknown as Host;
    const t = await harness([], host);
    const out = (await t.run('oscilloscope', { glow: 0, thickness: 4 }, { size: t.solid(96, 64, [0, 0, 0, 255]) })).image;
    const px = await t.pixels(out as never);
    const yHigh = Math.round((0.5 - 0.46 * 0.8) * 64);
    const yLow = Math.round((0.5 - 0.46 * -0.8) * 64);
    expect(px.at(20, yHigh)[0]).toBeGreaterThan(150);
    expect(px.at(76, yLow)[0]).toBeGreaterThan(150);
    expect(px.at(20, yLow)[0]).toBeLessThan(20);
    expect(px.at(76, yHigh)[0]).toBeLessThan(20);
    expect(px.at(20, 32)[3]).toBe(255); // black background
    // top to bottom: the same picture turned
    const down = await t.pixels((await t.run('oscilloscope', { glow: 0, thickness: 4, direction: 'down' }, { size: t.solid(64, 96, [0, 0, 0, 255]) })).image as never);
    expect(down.at(yHigh, 20)[0]).toBeGreaterThan(150);
    expect(down.at(yLow, 20)[0]).toBeLessThan(20);
  });
});
