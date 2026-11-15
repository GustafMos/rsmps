import { defineNode } from '../../define';
import { centerOf, sizeOf, validRegions } from '../../lib/track-core';

export default defineNode({
  id: 'region-info',
  title: 'Region Info',
  category: 'track',
  description:
    'Reads numbers from one region: centre position, size, score, id and how many regions there are. Wire them into any number setting (every number setting has a socket) so tracked positions can drive any effect.',
  keywords: ['position', 'x', 'y', 'size', 'number', 'drive', 'value', 'centre', 'center', 'info', 'count'],
  inputs: { regions: { type: 'regions', required: true, label: 'Regions' } },
  outputs: {
    x: { type: 'number', label: 'Centre X' },
    y: { type: 'number', label: 'Centre Y' },
    width: { type: 'number', label: 'Width' },
    height: { type: 'number', label: 'Height' },
    score: { type: 'number', label: 'Score' },
    id: { type: 'number', label: 'Id' },
    count: { type: 'number', label: 'Count' },
  },
  params: {
    index: { type: 'number', default: 0, min: 0, max: 63, step: 1, integer: true, label: 'Region number', hint: '0 = the first region in the list.' },
    id: { type: 'number', default: -1, min: -1, max: 100000, step: 1, integer: true, label: 'Or region with id', hint: '-1 = use the region number instead.' },
    fallback: { type: 'number', default: 0, min: -1000, max: 1000, step: 0.01, label: 'Value when nothing is found', hint: 'Used for position, size and score when the region does not exist.' },
  },
  summary: (p) => (p.id >= 0 ? `id ${p.id}` : `region #${p.index}`),
  render(ctx) {
    const p = ctx.params;
    const items = validRegions(ctx.in.regions.items);
    const r = p.id >= 0 ? items.find((x) => x.id === p.id) : items[p.index];
    if (!r) {
      return { x: p.fallback, y: p.fallback, width: p.fallback, height: p.fallback, score: p.fallback, id: -1, count: items.length };
    }
    const [x, y] = centerOf(r.box);
    const [width, height] = sizeOf(r.box);
    return { x, y, width, height, score: r.score, id: r.id, count: items.length };
  },
});
