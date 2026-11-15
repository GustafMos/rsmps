import { describe, expect, it } from 'vitest';
import { addNode, connect, createGraph } from '../../graph';
import { builtinPalette } from '../../lib/pixel-palettes';
import { hexToRgb } from '../../lib/pixel-color';
import type { ImageValue } from '../../types';
import { harness } from '../../testing';

describe('app-style chain: source -> pixelate -> dither', () => {
  it('works with no palette wire (fallback) and with an extracted palette wired from the pixelate output', async () => {
    const t = await harness();
    const srcId = t.source(t.scene(128, 96));
    let g = createGraph('chain');
    const s = addNode(g, t.registry, srcId);
    const pix = addNode(s.graph, t.registry, 'pixelate', { x: 0, y: 0 }, { mode: 'fixed-height', value: 24 });
    const dith = addNode(pix.graph, t.registry, 'dither', { x: 0, y: 0 }, { fallback: 'pico-8' });
    g = connect(dith.graph, t.registry, { node: s.node.id, port: 'out' }, { node: pix.node.id, port: 'image' });
    g = connect(g, t.registry, { node: pix.node.id, port: 'image' }, { node: dith.node.id, port: 'image' });
    const fb = (await t.evalGraph(g, dith.node.id, { port: 'image' })) as ImageValue;
    expect(fb).toBeTruthy();
    const pico = builtinPalette('pico-8')!.colors.map((c) => hexToRgb(c).map((v) => Math.round(v * 255)));
    const px = await t.pixels(fb);
    let bad = 0;
    for (let i = 0; i < px.width * px.height; i++) {
      if (!pico.some((c) => Math.abs(c[0] - px.data[i * 4]) <= 1 && Math.abs(c[1] - px.data[i * 4 + 1]) <= 1 && Math.abs(c[2] - px.data[i * 4 + 2]) <= 1)) bad++;
    }
    expect(bad).toBe(0);

    const pal = addNode(g, t.registry, 'palette', { x: 0, y: 0 }, { source: 'extract', count: 4 });
    g = connect(pal.graph, t.registry, { node: pix.node.id, port: 'image' }, { node: pal.node.id, port: 'image' });
    g = connect(g, t.registry, { node: pal.node.id, port: 'palette' }, { node: dith.node.id, port: 'palette' });
    const ex = (await t.evalGraph(g, dith.node.id, { port: 'image' })) as ImageValue;
    const colours = new Set<string>();
    const pe = await t.pixels(ex);
    for (let i = 0; i < pe.width * pe.height; i++) colours.add(`${pe.data[i * 4]},${pe.data[i * 4 + 1]},${pe.data[i * 4 + 2]}`);
    expect(colours.size).toBeLessThanOrEqual(4);
    expect(colours.size).toBeGreaterThan(1);
  });
});
