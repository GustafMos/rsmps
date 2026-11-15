import { describe, expect, it } from 'vitest';
import { harness } from '../../testing';
import { addNode, connect, createGraph } from '../../graph';
import type { Host } from '../../types';

/** A host whose signals are a known function of time and node/name, and which counts how often it is asked. */
function fakeHost() {
  const calls: { nodeId: string; name: string; seconds: number }[] = [];
  const host: Host = {
    assetInfo: () => null,
    assetFrame: async () => null,
    signal(nodeId, name, seconds) {
      calls.push({ nodeId, name, seconds });
      const k = name.length;
      return seconds * 10 + k; // known function
    },
  };
  return { host, calls };
}

describe('bridge nodes in the frame domain', () => {
  it('audio-level outputs follow Host.signal', async () => {
    const { host } = fakeHost();
    const t = await harness([], host);
    const out = await t.run('audio-level', {}, {}, { seconds: 1.5 });
    expect(out.level).toBeCloseTo(15 + 'level'.length, 6);
    expect(out.peak).toBeCloseTo(15 + 'peak'.length, 6);
    expect(out.low).toBeCloseTo(15 + 'low'.length, 6);
    expect(out.mid).toBeCloseTo(15 + 'mid'.length, 6);
    expect(out.high).toBeCloseTo(15 + 'high'.length, 6);
    expect(out.pitch).toBeCloseTo(15 + 'pitch'.length, 6);
  });

  it('midi-value and midi-trigger outputs follow Host.signal', async () => {
    const { host } = fakeHost();
    const t = await harness([], host);
    const mv = await t.run('midi-value', {}, {}, { seconds: 2 });
    expect(mv.note).toBeCloseTo(20 + 4, 6);
    expect(mv.velocity).toBeCloseTo(20 + 8, 6);
    expect(mv.gate).toBeCloseTo(20 + 4, 6);
    expect(mv.count).toBeCloseTo(20 + 5, 6);
    expect(mv.cc).toBeCloseTo(20 + 2, 6);
    const tr = await t.run('midi-trigger', {}, {}, { seconds: 0.25 });
    expect(tr.envelope).toBeCloseTo(2.5 + 'envelope'.length, 6);
  });

  it('is re-rendered every frame and asks for its own node id and the frame time', async () => {
    const { host, calls } = fakeHost();
    const t = await harness([], host);
    const g = addNode(createGraph(), t.registry, 'audio-level').graph;
    const nodeId = g.nodes[0].id;
    const a = await t.evalGraph(g, nodeId, { seconds: 0.5, port: 'level' });
    const b = await t.evalGraph(g, nodeId, { seconds: 1.0, port: 'level' });
    const c = await t.evalGraph(g, nodeId, { seconds: 1.5, port: 'level' });
    expect([a, b, c]).toEqual([5 + 5, 10 + 5, 15 + 5]);
    expect(calls.every((x) => x.nodeId === nodeId)).toBe(true);
    expect(calls.map((x) => x.seconds)).toEqual(expect.arrayContaining([0.5, 1, 1.5]));
  });

  it('without Host.signal (headless run) every output is 0', async () => {
    const t = await harness();
    const out = await t.run('audio-level', {}, {}, { seconds: 1 });
    expect(out.level).toBe(0);
    expect(out.pitch).toBe(0);
  });

  it('the number output can be wired on into another node (a number node chain)', async () => {
    const { host } = fakeHost();
    const t = await harness([], host);
    let { graph, node: lv } = addNode(createGraph(), t.registry, 'audio-level');
    const mathAdd = addNode(graph, t.registry, 'math');
    graph = mathAdd.graph;
    const target = t.registry.get('math');
    if (target && 'a' in target.params) {
      graph = connect(graph, t.registry, { node: lv.id, port: 'level' }, { node: mathAdd.node.id, port: 'a' });
      const v = await t.evalGraph(graph, mathAdd.node.id, { seconds: 1 });
      expect(typeof v === 'number').toBe(true);
    }
  });
});
