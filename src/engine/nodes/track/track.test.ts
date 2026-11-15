import { describe, expect, it } from 'vitest';
import { regionsSource, TestGraph } from '../../lib/track-testutil';
import { harness } from '../../testing';
import type { Region } from '../../types';

const box = (cx: number, cy: number, s = 0.1): [number, number, number, number] => [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2];
const det = (cx: number, cy: number, label = 'obj', s = 0.1): Region => ({ id: 0, label, score: 0.9, box: box(cx, cy, s) });

async function setup(f: (frame: number) => Region[], params: Record<string, unknown> = {}) {
  const sid = `test-regions-${Math.random().toString(36).slice(2)}`;
  const t = await harness([regionsSource(sid, f)]);
  const g = new TestGraph(t, { duration: 10, fps: 10 });
  const src = g.add(sid);
  const tr = g.add('track', params);
  g.wire(src, 'regions', tr, 'regions');
  return { g, tr };
}

describe('track', () => {
  it('keeps one id for a moving square over 20 frames', async () => {
    const { g, tr } = await setup((f) => [det(0.2 + 0.02 * f, 0.5)]);
    const ids = new Set<number>();
    for (let f = 0; f < 25; f++) {
      const r = await g.regions(tr, f);
      expect(r).toHaveLength(1);
      ids.add(r[0].id);
    }
    expect(ids.size).toBe(1);
  });

  it('gives the same id when a frame is evaluated directly (scrubbing = playback)', async () => {
    const { g, tr } = await setup((f) => [det(0.2 + 0.02 * f, 0.5)]);
    const direct = (await g.regions(tr, 18))[0].id;
    const first = (await g.regions(tr, 3))[0].id;
    expect(direct).toBe(first);
  });

  it('keeps two crossing objects distinct', async () => {
    const { g, tr } = await setup((f) => [det(0.15 + 0.02 * f, 0.35), det(0.85 - 0.02 * f, 0.65)]);
    let idA = -1;
    let idB = -1;
    for (let f = 0; f < 30; f++) {
      const r = await g.regions(tr, f);
      expect(r).toHaveLength(2);
      const a = r.find((x) => Math.abs((x.box[1] + x.box[3]) / 2 - 0.35) < 0.05)!;
      const b = r.find((x) => Math.abs((x.box[1] + x.box[3]) / 2 - 0.65) < 0.05)!;
      expect(a.id).not.toBe(b.id);
      if (f === 0) [idA, idB] = [a.id, b.id];
      expect(a.id).toBe(idA);
      expect(b.id).toBe(idB);
    }
  });

  it('keeps two objects distinct even when they pass through each other on one line', async () => {
    const { g, tr } = await setup((f) => [det(0.15 + 0.02 * f, 0.5), det(0.85 - 0.02 * f, 0.5, 'obj', 0.1)], { smooth: 0 });
    const r0 = await g.regions(tr, 0);
    const left = r0.find((x) => x.box[0] < 0.5)!.id;
    const right = r0.find((x) => x.box[0] > 0.5)!.id;
    expect(left).not.toBe(right);
    const r = await g.regions(tr, 34);
    expect(new Set(r.map((x) => x.id)).size).toBe(2);
    // After passing each other the id that started on the left must be on the right.
    expect(r.find((x) => x.id === left)!.box[0]).toBeGreaterThan(0.5);
  });

  it('holds a region through a short dropout and starts a new id after a long one', async () => {
    const gone = (f: number, from: number, to: number) => f >= from && f < to;
    const short = await setup((f) => (gone(f, 6, 8) ? [] : [det(0.2 + 0.02 * f, 0.5)]), { hold: 4 });
    const id0 = (await short.g.regions(short.tr, 5))[0].id;
    const held = await short.g.regions(short.tr, 7);
    expect(held).toHaveLength(1);
    expect(held[0].id).toBe(id0);
    expect(held[0].score).toBeLessThan(0.9);
    expect((await short.g.regions(short.tr, 9))[0].id).toBe(id0);

    const long = await setup((f) => (gone(f, 6, 16) ? [] : [det(0.2 + 0.02 * f, 0.5)]), { hold: 2 });
    const a = (await long.g.regions(long.tr, 5))[0].id;
    expect(await long.g.regions(long.tr, 12)).toHaveLength(0);
    const b = (await long.g.regions(long.tr, 17))[0].id;
    expect(b).not.toBe(a);
  });

  it('smoothing calms jitter', async () => {
    const jitter = (f: number) => (f % 2 ? 0.02 : -0.02);
    const raw = await setup((f) => [det(0.5 + jitter(f), 0.5)], { smooth: 0 });
    const smooth = await setup((f) => [det(0.5 + jitter(f), 0.5)], { smooth: 0.8 });
    const spread = async (s: typeof raw) => {
      const xs: number[] = [];
      for (let f = 0; f < 16; f++) xs.push((await s.g.regions(s.tr, f))[0].box[0]);
      const late = xs.slice(8);
      return Math.max(...late) - Math.min(...late);
    };
    expect(await spread(smooth)).toBeLessThan((await spread(raw)) * 0.5);
  });

  it('does not match across different labels, and ids stay inside the window documented limit', async () => {
    const { g, tr } = await setup((f) => [det(0.3 + 0.01 * f, 0.5, f < 5 ? 'a' : 'b')], { hold: 0 });
    expect((await g.regions(tr, 3))[0].id).not.toBe((await g.regions(tr, 8))[0].id);

    const short = await setup((f) => [det(0.1 + 0.01 * f, 0.5)], { history: 10, memory: 2 });
    const longer = await setup((f) => [det(0.1 + 0.01 * f, 0.5)], { history: 100, memory: 2 });
    const s = [(await short.g.regions(short.tr, 2))[0].id, (await short.g.regions(short.tr, 9))[0].id, (await short.g.regions(short.tr, 25))[0].id];
    const l = [(await longer.g.regions(longer.tr, 2))[0].id, (await longer.g.regions(longer.tr, 25))[0].id];
    expect(s[0]).toBe(s[1]);
    expect(l[0]).toBe(l[1]);
    expect(s[2]).not.toBe(s[0]); // the documented limitation: the window moved on
  });
});
