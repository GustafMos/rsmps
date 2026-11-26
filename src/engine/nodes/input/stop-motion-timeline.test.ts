import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph, setParam } from '../../graph';
import { editEnd, normalizeEdit } from '../../lib/media-edit';
import { reconcileMediaEdits, updateStopMotionCuts } from '../../lib/media-edit-graph';
import type { Shot } from '../../lib/stop-motion';
import { harness } from '../../testing';
import type { GraphDoc, Host, ImageValue } from '../../types';

const still = (asset: string, hold?: number): Shot => (hold ? { asset, kind: 'still', hold } : { asset, kind: 'still' });
const noDescribe = () => ({ name: 'x', duration: 0 });

async function build(shots: Shot[]) {
  const frames = new Map<string, ImageValue>();
  const host: Host = {
    assetInfo: (id) => {
      const f = frames.get(id);
      return f ? { id, name: id, kind: 'image', width: f.width, height: f.height, duration: 0, fps: 0, hasAudio: false } : null;
    },
    assetFrame: async (id) => {
      const f = frames.get(id);
      return f ? { texture: f.texture, width: f.width, height: f.height } : null;
    },
  };
  const t = await harness([], host);
  frames.set('red', t.solid(16, 16, [255, 0, 0, 255]));
  frames.set('green', t.solid(16, 16, [0, 255, 0, 255]));
  frames.set('blue', t.solid(16, 16, [0, 0, 255, 255]));
  frames.set('white', t.solid(16, 16, [255, 255, 255, 255]));
  let g: GraphDoc = createGraph('t');
  g = { ...g, project: { ...g.project, fps: 10, duration: 2 } };
  const sm = addNode(g, t.registry, 'stop-motion');
  g = setParam(sm.graph, sm.node.id, 'shots', shots);
  g = setParam(g, sm.node.id, 'fps', 10);
  const tl = addNode(g, t.registry, 'media-timeline');
  const wired = connect(tl.graph, t.registry, { node: sm.node.id, port: 'image' }, { node: tl.node.id, port: 'clips' });
  g = reconcileMediaEdits(tl.graph, wired, noDescribe);
  return { t, g, sm: sm.node.id, tl: tl.node.id };
}

const cuts = (g: GraphDoc, tl: string) => normalizeEdit(g.nodes.find((n) => n.id === tl)!.params.edit).clips.filter((c) => c.kind === 'video');

describe('Stop Motion wired into a Media Timeline', () => {
  it('makes one cut per shot, in order, with the right start and duration', async () => {
    const { g, tl } = await build([still('red'), still('green', 3), { asset: 'blue', kind: 'clip', seconds: 0.5 }]);
    const c = cuts(g, tl);
    expect(c.map((x) => [+x.start.toFixed(3), +x.in.toFixed(3), +x.duration.toFixed(3), x.source])).toEqual([
      [0, 0, 0.1, 0],
      [0.1, 0.1, 0.3, 0],
      [0.4, 0.4, 0.5, 0],
    ]);
    expect(c.map((x) => x.name)).toEqual(['Stop Motion 1', 'Stop Motion 2', 'Stop Motion 3']);
    expect(editEnd({ clips: c })).toBeCloseTo(0.9, 9);
  });

  it('the timeline shows each shot at its cut', async () => {
    const { t, g, tl } = await build([still('red'), still('green', 3), still('blue')]);
    const at = async (s: number) => {
      const img = (await t.evalGraph(g, tl, { seconds: s })) as ImageValue;
      return (await t.pixels(img)).at(img.width >> 1, img.height >> 1).slice(0, 3).join(',');
    };
    expect(await at(0)).toBe('255,0,0');
    expect(await at(0.2)).toBe('0,255,0');
    expect(await at(0.4)).toBe('0,0,255');
  });

  it('a shot added later appears as a new cut at the end (automatically, and by the update action)', async () => {
    const { g, sm, tl } = await build([still('red'), still('green')]);
    const more = setParam(g, sm, 'shots', [still('red'), still('green'), still('blue')]);
    const auto = reconcileMediaEdits(g, more, noDescribe);
    expect(cuts(auto, tl).map((x) => [+x.start.toFixed(3), x.name])).toEqual([[0, 'Stop Motion 1'], [0.1, 'Stop Motion 2'], [0.2, 'Stop Motion 3']]);
    // the explicit action does the same from a timeline that missed the change
    const manual = updateStopMotionCuts(more, tl);
    expect(cuts(manual, tl)).toHaveLength(3);
    expect(updateStopMotionCuts(auto, tl).nodes.find((n) => n.id === tl)!.params.edit).toEqual(auto.nodes.find((n) => n.id === tl)!.params.edit);
  });

  it('keeps trimmed cuts of unchanged shots and drops the cuts of deleted ones', async () => {
    const { g, sm, tl } = await build([still('red', 2), still('green'), still('blue')]);
    // trim the first cut by hand
    const edit = normalizeEdit(g.nodes.find((n) => n.id === tl)!.params.edit);
    edit.clips[0] = { ...edit.clips[0], duration: 0.1 };
    const trimmed = setParam(g, tl, 'edit', edit);
    const gone = setParam(trimmed, sm, 'shots', [still('red', 2)]);
    const out = cuts(reconcileMediaEdits(trimmed, gone, noDescribe), tl);
    expect(out).toHaveLength(1);
    expect(out[0].duration).toBeCloseTo(0.1, 9); // the trim survived
  });
});
