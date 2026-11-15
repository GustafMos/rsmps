/**
 * Test-only helpers for time nodes: an animated image source whose brightness is a function of
 * seconds, and a tiny "source → node" graph builder. Not used by shipped nodes.
 */
import { defineNode } from '../define';
import { addNode, connect, createGraph } from '../graph';
import type { Harness } from '../testing';
import type { AnyNodeDef, GraphDoc, ImageValue } from '../types';

/** A 4x4 grey image whose brightness (0..1) is f(seconds). Reads the clock, so it re-renders per frame. */
export function animatedSource(id: string, f: (seconds: number) => number): AnyNodeDef {
  return defineNode({
    id,
    title: id,
    category: 'input',
    description: 'test animated source',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      const v = f(ctx.time.seconds);
      return {
        image: ctx.gpu.pass({
          size: { width: 4, height: 4 },
          uniforms: { v },
          wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.v, u.v, u.v, 1.0); }',
        }),
      };
    },
  });
}

/** source → node(type, params) on port `image`, with a 10 fps / 2 s looping project. */
export function sourceChain(
  t: Harness,
  sourceId: string,
  type: string,
  params: Record<string, unknown> = {},
  project: Partial<GraphDoc['project']> = {},
): { graph: GraphDoc; node: string } {
  let g = createGraph('time-test');
  g.project = { ...g.project, fps: 10, duration: 2, loop: true, width: 4, height: 4, ...project };
  const s = addNode(g, t.registry, sourceId);
  const n = addNode(s.graph, t.registry, type, { x: 0, y: 0 }, params);
  g = connect(n.graph, t.registry, { node: s.node.id, port: 'image' }, { node: n.node.id, port: 'image' });
  return { graph: g, node: n.node.id };
}

/** Red channel (0..255) of the centre pixel of a node's output at `seconds`. */
export async function sampleAt(t: Harness, graph: GraphDoc, node: string, seconds: number): Promise<number> {
  const img = (await t.evalGraph(graph, node, { seconds })) as ImageValue | null;
  if (!img) throw new Error('sampleAt: node produced no image');
  return (await t.pixels(img)).at(1, 1)[0];
}
