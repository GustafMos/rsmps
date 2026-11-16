import { defineNode } from '../../define';
import { FLOW_DEFAULTS, flowBetween, flowGrid, flowPreview, pullFrameAbs } from '../../lib/optical-flow';

export default defineNode({
  id: 'optical-flow',
  title: 'Optical Flow',
  category: 'track',
  description:
    'Measures how every part of the picture moved since the previous frame (pyramidal Lucas-Kanade on the GPU). Outputs a flow image for other nodes (red/green = motion as a fraction of the picture size per frame, right and down positive) and a colour picture of it: hue = direction, brightness = speed. Needs moving footage; a still picture has no motion.',
  keywords: ['motion', 'flow', 'vectors', 'motion vectors', 'lucas kanade', 'movement', 'direction', 'velocity', 'displacement'],
  usesPrevious: true,
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: {
    flow: { type: 'image', label: 'Flow (rg = motion)' },
    preview: { type: 'image', label: 'Color wheel' },
  },
  params: {
    resolution: {
      type: 'number',
      default: FLOW_DEFAULTS.scale,
      min: 0.1,
      max: 1,
      step: 0.05,
      label: 'Flow resolution',
      group: 'Quality',
      hint: 'Flow is measured at this fraction of the picture size (0.5 = half). Cost scales with the pixel count. The playback proxy already shrinks the picture, so flow gets cheaper while playing.',
    },
    levels: { type: 'number', default: FLOW_DEFAULTS.levels, min: 1, max: 6, softMax: 4, step: 1, integer: true, label: 'Pyramid levels', group: 'Quality', hint: 'Each level doubles the largest motion that can be followed (about 2 texels x 2^levels at flow resolution).' },
    iterations: { type: 'number', default: FLOW_DEFAULTS.iterations, min: 1, max: 6, softMax: 3, step: 1, integer: true, label: 'Level iterations', group: 'Quality', hint: 'Solver passes per level. Cost = levels x iterations small passes.' },
    window: { type: 'number', default: FLOW_DEFAULTS.window, min: 1, max: 6, softMax: 4, step: 1, integer: true, label: 'Window radius', group: 'Quality', hint: 'Larger = smoother, more stable flow in flat areas, softer edges.' },
    visScale: { type: 'number', default: 4, min: 0.1, max: 200, softMax: 20, step: 0.1, unit: 'px', label: 'Full-scale speed', group: 'Preview', hint: 'Motion of this many pixels per frame shows at full brightness in the colour wheel.' },
  },
  summary: (p) => `${p.levels} levels x ${p.iterations} · ${Math.round(p.resolution * 100)}%`,
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const opts = { scale: p.resolution, levels: p.levels, iterations: p.iterations, window: p.window };
    let flow;
    if (!ctx.inputVaries('image')) {
      // A still picture: nothing moves. No clock, no pull: the result is static and cached.
      flow = flowBetween(gpu, src, null, null, opts);
    } else {
      const t = ctx.time;
      const paramsMove = Object.keys(p).some((k) => ctx.inputVaries(k as never));
      const cached = paramsMove ? null : ctx.previous();
      // The previous frame's luma rides in the cached flow's blue channel: no pull and one pass less. Otherwise rebuild it from the input.
      const prev = cached ? null : await pullFrameAbs(ctx as never, 'image', t.frame - 1, src);
      flow = flowBetween(gpu, src, prev ?? src, cached, opts);
    }
    return { flow, preview: flowPreview(gpu, flow, src, p.visScale) };
  },
});
