import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { resolutionDiff } from '../../lib/fx-testutil';

const ramp = (w: number) => (x: number): [number, number, number, number] => {
  const v = Math.round((x / (w - 1)) * 255);
  return [v, v, v, 255];
};
const base = { smoothing: 0, imageAmount: 0, thickness: 2, lineColor: [0, 1, 0, 1], background: [0, 0, 0, 1] };

/** number of runs of green pixels along row y */
function lineRuns(px: { at(x: number, y: number): number[]; width: number }, y: number): number {
  let runs = 0;
  let on = false;
  for (let x = 0; x < px.width; x++) {
    const lit = px.at(x, y)[1] > 128;
    if (lit && !on) runs++;
    on = lit;
  }
  return runs;
}

describe('contour-lines', () => {
  it('draws one line per brightness level', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('contour-lines', { ...base, count: 8 }, { image: t.fromFn(128, 16, ramp(128)) })).image as never);
    const n = lineRuns(px, 8);
    expect(n).toBeGreaterThanOrEqual(7);
    expect(n).toBeLessThanOrEqual(9);
    expect(px.at(5, 8)[1]).toBeLessThan(255); // not a solid fill
  });

  it('thickness is in pixels regardless of the slope of the field', async () => {
    const t = await harness();
    const steep = await t.pixels((await t.run('contour-lines', { ...base, count: 4, thickness: 4 }, { image: t.fromFn(128, 16, ramp(128)) })).image as never);
    const shallow = await t.pixels((await t.run('contour-lines', { ...base, count: 4, thickness: 4 }, { image: t.fromFn(128, 16, (x) => { const v = Math.round((x / 127) * 100); return [v, v, v, 255]; }) })).image as never);
    const avg = (p: typeof steep) => { let c = 0; for (let x = 0; x < 128; x++) if (p.at(x, 8)[1] > 128) c++; return c / Math.max(1, lineRuns(p, 8)); };
    expect(Math.abs(avg(steep) - avg(shallow))).toBeLessThan(1.6);
    expect(avg(steep)).toBeGreaterThan(2.5);
  });

  it('subject mode radiates rings around a shape on transparency', async () => {
    const t = await harness();
    const src = t.fromFn(96, 96, (x, y) => (Math.hypot(x - 48, y - 48) < 8 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    const px = await t.pixels((await t.run('contour-lines', { ...base, field: 'subject', spread: 20, count: 5 }, { image: src })).image as never);
    expect(lineRuns(px, 48)).toBeGreaterThanOrEqual(4); // rings on both sides of the subject
  });

  it('colour can come from the picture, and the background can be transparent', async () => {
    const t = await harness();
    const px = await t.pixels((await t.run('contour-lines', { ...base, count: 8, colorMode: 'source', background: [0, 0, 0, 0] }, { image: t.fromFn(128, 16, (x) => { const v = Math.round((x / 127) * 255); return [v, Math.round(v * 0.5), v, 255]; }) })).image as never);
    let lit = 0;
    let clear = 0;
    for (let x = 0; x < 128; x++) {
      const c = px.at(x, 8);
      if (c[3] > 200) { lit++; expect(c[0]).toBeGreaterThanOrEqual(c[1]); }
      if (c[3] === 0) clear++;
    }
    expect(lit).toBeGreaterThan(8);
    expect(clear).toBeGreaterThan(40);
  });

  it('wobble bends the lines, and is frozen by default', async () => {
    const t = await harness();
    const src = t.fromFn(128, 64, ramp(128));
    const straight = await t.pixels((await t.run('contour-lines', { ...base, count: 4 }, { image: src })).image as never);
    const wavy = await t.pixels((await t.run('contour-lines', { ...base, count: 4, wobble: 12, wobbleScale: 30 }, { image: src })).image as never);
    let moved = 0;
    for (let y = 0; y < 64; y += 4) {
      const first = (p: typeof straight) => { for (let x = 0; x < 128; x++) if (p.at(x, y)[1] > 128) return x; return 0; };
      moved += Math.abs(first(straight) - first(wavy));
    }
    expect(moved).toBeGreaterThan(20);
    const still = await t.loopCheck('contour-lines', { ...base, count: 4, wobble: 8 }, { image: src });
    expect(still.motion).toBe(0);
  });

  it('lines travel with whole cycles and loop', async () => {
    const t = await harness();
    const src = t.fromFn(64, 16, ramp(64));
    const r = await t.loopCheck('contour-lines', { ...base, count: 4, cycles: 1 }, { image: src });
    expect(r.seam).toBeLessThan(0.01);
    expect(r.motion).toBeGreaterThan(1);
    const w = await t.loopCheck('contour-lines', { ...base, count: 4, wobble: 8, wobbleEvolution: 2 }, { image: src });
    expect(w.seam).toBeLessThan(0.01);
    expect(w.motion).toBeGreaterThan(0.5);
  });

  it('thickness and smoothing follow resolution', async () => {
    const t = await harness();
    const d = await resolutionDiff(t, 'contour-lines', { count: 6, thickness: 2, smoothing: 2, imageAmount: 0.3 }, (w, h) => (x, y) => {
      const v = Math.round((Math.hypot(x / w - 0.5, y / h - 0.5) * 2) * 255);
      return [Math.min(255, v), Math.min(255, v), Math.min(255, v), 255];
    });
    expect(d).toBeLessThan(16);
  });
});
