/**
 * AI Style Transfer: the real thing. Style Melt IMITATES the music-video "style transfer" transition by moving texture around; this
 * node runs a neural network (AdaIN's two halves, lib/style-ai-bridge.ts) in the app. What it does with them is chosen by the LOOK:
 *
 *  - Painterly: picture A is given the colours and brush texture of picture B (AdaIN: the mean and spread of every feature map),
 *    its shapes then melt into B's. Soft and polite. This is all the node did at first.
 *  - Material: every feature cell of the picture is REPLACED by the most similar cell of the other picture (style swap,
 *    lib/style-ai-swap.ts), so the picture is rebuilt from pieces of the other picture's material.
 *  - Hallucination: the same, put through the networks twice and with the choice of pieces wandering from frame to frame, so the
 *    material swarms.
 *
 * Three ways to use it: A to B (each repainted with the other); A to B with a third picture wired to Style, which both are
 * repainted with in the middle; or held, with no transition, as a plain effect on A.
 *
 * A frame costs several runs of the network (seconds on a processor), so it cannot be computed while playing. The result exists only
 * as a stored sequence made by a job (PROCESS MODE, docs/ENGINE.md), like Codec Datamosh:
 *
 *   1. for every frame to paint, the pictures are rendered small ("Longest side");
 *   2. the encoder turns them into feature maps; between the two networks the features are blended, restyled and swapped
 *      (lib/style-ai-math.ts, lib/style-ai-swap.ts); the decoder paints the result; more passes repeat this on the painting;
 *   3. the painted frames are steadied against the frame before and stored.
 *
 * What is stored is ONLY the network's painting. The node shows it over the real pictures: nothing of it at the first and the last
 * moment of a transition, all of it in between. So progress 0 is exactly A and progress 1 is exactly B at full sharpness, and how
 * much of the painting is shown can be changed without rendering again. Outside the transition the node costs one pass-through.
 */
import { defineNode } from '../../define';
import { STYLE_AI_MESSAGES, STYLE_AI_MODEL, getStyleAiService } from '../../lib/style-ai-bridge';
import { joinFrame, mixStats, resizeRgba, styleMix, stylePlan, styleProgress, styleTileCount, styleTiles, styleWorkSize, toRgba, type StyleDrive, type StyleTiming } from '../../lib/style-ai-math';
import { STYLE_LOOKS, crawlCycles, crawlField, encodeContent, encodeMaterial, paintStyleFrame, styleLook, styleRecipe, styleScratch, type StyleFeatures, type StyleLook, type StyleMaterial, type StyleMode } from '../../lib/style-ai-swap';
import { stableStringify } from '../../lib/stable-json';
import type { ImageValue, ProcessCtx } from '../../types';

interface TimingParams {
  drive: string;
  start: number;
  length: number;
}

interface LookParams {
  look: string;
  material: number;
  pieces: number;
  push: number;
  passes: number;
  crawl: number;
  texture: string;
}

/** `held`: nothing to go to (B is not wired) or the user chose it: the painting is held and there is no transition. */
function timingOf(p: TimingParams, frames: number, loop: boolean, held = false): StyleTiming {
  const drive: StyleDrive = held || p.drive === 'hold' ? 'hold' : p.drive === 'pingpong' || p.drive === 'span' ? p.drive : 'loop';
  return { drive, start: Math.min(1, Math.max(0, p.start / 100)), length: Math.min(1, Math.max(0, p.length / 100)), frames: Math.max(1, Math.round(frames)), loop };
}

const textureOf = (p: { texture: string }) => (p.texture === '0.5' ? 0.5 : p.texture === '2' ? 2 : 1);
const isPainterly = (l: StyleLook) => l.material === 0 && l.push === 1 && l.passes === 1;

const sameBytes = (a: Uint8ClampedArray, b: Uint8ClampedArray | null) => !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** One picture of the job: its last pixels and what the encoder made of them, so a still is encoded once, not every frame. */
interface Side<T extends StyleFeatures = StyleFeatures> {
  rgba: Uint8ClampedArray | null;
  enc: T | null;
}

async function paint(job: ProcessCtx): Promise<Record<string, unknown>> {
  const svc = getStyleAiService();
  if (!svc) throw new Error(STYLE_AI_MESSAGES.noRuntime);
  if (!(await svc.modelReady())) throw new Error(STYLE_AI_MESSAGES.noModel);
  const p = job.params as unknown as TimingParams & LookParams & { size: string; steady: number };
  const long = Number(p.size) || 512;
  const texture = textureOf(p);
  const look = styleLook(p);
  // Render no larger than what the network is given: every extra pixel would be thrown away.
  const proxy = Math.min(1, Math.max(0.05, long / Math.max(job.canvas.width, job.canvas.height, 1)));

  /** Is anything wired there? (An unwired input gives nothing and no error.) Asked once, at a thumbnail's cost. */
  const wired = async (input: string) => {
    const pulled = await job.pull(input, { frame: 0, proxy: 0.05, quality: 'final' });
    try {
      return pulled.value !== null || pulled.errors.size > 0;
    } finally {
      pulled.release();
    }
  };
  const hasB = await wired('b');
  const hasStyle = await wired('style');
  const held = p.drive === 'hold' || !hasB;
  if (held && !hasB && !hasStyle) throw new Error(STYLE_AI_MESSAGES.noMaterial);
  const mode: StyleMode = held ? 'hold' : hasStyle ? 'style' : 'pair';
  /** Where the material comes from. The transition between two pictures takes it from B, which is encoded anyway when it is not resized. */
  const materialInput = hasStyle ? 'style' : 'b';
  const sharedWithB = mode === 'pair' && texture === 1;

  const timing = timingOf(p, job.frames, job.loop, held);
  const plan = stylePlan(timing);
  if (plan.count <= 0) throw new Error(STYLE_AI_MESSAGES.noFrames);
  const engine = await svc.open(job.signal);

  const grab = async (input: string, f: number, label: string, scale = 1) => {
    const pulled = await job.pull(input, { frame: f, proxy: Math.min(1, proxy * scale), quality: 'final' });
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

  let work: { width: number; height: number } | null = null;
  let full = { width: 0, height: 0 };
  let tiles = styleTiles(STYLE_AI_MODEL.tile, STYLE_AI_MODEL.tile);
  const sides: Record<'a' | 'b', Side> = { a: { rgba: null, enc: null }, b: { rgba: null, enc: null } };
  const separate: Side<StyleMaterial> = { rgba: null, enc: null };
  /** B's features seen as material (the transition between two pictures): kept as long as B's picture is the same, with its short forms. */
  let shared: StyleMaterial | null = null;
  const scratch = styleScratch();
  const tick = () => job.yield();
  let bias: Float32Array | null = null;
  let previous: Float32Array | null = null;
  let usedSwap = false;
  const blobs: Blob[] = [];
  const t0 = Date.now();

  /** Features and style of one content picture at this frame, from the memo when the picture is the same as in the frame before. */
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
    if (side.enc && sameBytes(rgba, side.rgba)) return side.enc;
    side.rgba = rgba;
    side.enc = await encodeContent(engine, rgba, work.width, work.height, tiles, scratch.input, job.signal, tick);
    if (name === 'b') shared = null;
    return side.enc;
  };

  /** The material at this frame: B's own features, or the Style picture (or B) encoded at the size "Texture size" asks for. */
  const encodeMaterialAt = async (f: number): Promise<StyleMaterial> => {
    const size = work!;
    if (sharedWithB) {
      const b = await encodeSide('b', f);
      shared ??= { ...b, cw: Math.min(64, size.width / STYLE_AI_MODEL.stride), ch: Math.min(64, size.height / STYLE_AI_MODEL.stride) };
      return shared;
    }
    const g = await grab(materialInput, f, materialInput === 'style' ? 'Style' : 'B', texture);
    // Its own shape is kept (it is only looked at, never put together again); its longest side follows the painting's.
    const ms = styleWorkSize(g.width, g.height, long * texture);
    const rgba = resizeRgba(g.rgba, g.width, g.height, ms.width, ms.height);
    if (separate.enc && sameBytes(rgba, separate.rgba)) return separate.enc;
    separate.rgba = rgba;
    separate.enc = await encodeMaterial(engine, rgba, ms.width, ms.height, scratch.input, job.signal, tick);
    return separate.enc;
  };

  const cycles = crawlCycles(job.duration);
  for (let i = 0; i < plan.count; i++) {
    await job.yield();
    const f = plan.first + i;
    const r = styleRecipe(styleProgress(f, timing), mode, look);
    // A picture is needed while its shapes or its own style have any say (and A once, to learn the size).
    const pair = mode === 'pair';
    const needA = r.shape < 1 || (pair && r.lead < 1) || !work;
    const needB = r.shape > 0;
    const a = needA ? await encodeSide('a', f) : null;
    const b = needB ? await encodeSide('b', f) : null;
    const needMaterial = r.lead > 0 || r.swap > 0;
    const material: StyleMaterial = needMaterial ? await encodeMaterialAt(f) : { ...(a ?? b)!, cw: 0, ch: 0 };
    const size = work!;
    // What the frame's statistics are before the material has any say: A's (B's once A has none), or between the two when a third picture is the material.
    const base = mode === 'style' && a && b ? mixStats(a.stats, b.stats, r.shape) : (a ?? b ?? material).stats;
    const swap = r.swap > 0 && needMaterial;
    if (swap) usedSwap = true;
    if (swap && r.crawl > 0) {
      const n = material.feats.length * 64 * 64;
      if (!bias || bias.length < n) bias = new Float32Array(n);
      crawlField(f / timing.frames, r.crawl, cycles, material.feats.length, bias);
    }
    const out = await paintStyleFrame({
      engine,
      signal: job.signal,
      tick,
      width: size.width,
      height: size.height,
      tiles,
      a: r.shape < 1 ? a : null,
      b: r.shape > 0 ? b : null,
      base,
      material,
      recipe: swap ? r : { ...r, swap: 0 },
      pieces: look.pieces,
      bias: swap && r.crawl > 0 ? bias : null,
      scratch,
    });
    previous = joinFrame(out.acc, out.weight, previous, p.steady);
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
    // How it was painted, for the panel and for showing it the way it was made.
    method: usedSwap ? 'swap' : 'adain',
    material: look.material,
    passes: look.passes,
    crawl: usedSwap ? look.crawl : 0,
    source: mode,
    secondsPerFrame: Number(((Date.now() - t0) / 1000 / plan.count).toFixed(2)),
    item: job.item.dependent ? job.item.index : null,
  };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const custom = (p: Record<string, unknown>) => p.look === 'custom';

export default defineNode({
  id: 'style-transfer-ai',
  title: 'AI Style Transfer',
  category: 'filter',
  description:
    'A transition made by a real neural network that runs on your own computer, the "AI style transfer" look of music videos. Picture A is rebuilt from the material of picture B (or of a third picture wired to Style), its shapes dissolve and re-form as B. Looks go from Painterly (only colours and brush texture) to Hallucination (the picture is made of crawling pieces of the other one). Without B it repaints A the whole time, as a plain effect. It has to be rendered once (the Render button): until then the node shows a plain dissolve, afterwards the stored painting plays. Needs a 27 MB model you download yourself. Style Melt is the instant imitation without a network.',
  keywords: ['style transfer', 'ai', 'neural', 'network', 'transition', 'adain', 'style swap', 'painting', 'repaint', 'morph', 'melt', 'music video', 'between two clips', 'dream', 'hallucination', 'psychedelic', 'texture', 'model', 'bake', 'van gogh'],
  inputs: {
    a: { type: 'image', required: true, lazy: true, label: 'A (from)' },
    b: { type: 'image', lazy: true, label: 'B (to)' },
    style: { type: 'image', lazy: true, label: 'Style (material)' },
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
        { value: 'hold', label: 'Held, no transition' },
      ],
      label: 'Driven by',
      hint: 'When the transition happens. It is rendered ahead, so it follows the project’s frames and cannot be wired to a number. A part of the project: A before it, B after it, both untouched. Held: no transition, A is repainted with the Style picture (or with B) on every frame of the project. That is also what happens when nothing is wired to B.',
    },
    start: { type: 'number', default: 25, min: 0, max: 100, step: 0.5, label: 'Start %', visibleIf: (p) => p.drive === 'span', hint: 'Where the transition begins, percent of the project length.' },
    length: { type: 'number', default: 50, min: 1, max: 100, step: 0.5, label: 'Length %', visibleIf: (p) => p.drive === 'span', hint: 'How long the transition is, percent of the project length. Only these frames are rendered.' },
    look: {
      type: 'enum',
      default: 'hallucination',
      // A node saved before looks existed keeps the painting it always made.
      absent: 'painterly',
      options: [
        { value: 'painterly', label: 'Painterly' },
        { value: 'material', label: 'Material' },
        { value: 'hallucination', label: 'Hallucination' },
        { value: 'custom', label: 'Custom' },
      ],
      label: 'Look',
      hint: 'Painterly: the picture gets the other picture’s colours and brush texture and stays itself (the mildest; one pass). Material: every small piece of the picture is replaced by the most similar piece of the other picture, so it is built from that picture’s material. Hallucination: the same, put through the network twice and with the pieces wandering from frame to frame; about three times slower. Custom: set the parts yourself. A strongly textured picture wired to Style gives by far the strongest result; a smooth photo has little material to give.',
    },
    material: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Material', visibleIf: custom, hint: 'How much of the picture is replaced by pieces of the other picture (style swap). 0 = only its colours and brush texture are taken over (AdaIN), 1 = everything is built from its pieces.' },
    pieces: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Piece size', visibleIf: (p) => custom(p) && Number(p.material) > 0, hint: 'Low: every small cell picks its own best match, a fine mosaic. High: neighbours carry on the same piece of the other picture, so larger recognisable parts of it arrive whole.' },
    push: { type: 'number', default: 1, min: 0, max: 2, step: 0.01, label: 'Style strength', visibleIf: custom, hint: 'How far the other picture’s colours and contrast are applied. 1 = exactly; above 1 they are overdone, which gets harsh and acid. It acts on what Material leaves: with Material at 1 it changes nothing.' },
    passes: { type: 'number', default: 2, min: 1, max: 3, step: 1, integer: true, label: 'Passes', visibleIf: custom, hint: 'How often the painting is fed through the network again. Every pass moves it further from the real picture and closer to pure material, and costs two more runs of the network per frame.' },
    crawl: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Crawl', visibleIf: (p) => custom(p) && Number(p.material) > 0, hint: 'Makes the choice of pieces wander from frame to frame, so the material swarms and boils instead of sticking to the picture. 0 = steady. It turns in whole cycles, so a loop still closes. Steady (below) is its opposite: it calms whatever flickers. Use a little of both for a slow crawl.' },
    texture: {
      type: 'enum',
      default: '1',
      options: [
        { value: '0.5', label: 'Half, fine' },
        { value: '1', label: 'As it is' },
        { value: '2', label: 'Double, coarse' },
      ],
      label: 'Texture size',
      hint: 'The size the other picture is looked at. Half: its details arrive at half their size and there are four times as many of them, a fine swarm. Double: large strokes and big pieces; only the middle of a wide picture is used then. This changes the look a lot.',
    },
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
    steady: { type: 'number', default: 0.3, min: 0, max: 0.9, step: 0.01, label: 'Steady', hint: 'The network repaints every frame from nothing, so the strokes flicker. This blends each painted frame with the one before. High values calm it down but fast motion leaves a smear. It is the opposite of Crawl, which makes the material move on purpose.' },
    strength: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Painting', group: 'Shown', hint: 'How much of the network’s painting is shown in the middle of the transition; the rest is a plain dissolve (held: the plain picture A). Changing it does not need a new render.' },
    fade: { type: 'number', default: 0.15, min: 0.02, max: 0.5, step: 0.01, label: 'Ends fade', group: 'Shown', visibleIf: (p) => p.drive !== 'hold', hint: 'How much of the transition the painting takes to appear at the start and to give way to the real picture B at the end. Changing it does not need a new render.' },
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
    signature: (p, sigs) => {
      const held = p.drive === 'hold' || !sigs.b;
      const look = styleLook(p);
      const timing = { drive: held ? 'hold' : p.drive, start: p.drive === 'span' && !held ? p.start : 0, length: p.drive === 'span' && !held ? p.length : 0, size: p.size, steady: p.steady, model: STYLE_AI_MODEL.encoder, rev: STYLE_AI_MODEL.revision };
      // The painting the node made before it had looks keeps the identity it had, so those stored results are not called out of date.
      if (!held && !sigs.style && isPainterly(look) && p.texture === '1') return `${stableStringify(timing)}|${sigs.a ?? ''}|${sigs.b ?? ''}`;
      const swap = look.material > 0;
      return `${stableStringify({ ...timing, material: look.material, pieces: swap ? look.pieces : 0, push: look.push, passes: look.passes, crawl: swap ? look.crawl : 0, texture: p.texture })}|${sigs.a ?? ''}|${sigs.b ?? ''}|${sigs.style ?? ''}`;
    },
    estimate: (p, project) => {
      const total = Math.max(1, Math.round(project.duration * project.fps));
      const frames = stylePlan(timingOf(p, total, project.loop)).count;
      const look = styleLook(p);
      // Per square of the painting: both pictures in, the painting out, and for every further pass the painting in and out again.
      const runs = styleTileCount(project.width, project.height, Number(p.size) || 512) * (3 + 2 * (look.passes - 1));
      // Measured on the processor (WASM): about 1.6 s per run with four threads, about 5 s with one (a page that is not cross-origin isolated).
      return { frames, note: `Up to ${runs} runs of the network per frame${look.material > 0 ? ', plus about half a second of matching' : ''}. Without WebGPU that is about ${Math.round(runs * 1.6)} to ${Math.round(runs * 5)} s per frame on a desktop processor; a GPU is far faster` };
    },
    async run(job) {
      return { meta: await paint(job as unknown as ProcessCtx) };
    },
  },
  summary: (p) => `${p.look === 'custom' ? 'custom look' : p.look} · ${p.drive === 'hold' ? 'held' : p.drive === 'loop' ? 'A to B over the loop' : p.drive === 'pingpong' ? 'A to B and back' : `from ${p.start}% for ${p.length}%`} · ${p.size} px`,
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
      : timingOf(p, total, ctx.time.loop, ctx.inputSignature('b') === '');
    const n = timing.frames;
    const f = ctx.time.loop ? ((ctx.time.frame % n) + n) % n : Math.min(n - 1, Math.max(0, ctx.time.frame));

    /** The stored painting of project frame `f`, no larger than this evaluation needs; null when there is none for it. */
    const stored = async () => {
      if (!meta || !seq) return null;
      const idx = f - num(meta.first, 0);
      if (idx < 0 || idx >= Math.max(1, seq.frames ?? num(meta.count, 0))) return null;
      const fullW = num(meta.width, 0) || seq.width || 0;
      const fullH = num(meta.height, 0) || seq.height || 0;
      const width = Math.max(1, Math.round(fullW * ctx.proxy));
      const height = Math.max(1, Math.round(fullH * ctx.proxy));
      const storedLong = Math.max(seq.width ?? 0, seq.height ?? 0);
      const wanted = Math.max(width, height);
      const frame = await ps.frame('frames', idx, storedLong > 0 && wanted < storedLong - 0.5 ? Math.ceil(wanted) : 0);
      if (!frame) return null;
      const painting: ImageValue = { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit: ctx.unitFor(frame.width, frame.height) };
      return { painting, width, height, fits: Math.abs(frame.width - width) <= 2 && Math.abs(frame.height - height) <= 2 };
    };
    const enlarge = (s: { painting: ImageValue; width: number; height: number }) =>
      ctx.gpu.pass({
        label: 'ai style transfer enlarge',
        size: { width: s.width, height: s.height, unit: ctx.unitFor(s.width, s.height) },
        textures: { src: s.painting },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(textureSampleLevel(src, smp, uv, 0.0).rgb, 1.0); }',
      });

    if (timing.drive === 'hold') {
      // No transition: the painting over picture A on every frame, by "Painting". Not rendered yet = picture A as it is.
      const net = Math.min(1, Math.max(0, p.strength));
      const s = net > 0 ? await stored() : null;
      if (!s) return { image: await ctx.pull('a') };
      if (net >= 1) return { image: s.fits ? s.painting : enlarge(s) };
      const a = await ctx.pull('a');
      if (!a) return { image: s.painting };
      const image = ctx.gpu.pass({
        label: 'ai style transfer held',
        size: a,
        textures: { a, src: s.painting },
        uniforms: { net },
        wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return mix(textureSampleLevel(a, smp, uv, 0.0), vec4f(textureSampleLevel(src, smp, uv, 0.0).rgb, 1.0), u.net); }',
      });
      return { image };
    }

    const t = styleProgress(f, timing);
    // Outside the transition: the real pictures, untouched and at their own cost only.
    if (t <= 0) return { image: (await ctx.pull('a')) ?? (await ctx.pull('b')) };
    if (t >= 1) return { image: (await ctx.pull('b')) ?? (await ctx.pull('a')) };
    // The real pictures underneath change places when the painted shapes do (later, the more of the picture is swapped).
    const source: StyleMode = meta ? (meta.source === 'style' ? 'style' : 'pair') : ctx.inputSignature('style') === '' ? 'pair' : 'style';
    const shape = styleRecipe(t, source, { ...STYLE_LOOKS.painterly, material: meta ? num(meta.material, 0) : styleLook(p).material }).shape;

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
    const net = styleMix(t, p.fade) * Math.min(1, Math.max(0, p.strength));
    const s = net > 0 ? await stored() : null;
    if (!s) return dissolve();
    // Only the painting is on screen: A and B are not evaluated at all.
    if (net >= 1) return { image: s.fits ? s.painting : enlarge(s) };
    const a = await ctx.pull('a');
    const b = await ctx.pull('b');
    const base = a ?? b;
    if (!base) return { image: s.painting };
    const image = ctx.gpu.pass({
      label: 'ai style transfer show',
      size: base,
      textures: { a: a ?? b, b: b ?? a, src: s.painting },
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
