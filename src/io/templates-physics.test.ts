import { describe, expect, it } from 'vitest';
import { harness } from '../engine/testing';
import { MOTION_PORT } from '../engine/define';
import { validateGraph } from '../engine/graph';
import { GROUP_TYPE, groupData } from '../engine/group';
import { clearRuns } from '../engine/lib/physics/sim';
import type { Edge, GraphDoc, ImageValue } from '../engine/types';
import { TEMPLATES, templateGraph } from './templates';

/** The "Falling shapes" template as 0.54.0 saved it: Position into Move XYZ and Rotation into Rotate XYZ, five times. */
function oldForm(g: GraphDoc): GraphDoc {
  const scene = g.nodes.find((n) => n.type === GROUP_TYPE)!;
  const inner = groupData(scene);
  const edges: Edge[] = [];
  for (const e of inner.edges) {
    if (e.to.port === MOTION_PORT) {
      const n = /^motion(\d+)$/.exec(e.from.port)![1];
      edges.push({ id: `${e.id}p`, from: { node: e.from.node, port: `pos${n}` }, to: { node: e.to.node, port: 'pos@xyz' } });
      edges.push({ id: `${e.id}r`, from: { node: e.from.node, port: `rot${n}` }, to: { node: e.to.node, port: 'rot@xyz' } });
    } else edges.push(e);
  }
  return { ...g, nodes: g.nodes.map((n) => (n === scene ? { ...n, params: { ...n.params, edges } } : n)) };
}

describe('Falling shapes template, one Motion wire per shape', () => {
  const t = TEMPLATES.find((x) => x.id === 'falling-shapes')!;

  it('uses one wire per shape and no vector wires', () => {
    const g = templateGraph(t);
    const inner = groupData(g.nodes.find((n) => n.type === GROUP_TYPE)!);
    expect(inner.edges.filter((e) => e.from.node === 'phys').map((e) => `${e.from.port}>${e.to.port}`)).toEqual([1, 2, 3, 4, 5].map((i) => `motion${i}>${MOTION_PORT}`));
  });

  it('renders the same picture as the old two-vector wiring at frames 0, 20, 60 and 120', async () => {
    clearRuns();
    const h = await harness();
    const small = (g: GraphDoc): GraphDoc => ({ ...g, project: { ...g.project, width: 240, height: 180 } });
    const next = small(templateGraph(t));
    const old = small(oldForm(templateGraph(t)));
    expect(validateGraph(next, h.registry)).toEqual([]);
    expect(validateGraph(old, h.registry)).toEqual([]);
    const fps = next.project.fps;
    for (const frame of [0, 20, 60, 120]) {
      const seconds = frame / fps;
      const a = (await h.pixels((await h.evalGraph(next, 'out', { seconds })) as ImageValue)).data;
      const b = (await h.pixels((await h.evalGraph(old, 'out', { seconds })) as ImageValue)).data;
      expect(Buffer.compare(Buffer.from(a), Buffer.from(b)), `frame ${frame}`).toBe(0);
    }
    // and the shapes really moved between the first and the last frame
    const first = (await h.pixels((await h.evalGraph(next, 'out', { seconds: 0 })) as ImageValue)).data;
    const last = (await h.pixels((await h.evalGraph(next, 'out', { seconds: 120 / fps })) as ImageValue)).data;
    expect(Buffer.compare(Buffer.from(first), Buffer.from(last))).not.toBe(0);
  }, 180_000);
});
