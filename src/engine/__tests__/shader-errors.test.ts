import { expect, it } from 'vitest';
import { defineNode } from '../define';
import { addNode, createGraph } from '../graph';
import { harness } from '../testing';

it('a shader that does not compile is reported on the node instead of giving a blank image', async () => {
  const t = await harness([
    defineNode({
      id: 'bad-shader',
      title: 'b',
      category: 'generate',
      description: 'd',
      inputs: {},
      outputs: { image: { type: 'image' } },
      params: {},
      render: (ctx) => ({
        image: ctx.gpu.pass({
          label: 'bad-shader',
          size: { width: 4, height: 4 },
          wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { let target = 1.0; return vec4f(target); }',
        }),
      }),
    }),
  ]);
  const a = addNode(createGraph(), t.registry, 'bad-shader');
  const r = await t.engine.evaluate({ graph: a.graph, node: a.node.id });
  expect(r.value).toBeNull();
  expect(r.errors.get(a.node.id)).toMatch(/failed to compile/);
});
