import { describe, expect, it } from 'vitest';
import { seamRatio } from '../../lib/copy-testutil';
import { LOOP_SEAM_OK, harness } from '../../testing';
import zoom, { zoomLoop } from './infinite-zoom.node';

/** A ring logo: an opaque border 6 px wide around a transparent hole (the next copy fits inside). */
const ring = (t: Awaited<ReturnType<typeof harness>>, size = 32, border = 6) =>
  t.fromFn(size, size, (x, y) => {
    const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
    return edge < border ? [20, 20, 20, 255] : [0, 0, 0, 0];
  });

describe('infinite-zoom', () => {
  it('shows a smaller copy of the picture inside the hole', async () => {
    const t = await harness();
    const src = ring(t);
    // scale 0.5 about the middle: the nested frame spans 8..24, so its border sits at x 8..10 (3 px wide)
    const deep = await t.pixels((await t.run('infinite-zoom', { scale: 0.5, levels: 1 }, { image: src })).image as never);
    expect(deep.at(9, 16)[3]).toBe(255);
    expect(deep.at(13, 16)[3]).toBe(0);
    const flat = await t.pixels((await t.run('infinite-zoom', { scale: 0.5, levels: 0 }, { image: src })).image as never);
    expect(flat.at(9, 16)[3]).toBe(0); // only the outer picture
    expect(flat.at(2, 16)[3]).toBe(255);
  });

  it('the nested copy goes where Centre says', async () => {
    const t = await harness();
    const src = ring(t, 32, 4);
    const out = await t.pixels((await t.run('infinite-zoom', { scale: 0.4, centre: [0.65, 0.5], levels: 1 }, { image: src })).image as never);
    // nested frame: width 12.8 centred on x = 20.8 -> 14.4 .. 27.2, its left border starts at 14.4
    expect(out.at(15, 16)[3]).toBe(255);
    expect(out.at(11, 16)[3]).toBe(0);
  });

  it('recolours each level with the next palette colour, keeping the shape', async () => {
    const t = await harness();
    const src = ring(t);
    const out = await t.pixels(
      (
        await t.run(
          'infinite-zoom',
          { scale: 0.5, levels: 3, recolor: 'fill', palette: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
          { image: src },
        )
      ).image as never,
    );
    expect(out.at(2, 16)).toEqual([255, 0, 0, 255]); // level 0: first colour
    expect(out.at(9, 16)).toEqual([0, 255, 0, 255]); // level 1: second colour
    // level 2: nested again by 0.5 -> frame 12..20, border 12..13.5
    expect(out.at(12, 16)).toEqual([0, 0, 255, 255]);
  });

  it('falls a whole number of levels per loop with no seam, for a picture that does not fit its hole too', async () => {
    const t = await harness();
    for (const src of [ring(t), t.fromFn(32, 32, (x, y) => [x * 8, y * 8, 120, 255])]) {
      const r = await seamRatio(t, 'infinite-zoom', { scale: 0.4, levels: 6, speed: 1, rotatePerLevel: 20, centre: [0.55, 0.45] }, { image: src });
      expect(r.wrap).toBeLessThan(r.max * 1.3 + 0.5);
      expect(r.motion).toBeGreaterThan(0.5);
    }
  });

  it('loops with spiral twist, and colours that flow with the depth on screen', async () => {
    const t = await harness();
    const src = ring(t);
    const base = { scale: 0.45, levels: 6, recolor: 'fill', palette: [[1, 0, 0], [0, 0, 1]] };
    const a = await seamRatio(t, 'infinite-zoom', { ...base, speed: 2, spiral: 1 }, { image: src });
    expect(a.seam, a.text).toBeLessThan(LOOP_SEAM_OK);
    expect(a.motion).toBeGreaterThan(0.5);
    const b = await seamRatio(t, 'infinite-zoom', { ...base, speed: 1, attached: false }, { image: src });
    expect(b.seam, b.text).toBeLessThan(LOOP_SEAM_OK);
  });

  it('attached colours loop whatever the travel and the palette length (Loop on): no maths for the user', async () => {
    const t = await harness();
    const src = ring(t);
    const pal5: [number, number, number][] = [[1, 0.1, 0.1], [1, 0.8, 0.1], [0.2, 0.9, 0.3], [0.1, 0.6, 1], [0.7, 0.2, 0.9]];
    for (const [speed, palette] of [[1, pal5.slice(0, 2)], [2, pal5], [3, pal5.slice(0, 2)], [-3, pal5.slice(0, 4)], [4, pal5.slice(0, 3)]] as const) {
      for (const colorLoop of ['drift', 'snap', 'stretch']) {
        const r = await seamRatio(t, 'infinite-zoom', { scale: 0.45, levels: 6, speed, recolor: 'fill', palette, attached: true, colorLoop }, { image: src }, 24);
        expect(r.seam, `speed ${speed}, ${palette.length} colours, ${colorLoop}: ${r.text}`).toBeLessThan(LOOP_SEAM_OK);
        expect(r.motion).toBeGreaterThan(0.5);
      }
    }
  });

  it('with Loop OFF nothing is closed for you: attached colours that do not divide the travel still pop', async () => {
    const t = await harness();
    const r = await t.loopCheck('infinite-zoom', { scale: 0.45, levels: 6, speed: 1, recolor: 'fill', palette: [[1, 0, 0], [0, 0, 1]], attached: true }, { image: ring(t) }, { frames: 16, fps: 8, size: 48, project: { loop: false } });
    expect(r.seam, r.text).toBeGreaterThan(2);
    expect(r.worst.wrap).toBe(true);
  });

  it('a hue step per level closes too', async () => {
    const t = await harness();
    const r = await seamRatio(t, 'infinite-zoom', { scale: 0.45, levels: 6, speed: 2, hueStep: 37, attached: true }, { image: ring(t) }, 24);
    expect(r.seam, r.text).toBeLessThan(LOOP_SEAM_OK);
  });

  it('zoomLoop: drift, snap and stretch close the sequence, and say what they changed', () => {
    const base = { speed: 2, recolor: 'fill', palette: [1, 2, 3, 4, 5], attached: true, hueStep: 0 };
    const clock = { loop: true };
    // drift (default): the colour index drifts by the remainder: 2 + drift is a multiple of 5 (the shortest way round is -2)
    const d = zoomLoop(base, clock);
    expect(d.travel).toBe(2);
    expect(d.palDrift).toBe(-2);
    expect((((d.travel + d.palDrift) % 5) + 5) % 5).toBe(0);
    expect(d.notes.join(' ')).toContain('colors drift');
    // snap: 4 levels of a 3-colour palette -> 3 (within 50%); 2 of 5 is too far and falls back to drift
    expect(zoomLoop({ ...base, speed: 4, palette: [1, 2, 3], colorLoop: 'snap' }, clock)).toMatchObject({ travel: 3, palDrift: 0 });
    expect(zoomLoop({ ...base, speed: 4, palette: [1, 2, 3], colorLoop: 'snap' }, clock).notes[0]).toBe('speed 4 → 3 to loop');
    expect(zoomLoop({ ...base, colorLoop: 'snap' }, clock)).toMatchObject({ travel: 2, palDrift: -2 });
    // stretch: 3 levels of a 2-colour palette: 4 palette steps over 3 levels
    const st = zoomLoop({ ...base, speed: 3, palette: [1, 2], colorLoop: 'stretch' }, clock);
    expect(3 * st.idxStep).toBeCloseTo(4, 12);
    // a multiple of the palette length: nothing to do
    expect(zoomLoop({ ...base, speed: 5 }, clock)).toMatchObject({ travel: 5, idxStep: 1, palDrift: 0, notes: [] });
    // a fraction from a socket is rounded; never to 0
    expect(zoomLoop({ ...base, speed: 0.37, recolor: 'off', palette: [] }, clock).travel).toBe(1);
    // colours on the screen depth, or Loop off: as typed
    expect(zoomLoop({ ...base, attached: false }, clock)).toMatchObject({ travel: 2, palDrift: 0 });
    expect(zoomLoop(base, { loop: false })).toMatchObject({ travel: 2, palDrift: 0, idxStep: 1, notes: [] });
    // hue: 37 degrees x 3 levels = 111 degrees: the drift cancels it to a whole turn
    const h = zoomLoop({ ...base, speed: 3, recolor: 'off', palette: [], hueStep: 37 }, clock);
    expect(3 * (37 / 360) + h.hueDrift).toBeCloseTo(0, 9);
  });

  it('the summary says when Loop changed a value, and only then', () => {
    const def = zoom;
    const p = { ...Object.fromEntries(Object.entries(def.params).map(([k, d]) => [k, (d as { default: unknown }).default])), speed: 2, recolor: 'fill', palette: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0, 1, 1]] } as never;
    expect(def.summary!(p, undefined, { loop: true, frames: 24, fps: 8 })).toContain('colors drift -2/loop to close');
    expect(def.summary!(p, undefined, { loop: false, frames: 24, fps: 8 })).not.toContain('drift');
    expect(def.summary!(p)).not.toContain('drift');
  });

  it('is still by default', async () => {
    const t = await harness();
    const r = await t.loopCheck('infinite-zoom', { levels: 4 }, { image: ring(t) });
    expect(r.motion).toBe(0);
  });

  it('inner picture replaces the picture for the nested levels', async () => {
    const t = await harness();
    const src = ring(t);
    const inner = t.fromFn(32, 32, () => [0, 255, 0, 255]);
    const out = await t.pixels((await t.run('infinite-zoom', { scale: 0.5, levels: 2 }, { image: src, inner })).image as never);
    expect(out.at(2, 16)).toEqual([20, 20, 20, 255]);
    expect(out.at(16, 16)).toEqual([0, 255, 0, 255]);
  });

  it('one pass, no new shader when numbers move', async () => {
    const t = await harness();
    const src = ring(t);
    await t.run('infinite-zoom', { levels: 4 }, { image: src });
    const s0 = t.gpu.stats().objects;
    await t.run('infinite-zoom', { levels: 20, scale: 0.61, spiral: 0.7, rotatePerLevel: 33, speed: 3 }, { image: src }, { seconds: 0.4 });
    const s1 = t.gpu.stats().objects;
    expect(s1.submits - s0.submits).toBe(1);
    expect(s1.pipelinesCreated - s0.pipelinesCreated).toBe(0);
    // Loop on, attached palette, snapping and drift: still one pass, no new shader
    await t.run('infinite-zoom', { levels: 9, speed: 3, recolor: 'fill', palette: [[1, 0, 0], [0, 1, 0]], colorLoop: 'drift' }, { image: src }, { seconds: 0.4, project: { loop: true } });
    const s2 = t.gpu.stats().objects;
    await t.run('infinite-zoom', { levels: 9, speed: 5, recolor: 'fill', palette: [[1, 0, 0], [0, 1, 0]], colorLoop: 'stretch', hueStep: 40 }, { image: src }, { seconds: 0.4, project: { loop: true } });
    const s3 = t.gpu.stats().objects;
    expect(s3.submits - s2.submits).toBe(1);
    expect(s3.pipelinesCreated - s2.pipelinesCreated).toBe(0);
  });
});
