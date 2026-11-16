import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';

const stripes = (x: number, y: number): [number, number, number, number] => [(x * 5 + y) % 256, (y * 7) % 256, (x * 3) % 256, 255];
const quiet = { slices: 0, blockChance: 0, split: 0, jitter: 0, dropouts: 0, stuck: 0, comb: 0, roll: 0, bits: 8, noise: 0, density: 1, freeze: true };

async function changedRows(t: Awaited<ReturnType<typeof harness>>, params: Record<string, unknown>, src = t.fromFn(96, 64, stripes)) {
  const out = await t.pixels((await t.run('glitch', { ...quiet, ...params }, { image: src })).image as never);
  const ref = await t.pixels(src);
  let rows = 0;
  for (let y = 0; y < 64; y++) {
    let d = 0;
    for (let x = 0; x < 96; x++) d += Math.abs(out.at(x, y)[0] - ref.at(x, y)[0]);
    if (d > 20) rows++;
  }
  return { rows, out, ref };
}

describe('glitch', () => {
  it('slices shift whole bands of rows, the rest stays', async () => {
    const t = await harness();
    const { rows, out, ref } = await changedRows(t, { slices: 3, sliceShift: 30, sliceHeight: 0.1 });
    expect(rows).toBeGreaterThan(3);
    expect(rows).toBeLessThan(40);
    let same = 0;
    for (let y = 0; y < 64; y++) if (out.at(10, y).join() === ref.at(10, y).join()) same++;
    expect(same).toBeGreaterThan(20);
  });

  it('corrupted tiles repeat content from other tiles on a tile grid', async () => {
    const t = await harness();
    const { out, ref } = await changedRows(t, { blockChance: 0.5, blockSize: 16, blockOffset: 3, blockTint: false });
    let tilesChanged = 0;
    let tilesUntouched = 0;
    for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 6; tx++) {
      let d = 0;
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) d += Math.abs(out.at(tx * 16 + x, ty * 16 + y)[0] - ref.at(tx * 16 + x, ty * 16 + y)[0]);
      if (d === 0) tilesUntouched++; else tilesChanged++;
    }
    expect(tilesChanged).toBeGreaterThan(3);
    expect(tilesUntouched).toBeGreaterThan(3);
  });

  it('RGB split moves channels apart; bit crush limits levels; line effects', async () => {
    const t = await harness();
    const src = t.fromFn(96, 64, (x) => (x > 40 && x < 56 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const split = await t.pixels((await t.run('glitch', { ...quiet, split: 12 }, { image: src })).image as never);
    let apart = 0;
    for (let x = 0; x < 96; x++) { const c = split.at(x, 20); if (c[0] !== c[2]) apart++; }
    expect(apart).toBeGreaterThan(4);
    const ramp = t.fromFn(64, 4, (x) => [x * 4, x * 4, x * 4, 255]);
    const crushed = await t.pixels((await t.run('glitch', { ...quiet, bits: 2 }, { image: ramp })).image as never);
    expect(new Set(Array.from({ length: 64 }, (_, x) => crushed.at(x, 1)[0])).size).toBe(4);
    const j = await changedRows(t, { jitter: 8 });
    expect(j.rows).toBeGreaterThan(40);
    const c = await changedRows(t, { comb: 6 });
    expect(c.rows).toBeGreaterThan(25);
    const d = await changedRows(t, { dropouts: 0.4 });
    expect(d.rows).toBeGreaterThan(10);
    const s = await changedRows(t, { stuck: 2 });
    expect(s.rows).toBeGreaterThan(3);
  });

  it('events hold still, then change: deterministic, loops, and freezes on request', async () => {
    const t = await harness();
    const src = t.fromFn(64, 64, stripes);
    const params = { ...quiet, freeze: false, eventsPerLoop: 4, slices: 3, sliceShift: 30, density: 1 };
    const project = { fps: 10, duration: 2, loop: true, width: 64, height: 64 };
    const at = async (seconds: number) => t.pixels((await t.run('glitch', params, { image: src }, { seconds, project })).image as never);
    const a = await at(0.1);
    const a2 = await at(0.4); // same event (0..0.5 s)
    expect(Array.from(a.data)).toEqual(Array.from(a2.data));
    const b = await at(0.6); // next event
    expect(Array.from(a.data)).not.toEqual(Array.from(b.data));
    const r = await t.loopCheck('glitch', params, { image: src });
    expect(r.seam).toBe(0);
    expect(r.motion).toBeGreaterThan(0.5);
    const frozen = await t.loopCheck('glitch', { ...params, freeze: true }, { image: src });
    expect(frozen.motion).toBe(0);
  });

  it('density 0 is a clean picture, presets differ, alpha survives', async () => {
    const t = await harness();
    const src = t.fromFn(96, 64, stripes);
    expect((await t.run('glitch', { density: 0 }, { image: src })).image).toBe(src);
    const seen = new Set<string>();
    for (const preset of ['light', 'broken', 'cable', 'corrupt', 'heavy']) {
      const px = await t.pixels((await t.run('glitch', { preset, freeze: true, seed: 3, density: 1 }, { image: src })).image as never);
      seen.add(Array.from(px.data.slice(0, 4000)).join());
    }
    expect(seen.size).toBeGreaterThan(3);
    const clear = await t.pixels((await t.run('glitch', { ...quiet, slices: 3, split: 8 }, { image: t.solid(16, 16, [0, 0, 0, 0]) })).image as never);
    expect(clear.at(5, 5)[3]).toBe(0);
  });
});
