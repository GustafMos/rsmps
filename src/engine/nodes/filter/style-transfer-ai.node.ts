/**
 * AI Style Transfer: the real thing. Style Melt IMITATES the music-video "style transfer" transition by moving texture around; this
 * node runs a neural network (AdaIN, lib/style-ai-bridge.ts) in the app: picture A is repainted in the colours and brush texture of
 * picture B, its shapes then melt into B's, and the painting settles into the real picture B.
 *
 * A frame costs several runs of the network (seconds on a processor), so it cannot be computed while playing. The result exists only
 * as a stored sequence made by a job (PROCESS MODE, docs/ENGINE.md), like Codec Datamosh:
 *
 *   1. for every frame of the transition, A and B are rendered small ("Longest side");
 *   2. the encoder turns both into feature maps; between the two networks the features are blended and given a style between A's
 *      and B's (lib/style-ai-math.ts); the decoder paints the result;
 *   3. the painted frames are steadied against the frame before and stored.
 *
 * What is stored is ONLY the network's painting. The node shows it over the real pictures: nothing of it at the first and the last
 * moment of the transition, all of it in between. So progress 0 is exactly A and progress 1 is exactly B at full sharpness, and how
 * much of the painting is shown can be changed without rendering again. Outside the transition the node costs one pass-through.
 */
import { defineNode } from '../../define';
import { STYLE_AI_MESSAGES, STYLE_AI_MODEL, getStyleAiService } from '../../lib/style-ai-bridge';
import { adainMix, addTile, featureStats, joinFrame, packTile, resizeRgba, styleMix, stylePlan, styleProgress, styleStages, styleTileCount, styleTiles, styleWorkSize, toRgba, type StyleDrive, type StyleStats, type StyleTiming } from '../../lib/style-ai-math';
import { stableStringify } from '../../lib/stable-json';
import type { ImageValue, ProcessCtx } from '../../types';

interface TimingParams {
  drive: string;
  start: number;
  length: number;
}

function timingOf(p: TimingParams, frames: number, loop: boolean): StyleTiming {
  const drive: StyleDrive = p.drive === 'pingpong' || p.drive === 'span' ? p.drive : 'loop';
  return { drive, start: Math.min(1, Math.max(0, p.start / 100)), length: Math.min(1, Math.max(0, p.length / 100)), frames: Math.max(1, Math.round(frames)), loop };
}

const sameBytes = (a: Uint8ClampedArray, b: Uint8ClampedArray | null) => !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** One side (A or B) of the job: its last picture and the features of that picture's tiles, so a still is encoded once, not every frame. */
interface Side {
  rgba: Uint8ClampedArray | null;
  feats: Float32Array[];
  stats: StyleStats | null;
}

async function paint(job: ProcessCtx): Promise<Record<string, unknown>> {
  const svc = getStyleAiService();
  if (!svc) throw new Error(STYLE_AI_MESSAGES.noRuntime);
  if (!(await svc.modelReady())) throw new Error(STYLE_AI_MESSAGES.noModel);
  const p = job.params as unknown as TimingParams & { size: string; steady: number };
  const timing = timingOf(p, job.frames, job.loop);
  const plan = stylePlan(timing);
  if (plan.count <= 0) throw new Error(STYLE_AI_MESSAGES.noFrames);
  const long = Number(p.size) || 512;
  const engine = await svc.open(job.signal);
  // Render no larger than what the network is given: every extra pixel would be thrown away.
  const proxy = Math.min(1, Math.max(0.05, long / Math.max(job.canvas.width, job.canvas.height, 1)));

  const grab = async (input: 'a' | 'b', f: number, label: string) => {
    const pulled = await job.pull(input, { frame: f, proxy, quality: 'final' });
    try {
      const v = pulled.value;
      if (!(v && typeof v === 'object' && 'texture' in v)) throw new Error([...pulled.errors.values()][0] ?? `Picture ${label} of the AI Style Transfer node is empty. Connect a picture first.`);
      const img = v as ImageValue;
      // Premultiplied = the picture over black: the network and the stored frames have no transparency.
      return { rgba: await job.gpu.read(img, false), width: img.width, height: img.height };
    } finally {
      pulled.release();
    }
  };

  const T = STYLE_AI_MODEL.tile;
  let work: { width: number; height: number } | null = null;
  let full = { width: 0, height: 0 };
  let tiles = styleTiles(T, T);
  const sides: Record<'a' | 'b', Side> = { a: { rgba: null, feats: [], stats: null }, b: { rgba: null, feats: [], stats: null } };
  const input = new Float32Array(3 * T * T);
  const mixed = new Float32Array(STYLE_AI_MODEL.channels * (T / STYLE_AI_MODEL.stride) ** 2);
  let previous: Float32Array | null = null;
  const blobs: Blob[] = [];
  const t0 = Date.now();

  /** Features and style of one side at this frame, from the memo when the picture is the same as in the frame before. */
  const encodeSide = async (name: 'a' | 'b', f: number) => {
    const g = await grab(name, f, name === 'a' ? 'A' : 'B');
    if (!work) {
      work = styleWorkSize(g.width, g.height, long);
      tiles = styleTiles(work.width, work.height);
      // Size of the picture this node replaces, at full resolution: the stored (smaller) painting is enlarged back to it.
      full = { width: Math.round(g.width / proxy), height: Math.round(g.height / proxy) };
    }
    const rgba = resizeRgba(g.rgba, g.width, g.height, work.width, work.height);
    const side = sides[name];
    if (side.stats && sameBytes(rgba, side.rgba)) return;
    side.rgba = rgba;
    side.feats = [];
    for (const tile of tiles) {
      await job.yield();
      side.feats.push(await engine.encode(packTile(rgba, work.width, work.height, tile.x, tile.y, input), job.signal));
    }
    side.stats = featureStats(side.feats, work.width / STYLE_AI_MODEL.stride, work.height / STYLE_AI_MODEL.stride);
  };

  for (let i = 0; i < plan.count; i++) {
    await job.yield();
    const f = plan.first + i;
    const st = styleStages(styleProgress(f, timing));
    // A is needed while any of its shapes or its style is left; B from the moment its style starts to arrive.
    const needA = st.shape < 1 || st.lead < 1 || !work;
    const needB = st.shape > 0 || st.lead > 0;
    if (needA) await encodeSide('a', f);
    if (needB) await encodeSide('b', f);
    const size = work!;
    const sa = (needA ? sides.a.stats : sides.b.stats)!;
    const sb = (needB ? sides.b.stats : sides.a.stats)!;
    const acc = new Float32Array(size.width * size.height * 3);
    const weight = new Float32Array(size.width * size.height);
    for (let k = 0; k < tiles.length; k++) {
      await job.yield();
      adainMix(needA && st.shape < 1 ? sides.a.feats[k] : null, needB && st.shape > 0 ? sides.b.feats[k] : null, sa, sb, st.shape, st.lead, mixed);
      addTile(await engine.decode(mixed, job.signal), tiles[k], size.width, size.height, acc, weight);
    }
    previous = joinFrame(acc, weight, previous, p.steady);
    blobs.push(await engine.toBlob(toRgba(previous, size.width, size.height), size.width, size.height));
    const each = (Date.now() - t0) / (i + 1);
    const left = each * (plan.count - i - 1);
    job.progress((i + 1) / plan.count, `Painting frame ${i + 1} of ${plan.count}${left > 1500 ? `, about ${left > 90000 ? `${Math.round(left / 60000)} min` : `${Math.round(left / 1000)} s`} left` : ''}${engine.note ? `, ${engine.note}` : ''}`, { frame: i + 1, frames: plan.count });
  }
  const size = work!;
  job.store.sequence('frames', blobs, { fps: job.fps, width: size.width, height: size.height });
  return {
    model: 'AdaIN',
    revision: STYLE_AI_MODEL.revision,
    provider: engine.provider,
    // The timing the frames were made with: the node shows a (stale) result with ITS timing, not with settings changed since.
    drive: timing.drive,
    start: timing.start,
    length: timing.length,
    frames: timing.frames,
    loop: timing.loop,
    first: plan.first,
    count: plan.count,
    width: full.width,
    height: full.height,
    tiles: tiles.length,
    secondsPerFrame: Number(((Date.now() - t0) / 1000 / plan.count).toFixed(2)),
    item: job.item.dependent ? job.item.index : null,
  };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export default defineNode({
  id: 'style-transfer-ai',
  title: 'AI Style Transfer',
  category: 'filter',
  description:
    'A transition made by a real neural network that runs on your own computer: picture A is repainted in the colours and brush texture of picture B, melts into B’s shapes and settles as B, the "AI style transfer" look of music videos. It has to be rendered once (the Render button): until then the node shows a plain dissolve, afterwards the stored painting plays. Needs a 27 MB model you download yourself. Style Melt is the instant imitation without a network.',
  keywords: ['style transfer', 'ai', 'neural', 'network', 'transition', 'adain', 'painting', 'repaint', 'morph', 'melt', 'music video', 'between two clips', 'dream', 'model', 'bake', 'van gogh'],
  inputs: {
    a: { type: 'image', required: true, lazy: true, label: 'A (from)' },
    b: { type: 'image', required: true, lazy: true, label: 'B (to)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    drive: {
      type: 'enum',
      default: 'loop',
      options: [
        { value: 'loop', label: 'A to B over the loop' },
        { value: 'pingpong', label: 'A to B and back' },
        { value: 'span', label: 'A part of the project' },
      ],
      label: 'Driven by',
      hint: 'When the transition happens. It is rendered ahead, so it follows the project’s frames and cannot be wired to a number. A part of the project: A before it, B after it, both untouched.',
    },
    start: { type: 'number', default: 25, min: 0, max: 100, step: 0.5, label: 'Start %', visibleIf: (p) => p.drive === 'span', hint: 'Where the transition begins, percent of the project length.' },
    length: { type: 'number', default: 50, min: 1, max: 100, step: 0.5, label: 'Length %', visibleIf: (p) => p.drive === 'span', hint: 'How long the transition is, percent of the project length. Only these frames are rendered.' },
    size: {
      type: 'enum',
      default: '512',
      options: [
        { value: '512', label: '512 px, fastest' },
        { value: '768', label: '768 px' },
        { value: '896', label: '896 px, most detail' },
      ],
      label: 'Longest side',
      hint: 'Size of the painting; it is enlarged to the frame afterwards. The network paints 512 px squares: a 16:9 frame is one square at 512 and two at 768 or 896, so those take twice as long. Larger also means finer brush strokes.',
    },
    steady: { type: 'number', default: 0.3, min: 0, max: 0.9, step: 0.01, label: 'Steady', hint: 'The network repaints every frame from nothing, so the strokes flicker. This blends each painted frame with the one before. High values calm it down but fast motion leaves a smear.' },
    strength: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Painting', group: 'Shown', hint: 'How much of the network’s painting is shown in the middle of the transition; the rest is a plain dissolve. Changing it does not need a new render.' },
    fade: { type: 'number', default: 0.15, min: 0.02, max: 0.5, step: 0.01, label: 'Ends fade', group: 'Shown', hint: 'How much of the transition the painting takes to appear at the start and to give way to the real picture B at the end. Changing it does not need a new render.' },
  },
  process: {
    title: 'Render',
    description: 'Run the style transfer network on every frame of the transition and store the painted frames.',
    // Once it has run, the last painting stays on screen while settings are tried out, and the badge says it is stale.
    standIn: 'last',
    // The dissolve shown before it has run is not what this node is for: an export must not silently contain it.
    required: 'always',
    auto: false,
    gpu: true,
    // Only what changes the stored painting. "Painting" and "Ends fade" act when it is shown.
    signature: (p, sigs) => `${stableStringify({ drive: p.drive, start: p.drive === 'span' ? p.start : 0, length: p.drive === 'span' ? p.length : 0, size: p.size, steady: p.steady, model: STYLE_AI_MODEL.encoder, rev: STYLE_AI_MODEL.revision })}|${sigs.a ?? ''}|${sigs.b ?? ''}`,
    estimate: (p, project) => {
      const total = Math.max(1, Math.round(project.duration * project.fps));
      const frames = stylePlan(timingOf(p, total, project.loop)).count;
      const runs = styleTileCount(project.width, project.height, Number(p.size) || 512) * 3;
      // Measured on the processor (WASM): about 1.6 s per run with four threads, about 5 s with one (a page that is not cross-origin isolated).
      return { frames, note: `${runs} runs of the network per frame. Without WebGPU that is about ${Math.round(runs * 1.6)} to ${Math.round(runs * 5)} s per frame on a desktop processor; a GPU is far faster` };
    },
    async run(job) {
      return { meta: await paint(job as unknown as ProcessCtx) };
    },
  },
  summary: (p) => `${p.drive === 'loop' ? 'A to B over the loop' : p.drive === 'pingpong' ? 'A to B and back' : `from ${p.start}% for ${p.length}%`} · ${p.size} px`,
  async render(ctx) {
    const ps = ctx.process!;
    const p = ctx.params;
    const result = ps.servable ? ps.result : null;
    const seq = result?.items.frames;
    // A painting made for one batch item serves only that item.
    const itemOk = !result || result.meta.item === null || result.meta.item === undefined || result.meta.item === ctx.item.index;
    const meta = result && seq && itemOk ? result.meta : null;
    const total = Math.max(1, Math.round(ctx.time.duration * ctx.time.fps));
    // A stored painting is shown with the timing it was made with (it may be stale); without one, the settings as they are now.
    const timing: StyleTiming = meta
      ? { drive: (meta.drive as StyleDrive) ?? 'loop', start: num(meta.start, 0), length: num(meta.length, 1), frames: Math.max(1, num(meta.frames, total)), loop: meta.loop !== false }
      : timingOf(p, total, ctx.time.loop);
    const n = timing.frames;
    const f = ctx.time.loop ? ((ctx.time.frame % n) + n) % n : Math.min(n - 1, Math.max(0, ctx.time.frame));
    const t = styleProgress(f, timing);
    // Outside the transition: the real pictures, untouched and at their own cost only.
    if (t <= 0) return { image: (await ctx.pull('a')) ?? (await ctx.pull('b')) };
    if (t >= 1) return { image: (await ctx.pull('b')) ?? (await ctx.pull('a')) };
    const shape = styleStages(t).shape;

    const dissolve = async () => {
      const a = await ctx.pull('a');
      const b = await ctx.pull('b');
      if (!a || !b) return { image: a ?? b };
      const image = ctx.gpu.pass({
        label: 'ai style transfer dissolve',
        size: a,
        textures: { a, b },
        uniforms: { shape },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return mix(textureSampleLevel(a, smp, uv, 0.0), textureSampleLevel(b, smp, uv, 0.0), u.shape); }',
      });
      return { image };
    };
    if (!meta || !seq) return dissolve();

    const idx = f - num(meta.first, 0);
    const net = styleMix(t, p.fade) * Math.min(1, Math.max(0, p.strength));
    if (idx < 0 || idx >= Math.max(1, seq.frames ?? num(meta.count, 0)) || net <= 0) return dissolve();
    const fullW = num(meta.width, 0) || seq.width || 0;
    const fullH = num(meta.height, 0) || seq.height || 0;
    const width = Math.max(1, Math.round(fullW * ctx.proxy));
    const height = Math.max(1, Math.round(fullH * ctx.proxy));
    const storedLong = Math.max(seq.width ?? 0, seq.height ?? 0);
    const wanted = Math.max(width, height);
    const frame = await ps.frame('frames', idx, storedLong > 0 && wanted < storedLong - 0.5 ? Math.ceil(wanted) : 0);
    if (!frame) return dissolve();
    const painting: ImageValue = { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit: ctx.unitFor(frame.width, frame.height) };
    if (net >= 1) {
      // Only the painting is on screen: A and B are not evaluated at all.
      if (Math.abs(frame.width - width) <= 2 && Math.abs(frame.height - height) <= 2) return { image: painting };
      const image = ctx.gpu.pass({
        label: 'ai style transfer enlarge',
        size: { width, height, unit: ctx.unitFor(width, height) },
        textures: { src: painting },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(textureSampleLevel(src, smp, uv, 0.0).rgb, 1.0); }',
      });
      return { image };
    }
    const a = await ctx.pull('a');
    const b = await ctx.pull('b');
    const base = a ?? b;
    if (!base) return { image: painting };
    const image = ctx.gpu.pass({
      label: 'ai style transfer show',
      size: base,
      textures: { a: a ?? b, b: b ?? a, src: painting },
      uniforms: { shape, net },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  // the real pictures dissolve underneath; the painting (opaque) lies over them by how far the transition is from its ends
  let real = mix(textureSampleLevel(a, smp, uv, 0.0), textureSampleLevel(b, smp, uv, 0.0), u.shape);
  let painted = vec4f(textureSampleLevel(src, smp, uv, 0.0).rgb, 1.0);
  return mix(real, painted, u.net);
}`,
    });
    return { image };
  },
});
