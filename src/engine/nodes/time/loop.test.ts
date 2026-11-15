import { describe, expect, it } from 'vitest';
import { animatedSource, sampleAt, sourceChain } from '../../lib/util-testsource';
import { harness } from '../../testing';

// A source that does NOT loop on its own: a slow wave whose period does not match the 2 s project.
const wave = animatedSource('test-wave', (s) => 0.5 + 0.4 * Math.sin((2 * Math.PI * s) / 2.8));

describe('loop (Make Loop)', () => {
  it('frame 0 equals the frame one full duration later', async () => {
    const t = await harness([wave]);
    const c = sourceChain(t, 'test-wave', 'loop', { blend: 1 });
    expect(await sampleAt(t, c.graph, c.node, 2)).toBe(await sampleAt(t, c.graph, c.node, 0));
    expect(await sampleAt(t, c.graph, c.node, 2.5)).toBe(await sampleAt(t, c.graph, c.node, 0.5));
  });

  it('the seam is as smooth as any other pair of frames, unlike the raw source', async () => {
    const t = await harness([wave]);
    const c = sourceChain(t, 'test-wave', 'loop', { blend: 1 });
    const looped: number[] = [];
    for (let f = 0; f <= 20; f++) looped.push(await sampleAt(t, c.graph, c.node, f / 10));
    const steps = looped.slice(1).map((v, i) => Math.abs(v - looped[i]));
    // steps[19] is frame 19 -> frame 20 (= frame 0): the seam. steps[0] is frame 0 -> 1, the other side of it.
    const seam = Math.max(steps[19], steps[0]);
    const elsewhere = Math.max(...steps.slice(1, 19));
    expect(seam).toBeLessThanOrEqual(elsewhere);
    // The unlooped source has a visible jump from its last frame back to its first.
    const rawFirst = Math.round(255 * (0.5 + 0.4 * Math.sin(0)));
    const rawLast = Math.round(255 * (0.5 + 0.4 * Math.sin((2 * Math.PI * 1.9) / 2.8)));
    expect(Math.abs(rawFirst - rawLast)).toBeGreaterThan(elsewhere);
  });

  it('leaves the part after the blend window untouched', async () => {
    const t = await harness([wave]);
    const c = sourceChain(t, 'test-wave', 'loop', { blend: 0.5 });
    const v = await sampleAt(t, c.graph, c.node, 1.2);
    expect(Math.abs(v - Math.round(255 * (0.5 + 0.4 * Math.sin((2 * Math.PI * 1.2) / 2.8))))).toBeLessThanOrEqual(1);
  });

  it('starts from the footage after the end and fades to the real start', async () => {
    const t = await harness([wave]);
    const c = sourceChain(t, 'test-wave', 'loop', { blend: 1, curve: 'linear' });
    const at = (s: number) => 255 * (0.5 + 0.4 * Math.sin((2 * Math.PI * s) / 2.8));
    expect(Math.abs((await sampleAt(t, c.graph, c.node, 0)) - at(2))).toBeLessThanOrEqual(1.5);
    const mid = (at(2.5) + at(0.5)) / 2;
    expect(Math.abs((await sampleAt(t, c.graph, c.node, 0.5)) - mid)).toBeLessThanOrEqual(2);
  });

  it('is a no-op with zero blend', async () => {
    const t = await harness([wave]);
    const c = sourceChain(t, 'test-wave', 'loop', { blend: 0 });
    const v = await sampleAt(t, c.graph, c.node, 1.7);
    expect(Math.abs(v - Math.round(255 * (0.5 + 0.4 * Math.sin((2 * Math.PI * 1.7) / 2.8))))).toBeLessThanOrEqual(1);
  });
});
