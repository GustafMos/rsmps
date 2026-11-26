import { describe, expect, it } from 'vitest';
import {
  addShot,
  cycleHold,
  describeShots,
  duplicateShot,
  moveShot,
  normalizeShots,
  removeLast,
  removeShot,
  replaceShot,
  setHold,
  shotAt,
  shotSpans,
  totalFrames,
  totalSeconds,
  type Shot,
} from '../../lib/stop-motion';
import { harness } from '../../testing';
import type { Host, ImageValue } from '../../types';
import def from './stop-motion.node';

const still = (asset: string, hold?: number): Shot => (hold ? { asset, kind: 'still', hold } : { asset, kind: 'still' });

describe('stop motion sequence maths', () => {
  it('lengths: holds add up, clips last their seconds', () => {
    const shots: Shot[] = [still('a'), still('b', 2), { asset: 'c', kind: 'clip', seconds: 0.5 }];
    expect(totalFrames(shots, 10)).toBe(1 + 2 + 5);
    expect(totalSeconds(shots, 10)).toBeCloseTo(0.8, 9);
    expect(totalFrames([], 10)).toBe(0);
    expect(shotSpans(shots, 10).map((s) => [s.index, +s.start.toFixed(3), +s.duration.toFixed(3)])).toEqual([[0, 0, 0.1], [1, 0.1, 0.2], [2, 0.3, 0.5]]);
  });

  it('which shot shows at time t, wrapping at the end', () => {
    const shots: Shot[] = [still('a'), still('b', 2), { asset: 'c', kind: 'clip', seconds: 0.4 }];
    const fps = 10; // frames: a | b b | c c c c
    const idx = (t: number) => shotAt(shots, fps, t)!.index;
    expect([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map(idx)).toEqual([0, 1, 1, 2, 2, 2, 2]);
    expect(idx(0.7)).toBe(0); // wrapped: 7 frames
    expect(idx(0.85)).toBe(1);
    expect(idx(-0.1)).toBe(2); // before zero wraps backwards
    expect(shotAt(shots, fps, 0.5)!.local).toBeCloseTo(0.2, 9); // a clip plays at its own speed
    expect(shotAt([], fps, 1)).toBeNull();
  });

  it('edits: add, remove, undo last, move, duplicate, hold, retake', () => {
    let s: Shot[] = [still('a'), still('b'), still('c')];
    expect(removeLast(s).map((x) => x.asset)).toEqual(['a', 'b']);
    expect(removeShot(s, 1).map((x) => x.asset)).toEqual(['a', 'c']);
    expect(moveShot(s, 2, -1).map((x) => x.asset)).toEqual(['a', 'c', 'b']);
    expect(moveShot(s, 0, -1).map((x) => x.asset)).toEqual(['a', 'b', 'c']);
    expect(duplicateShot(s, 0).map((x) => x.asset)).toEqual(['a', 'a', 'b', 'c']);
    s = setHold(s, 1, 3);
    expect(s[1]).toEqual({ asset: 'b', kind: 'still', hold: 3 });
    expect(replaceShot(s, 1, 'z')[1]).toEqual({ asset: 'z', kind: 'still', hold: 3 });
    expect(addShot(s, still('d')).length).toBe(4);
    expect([1, 2, 3, 4].map(cycleHold)).toEqual([2, 3, 4, 1]);
    expect(describeShots(s, 10)).toBe('3 shots · 0.5 s');
  });

  it('normalizes anything stored', () => {
    expect(normalizeShots(null)).toEqual([]);
    expect(normalizeShots([{ asset: 'a', kind: 'still', hold: 99 }, { asset: '', kind: 'still' }, { asset: 'c', kind: 'clip' }, 5, { asset: 'd', kind: 'clip', seconds: 2 }])).toEqual([
      { asset: 'a', kind: 'still', hold: 24 },
      { asset: 'd', kind: 'clip', seconds: 2 },
    ]);
  });
});

describe('stop-motion node', () => {
  const frames = new Map<string, ImageValue>();
  const asked: [string, number][] = [];
  const host: Host = {
    assetInfo: (id) => {
      const f = frames.get(id);
      return f ? { id, name: id, kind: 'image', width: f.width, height: f.height, duration: 0, fps: 0, hasAudio: false } : null;
    },
    assetFrame: async (id, seconds) => {
      asked.push([id, seconds]);
      const f = frames.get(id);
      return f ? { texture: f.texture, width: f.width, height: f.height } : null;
    },
  };
  const setup = async () => {
    const t = await harness([], host);
    frames.set('red', t.solid(16, 16, [255, 0, 0, 255]));
    frames.set('green', t.solid(16, 16, [0, 255, 0, 255]));
    frames.set('blue', t.solid(16, 16, [0, 0, 255, 255]));
    return t;
  };
  const shotsParam = [still('red'), still('green'), still('blue')];
  const rgb = async (t: Awaited<ReturnType<typeof setup>>, params: Record<string, unknown>, sec: number, inputs: Record<string, never> = {}) => {
    const out = await t.run('stop-motion', params, inputs, { seconds: sec, project: { fps: 10, duration: 1, loop: true } });
    return { out, px: (await t.pixels(out.image as never)).at(8, 8) };
  };

  it('plays the shots in order at the frame rate and wraps', async () => {
    const t = await setup();
    const p = { shots: shotsParam, fps: 10, show: 'loop' };
    const colours = [];
    for (const sec of [0, 0.1, 0.2, 0.3, 0.4]) colours.push((await rgb(t, p, sec)).px.slice(0, 3).join(','));
    expect(colours).toEqual(['255,0,0', '0,255,0', '0,0,255', '255,0,0', '0,255,0']);
    const r = await rgb(t, p, 0.1);
    expect(r.out.shots).toBe(3);
    expect(r.out.shot).toBe(2);
  });

  it('a hold of 2 makes a shot last twice as long', async () => {
    const t = await setup();
    const p = { shots: [still('red'), still('green', 2), still('blue')], fps: 10, show: 'loop' };
    const cols = [];
    for (const sec of [0, 0.1, 0.2, 0.3, 0.4]) cols.push((await rgb(t, p, sec)).px.slice(0, 3).join(','));
    expect(cols).toEqual(['255,0,0', '0,255,0', '0,255,0', '0,0,255', '255,0,0']);
  });

  it('a clip plays at its own speed inside the loop', async () => {
    const t = await setup();
    asked.length = 0;
    const p = { shots: [still('red'), { asset: 'green', kind: 'clip', seconds: 0.3 }], fps: 10, show: 'loop' };
    await rgb(t, p, 0.2);
    expect(asked.at(-1)![0]).toBe('green');
    expect(asked.at(-1)![1]).toBeCloseTo(0.1, 6);
  });

  it('live view with onion skin blends the last shot over the input; off gives the input exactly', async () => {
    const t = await setup();
    const live = t.solid(16, 16, [0, 0, 255, 255]);
    const base = { shots: [still('red'), still('green')], fps: 10, show: 'live' };
    const on = await rgb(t, { ...base, onion: true, onionStrength: 0.5 }, 0, { image: live as never });
    expect(on.px[0]).toBe(0);
    expect(Math.abs(on.px[1] - 128)).toBeLessThanOrEqual(2); // half green
    expect(Math.abs(on.px[2] - 128)).toBeLessThanOrEqual(2); // half of the blue input
    const off = await rgb(t, { ...base, onion: false }, 0, { image: live as never });
    expect(off.px.slice(0, 3)).toEqual([0, 0, 255]);
    const two = await rgb(t, { ...base, onion: true, onionStrength: 1, onionFrames: 2 }, 0, { image: live as never });
    expect(two.px.slice(0, 3)).toEqual([0, 255, 0]); // strength 1: the nearest shot covers the rest
  });

  it('"The animation" ignores the input; automatic follows the shoot view stamp', async () => {
    const t = await setup();
    const live = t.solid(16, 16, [255, 255, 255, 255]);
    const p = { shots: shotsParam, fps: 10 };
    expect((await rgb(t, { ...p, show: 'loop' }, 0, { image: live as never })).px.slice(0, 3)).toEqual([255, 0, 0]);
    expect((await rgb(t, { ...p, show: 'auto' }, 0, { image: live as never })).px.slice(0, 3)).toEqual([255, 0, 0]);
    expect((await rgb(t, { ...p, show: 'auto', shootView: '1', onion: false }, 0, { image: live as never })).px.slice(0, 3)).toEqual([255, 255, 255]);
  });

  it('no shots: the input passes through', async () => {
    const t = await setup();
    const live = t.solid(16, 16, [10, 20, 30, 255]);
    const r = await rgb(t, { shots: [], show: 'auto' }, 0, { image: live as never });
    expect(r.px.slice(0, 3)).toEqual([10, 20, 30]);
    expect(r.out.shots).toBe(0);
  });

  it('sets the project length to the animation when asked', () => {
    const p = { shots: [still('a'), still('b', 2)], fps: 10, setsLength: true };
    expect(def.projectLength!(p as never)).toBeCloseTo(0.3, 9);
    expect(def.projectLength!({ ...p, setsLength: false } as never)).toBeNull();
    expect(def.projectLength!({ ...p, shots: [] } as never)).toBeNull();
  });
});
