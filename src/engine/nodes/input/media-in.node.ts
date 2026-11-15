import { defineNode } from '../../define';

/**
 * EXEMPLAR — source node. Shows: assets param, batch item, host services, stamping `unit`.
 * Reads the clock only for video so stills stay cached across frames.
 */
export default defineNode({
  id: 'media-in',
  title: 'Media In',
  category: 'input',
  description: 'Images and videos to process. Add many files: the graph runs once per file when exporting a batch.',
  keywords: ['file', 'image', 'video', 'folder', 'batch', 'load'],
  inputs: {},
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    assets: { type: 'assets', default: [], accept: 'image-video', label: 'Media' },
    trim: {
      type: 'vec2',
      default: [0, 1],
      min: 0,
      max: 1,
      step: 0.001,
      unit: 'norm',
      range: true,
      label: 'In / out',
      hint: 'Use only this part of each video: drag the two ends. 0 = start of the clip, 1 = its end.',
    },
    loopVideo: { type: 'bool', default: true, label: 'Loop video', hint: 'Repeat the clip when the project is longer than it.' },
    offset: { type: 'number', default: 0, unit: 's', step: 0.01, label: 'Start offset' },
  },
  summary: (p) => (p.assets.length === 0 ? 'no media' : p.assets.length === 1 ? '1 file' : `${p.assets.length} files`),
  async render(ctx) {
    const { assets } = ctx.params;
    if (assets.length === 0) return { image: null };
    const assetId = assets[ctx.item.index % assets.length];
    const info = ctx.host.assetInfo(assetId);
    if (!info) throw new Error('Media file is missing. Re-add it to this node.');
    let seconds = 0;
    if (info.kind === 'video') {
      // In / out points as fractions of the clip; playback (and looping) stays inside them.
      const a = Math.min(Math.max(Math.min(ctx.params.trim[0], ctx.params.trim[1]), 0), 1) * info.duration;
      const b = Math.min(Math.max(Math.max(ctx.params.trim[0], ctx.params.trim[1]), 0), 1) * info.duration;
      const span = Math.max(b - a, info.fps > 0 ? 1 / info.fps : 0.001);
      const local = ctx.time.seconds + ctx.params.offset;
      seconds = info.duration > 0 ? a + (ctx.params.loopVideo ? ((local % span) + span) % span : Math.min(Math.max(local, 0), span - 1e-4)) : 0;
    }
    const maxSide = ctx.proxy < 1 ? Math.ceil(Math.max(info.width, info.height) * ctx.proxy) : 0;
    const frame = await ctx.host.assetFrame(assetId, seconds, maxSide);
    if (!frame) throw new Error(`Could not decode "${info.name}".`);
    return {
      image: { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit: ctx.unitFor(frame.width, frame.height) },
    };
  },
});
