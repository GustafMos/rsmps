import { expect, it } from 'vitest';
import { connect, createGraph, addNode } from '../../graph';
import { harness } from '../../testing';

/** Evaluate `type`'s Mask output with `inputs` wired from in-test pictures. */
async function maskOf(t: Awaited<ReturnType<typeof harness>>, type: string, params: Record<string, unknown>, inputs: Record<string, never>) {
  let g = createGraph('t');
  g = { ...g, project: { ...g.project, width: 64, height: 32 } };
  const node = addNode(g, t.registry, type, { x: 0, y: 0 }, params);
  g = node.graph;
  for (const [port, image] of Object.entries(inputs)) {
    const src = addNode(g, t.registry, t.source(image), { x: 0, y: 0 });
    g = connect(src.graph, t.registry, { node: src.node.id, port: Object.keys(t.registry.get(src.node.type)!.outputs)[0] }, { node: node.node.id, port });
  }
  // a mask consumer, so the wire type is checked too: depth -> Mask Invert
  const inv = addNode(g, t.registry, 'mask-invert', { x: 0, y: 0 });
  g = connect(inv.graph, t.registry, { node: node.node.id, port: 'mask' }, { node: inv.node.id, port: Object.keys(t.registry.get('mask-invert')!.inputs)[0] });
  const mask = await t.evalGraph(g, node.node.id, { port: 'mask' });
  const inverted = await t.evalGraph(g, inv.node.id);
  return { mask: await t.pixels(mask as never), inverted: await t.pixels(inverted as never), kind: (mask as { kind: string }).kind };
}

it('Depth Convert: the Mask output is the depth map as coverage (near = white) and feeds mask inputs', async () => {
  const t = await harness();
  // a depth map: left = far (black), right = near (white)
  const map = t.fromFn(64, 32, (x) => { const v = Math.round((x / 63) * 255); return [v, v, v, 255]; });
  const r = await maskOf(t, 'depth-convert', { mode: 'picture-to-scene' }, { depth: map as never });
  expect(r.kind).toBe('mask');
  expect(r.mask.at(1, 16)[0]).toBeLessThan(12);
  expect(r.mask.at(62, 16)[0]).toBeGreaterThan(243);
  expect(Math.abs(r.mask.at(32, 16)[0] - 130)).toBeLessThan(6);
  expect(r.mask.at(32, 16)[3]).toBe(255);
  expect(r.inverted.at(1, 16)[0]).toBeGreaterThan(243); // Mask Invert selects the background
  expect(r.inverted.at(62, 16)[0]).toBeLessThan(12);
});

it('Depth from Picture: the Mask output matches its depth map', async () => {
  const t = await harness();
  const scene = t.scene(64, 32);
  const out = await t.run('depth-estimate', {}, { image: scene });
  const depth = await t.pixels(out.depth as never);
  const r = await maskOf(t, 'depth-estimate', {}, { image: scene as never });
  expect(r.kind).toBe('mask');
  let worst = 0;
  let spread = 0;
  for (let y = 2; y < 30; y += 3) for (let x = 2; x < 62; x += 3) {
    worst = Math.max(worst, Math.abs(r.mask.at(x, y)[0] - depth.at(x, y)[0]));
    spread = Math.max(spread, depth.at(x, y)[0]);
  }
  expect(worst).toBeLessThanOrEqual(2);
  expect(spread).toBeGreaterThan(20); // the depth map is not empty
});
