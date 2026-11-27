import { defineNode } from '../../define';
import { centerOf, sizeOf, validRegions } from '../../lib/track-core';

export default defineNode({
  id: 'region-info',
  title: 'Region Info',
  category: 'track',
  description:
    'Reads numbers from one region: center position, size, score, id and how many regions there are. Wire them into any number setting (every number setting has a socket) so tracked positions can drive any effect.',
  keywords: ['position', 'x', 'y', 'size', 'number', 'drive', 'value', 'centre', 'center', 'info', 'count'],
  guide: {
    does: 'Reads numbers (position, size, id, count) from one region, so they can drive any setting.',
    steps: [
      'Wire regions into Regions to read.',
      'Choose which region: by number, or by id.',
      'Wire an output such as Center X into any number setting of another node.',
    ],
    needs: [
      { input: 'regions', hint: 'The regions to read numbers from.' },
    ],
    seeAlso: ['track', 'detect-blobs'],
  },
  inputs: { regions: { type: 'regions', required: true, label: 'Regions to read' } },
  outputs: {
    x: { type: 'number', label: 'Center X' },
    y: { type: 'number', label: 'Center Y' },
    width: { type: 'number', label: 'Width' },
    height: { type: 'number', label: 'Height' },
    score: { type: 'number', label: 'Score' },
    id: { type: 'number', label: 'Id' },
    count: { type: 'number', label: 'Count' },
    center: { type: 'vector', label: 'Center XY' },
    size: { type: 'vector', label: 'Size XY' },
  },
  params: {
    index: { type: 'number', default: 0, min: 0, max: 63, step: 1, integer: true, label: 'Region number', hint: '0 = the first region in the list.' },
    id: { type: 'number', default: -1, min: -1, max: 100000, step: 1, integer: true, label: 'Or region with id', hint: '-1 = use the region number instead.' },
    fallback: { type: 'number', default: 0, min: -1000, max: 1000, step: 0.01, label: 'Fallback value', hint: 'Used for position, size and score when the region does not exist.' },
  },
  summary: (p) => (p.id >= 0 ? `id ${p.id}` : `region #${p.index}`),
  render(ctx) {
    const p = ctx.params;
    const items = validRegions(ctx.in.regions.items);
    const r = p.id >= 0 ? items.find((x) => x.id === p.id) : items[p.index];
    if (!r) {
      return { x: p.fallback, y: p.fallback, width: p.fallback, height: p.fallback, score: p.fallback, id: -1, count: items.length, center: [p.fallback, p.fallback, 0], size: [p.fallback, p.fallback, 0] };
    }
    const [x, y] = centerOf(r.box);
    const [width, height] = sizeOf(r.box);
    return { x, y, width, height, score: r.score, id: r.id, count: items.length, center: [x, y, 0], size: [width, height, 0] };
  },
});
