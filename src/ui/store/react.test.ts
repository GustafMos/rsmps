import { describe, expect, it } from 'vitest';
import { Registry } from '../../engine/define';
import { addNode, connect, createGraph, validateGraph } from '../../engine/graph';
import { registerBuiltins } from '../../engine/nodes';
import type { GraphDoc } from '../../engine/types';
import { defaultSwing, reactPatch, reactionOf, soundSources, stopReacting } from './react';

const registry = new Registry();
registerBuiltins(registry);

function project(): { g: GraphDoc; media: string; xf: string; out: string; exp: string } {
  let g = createGraph('t');
  const media = addNode(g, registry, 'media-in', { x: 0, y: 0 });
  g = media.graph;
  const xf = addNode(g, registry, 'transform', { x: 300, y: 0 });
  g = xf.graph;
  const exp = addNode(g, registry, 'color-adjust', { x: 600, y: 0 });
  g = exp.graph;
  const out = addNode(g, registry, 'image-out', { x: 900, y: 0 });
  g = out.graph;
  g = connect(g, registry, { node: media.node.id, port: 'image' }, { node: xf.node.id, port: 'image' });
  g = connect(g, registry, { node: xf.node.id, port: 'image' }, { node: exp.node.id, port: 'image' });
  g = connect(g, registry, { node: exp.node.id, port: 'image' }, { node: out.node.id, port: 'image' });
  return { g, media: media.node.id, xf: xf.node.id, out: out.node.id, exp: exp.node.id };
}

describe('react to sound (patch builder on the real registry)', () => {
  it('finds the sound: Media In first, what feeds an Audio Output when there is one', () => {
    const p = project();
    expect(soundSources(p.g, registry)).toEqual([{ node: p.media, port: 'audio', label: 'Media In' }]);
    let g = p.g;
    const file = addNode(g, registry, 'audio-file', { x: 0, y: 200 });
    g = file.graph;
    const aout = addNode(g, registry, 'audio-out', { x: 300, y: 200 });
    g = connect(aout.graph, registry, { node: file.node.id, port: 'audio' }, { node: aout.node.id, port: 'audio' });
    expect(soundSources(g, registry).map((s) => s.node)).toEqual([file.node.id]);
  });

  it('wires sound -> Beat Detect -> Remap -> the setting, keeps the look, validates, and is one pure edit', () => {
    const p = project();
    const r = reactPatch(p.g, registry, { node: p.xf, param: 'scale', feature: 'kick', source: { node: p.media, port: 'audio' } });
    expect(validateGraph(r.graph, registry)).toEqual([]);
    const beat = r.graph.nodes.find((n) => n.id === r.beat)!;
    const remap = r.graph.nodes.find((n) => n.id === r.remap)!;
    expect(beat.type).toBe('beat-detect');
    expect(remap.type).toBe('remap');
    expect(r.graph.edges.filter((e) => e.to.node === r.beat).map((e) => `${e.from.node}.${e.from.port}`)).toEqual([`${p.media}.audio`]);
    expect(r.graph.edges.some((e) => e.from.node === r.beat && e.from.port === 'kick' && e.to.node === r.remap && e.to.port === 'value')).toBe(true);
    expect(r.graph.edges.some((e) => e.from.node === r.remap && e.to.node === p.xf && e.to.port === 'scale')).toBe(true);
    // the base is the current value (scale 1) and the swing stays inside the setting's range
    expect(remap.params.toMin).toBe(1);
    expect(remap.params.toMax as number).toBeGreaterThan(1);
    expect(remap.params.toMax as number).toBeLessThanOrEqual(50);
    // the original graph was not touched
    expect(p.g.nodes.length).toBe(4);
    const re = reactionOf(r.graph, p.xf, 'scale')!;
    expect(re.feature).toBe('kick');
    expect(re.source).toBe(p.media);
    expect(reactionOf(p.g, p.xf, 'scale')).toBeNull();
  });

  it('a second setting reuses the same Beat Detect; switching feature replaces the first reaction', () => {
    const p = project();
    const a = reactPatch(p.g, registry, { node: p.xf, param: 'scale', feature: 'beat', source: { node: p.media, port: 'audio' } });
    const b = reactPatch(a.graph, registry, { node: p.exp, param: 'brightness', feature: 'level', source: { node: p.media, port: 'audio' } });
    expect(b.graph.nodes.filter((n) => n.type === 'beat-detect').length).toBe(1);
    expect(b.beat).toBe(a.beat);
    const c = reactPatch(b.graph, registry, { node: p.xf, param: 'scale', feature: 'phase', source: { node: p.media, port: 'audio' } });
    expect(c.graph.nodes.filter((n) => n.type === 'remap').length).toBe(2);
    expect(reactionOf(c.graph, p.xf, 'scale')!.feature).toBe('phase');
    expect(reactionOf(c.graph, p.exp, 'brightness')!.feature).toBe('level');
    expect(validateGraph(c.graph, registry)).toEqual([]);
  });

  it('stop reacting removes the wiring, the helper nodes it made, and restores the base value', () => {
    const p = project();
    const r = reactPatch(p.g, registry, { node: p.exp, param: 'brightness', feature: 'kick', source: { node: p.media, port: 'audio' }, base: 0.1, top: 0.4 });
    const stopped = stopReacting(r.graph, registry, p.exp, 'brightness');
    expect(stopped.nodes.map((n) => n.id).sort()).toEqual(p.g.nodes.map((n) => n.id).sort());
    expect(stopped.edges.length).toBe(p.g.edges.length);
    expect(stopped.nodes.find((n) => n.id === p.exp)!.params.brightness).toBe(0.1);
    // with two reactions, stopping one keeps the shared Beat Detect
    const two = reactPatch(r.graph, registry, { node: p.xf, param: 'scale', feature: 'beat', source: { node: p.media, port: 'audio' } });
    const one = stopReacting(two.graph, registry, p.xf, 'scale');
    expect(one.nodes.some((n) => n.type === 'beat-detect')).toBe(true);
    expect(stopReacting(p.g, registry, p.xf, 'scale')).toBe(p.g);
  });

  it('refuses settings that are not numbers, and swings downward when there is no room above', () => {
    const p = project();
    expect(() => reactPatch(p.g, registry, { node: p.xf, param: 'edge', feature: 'kick', source: { node: p.media, port: 'audio' } })).toThrow(/number/);
    expect(() => reactPatch(p.g, registry, { node: 'nope', param: 'scale', feature: 'kick', source: { node: p.media, port: 'audio' } })).toThrow();
    const def = { type: 'number', default: 1, min: 0, max: 1, step: 0.01 } as const;
    const s = defaultSwing(def, 1)!;
    expect(s.base).toBe(1);
    expect(s.top).toBeLessThan(1);
    const t = defaultSwing(def, 0.2)!;
    expect(t.top).toBeGreaterThan(0.2);
    expect(defaultSwing({ type: 'bool', default: false }, false)).toBeNull();
  });
});
