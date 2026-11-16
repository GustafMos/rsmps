import { defineNode } from '../../define';
import { FLOW_DEFAULTS, flowBetween, pullFrameAbs } from '../../lib/optical-flow';
import { mod } from '../../lib/util-time';
import type { ImageValue } from '../../types';

/**
 * Datamosh: a "keyframe" is held, and every later frame only moves its pixels along the measured motion of the playing clip.
 *
 * out[r] = held frame (r = the last refresh frame), out[j] = warp(out[j-1], flow(j)) for j in r+1..f. The fold is bounded by
 * `refresh` and is a pure function of the frame, so any frame renders alone. `ctx.previous()` (the kernel seam) turns playback
 * into one flow estimate and one warp per frame, with identical pixels (tested).
 */
export default defineNode({
  id: 'motion-smear',
  title: 'Motion Smear',
  category: 'time',
  description:
    'Repeating datamosh: a held frame is dragged along the motion of the playing clip, so shapes smear, bloom and melt like a video that lost its key frames. A fresh key frame every few frames snaps it back, so it keeps repeating on its own. Needs moving footage; a still picture comes back unchanged. To mosh just one chosen span of the loop use Datamosh Span.',
  keywords: ['datamosh', 'glitch', 'pixel bleed', 'motion vectors', 'smear', 'melt', 'i-frame', 'p-frame', 'compression', 'macroblock', 'bloom'],
  usesPrevious: true,
  inputs: {
    image: { type: 'image', required: true, label: 'Moving clip' },
    source: { type: 'image', lazy: true, label: 'Held frame (optional)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    refresh: {
      type: 'number',
      default: 24,
      min: 2,
      max: 600,
      softMax: 120,
      step: 1,
      integer: true,
      label: 'Key frame every',
      hint: 'In frames. Cost: playing forward = one flow estimate (about 12 small passes) and one warp per frame. The first frame after a jump in time replays the motion since the last key frame: up to this many estimates. Pick a number that divides the loop length so the loop seam is a key frame.',
    },
    hold: { type: 'number', default: -1, min: -1, max: 100000, softMax: 600, step: 1, integer: true, label: 'Held frame number', hint: '-1 = each key frame is the clip\'s own frame at that moment. Otherwise every key frame shows this one frame of the clip (or of the Held frame input).' },
    bleed: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'Bleed', hint: '0 = the held frame stays frozen, 1 = follows the motion exactly, 2+ = exaggerated.' },
    block: { type: 'number', default: 16, min: 1, max: 128, softMax: 64, step: 1, unit: 'px', label: 'Block size', hint: 'Motion is applied per block: larger = chunkier, more macroblock look. 1 = per pixel.' },
    resolution: { type: 'number', default: FLOW_DEFAULTS.scale, min: 0.1, max: 1, step: 0.05, label: 'Flow resolution', hint: 'Motion is measured at this fraction of the picture size.' },
  },
  summary: (p) => `key frame every ${p.refresh} · bleed ${p.bleed}`,
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    // A still picture has no motion: nothing to smear (the held frame is then the picture itself unless a Held frame is wired).
    if (!ctx.inputVaries('image') && ctx.inputSignature('source') === '') return { image: src };
    const t = ctx.time;
    const total = Math.max(1, Math.round(t.duration * t.fps));
    const f = t.loop ? mod(t.frame, total) : Math.max(0, t.frame);
    const R = Math.max(2, Math.round(p.refresh));
    const r = Math.floor(f / R) * R;
    const opts = { scale: p.resolution, levels: FLOW_DEFAULTS.levels, iterations: FLOW_DEFAULTS.iterations, window: FLOW_DEFAULTS.window };

    const keyframe = async (): Promise<ImageValue> => {
      const at = p.hold >= 0 ? p.hold : r;
      const held = (await ctx.pull('source', { seconds: Math.max(0, t.loop ? mod(at, total) : at) / t.fps })) as ImageValue | null;
      if (held && held.width === src.width && held.height === src.height) return held;
      if (at === f) return src;
      return (await pullFrameAbs(ctx as never, 'image', at, src)) ?? src;
    };

    const warp = (held: ImageValue, flow: ImageValue): ImageValue =>
      gpu.pass({
        label: 'smear-warp',
        size: src,
        textures: { held, flow },
        uniforms: { blk: Math.max(1, p.block), bleed: p.bleed },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = (floor(px / u.blk) + 0.5) * u.blk / u.size;
  let m = textureSampleLevel(flow, smp, clamp(c, vec2f(0.0), vec2f(1.0)), 0.0).rg;
  return textureSampleLevel(held, smp, uv - m * u.bleed, 0.0);
}`,
      });

    if (f === r) return { image: await keyframe() };

    const paramsMove = Object.keys(p).some((k) => ctx.inputVaries(k as never));
    const prev = paramsMove ? null : ctx.previous();
    const before = await pullFrameAbs(ctx as never, 'image', t.frame - 1, src);
    const flowNow = flowBetween(gpu, src, before ?? src, null, opts);
    if (prev && prev.width === src.width && prev.height === src.height) {
      const out = warp(prev, flowNow);
      gpu.recycle(flowNow);
      return { image: out };
    }

    // Fold from the key frame: replay the motion of frames r+1 .. f.
    let pic = await keyframe();
    let last: ImageValue | null = await pullFrameAbs(ctx as never, 'image', r, src);
    for (let j = r + 1; j <= f; j++) {
      const cur = j === f ? src : ((await pullFrameAbs(ctx as never, 'image', j, src)) ?? src);
      const flow = j === f ? flowNow : flowBetween(gpu, cur, last ?? cur, null, opts);
      const next = warp(pic, flow);
      if (pic !== next && j > r + 1) gpu.recycle(pic);
      gpu.recycle(flow);
      pic = next;
      last = cur;
    }
    return { image: pic };
  },
});
