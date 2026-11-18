import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT, type GraphDoc } from '../../engine/types';
import { rateForFirstVideo } from './firstVideoRate';

const graph = (assets: string[][], fps = DEFAULT_PROJECT.fps): GraphDoc => ({
  schema: 'rsmps/graph',
  version: 2,
  name: 't',
  project: { ...DEFAULT_PROJECT, fps },
  nodes: assets.map((a, i) => ({ id: 'm' + i, type: 'media-in', x: 0, y: 0, params: { assets: a } })),
  edges: [],
  frames: [],
});
const files: Record<string, { kind: string; fps: number }> = {
  clip25: { kind: 'video', fps: 25 },
  clip2997: { kind: 'video', fps: 29.97 },
  clip24: { kind: 'video', fps: 24 },
  clip0: { kind: 'video', fps: 0 },
  photo: { kind: 'image', fps: 0 },
};
const info = (id: string) => files[id];

describe('project frame rate when the first video arrives', () => {
  it('takes the rate of the first video put into a project that had none', () => {
    expect(rateForFirstVideo(graph([[]]), graph([['clip25']]), info)).toBe(25);
    expect(rateForFirstVideo(graph([]), graph([['photo', 'clip25']]), info)).toBe(25);
    expect(rateForFirstVideo(graph([['photo']]), graph([['photo'], ['clip2997']]), info)).toBe(30);
  });
  it('leaves the project alone otherwise', () => {
    expect(rateForFirstVideo(graph([['clip24']]), graph([['clip24'], ['clip25']]), info)).toBeNull(); // not the first video
    expect(rateForFirstVideo(graph([[]], 30), graph([['clip25']], 30), info)).toBeNull(); // a rate set by hand
    expect(rateForFirstVideo(graph([[]]), graph([['clip25']], 12), info)).toBeNull(); // the edit itself sets the rate
    expect(rateForFirstVideo(graph([[]]), graph([['clip24']]), info)).toBeNull(); // already the same
    expect(rateForFirstVideo(graph([[]]), graph([['photo']]), info)).toBeNull(); // no video
    expect(rateForFirstVideo(graph([[]]), graph([['clip0']]), info)).toBeNull(); // rate unknown
    expect(rateForFirstVideo(graph([[]]), graph([['gone']]), info)).toBeNull(); // file not in the library
  });
});
