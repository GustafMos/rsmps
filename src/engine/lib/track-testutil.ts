/**
 * Test-only helpers for the Detect & Track nodes: animated sources (regions and images) and a tiny
 * graph builder. Not used by shipped nodes.
 */
import { defineNode } from '../define';
import { addNode, connect, createGraph } from '../graph';
import type { Harness } from '../testing';
import type { AnyNodeDef, GraphDoc, RegionsValue, Region } from '../types';

/** A regions source whose list is a function of the frame index (reads the clock, so it re-renders per frame). */
export function regionsSource(id: string, f: (frame: number) => Region[]): AnyNodeDef {
  return defineNode({
    id,
    title: id,
    category: 'input',
    description: 'test regions source',
    inputs: {},
    outputs: { regions: { type: 'regions' } },
    params: {},
    render(ctx) {
      return { regions: { kind: 'regions', items: f(ctx.time.frame) } satisfies RegionsValue };
    },
  });
}

export interface Rect {
  /** Normalised centre and half-size (fraction of width) and straight RGB colour 0..255. */
  cx: number;
  cy: number;
  hs: number;
  color: [number, number, number];
}

/** An image source of `size` x `size` texels: black background with coloured squares at f(frame). */
export function squaresSource(id: string, size: number, f: (frame: number) => Rect[], background: [number, number, number] = [0, 0, 0]): AnyNodeDef {
  return defineNode({
    id,
    title: id,
    category: 'input',
    description: 'test moving squares',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      const rects = f(ctx.time.frame).slice(0, 4);
      const data = new Uint8ClampedArray(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          let c = background;
          for (const r of rects) {
            if (Math.abs((x + 0.5) / size - r.cx) <= r.hs && Math.abs((y + 0.5) / size - r.cy) <= r.hs) c = r.color;
          }
          data.set([c[0], c[1], c[2], 255], (y * size + x) * 4);
        }
      }
      return { image: ctx.gpu.upload(data, size, size, ctx.unitFor(size, size)) };
    },
  });
}

/** Minimal graph builder: add nodes, wire ports, evaluate. */
export class TestGraph {
  graph: GraphDoc;
  constructor(public t: Harness, project: Partial<GraphDoc['project']> = {}) {
    this.graph = createGraph('track-test');
    this.graph.project = { ...this.graph.project, fps: 10, duration: 4, loop: false, width: 64, height: 64, ...project };
  }
  add(type: string, params: Record<string, unknown> = {}): string {
    const r = addNode(this.graph, this.t.registry, type, { x: 0, y: 0 }, params);
    this.graph = r.graph;
    return r.node.id;
  }
  wire(from: string, fromPort: string, to: string, toPort: string): void {
    this.graph = connect(this.graph, this.t.registry, { node: from, port: fromPort }, { node: to, port: toPort });
  }
  async eval(node: string, frame = 0, port?: string): Promise<unknown> {
    return this.t.evalGraph(this.graph, node, { seconds: frame / this.graph.project.fps, port });
  }
  async regions(node: string, frame = 0, port?: string): Promise<Region[]> {
    return ((await this.eval(node, frame, port)) as RegionsValue).items;
  }
}
