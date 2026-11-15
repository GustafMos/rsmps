import type { Harness } from '../testing';
import type { ImageValue } from '../types';

/**
 * Resolution-independence check: runs `type` on a picture at 1x (unit 1) and at 2x (unit 2),
 * downsamples the 2x result and returns the mean absolute difference (0..255) between the two.
 */
export async function resolutionDiff(
  t: Harness,
  type: string,
  params: Record<string, unknown>,
  make: (w: number, h: number, x: (v: number) => number) => (px: number, py: number) => [number, number, number, number],
  size = 32,
): Promise<number> {
  const small = t.fromFn(size, size, make(size, size, (v) => v), 1);
  const big = t.fromFn(size * 2, size * 2, make(size * 2, size * 2, (v) => v), 2);
  const a = await t.pixels(((await t.run(type, params, { image: small })).image ?? null) as ImageValue);
  const b = await t.pixels(((await t.run(type, params, { image: big })).image ?? null) as ImageValue);
  let sum = 0;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      for (let c = 0; c < 4; c++) {
        let m = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) m += b.at(x * 2 + dx, y * 2 + dy)[c];
        sum += Math.abs(a.at(x, y)[c] - m / 4);
      }
  return sum / (size * size * 4);
}

/** Smooth test picture that scales with its size: diagonal gradient with a bright disc. */
export const scalable =
  (w: number, h: number) =>
  (x: number, y: number): [number, number, number, number] => {
    const u = x / w;
    const v = y / h;
    const disc = Math.hypot(u - 0.5, v - 0.5) < 0.2;
    const g = Math.round(((u + v) / 2) * 200);
    return disc ? [230, 90, 40, 255] : [g, g, Math.min(255, g + 30), 255];
  };

import { defineNode } from '../define';
import { addNode, connect, createGraph } from '../graph';
import type { AnyNodeDef, GraphDoc } from '../types';

/**
 * Test source whose picture moves with time: a bright vertical bar on a dark ground that steps
 * 2 texels per frame (32x32). Reads the clock, so it re-renders per frame.
 */
export function movingBarSource(id = 'fx-moving-bar'): AnyNodeDef {
  return defineNode({
    id,
    title: id,
    category: 'input',
    description: 'test moving source',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: {},
    render(ctx) {
      const f = ctx.time.frame;
      return {
        image: ctx.gpu.pass({
          size: { width: 32, height: 32, unit: 1 },
          uniforms: { x: (f * 2) % 32 },
          wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let on = abs(px.x - (u.x + 0.5)) < 2.0;
  return select(vec4f(0.05, 0.05, 0.1, 1.0), vec4f(1.0), on);
}`,
        }),
      };
    },
  });
}

/** source -> node on `image` in a 10 fps, 2 s looping project (20 frames). */
export function timeChain(t: Harness, sourceId: string, type: string, params: Record<string, unknown> = {}): { graph: GraphDoc; node: string } {
  let g = createGraph('fx-time');
  g.project = { ...g.project, fps: 10, duration: 2, loop: true, width: 32, height: 32 };
  const s = addNode(g, t.registry, sourceId);
  const n = addNode(s.graph, t.registry, type, { x: 0, y: 0 }, params);
  g = connect(n.graph, t.registry, { node: s.node.id, port: 'image' }, { node: n.node.id, port: 'image' });
  return { graph: g, node: n.node.id };
}
