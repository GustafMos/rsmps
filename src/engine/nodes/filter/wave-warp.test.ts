import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff, scalable } from '../../lib/fx-testutil';

const bars = (x: number): [number, number, number, number] => (x % 16 < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
const none = { waveX: 0, waveY: 0, noiseAmount: 0, tears: 0 };
const firstBright = (p: { at(x: number, y: number): number[]; width: number }, y: number) => { for (let x = 0; x < p.width; x++) if (p.at(x, y)[0] > 128) return x; return -1; };

describe('wave-warp', () => {
  it('rows slide sideways by a sine of their height (static by default)', async () => {
    const t = await harness();
    const src = t.fromFn(96, 64, (x) => bars(x));
    const px = await t.pixels((await t.run('wave-warp', { ...none, waveX: 6, waveXLength: 32, edge: 'wrap' }, { image: src })).image as never);
    const first = Array.from({ length: 64 }, (_, y) => firstBright(px, y));
    expect(new Set(first).size).toBeGreaterThanOrEqual(3);
    const still = await t.loopCheck('wave-warp', { ...none, waveX: 6, waveXLength: 32 }, { image: src });
    expect(still.motion).toBe(0);
  });

  it('columns slide up and down', async () => {
    const t = await harness();
    const src = t.fromFn(64, 64, (x, y) => (y % 16 < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const px = await t.pixels((await t.run('wave-warp', { ...none, waveY: 5, waveYLength: 32 }, { image: src })).image as never);
    const col = (x: number) => Array.from({ length: 64 }, (_, y) => px.at(x, y)[0]).join();
    expect(col(0)).not.toEqual(col(8));
  });

  it('waves with whole cycles move and loop seamlessly', async () => {
    const t = await harness();
    const src = t.fromFn(64, 64, (x) => bars(x));
    const r = await t.loopCheck('wave-warp', { ...none, waveX: 8, waveXLength: 24, waveXCycles: 1 }, { image: src });
    expect(r.seam).toBeLessThan(0.01);
    expect(r.motion).toBeGreaterThan(1);
    const n = await t.loopCheck('wave-warp', { ...none, noiseAmount: 10, noiseScale: 20, noiseEvolution: 2 }, { image: src });
    expect(n.seam).toBeLessThan(0.01);
    expect(n.motion).toBeGreaterThan(0.5);
  });

  it('tear lines slip bands sideways while other rows stay', async () => {
    const t = await harness();
    const src = t.fromFn(96, 96, (x) => bars(x));
    const px = await t.pixels((await t.run('wave-warp', { ...none, tears: 3, tearShift: 20, tearHeight: 6 }, { image: src })).image as never);
    let moved = 0;
    let same = 0;
    for (let y = 0; y < 96; y++) (firstBright(px, y) === 0 ? same++ : moved++);
    expect(moved).toBeGreaterThan(2);
    expect(same).toBeGreaterThan(40);
  });

  it('all-zero returns the input; alpha survives; amounts follow resolution', async () => {
    const t = await harness();
    const src = t.solid(8, 8, [1, 2, 3, 255]);
    expect((await t.run('wave-warp', none, { image: src })).image).toBe(src);
    const clear = await t.pixels((await t.run('wave-warp', {}, { image: t.solid(16, 16, [0, 0, 0, 0]) })).image as never);
    expect(clear.at(5, 5)[3]).toBe(0);
    const d = await resolutionDiff(t, 'wave-warp', { ...none, waveX: 4, waveXLength: 24, edge: 'clamp' }, scalable);
    expect(d).toBeLessThan(10);
  });
});
