import { defineNode } from '../../define';
import { DEPTH_AI_MESSAGES, DEPTH_AI_MODEL, getDepthAiService } from '../../lib/depth-ai-bridge';
import {
  blendFrames,
  fromU16,
  interpPlan,
  normaliseDepth,
  processedFrames,
  resizeChannels,
  alignChain,
  clipRange,
  robustRange,
  temporalBlend,
  toU16,
  type DepthRange,
} from '../../lib/depth-ai-math';
import { cropRgba, mergeTiles, tileCrop, tileLayout, tileScale } from '../../lib/depth-ai-tiles';
import { depthHeuristicDefaults, depthMaskPass, depthPreviewPass, renderDepthHeuristic, type DepthHeuristicCtx } from '../../lib/depth-heuristic';
import { stableStringify } from '../../lib/stable-json';
import type { ImageValue, NodeGpu, ProcessView } from '../../types';

/**
 * AI Depth: real monocular depth from a small neural model (Depth Anything V2 Small, Apache-2.0) that runs on YOUR GPU inside the app.
 * Nothing is uploaded. The model is an optional download the user asks for (Plugins > AI models); it is never fetched by this node.
 *
 * It is a PROCESS node (docs/ENGINE.md, "Process mode"): "Estimate depth" walks the clip once, and the result is stored with the project.
 * Until then (and while stale) the node shows the heuristic "Depth from Picture" estimate (the same shared code, standIn 'preview'), so the
 * graph keeps working before the model has run. An export that needs it and does not have it stops (required 'once-run', like Track).
 *
 * The model's output is RELATIVE inverse depth, different in scale and offset for every picture, so the job normalises per CLIP, not per
 * frame (lib/depth-ai-math.ts): each frame is fitted onto the previous one by a robust least-squares scale + shift on the pixels that did not
 * change, one clip-wide 2% / 98% range maps the clip to 0..1, then a zero-phase temporal blend.
 * The result is stored as unsigned 16 bit (no 8-bit banding in Lens Blur) at the model's output size and enlarged on the GPU when shown.
 * Output convention is Depth from Picture's (lib/depth.ts): r = g = b = d in 0..1, white = near, rgba16float: a drop-in for Picture to Splats,
 * Lens Blur, Depth Slice and Image to 3D relief.
 *
 * FINE DETAIL. The model's output is soft (a few hundred pixels across, thin things lost), so two things sharpen it, neither a new model:
 *  - "Edge detail", when the depth is SHOWN (no re-run, like the levels): the enlarged depth is filtered with the picture as the guide
 *    (refine, below), which moves each depth edge onto the picture's edge. It only ever averages depth values, so it cannot paint the
 *    picture's texture into a flat surface.
 *  - "Detail", in the JOB: the model also runs on overlapping tiles and their fine detail is laid over the whole-picture result
 *    (lib/depth-ai-tiles.ts). 4 or 9 more model runs per frame; the stored map is 1.6 or 2.4 times larger per side.
 *
 * LIMITS, said plainly: the temporal blend has no motion compensation (the optical-flow code needs a node render, a process job has none), so it
 * backs off where pixels change fast; a thing the model did not see at all (a single hair at Standard detail) is not invented by Edge detail,
 * which only moves edges that are there; the job reads each frame back once (the GPU shrinks it first, the model input is normalised on the CPU).
 */

/** Frames of this node kept decoded (one clip at a time: a clip's depth is tens of MB). */
const frameMemo = new Map<string, Promise<Uint16Array | null>>();

interface Meta {
  w: number;
  h: number;
  k: number;
  every: number;
  frames: number;
  still: boolean;
  item: number | null;
}

/** Tiles per side for the Detail setting (1 = Standard, also for anything unknown). */
const tilesOf = (detail: unknown): number => (detail === '2' ? 2 : detail === '3' ? 3 : 1);

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function metaOf(m: Record<string, unknown>): Meta {
  return { w: num(m.w, 0), h: num(m.h, 0), k: num(m.k, 0), every: Math.max(1, num(m.every, 1)), frames: Math.max(1, num(m.frames, 1)), still: m.still === true, item: m.item === null || m.item === undefined ? null : num(m.item, 0) };
}

async function loadFrames(ps: ProcessView): Promise<Uint16Array | null> {
  const it = ps.result?.items.depth;
  if (!it) return null;
  const key = `${it.id}@${ps.result?.createdAt}:${it.bytes}`;
  let p = frameMemo.get(key);
  if (!p) {
    frameMemo.clear();
    p = ps.array('depth').then((a) => (a instanceof Uint16Array ? a : null));
    frameMemo.set(key, p);
  }
  return p;
}

/** Edge detail: how different two picture colours may be (0..1 per channel) and still count as the same surface. */
const EDGE_COLOUR = 0.04;
/** Edge detail: depth change per 1/518 of the long side above which a place counts as "on a soft edge" and is trusted less. */
const EDGE_CALM = 0.02;

/**
 * Edge detail: enlarge the stored depth to the picture's size with the PICTURE as the guide (a joint bilateral filter).
 *
 * Every output pixel is a weighted average of the depth around it, where a neighbour counts when (a) it is close, (b) the picture has
 * about the same colour there as here, so depth is not averaged across a visible edge and the depth edge lands on the picture's edge, and
 * (c) the depth map is calm there: the model's own edges are a soft ramp a few texels wide, and the values ON that ramp belong to neither
 * side. Without (c) the ramp survives as a glow around every object; with it both sides take their value from just beyond the ramp.
 *
 * A pixel is moved only when the picture explains why: there is a picture edge within reach, and the pixel's depth lies between its
 * own side and the far side of that edge. Elsewhere the depth is left as it is.
 *
 * Because the result is always an average of depth values, a flat surface stays flat whatever is printed on it: the picture decides only
 * the weights, its brightness never enters the depth.
 */
function refine(gpu: NodeGpu, tex: { texture: GPUTexture }, meta: Meta, src: ImageValue, p: { edge: number; edgeReach: number }): ImageValue {
  // depth and how steep it is, at the stored size. Steepness is measured per 1/518 of the long side, so a tiled (larger) map is judged alike.
  const grad = gpu.pass({
    label: 'ai depth steepness',
    size: { width: meta.w, height: meta.h, unit: 1 },
    format: 'rgba16float',
    textures: { dp: tex },
    uniforms: { k: Math.max(meta.w, meta.h) / 518 },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let t = 1.0 / u.size;
  let c = textureSampleLevel(dp, smp, uv, 0.0).r;
  let gx = textureSampleLevel(dp, smp, uv + vec2f(t.x, 0.0), 0.0).r - textureSampleLevel(dp, smp, uv - vec2f(t.x, 0.0), 0.0).r;
  let gy = textureSampleLevel(dp, smp, uv + vec2f(0.0, t.y), 0.0).r - textureSampleLevel(dp, smp, uv - vec2f(0.0, t.y), 0.0).r;
  return vec4f(c, 0.5 * length(vec2f(gx, gy)) * u.k, 0.0, 1.0);
}`,
  });
  const out = gpu.pass({
    label: 'ai depth edge detail',
    size: src,
    format: 'rgba16float',
    textures: { dp: grad, pic: src },
    uniforms: { amount: p.edge, reach: p.edgeReach / 100, colour: 1 / (2 * EDGE_COLOUR * EDGE_COLOUR), calm: 1 / (EDGE_CALM * EDGE_CALM) },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let here = textureSampleLevel(pic, smp, uv, 0.0).rgb;
  let d0 = textureSampleLevel(dp, smp, uv, 0.0).r;
  // 9 x 9 taps spread over the reach (a share of the long side, so a preview at a smaller size looks like the export)
  let tap = u.reach * max(u.size.x, u.size.y) / 4.0 / u.size;
  var acc = 0.0;
  var ws = 0.0;
  var across = 0.0;
  var wa = 0.0;
  var wn = 0.0;
  for (var j = -4; j <= 4; j++) {
    for (var i = -4; i <= 4; i++) {
      let o = vec2f(f32(i), f32(j));
      let q = uv + o * tap;
      let dc = textureSampleLevel(pic, smp, q, 0.0).rgb - here;
      let s = textureSampleLevel(dp, smp, q, 0.0);
      let close = exp(-dot(o, o) / 8.0);
      let alike = exp(-dot(dc, dc) * u.colour);
      let w = close * alike * (1.0 / (1.0 + s.g * s.g * u.calm) + 0.001);
      acc += w * s.r;
      ws += w;
      // what lies on the OTHER side of the picture's edges around here, and how much of the surroundings that is
      across += close * (1.0 - alike) * s.r;
      wa += close * (1.0 - alike);
      wn += close;
    }
  }
  let mine = acc / max(ws, 1e-6);
  let other = across / max(wa, 1e-6);
  // Move this pixel only when the picture explains it: its depth must lie BETWEEN its own side and what is across a picture edge, which
  // is what a soft edge in the wrong place looks like. A thin dark leg before a dark wall is not that: around it the picture shows no
  // edge (or only edges to things that are just as far), so nothing says the leg is a mistake, and averaging would dissolve it.
  let between = smoothstep(0.0, 0.00002, (d0 - mine) * (other - d0));
  let edge = smoothstep(0.03, 0.15, wa / wn);
  let v = clamp(mix(d0, mine, u.amount * edge * between), 0.0, 1.0);
  return vec4f(v, v, v, 1.0);
}`,
  });
  gpu.recycle(grad);
  return out;
}

/** One-pass level remap shared by the served result and the stand-in: near / far levels and invert. */
function remap(gpu: NodeGpu, depth: ImageValue, p: { nearLevel: number; farLevel: number; invert: boolean }): ImageValue {
  if (p.nearLevel === 1 && p.farLevel === 0 && !p.invert) return depth;
  const out = gpu.pass({
    label: 'ai depth levels',
    size: depth,
    format: 'rgba16float',
    textures: { src: depth },
    uniforms: { nearLevel: p.nearLevel, farLevel: p.farLevel, inv: p.invert },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var v = mix(u.farLevel, u.nearLevel, clamp(textureSampleLevel(src, smp, uv, 0.0).r, 0.0, 1.0));
  if (u.inv > 0.5) { v = 1.0 - v; }
  return vec4f(v, v, v, 1.0);
}`,
  });
  gpu.recycle(depth);
  return out;
}

export default defineNode({
  id: 'depth-ai',
  title: 'AI Depth',
  category: 'composite',
  description:
    'Real depth from a neural model (Depth Anything V2 Small) that runs on your own GPU, nothing is uploaded. Press Estimate depth once: it walks the clip, keeps the depth steady from frame to frame and stores it with the project. White = near, like Depth from Picture, so it plugs into Picture to Splats, Lens Blur, Depth Slice and Image to 3D. Needs a 50 MB model you download yourself (Plugins, AI models). Until it has run, the node shows the quick Depth from Picture guess.',
  keywords: ['depth map', 'depth anything', 'ai', 'neural', 'monocular', 'z depth', 'depth', 'estimate', 'relief', 'model'],
  inputs: { image: { type: 'image', required: true, label: 'Picture' } },
  outputs: { depth: { type: 'image', label: 'Depth' }, preview: { type: 'image', label: 'Preview' }, mask: { type: 'mask', label: 'Mask (near = white)' } },
  optionalOutputs: ['preview', 'mask'],
  params: {
    size: {
      type: 'enum',
      default: '518',
      label: 'Model size',
      hint: 'Long side of the picture given to the model. 392 is fastest, 518 is what the model was trained at, 700 adds a little fine detail and is slower.',
      options: [
        { value: '392', label: '392 px, fast' },
        { value: '518', label: '518 px, balanced' },
        { value: '700', label: '700 px, detailed' },
      ],
    },
    every: {
      type: 'number',
      default: 1,
      min: 1,
      max: 30,
      step: 1,
      integer: true,
      label: 'Every N frames',
      hint: 'Run the model on every Nth frame and blend the frames in between. 2 to 4 is fine for slow footage and much faster.',
    },
    temporal: {
      type: 'number',
      default: 0.5,
      min: 0,
      max: 1,
      step: 0.05,
      label: 'Smoothing in time',
      hint: 'Blends each frame with its neighbors so depth does not shimmer. It backs off where a pixel changes fast (moving edges). The overall near-to-far range is always kept steady across the clip.',
    },
    detail: {
      type: 'enum',
      default: '1',
      label: 'Detail',
      hint: 'High detail also runs the model on overlapping parts of the picture, each at the full Model size, and lays their fine detail (hair, fingers, wires) over the whole-picture result. High is 4 more model runs per frame, Very high is 9 more, and the stored depth is 1.6 or 2.4 times larger per side. It helps most when the picture is larger than the Model size.',
      options: [
        { value: '1', label: 'Standard' },
        { value: '2', label: 'High, 2 x 2 tiles' },
        { value: '3', label: 'Very high, 3 x 3 tiles' },
      ],
    },
    edge: {
      type: 'number',
      default: 1,
      min: 0,
      max: 1,
      step: 0.05,
      label: 'Edge detail',
      group: 'Output',
      hint: 'Moves the soft edges of the depth onto the edges of the picture, so outlines are crisp and sit where the picture has them. 0 is off: the plain enlarged depth. It never copies the picture into the depth, and changing it does not re-run the model.',
    },
    edgeReach: {
      type: 'number',
      default: 1,
      min: 0.2,
      max: 4,
      step: 0.1,
      unit: '%',
      label: 'Edge reach',
      group: 'Output',
      hint: 'How far Edge detail looks for the matching edge of the picture, as a share of the long side. Raise it when edges are still soft or sit beside the outline, lower it when small parts take the depth of what is behind them.',
    },
    nearLevel: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Near level', group: 'Output', hint: 'Output value of the nearest depth. Move both levels toward each other for a shallower scene. Changing it does not re-run the model.' },
    farLevel: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Far level', group: 'Output', hint: 'Output value of the farthest depth.' },
    invert: { type: 'bool', default: false, label: 'Invert', group: 'Output', hint: 'Black = near.' },
  },
  process: {
    title: 'Estimate depth',
    description: 'Run the AI depth model over the whole clip once and store the result. Afterwards depth is instant and identical in the export.',
    standIn: 'preview',
    // A picture could be processed by itself (cheap), but a clip is not, and the node cannot know which it is when it is declared: always the user's choice.
    auto: false,
    required: 'once-run',
    // Detail is part of the signature only when it is not Standard: a result made before the setting existed is a Standard result and stays valid.
    signature: (p, sigs) =>
      `${stableStringify({ size: p.size, every: p.every, temporal: p.temporal, model: DEPTH_AI_MODEL.id, rev: DEPTH_AI_MODEL.revision, ...(tilesOf(p.detail) > 1 ? { detail: tilesOf(p.detail) } : {}) })}|${sigs.image}`,
    estimate: (p, project) => {
      const total = Math.max(1, Math.round(project.duration * project.fps));
      const frames = processedFrames(total, p.every).length;
      const n = tilesOf(p.detail);
      const long = Number(p.size) * tileScale(n);
      const bytes = Math.round(frames * long * (long * 0.5625) * 2);
      if (n === 1) return { frames, bytes, note: 'about 30 to 70 ms per frame on a modern GPU, seconds per frame without WebGPU' };
      return { frames, bytes, note: `${n * n + 1} model runs per frame, each about 30 to 70 ms on a modern GPU, seconds without WebGPU` };
    },
    async run(job) {
      const svc = getDepthAiService();
      if (!svc) throw new Error(DEPTH_AI_MESSAGES.noRuntime);
      if (!(await svc.modelReady())) throw new Error(DEPTH_AI_MESSAGES.noModel);
      const p = job.params;
      const long = Number(p.size) || 518;
      const total = job.frames;
      const engine = await svc.open(job.signal);
      const tilesPerSide = tilesOf(p.detail);
      // With tiles the picture is fetched as large as the detailed map (never larger than the project): the tiles are cut out of it.
      const proxy = Math.min(1, Math.max(0.05, (long * tileScale(tilesPerSide)) / Math.max(job.canvas.width, job.canvas.height)));

      const grab = async (f: number) => {
        const pulled = await job.pull('image', { frame: f, proxy, quality: 'final' });
        try {
          const v = pulled.value;
          if (!(v && typeof v === 'object' && 'texture' in v)) throw new Error([...pulled.errors.values()][0] ?? 'The picture before the AI Depth node is empty.');
          const img = v as ImageValue;
          const rgba = await job.gpu.read(img, true);
          return { rgba, width: img.width, height: img.height };
        } finally {
          pulled.release();
        }
      };

      // A still picture is one frame of work: if five frames spread over the clip are identical, process just one.
      let list = processedFrames(total, p.every);
      let still = false;
      if (total > 1) {
        const probes = [...new Set([0, Math.floor(total / 4), Math.floor(total / 2), Math.floor((3 * total) / 4), total - 1])];
        const first = await grab(0);
        still = true;
        for (const f of probes.slice(1)) {
          await job.yield();
          const o = await grab(f);
          if (o.width !== first.width || o.height !== first.height || !o.rgba.every((v, i) => v === first.rgba[i])) {
            still = false;
            break;
          }
        }
        if (still) list = [0];
      }

      const raws: Float32Array[] = [];
      const ranges: DepthRange[] = []; // per frame robust range of the raw output, kept in the result for inspection
      let size = { w: 0, h: 0 };
      const t0 = Date.now();
      let bytes = 0;
      for (let i = 0; i < list.length; i++) {
        await job.yield();
        const f = list[i];
        const g = await grab(f);
        const whole = await engine.infer(g.rgba, g.width, g.height, long, job.signal);
        let r = whole;
        if (tilesPerSide > 1) {
          // High detail: the same model on overlapping parts of the picture, merged onto the whole-picture result (lib/depth-ai-tiles.ts)
          const layout = tileLayout(whole.width, whole.height, tilesPerSide);
          const outs: Float32Array[] = [];
          for (const tile of layout.tiles) {
            await job.yield();
            const rect = tileCrop(layout, tile, g.width, g.height);
            const t = await engine.infer(cropRgba(g.rgba, g.width, rect), rect.width, rect.height, long, job.signal);
            // a part's size can round to another multiple of 14 than the whole picture's
            outs.push(t.width === whole.width && t.height === whole.height ? t.data : resizeChannels(t.data, t.width, t.height, whole.width, whole.height, 1));
          }
          r = { data: mergeTiles(whole.data, layout, outs).data, width: layout.width, height: layout.height };
        }
        if (i === 0) size = { w: r.width, h: r.height };
        else if (r.width !== size.w || r.height !== size.h) throw new Error(`Frame ${f + 1} has another size than the first; AI Depth needs one picture size over the clip.`);
        raws.push(r.data);
        ranges.push(robustRange(r.data));
        bytes += r.data.byteLength;
        if (bytes > 1.5 * 1024 * 1024 * 1024) throw new Error('This clip is too long to keep at this model size. Use Every N frames, a smaller Model size, or a shorter project.');
        const left = ((Date.now() - t0) / (i + 1)) * (list.length - i - 1);
        job.progress((i + 1) / (list.length + 1), `Frame ${f + 1} of ${total}${left > 1500 ? `, about ${Math.round(left / 1000)} s left` : ''}${engine.note ? `, ${engine.note}` : ''}`, { frame: f + 1, frames: total });
      }
      job.progress(list.length / (list.length + 1), 'Steadying depth over the clip');
      await job.yield();
      // One coordinate system for the whole clip (each frame fitted onto the one before it), then one clip-wide range: no flicker from the model's
      // per-frame scale and offset. A still has one frame: its own robust range.
      const aligned = alignChain(raws);
      const range = clipRange(aligned.frames);
      const frames = aligned.frames.map((a) => normaliseDepth(a, range, a));
      if (!still) temporalBlend(frames, p.temporal, job.loop && list.length > 2);
      const n = size.w * size.h;
      const all = new Uint16Array(frames.length * n);
      frames.forEach((fr, i) => toU16(fr, all.subarray(i * n, (i + 1) * n)));
      job.store.array('depth', all);
      return {
        meta: {
          w: size.w,
          h: size.h,
          k: frames.length,
          every: still ? 1 : Math.max(1, Math.round(p.every)),
          frames: total,
          still,
          item: job.item.dependent ? job.item.index : null,
          model: DEPTH_AI_MODEL.id,
          revision: DEPTH_AI_MODEL.revision,
          provider: engine.provider,
          detail: tilesPerSide,
          clipRange: [Number(range.lo.toFixed(4)), Number(range.hi.toFixed(4))],
          ranges: ranges.map((r) => [Number(r.lo.toFixed(4)), Number(r.hi.toFixed(4))]),
        },
      };
    },
  },
  summary: (p) => `${p.size} px${tilesOf(p.detail) > 1 ? ` · ${tilesOf(p.detail)} x ${tilesOf(p.detail)} tiles` : ''}${p.every > 1 ? ` · every ${p.every}` : ''}`,
  async render(ctx) {
    const { gpu } = ctx;
    const src = ctx.in.image;
    const p = ctx.params;
    const ps = ctx.process!;
    const meta = ps.servable && ps.result ? metaOf(ps.result.meta) : null;
    if (meta && meta.w > 0 && meta.k > 0 && (meta.item === null || meta.item === ctx.item.index)) {
      const all = await loadFrames(ps);
      if (all && all.length >= meta.w * meta.h * meta.k) {
        const n = meta.w * meta.h;
        const varies = ctx.inputVaries('image') && !meta.still;
        const t = ctx.time;
        const plan = varies ? interpPlan(t.frame, meta.every, meta.k, meta.frames, t.loop) : { a: 0, b: 0, t: 0 };
        const fa = fromU16(all, plan.a * n, n);
        let d = fa;
        if (plan.b !== plan.a && plan.t > 0) d = blendFrames(fa, fromU16(all, plan.b * n, n), plan.t, new Float32Array(n));
        const rgba = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = d[i];
          rgba[i * 4 + 3] = 1;
        }
        const tex = gpu.dataTexture(rgba, meta.w, meta.h);
        const up = p.edge > 0 ? refine(gpu, tex, meta, src, p) : gpu.pass({
          label: 'ai depth enlarge',
          size: src,
          format: 'rgba16float',
          textures: { dp: tex },
          wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let v = clamp(textureSampleLevel(dp, smp, uv, 0.0).r, 0.0, 1.0);
  return vec4f(v, v, v, 1.0);
}`,
        });
        const depth = remap(gpu, up, p);
        return { depth, preview: ctx.wants('preview') ? depthPreviewPass(gpu, src, depth) : null, mask: ctx.wants('mask') ? depthMaskPass(gpu, depth) : null };
      }
    }
    // Stand-in: the quick estimate from Depth from Picture (shared code, its default cues), with this node's levels.
    const est = await renderDepthHeuristic(
      { gpu, nodeId: ctx.nodeId, item: ctx.item, inputSignature: (i) => ctx.inputSignature(i as 'image'), inputVaries: (i) => ctx.inputVaries(i as 'image'), pull: (i, at) => ctx.pull(i as 'image', at), wants: () => false, in: { image: src } } satisfies DepthHeuristicCtx,
      depthHeuristicDefaults(),
    );
    const depth = remap(gpu, est.depth, p);
    return { depth, preview: ctx.wants('preview') ? depthPreviewPass(gpu, src, depth) : null, mask: ctx.wants('mask') ? depthMaskPass(gpu, depth) : null };
  },
});
