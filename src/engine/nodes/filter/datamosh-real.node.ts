/**
 * Codec Datamosh: the real thing. Datamosh Span and Motion Smear IMITATE a broken video with their own motion estimate; this node
 * compresses the picture with a real video codec, damages the compressed stream on purpose and decodes it again, so every block,
 * smear and colour bleed is the codec's own.
 *
 * It cannot be computed for one frame at a time: a decoded frame depends on every chunk the decoder was given before it. So the
 * result exists only as a stored sequence made by a job (PROCESS MODE, docs/ENGINE.md), exactly like a bake:
 *
 *   1. every frame of the project is rendered from what is wired in (a clip, a clip with effects, two clips cut together...),
 *   2. the frames are encoded; key frames are made only where the plan says so (lib/datamosh-plan.ts),
 *   3. the chunk list is rewritten: key frames left out at cuts, a delta frame repeated for a bloom,
 *   4. the rewritten stream is decoded and the pictures are stored.
 *
 * Until that has been done the node passes its input through unchanged. Afterwards it serves the stored pictures and its input is
 * not evaluated at all (the input is `lazy`). The codec itself lives behind `lib/datamosh-bridge.ts`: the app installs the browser's
 * encoder and decoder, the command line has none (it uses the stored result), tests install a fake.
 */
import { defineNode } from '../../define';
import { DATAMOSH_MESSAGES, DatamoshRefused, getDatamoshService, type DatamoshCodec, type DatamoshService } from '../../lib/datamosh-bridge';
import { cutScore, cutThreshold, decodePlan, encodeSteps, frameSignature, parsePositions, resolveShown, type MoshSettings, type MoshStep } from '../../lib/datamosh-plan';
import { stableStringify } from '../../lib/stable-json';
import type { ImageValue, ProcessCtx } from '../../types';

interface MoshParams {
  mode: string;
  removeAt: string;
  cutSensitivity: number;
  positions: string;
  bloomWhere: string;
  bloomAt: number;
  bloomCount: number;
  refreshEvery: number;
}

/** The plan's settings from the node's params. Frame numbers are shown from 1 in the app (the transport says "1 / 120"); the plan counts from 0. */
function settingsOf(p: MoshParams, frames: number): MoshSettings {
  const mode = p.mode === 'bloom' || p.mode === 'both' ? p.mode : 'keys';
  return {
    mode,
    removeAt: p.removeAt === 'list' || p.removeAt === 'both' ? p.removeAt : 'cuts',
    positions: parsePositions(p.positions, frames, 1),
    refreshEvery: Math.max(0, Math.round(p.refreshEvery)),
    // With no key frame removed there is nothing to bloom "after": Bloom alone always uses the chosen frame.
    bloomWhere: mode === 'both' && p.bloomWhere === 'cuts' ? 'cuts' : 'frame',
    bloomAt: Math.min(Math.max(0, frames - 1), Math.max(0, Math.round(p.bloomAt) - 1)),
    bloomCount: Math.max(0, Math.round(p.bloomCount)),
  };
}

const hasKeys = (p: Record<string, unknown>) => p.mode !== 'bloom';
const hasBloom = (p: Record<string, unknown>) => p.mode !== 'keys';

/** One try with one codec: render and encode every frame, rewrite the chunk list, decode, stage the pictures. */
async function moshOnce(job: ProcessCtx, svc: DatamoshService, p: MoshParams & { compression: number; maxSide: number }, exclude: string[]): Promise<Record<string, unknown>> {
  const total = job.frames;
  const settings = settingsOf(p, total);
  const maxSide = Math.max(16, Math.round(p.maxSide));
  // Render no larger than what is encoded: the encode and decode of every frame is the cost of this node.
  const proxy = Math.min(1, Math.max(0.02, maxSide / Math.max(job.canvas.width, job.canvas.height, 1)));
  const threshold = cutThreshold(p.cutSensitivity);
  let codec: DatamoshCodec | null = null;
  try {
    let first: { width: number; height: number } | null = null;
    const steps: MoshStep[] = [];
    const cuts: number[] = [];
    let before: Uint8Array | null = null;
    for (let f = 0; f < total; f++) {
      await job.yield();
      const pulled = await job.pull('image', { frame: f, proxy, quality: 'final' });
      let rgba: Uint8ClampedArray;
      let width = 0;
      let height = 0;
      try {
        const v = pulled.value;
        if (!(v && typeof v === 'object' && 'texture' in v)) throw new Error([...pulled.errors.values()][0] ?? 'The picture before the Codec Datamosh node is empty. Connect a picture first.');
        const img = v as ImageValue;
        width = img.width;
        height = img.height;
        // Premultiplied = the picture over black, which is what a video (no transparency) holds.
        rgba = await job.gpu.read(img, false);
      } finally {
        pulled.release();
      }
      if (!first) {
        first = { width, height };
        codec = await svc.open({ width, height, maxSide, fps: job.fps, compression: p.compression, exclude }, job.signal);
      } else if (width !== first.width || height !== first.height) {
        throw new Error(`Frame ${f + 1} has another size (${width}x${height}) than the first (${first.width}x${first.height}); a video needs one size.`);
      }
      // A cut = this frame differs a lot from the one before. Found on the frames as they are read, so the encoder can be told at once.
      const sig = frameSignature(rgba, width, height);
      const cut = !!before && cutScore(before, sig) > threshold && cuts[cuts.length - 1] !== f - 1;
      if (cut) cuts.push(f);
      before = sig;
      for (const step of encodeSteps(f, cut, settings)) {
        steps.push(step);
        await codec!.encode(rgba, step.key);
      }
      job.progress(((f + 1) / total) * 0.6, `Compressing frame ${f + 1} of ${total}${codec!.note ? `, ${codec!.note}` : ''}`, { frame: f + 1, frames: total });
    }
    if (!first || !codec) throw new Error('Nothing to mosh.');
    await job.yield();
    const made = await codec.finish();
    const plan = decodePlan(steps, made, settings);
    const got = await codec.decode(plan.feed, (done, n) => job.progress(0.6 + 0.4 * (done / Math.max(1, n)), `Decoding the damaged stream, ${done} of ${n}`), job.signal);
    const have = got.map(Boolean);
    const shown = resolveShown(plan.show, have);
    // A decoder that quietly gives back far fewer pictures than chunks has "repaired" the stream: that is a refusal too.
    if (!shown || have.filter(Boolean).length < plan.feed.length * 0.75) throw new DatamoshRefused(codec.name, DATAMOSH_MESSAGES.refused);
    job.store.sequence('frames', shown.map((i) => got[i]!), { fps: job.fps, width: codec.width, height: codec.height });
    return {
      codec: codec.name,
      mode: settings.mode,
      frames: total,
      // Size of the picture this node replaces, at full resolution: the stored (smaller) frames are enlarged back to it.
      width: Math.round(first.width / proxy),
      height: Math.round(first.height / proxy),
      cuts: cuts.length,
      removed: plan.removed.length,
      // Shown from 1, as the transport counts.
      removedAt: plan.removed.slice(0, 64).map((f) => f + 1),
      blooms: plan.bloomStarts.length,
      item: job.item.dependent ? job.item.index : null,
    };
  } finally {
    codec?.close();
  }
}

export default defineNode({
  id: 'datamosh-real',
  title: 'Codec Datamosh',
  category: 'filter',
  description:
    'A real datamosh: the picture is compressed with a real video codec, the compressed stream is damaged on purpose and decoded again. Removed key frames make a new shot drag the old shot’s pixels around; a repeated frame makes the picture bloom in the direction it moves. It has to be moshed once (the Mosh button): until then the picture passes through unchanged, afterwards the stored result plays and the nodes before it cost nothing. Needs motion, and for key frame removal a cut: put two clips after each other before this node.',
  keywords: ['datamosh', 'real', 'codec', 'i-frame', 'p-frame', 'glitch', 'mosh', 'bloom', 'compression', 'key frame', 'h264', 'video', 'bake', 'melt', 'data mosh'],
  inputs: { image: { type: 'image', lazy: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'keys',
      options: [
        { value: 'keys', label: 'Remove key frames' },
        { value: 'bloom', label: 'Bloom' },
        { value: 'both', label: 'Both' },
      ],
      label: 'Damage',
      hint: 'Remove key frames: at a cut the new shot’s motion is applied to the old shot’s picture. Bloom: one frame is repeated, so its motion is applied again and again.',
    },
    removeAt: {
      type: 'enum',
      default: 'cuts',
      options: [
        { value: 'cuts', label: 'At cuts' },
        { value: 'list', label: 'At listed frames' },
        { value: 'both', label: 'Cuts and listed frames' },
      ],
      label: 'Remove keys',
      group: 'Key frames',
      visibleIf: hasKeys,
      hint: 'Cuts are found by comparing each frame with the one before. A dissolve is not a cut: list its frame by hand.',
    },
    cutSensitivity: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Cut sensitivity', group: 'Key frames', visibleIf: (p) => hasKeys(p) && p.removeAt !== 'list', hint: 'Higher finds softer cuts, and fast motion may then count as one. After moshing, the panel says how many were found.' },
    positions: { type: 'string', default: '', label: 'Frames', group: 'Key frames', visibleIf: (p) => hasKeys(p) && p.removeAt !== 'cuts', hint: 'Frame numbers as the transport shows them, separated by commas or spaces, for example 25, 49. The key frame of each is left out.' },
    refreshEvery: { type: 'number', default: 0, min: 0, max: 2000, softMax: 120, step: 1, integer: true, label: 'Key frame every', group: 'Key frames', hint: '0 = only the first frame is whole, the damage never heals. Otherwise the picture snaps back to the real frame this often.' },
    bloomWhere: {
      type: 'enum',
      default: 'cuts',
      options: [
        { value: 'cuts', label: 'After each removed key' },
        { value: 'frame', label: 'At one frame' },
      ],
      label: 'Bloom starts',
      group: 'Bloom',
      visibleIf: (p) => p.mode === 'both',
      hint: 'After each removed key: the first motion of the new shot is the one that is repeated, the classic look.',
    },
    bloomAt: { type: 'number', default: 12, min: 1, max: 100000, softMax: 240, step: 1, integer: true, label: 'Bloom at frame', group: 'Bloom', visibleIf: (p) => p.mode === 'bloom' || (p.mode === 'both' && p.bloomWhere === 'frame'), hint: 'The frame that is repeated, as the transport counts. Pick one with clear motion: a frame where nothing moves blooms into nothing.' },
    bloomCount: { type: 'number', default: 12, min: 0, max: 600, softMax: 60, step: 1, integer: true, label: 'Bloom repeats', group: 'Bloom', visibleIf: hasBloom, hint: 'How many times the frame is repeated. The repeats take the place of the frames after it, so the length stays the same.' },
    compression: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Compression', group: 'Codec', hint: '0 = clean video, 1 = starved: coarse blocks that smear visibly. The coarseness is part of the look.' },
    maxSide: { type: 'number', default: 1280, min: 16, max: 4096, step: 2, integer: true, label: 'Longest side', group: 'Codec', hint: 'The video is compressed at most this large and enlarged again afterwards. Every frame is compressed and decoded once, so this is what it costs; smaller also gives larger blocks.' },
  },
  process: {
    title: 'Mosh',
    description: 'Render every frame of what feeds this node, compress it as video, damage the stream and store what the decoder makes of it.',
    // Until it has run the picture passes through (the kernel's stand-in); once it has, the last result stays on screen while
    // settings are tried out, and the badge says it is stale.
    standIn: 'last',
    // The pass-through is not what this node is for: an export must not silently contain it.
    required: 'always',
    auto: false,
    gpu: true,
    // Every visible param changes the stored pictures.
    signature: (p, sigs) =>
      `${stableStringify({ mode: p.mode, removeAt: p.removeAt, cut: p.cutSensitivity, positions: p.positions, refresh: p.refreshEvery, bloomWhere: p.bloomWhere, bloomAt: p.bloomAt, bloomCount: p.bloomCount, compression: p.compression, maxSide: p.maxSide })}|${sigs.image ?? ''}`,
    estimate: (_p, project) => ({ frames: Math.max(1, Math.round(project.duration * project.fps)), note: 'each frame is rendered, compressed and decoded once' }),
    async run(job) {
      const svc = getDatamoshService();
      if (!svc) throw new Error(DATAMOSH_MESSAGES.noRuntime);
      const p = job.params as unknown as MoshParams & { compression: number; maxSide: number };
      const refused: string[] = [];
      for (;;) {
        try {
          return { meta: await moshOnce(job as unknown as ProcessCtx, svc, p, [...refused]) };
        } catch (e) {
          // A decoder that gives up on the damaged stream: render again with the next codec (the service says so when there is none left).
          if (!(e instanceof DatamoshRefused) || refused.includes(e.codec) || refused.length >= 4) throw e;
          refused.push(e.codec);
          job.progress(0, `The ${e.codec} decoder refused the damaged stream, trying another codec`);
        }
      }
    },
  },
  summary: (p) => `${p.mode === 'keys' ? 'key frames removed' : p.mode === 'bloom' ? `bloom x${p.bloomCount}` : `keys removed + bloom x${p.bloomCount}`} · stored result only`,
  async render(ctx) {
    const ps = ctx.process!;
    const result = ps.servable ? ps.result : null;
    const seq = result?.items.frames;
    // A mosh made for one batch item serves only that item; the others pass through.
    const itemOk = !result || result.meta.item === null || result.meta.item === undefined || result.meta.item === ctx.item.index;
    if (!result || !seq || !itemOk) return ps.standIn();

    const total = Math.max(1, seq.frames ?? Number(result.meta.frames) ?? 1);
    const f = ctx.time.frame;
    const idx = ctx.time.loop ? ((f % total) + total) % total : Math.min(total - 1, Math.max(0, f));
    // The picture this node replaces, at the size asked for now.
    const fullW = Number(result.meta.width) || seq.width || 0;
    const fullH = Number(result.meta.height) || seq.height || 0;
    const width = Math.max(1, Math.round(fullW * ctx.proxy));
    const height = Math.max(1, Math.round(fullH * ctx.proxy));
    const storedLong = Math.max(seq.width ?? 0, seq.height ?? 0);
    const wanted = Math.max(width, height);
    const frame = await ps.frame('frames', idx, storedLong > 0 && wanted < storedLong - 0.5 ? Math.ceil(wanted) : 0);
    if (!frame) return ps.standIn();
    const stored: ImageValue = { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit: ctx.unitFor(frame.width, frame.height) };
    if (!fullW || !fullH || (Math.abs(frame.width - width) <= 2 && Math.abs(frame.height - height) <= 2)) return { image: stored };
    // Stored smaller than the picture it replaces ("Longest side"): enlarge it, so what comes after sees the size it had before.
    const image = ctx.gpu.pass({
      label: 'codec datamosh enlarge',
      size: { width, height, unit: ctx.unitFor(width, height) },
      textures: { src: stored },
      wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }',
    });
    return { image };
  },
});
