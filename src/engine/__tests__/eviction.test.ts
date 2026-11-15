import { expect, it } from 'vitest';
import { Engine } from '../engine';
import { addNode, connect, createGraph } from '../graph';
import { harness } from '../testing';
import type { ImageValue } from '../types';

it('results stay correct when the cache evicts and textures are recycled (no stale or overwritten frames)', async () => {
  const t = await harness();
  let g = createGraph();
  g.project = { ...g.project, width: 128, height: 128, fps: 10, duration: 3 };
  const noise = addNode(g, t.registry, 'noise', { x: 0, y: 0 }, { evolution: 3, scale: 30 });
  const blur = addNode(noise.graph, t.registry, 'blur', { x: 0, y: 0 }, { radius: 12 });
  const cube = addNode(blur.graph, t.registry, 'object-3d'); // static: cached across frames
  const merge = addNode(cube.graph, t.registry, 'merge');
  const adj = addNode(merge.graph, t.registry, 'color-adjust', { x: 0, y: 0 }, { contrast: 1.3 });
  g = adj.graph;
  g = connect(g, t.registry, { node: noise.node.id, port: 'image' }, { node: blur.node.id, port: 'image' });
  g = connect(g, t.registry, { node: blur.node.id, port: 'image' }, { node: merge.node.id, port: 'background' });
  g = connect(g, t.registry, { node: cube.node.id, port: 'image' }, { node: merge.node.id, port: 'foreground' });
  g = connect(g, t.registry, { node: merge.node.id, port: 'image' }, { node: adj.node.id, port: 'image' });

  // Reference: a fresh engine per frame (nothing cached, nothing recycled).
  const reference: Uint8ClampedArray[] = [];
  for (let f = 0; f < 12; f++) {
    const fresh = new Engine(t.gpu, t.registry, t.engine.host);
    const r = await fresh.evaluate({ graph: g, node: adj.node.id, seconds: f / 10 });
    reference.push(await t.gpu.read(r.value as ImageValue, false));
    fresh.clear();
  }

  // Under test: one engine with a tiny cache budget so every evaluation evicts and recycles textures.
  const engine = new Engine(t.gpu, t.registry, t.engine.host);
  engine.cacheBudget = 200 * 1024;
  for (const pass of [0, 1]) {
    for (let f = 0; f < 12; f++) {
      const r = await engine.evaluate({ graph: g, node: adj.node.id, seconds: f / 10 });
      const px = await t.gpu.read(r.value as ImageValue, false);
      let diff = 0;
      for (let i = 0; i < px.length; i++) diff += Math.abs(px[i] - reference[f][i]);
      expect(diff / px.length, `pass ${pass} frame ${f}`).toBeLessThan(0.5);
    }
  }
});
