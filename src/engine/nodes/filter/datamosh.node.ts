import { defineNode } from '../../define';
import { pullFrames } from '../../lib/fx-video';
import type { ImageValue } from '../../types';

/**
 * HOW IT WORKS: video compressors send a key frame, then only "motion" for the frames after it. If the key frame is
 * dropped, the decoder keeps applying new motion to the OLD picture, so shapes smear and melt. We do the same:
 * inside the mosh span the picture starts from a held frame and, frame after frame, is warped by block motion
 * estimated between consecutive input frames (block matching on a coarse grid). The picture at frame f is computed
 * in closed form from at most `Frames to melt` earlier frames (back to the last refresh), so the cost per frame is
 * bounded: one block-matching pass and one warp pass per step, and one re-render of the input per step.
 */
export default defineNode({
  id: 'datamosh',
  title: 'Datamosh Span',
  category: 'filter',
  description:
    'Datamosh over a chosen span: the look of a video that lost its key frames. During a chosen part of the loop the picture stops updating and is only smeared by the motion of the new frames, so shapes melt and drag. Needs moving footage; a still picture comes back unchanged. Inherently temporal: set the span to 0 length to switch it off. Use this to mosh one moment; for a repeating mosh with automatic key frames use Motion Smear.',
  keywords: ['datamosh', 'mosh', 'glitch', 'melt', 'smear', 'compression', 'key frame', 'i-frame', 'p-frame', 'bloom', 'motion vectors', 'video', 'data mosh'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    holdStart: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.005, unit: 'norm', label: 'Mosh starts at', group: 'When', hint: 'Position in the loop where the key frame is dropped. Wraps around the loop end.' },
    holdLength: { type: 'number', default: 0.4, min: 0, max: 1, step: 0.005, unit: 'norm', label: 'Mosh lasts', group: 'When', hint: 'Share of the loop. 0 = off.' },
    refreshEvery: { type: 'number', default: 0, min: 0, max: 240, softMax: 60, step: 1, integer: true, label: 'Key frame every', group: 'When', hint: '0 = never inside the span. Otherwise the picture snaps back to the real frame this often, then melts again.' },
    maxFrames: { type: 'number', default: 12, min: 1, max: 96, softMax: 24, step: 1, integer: true, label: 'Max melt frames', group: 'Quality', hint: 'The most frames of motion that pile up before the picture is rebuilt. Each one re-renders the input once, so this is the cost limit.' },
    blockSize: { type: 'number', default: 16, min: 4, max: 128, softMax: 64, step: 1, unit: 'px', label: 'Block size', group: 'Motion', hint: 'Size of the motion blocks. Larger = chunkier smear.' },
    search: { type: 'number', default: 16, min: 2, max: 128, softMax: 48, step: 1, unit: 'px', label: 'Max motion', hint: 'The largest motion that is followed.', group: 'Motion' },
    smear: { type: 'number', default: 1, min: 0, max: 2, step: 0.01, label: 'Smear amount', group: 'Motion', hint: '0 = the held frame stays frozen, 1 = follows the motion exactly, 2 = exaggerated.' },
  },
  summary: (p) => `${Math.round(p.holdLength * 100)}% of loop from ${Math.round(p.holdStart * 100)}%`,
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    if (p.holdLength <= 0) return { image: src };
    const t = ctx.time;
    const T = Math.max(1, Math.round(t.duration * t.fps));
    const f = ((t.frame % T) + T) % T;
    const s = Math.round(p.holdStart * T);
    const L = Math.max(1, Math.round(p.holdLength * T));
    const k = (((f - s) % T) + T) % T;
    if (k >= L) return { image: src };
    const rel = p.refreshEvery > 0 ? k % p.refreshEvery : k;
    const steps = Math.min(rel, Math.round(p.maxFrames));
    if (steps <= 0) return { image: src };

    const frames: ImageValue[] = [];
    for (let j = 0; j <= steps; j++) {
      if (j === steps) frames.push(src);
      else {
        const fr = await pullFrames(ctx as never, 'image', j - steps);
        frames.push(fr && fr.width === src.width && fr.height === src.height ? fr : src);
      }
    }
    const B = Math.max(4, Math.round(p.blockSize));
    const mvSize = { width: Math.ceil(src.width / B), height: Math.ceil(src.height / B), unit: 1 };
    const range = Math.max(1, p.search);
    const stepPx = Math.max(1, range / 6);
    const half = Math.max(1, Math.round(range / stepPx));
    let pic = frames[0];
    for (let j = 1; j <= steps; j++) {
      const mv = gpu.pass({
        label: 'mosh-match',
        size: mvSize,
        format: 'rgba16float',
        textures: { cur: frames[j], prev: frames[j - 1] },
        uniforms: { blk: B, stepPx, half },
        wgsl: /* wgsl */ `
fn lum(t: texture_2d<f32>, q: vec2f) -> f32 { return luma(textureSampleLevel(t, smp, q / vec2f(textureDimensions(t)), 0.0).rgb); }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let origin = floor(px) * u.blk;
  var best = 1e9;
  var bestD = vec2f(0.0);
  let n = i32(u.half);
  for (var j = -n; j <= n; j++) {
    for (var i = -n; i <= n; i++) {
      let d = vec2f(f32(i), f32(j)) * u.stepPx;
      var sad = 0.0;
      for (var b = 0; b < 4; b++) {
        for (var a = 0; a < 4; a++) {
          let q = origin + (vec2f(f32(a), f32(b)) + 0.5) * u.blk * 0.25;
          sad += abs(lum(cur, q) - lum(prev, q + d));
        }
      }
      sad += length(d) * 0.0004;   // prefer the smaller motion when it is a tie
      if (sad < best) { best = sad; bestD = d; }
    }
  }
  return vec4f(bestD, best, 1.0);
}`,
      });
      pic = gpu.pass({
        label: 'mosh-warp',
        size: src,
        textures: { pic, mv },
        uniforms: { blk: B, amt: p.smear },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let d = textureLoad(mv, vec2i(floor(px / u.blk)), 0).xy;
  return textureSampleLevel(pic, smp, clamp(uv + d * u.amt / u.size, vec2f(0.0), vec2f(1.0)), 0.0);
}`,
      });
    }
    return { image: pic };
  },
});
