import { describe, expect, it } from 'vitest';
import { harness } from '../engine/testing';
import { defineNode } from '../engine/define';
import { validateGraph } from '../engine/graph';
import type { ImageValue } from '../engine/types';
import { TEMPLATES, TEMPLATE_GROUPS, availableTemplates, templateGraph, templateGroups } from './templates';
import { encodeShareLink, decodeShareLink } from './share';

/** Stands in for the empty Media In of templates that need media: same ports, picture supplied by the test. */
function testSource(holder: { image: ImageValue | null }) {
  return defineNode({
    id: 'template-test-source',
    title: 'Test source',
    category: 'input',
    description: 'test',
    inputs: {},
    outputs: { image: { type: 'image' } },
    params: { assets: { type: 'assets', default: [], accept: 'any' } },
    render: () => ({ image: holder.image }),
  });
}

describe('templates (table driven)', () => {
  it('there are 10 to 14 templates with unique ids and titles, in known groups, each with a description', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(10);
    expect(TEMPLATES.length).toBeLessThanOrEqual(14);
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length);
    expect(new Set(TEMPLATES.map((t) => t.title)).size).toBe(TEMPLATES.length);
    for (const t of TEMPLATES) {
      expect(TEMPLATE_GROUPS).toContain(t.group);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.description.length).toBeLessThan(200);
      expect(t.graph.name).toBe(t.title);
    }
    expect(templateGroups().length).toBeGreaterThanOrEqual(5);
  });

  for (const t of TEMPLATES) {
    it(`${t.id}: valid graph, real node types, frame 0 evaluates`, async () => {
      const holder: { image: ImageValue | null } = { image: null };
      const h = await harness([testSource(holder)]);
      const g = templateGraph(t);
      expect(validateGraph(g, h.registry)).toEqual([]);
      for (const n of g.nodes) expect(h.registry.get(n.type), `${n.type} exists`).toBeTruthy();
      for (const n of g.nodes.filter((x) => x.type === 'media-in')) expect((n.params.assets as unknown[] | undefined) ?? [], 'no media baked in').toEqual([]);
      expect(availableTemplates(h.registry).map((x) => x.id)).toContain(t.id);
      expect(new Set(g.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(g.nodes.length);
      const out = g.nodes.find((n) => h.registry.get(n.type)?.category === 'output')!;
      expect(out).toBeTruthy();

      if (t.needs) {
        // empty Media In: evaluates without an error (and without a picture)
        await expect(h.evalGraph(g, out.id, { seconds: 0 })).resolves.toBeDefined();
        if (t.needs !== 'sound') {
          holder.image = h.fromFn(160, 90, (x, y) => (Math.abs(x - 80) < 30 && y > 15 ? [200, 150, 120, 255] : [30 + y, 40, 60, 255]), 0.5);
          const run = { ...g, project: { ...g.project, width: 160, height: 90 }, nodes: g.nodes.map((n) => (n.type === 'media-in' ? { ...n, type: 'template-test-source' } : n)) };
          const img = (await h.evalGraph(run, out.id, { seconds: 0 })) as ImageValue | null;
          expect(img, 'renders with media').toBeTruthy();
        }
        return;
      }
      // generator templates: a real picture with no media at all
      const small = { ...g, project: { ...g.project, width: Math.round(g.project.width / 4), height: Math.round(g.project.height / 4) } };
      const img = (await h.evalGraph(small, out.id, { seconds: 0 })) as ImageValue | null;
      expect(img, 'a picture without any media').toBeTruthy();
      const px = await h.pixels(img);
      let lit = 0;
      for (let i = 0; i < px.data.length; i += 4) if (px.data[i + 3] > 0 && px.data[i] + px.data[i + 1] + px.data[i + 2] > 12) lit++;
      expect(lit).toBeGreaterThan(px.width * px.height * 0.02);
    }, 90000);

    it(`${t.id}: shares as a link and comes back unchanged in shape`, async () => {
      const h = await harness();
      const link = encodeShareLink(templateGraph(t), h.registry);
      expect(link.size).not.toBe('too-large');
      const back = decodeShareLink(link.payload, h.registry).graph;
      expect(back.nodes.map((n) => n.type)).toEqual(t.graph.nodes.map((n) => n.type));
      expect(back.edges.length).toBe(t.graph.edges.length);
    });
  }
});

describe('start screen helpers', () => {
  const reg = { get: (id: string) => ({ 'media-in': { category: 'input' }, 'image-out': { category: 'output' }, blur: { category: 'filter' } } as Record<string, { category: string }>)[id] };
  const doc = (nodes: { id: string; type: string; params?: Record<string, unknown> }[]) => ({ ...templateGraph(TEMPLATES[0]), nodes: nodes.map((n) => ({ x: 0, y: 0, params: {}, ...n })), edges: [] });
  it('a fresh project (empty media in and an output) is blank, anything else is not', async () => {
    const { isBlankGraph } = await import('./templates');
    expect(isBlankGraph(doc([{ id: 'a', type: 'media-in' }, { id: 'b', type: 'image-out' }]), reg)).toBe(true);
    expect(isBlankGraph(doc([{ id: 'a', type: 'media-in', params: { assets: ['x'] } }, { id: 'b', type: 'image-out' }]), reg)).toBe(false);
    expect(isBlankGraph(doc([{ id: 'a', type: 'media-in' }, { id: 'c', type: 'blur' }, { id: 'b', type: 'image-out' }]), reg)).toBe(false);
    expect(isBlankGraph(doc([]), reg)).toBe(true);
  });
  it('the hash changes when a template changes', async () => {
    const { templateHash } = await import('./templates');
    const t = TEMPLATES[0];
    const edited = { ...t, graph: { ...t.graph, name: 'other' } };
    expect(templateHash(t)).toBe(templateHash(t));
    expect(templateHash(edited)).not.toBe(templateHash(t));
  });
});
