import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { harness } from '../../testing';

describe('large values stay safe (owner froze the app typing 1515 art pixels)', () => {
  it('1515 art pixels on a 1080p source: every node is fast, including error diffusion', async () => {
    const t = await harness();
    const img = t.scene(1920, 1080);
    for (const [mode, algorithm, extract] of [['fixed-height', 'bayer-4', false], ['fixed-height', 'floyd-steinberg', false], ['short-side', 'jarvis', true], ['fixed-width', 'atkinson', true]] as const) {
      let g = createGraph('x');
      const s = addNode(g, t.registry, t.source(img));
      const pix = addNode(s.graph, t.registry, 'pixelate', { x: 0, y: 0 }, { mode, value: 1515 });
      const dith = addNode(pix.graph, t.registry, 'dither', { x: 0, y: 0 }, { algorithm });
      const up = addNode(dith.graph, t.registry, 'pixel-upscale', { x: 0, y: 0 }, { factor: 2 });
      g = connect(up.graph, t.registry, { node: s.node.id, port: 'out' }, { node: pix.node.id, port: 'image' });
      g = connect(g, t.registry, { node: pix.node.id, port: 'image' }, { node: dith.node.id, port: 'image' });
      g = connect(g, t.registry, { node: dith.node.id, port: 'image' }, { node: up.node.id, port: 'image' });
      if (extract) {
        const pal = addNode(g, t.registry, 'palette', { x: 0, y: 0 }, { source: 'extract' });
        g = connect(pal.graph, t.registry, { node: pix.node.id, port: 'image' }, { node: pal.node.id, port: 'image' });
        g = connect(g, t.registry, { node: pal.node.id, port: 'palette' }, { node: dith.node.id, port: 'palette' });
      }
      const r = await t.engine.evaluate({ graph: g, node: up.node.id, port: 'image' });
      await t.gpu.device.queue.onSubmittedWorkDone();
      expect([...r.errors.values()]).toEqual([]);
      expect(r.value).toBeTruthy();
      for (const ms of r.timings.values()) expect(ms).toBeLessThan(3000);
    }
  }, 60000);

  it('sequential modes (Riemersma, serpentine) refuse big images with a readable error', async () => {
    const t = await harness();
    await expect(t.run('dither', { algorithm: 'riemersma' }, { image: t.solid(800, 600, [1, 2, 3, 255]) })).rejects.toThrow(/limited to/);
    await expect(t.run('dither', { algorithm: 'floyd-steinberg', serpentine: true }, { image: t.solid(800, 600, [1, 2, 3, 255]) })).rejects.toThrow(/limited to/);
  });
});
