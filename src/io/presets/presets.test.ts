import { describe, expect, it } from 'vitest';
import { harness } from '../../engine/testing';
import { defineNode } from '../../engine/define';
import { validateGraph } from '../../engine/graph';
import type { GraphDoc, ImageValue } from '../../engine/types';

const modules = import.meta.glob('./*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

/** Stands in for the empty Media In of each preset: same output port, picture supplied by the test. */
function testSource(holder: { image: ImageValue | null }) {
  return defineNode({
    id: 'preset-test-source',
    title: 'Test source',
    category: 'input',
    description: 'test',
    inputs: {},
    outputs: { image: { type: 'image' }, audio: { type: 'audio' } },
    params: { assets: { type: 'assets', default: [], accept: 'any' } },
    render: () => ({ image: holder.image }),
  });
}

describe('built-in presets', () => {
  it('there are presets, each with a short unique name', () => {
    const names = Object.values(modules).map((m) => (m as GraphDoc).name);
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) {
      expect(n.length).toBeGreaterThan(2);
      expect(n.length).toBeLessThan(40);
    }
  });

  for (const [path, raw] of Object.entries(modules)) {
    const stem = path.replace(/^.*\//, '').replace(/\.json$/, '');
    it(`${stem}: loads, validates, and renders a picture`, async () => {
      const holder: { image: ImageValue | null } = { image: null };
      const t = await harness([testSource(holder)]);
      const graph = raw as GraphDoc;
      expect([graph.schema, graph.version]).toEqual(['rsmps/graph', 2]);
      expect(graph.name).not.toBe('Untitled');
      // structure
      expect(validateGraph(graph, t.registry)).toEqual([]);
      for (const n of graph.nodes) expect(t.registry.get(n.type), `${n.type} exists`).toBeTruthy();
      const media = graph.nodes.filter((n) => n.type === 'media-in');
      for (const m of media) expect((m.params.assets as unknown[] | undefined) ?? []).toEqual([]); // no media baked in
      expect(graph.nodes.filter((n) => t.registry.get(n.type)?.category === 'output').length).toBeGreaterThan(0);
      // every node has a distinct position (tidy graph)
      const spots = new Set(graph.nodes.map((n) => `${n.x},${n.y}`));
      expect(spots.size).toBe(graph.nodes.length);
      // render: swap the empty Media In for a generated subject
      holder.image = t.fromFn(180, 320, (x, y) => {
        const body = Math.abs(x - 90) < 28 && y > 70 && y < 230;
        const head = Math.hypot(x - 90, y - 52) < 22;
        const v = 80 + 140 * (1 - Math.abs(x - 90) / 40);
        return body || head ? [v, v * 0.8, v * 0.7, 255] : [28 + y / 20, 34 + y / 20, 52 + y / 14, 255];
      }, 0.5);
      const run: GraphDoc = { ...graph, project: { ...graph.project, width: 180, height: 320 }, nodes: graph.nodes.map((n) => (n.type === 'media-in' ? { ...n, type: 'preset-test-source' } : n)) };
      const out = run.nodes.find((n) => t.registry.get(n.type)?.category === 'output')!;
      const img = (await t.evalGraph(run, out.id, { seconds: 0.5 })) as ImageValue | null;
      expect(img).toBeTruthy();
      expect(img!.width).toBeGreaterThan(0);
      const px = await t.pixels(img);
      let lit = 0;
      for (let i = 0; i < px.data.length; i += 4) if (px.data[i + 3] > 0 && px.data[i] + px.data[i + 1] + px.data[i + 2] > 15) lit++;
      expect(lit).toBeGreaterThan(px.width * px.height * 0.02);
    }, 60000);
  }
});
