import { defineNode } from '../../define';
import type { ImageValue } from '../../types';

/**
 * Cache / Bake. Unbaked it is a transparent pass-through. Once the user has baked it (the IO layer renders every frame of
 * the input into a hidden sequence, see `Io.bake`), it serves frames from that sequence and its input is NOT evaluated at all:
 * everything upstream of it costs nothing, however heavy. Editing upstream does not touch the baked picture (the user decides when
 * to re-bake); the `stale` output and the node badge say that it no longer matches.
 *
 * The input is `lazy`: the engine never evaluates it on its own, this node pulls it only when it is live. `ctx.inputSignature`
 * is the structural signature of everything upstream; the baked sequence remembers the one it was made from.
 *
 * The `baked*` params are written by the UI from the result of `Io.bake.bake` and are not shown in the inspector.
 *
 * PROCESS MODE: baking is the first user of the generic process mechanism (docs/ENGINE.md, "Process mode"). `process.run` below is the
 * bake job; its stand-in is 'bypass' (the live pass-through), it is never required for an export (the stand-in is exactly what the node
 * computes), and its result handle is mapped onto the old `baked*` params so projects saved before process mode keep working.
 */
const hidden = () => false;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Frames above this many encoded bytes stop a bake (the browser's storage quota would fail later, less readably). */
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024 * 1024;

export default defineNode({
  id: 'cache',
  title: 'Cache / Bake',
  category: 'time',
  description:
    'Bake everything before this node into a stored sequence. Baked, the nodes upstream are not calculated at all, so a finished piece of the graph stops costing time and memory. Unbaked it does nothing.',
  keywords: ['bake', 'cache', 'freeze', 'lock', 'render', 'precompute', 'done', 'region'],
  inputs: { image: { type: 'image', lazy: true, label: 'Image' } },
  outputs: {
    image: { type: 'image', label: 'Image' },
    stale: { type: 'number', label: 'Stale' },
  },
  params: {
    mode: {
      type: 'enum',
      default: 'cache',
      options: [
        { value: 'cache', label: 'Use cache' },
        { value: 'live', label: 'Always live' },
      ],
      label: 'Use',
      hint: 'Always live ignores the baked picture and calculates the nodes before this one as usual (the bake is kept).',
    },
    followEdits: {
      type: 'bool',
      default: false,
      label: 'Follow edits',
      hint: 'Go live when the graph before it changes. Off: the baked picture stays until you bake again, and the node only reports that it is out of date. On: any edit before this node makes it live again.',
    },
    exportFromBake: {
      type: 'bool',
      default: false,
      label: 'Export baked',
      hint: 'Export from a compressed bake. A lossless bake is always used when exporting. A compressed bake is only an approximation, so exports re-render live unless this is on.',
    },
    baked: { type: 'string', default: '', label: 'Baked sequence', visibleIf: hidden },
    bakedSignature: { type: 'string', default: '', label: 'Baked from', visibleIf: hidden },
    bakedQuality: { type: 'string', default: '', label: 'Bake quality', visibleIf: hidden },
    bakedItem: { type: 'string', default: '', label: 'Baked for item', visibleIf: hidden },
    bakedUnit: { type: 'string', default: '', label: 'Baked unit', visibleIf: hidden },
    bakedWidth: { type: 'string', default: '', label: 'Baked width', visibleIf: hidden },
    bakedCanvas: { type: 'string', default: '', label: 'Baked frame size', visibleIf: hidden },
  },
  process: {
    title: 'Bake',
    description: 'Render every frame of what feeds this node at full size and store it; the nodes before it then cost nothing.',
    standIn: 'bypass',
    required: 'never',
    gpu: true,
    // Exactly what `ctx.inputSignature('image')` gives: the baked sequence remembers it and the node compares.
    signature: (_p, sigs) => sigs.image ?? '',
    estimate: (_p, project) => {
      const frames = Math.max(1, Math.round(project.duration * project.fps));
      return { frames, bytes: Math.round(frames * project.width * project.height * 1.5), note: 'about 1.5 bytes per pixel lossless, far less compressed' };
    },
    handle: {
      read: (p) =>
        !p.baked
          ? null
          : {
              signature: str(p.bakedSignature),
              items: { frames: { kind: 'sequence', id: str(p.baked), bytes: 0 } },
              meta: {
                quality: str(p.bakedQuality),
                item: str(p.bakedItem) === '' ? null : Number(p.bakedItem),
                unit: Number(p.bakedUnit),
                width: Number(p.bakedWidth),
                canvas: str(p.bakedCanvas),
              },
              bytes: 0,
              createdAt: 0,
              seconds: 0,
            },
      write: (r) => ({
        baked: r.items.frames?.id ?? '',
        bakedSignature: r.signature,
        bakedQuality: str(r.meta.quality),
        bakedItem: r.meta.item === null || r.meta.item === undefined ? '' : String(r.meta.item),
        bakedUnit: String(r.meta.unit ?? ''),
        bakedWidth: String(r.meta.width ?? ''),
        bakedCanvas: str(r.meta.canvas),
      }),
      clear: () => ({ baked: '', bakedSignature: '', bakedQuality: '', bakedItem: '', bakedUnit: '', bakedWidth: '', bakedCanvas: '' }),
    },
    async run(job) {
      const quality = job.options.quality === 'compressed' ? 'compressed' : 'lossless';
      const maxBytes = typeof job.options.maxBytes === 'number' ? job.options.maxBytes : DEFAULT_MAX_BYTES;
      const blobs: Blob[] = [];
      let bytes = 0;
      let first: { width: number; height: number; unit: number } | null = null;
      for (let i = 0; i < job.frames; i++) {
        await job.yield();
        const pulled = await job.pull('image', { frame: i, proxy: 1, quality: 'final' });
        try {
          const v = pulled.value;
          if (!(v && typeof v === 'object' && 'texture' in v)) throw new Error([...pulled.errors.values()][0] ?? 'The picture before the Cache / Bake node is empty.');
          const img = v as ImageValue;
          first ??= { width: img.width, height: img.height, unit: img.unit };
          if (img.width !== first.width || img.height !== first.height) {
            throw new Error(`Frame ${i + 1} has another size (${img.width}x${img.height}) than the first (${first.width}x${first.height}); a baked sequence needs one size.`);
          }
          const blob = await job.encodeImage(img, quality);
          blobs.push(blob);
          bytes += blob.size;
        } finally {
          pulled.release();
        }
        if (bytes > maxBytes) throw new Error(`The baked frames are over ${Math.round(maxBytes / 1048576)} MB. Bake as compressed, or bake a shorter project.`);
        job.progress((i + 1) / job.frames, `Frame ${i + 1} of ${job.frames}`, { frame: i + 1, frames: job.frames, bytes });
      }
      if (!first) throw new Error('Nothing to bake.');
      job.store.sequence('frames', blobs, { fps: job.fps, width: first.width, height: first.height, unit: first.unit });
      return {
        meta: {
          quality,
          item: job.item.dependent ? job.item.index : null,
          unit: first.unit,
          width: first.width,
          canvas: `${Math.round(job.canvas.width)}x${Math.round(job.canvas.height)}`,
        },
      };
    },
  },
  summary: (p) => (p.baked ? `${p.mode === 'live' ? 'live (baked kept)' : 'baked'}${p.bakedQuality === 'compressed' ? ' · compressed' : ''}` : 'not baked: pass-through'),
  async render(ctx) {
    const p = ctx.params;
    const ps = ctx.process!;
    // The stand-in is the live pass-through (process.standIn 'bypass'): the lazy input is pulled, nothing else.
    const live = async () => ({ ...(await ps.standIn()), stale: 0 });
    if (!p.baked || p.mode === 'live') return live();

    const sig = ctx.inputSignature('image');
    const sequence = ps.result?.items.frames;
    const info = sequence ? ctx.host.assetInfo(sequence.id) : null; // null also when the stored frames are gone ('missing')
    const fresh = !!info && ps.result!.signature === sig;
    const stale = fresh ? 0 : 1;
    // A bake of one batch item serves only that item; the others render live.
    const itemOk = p.bakedItem === '' || ctx.item.index === Number(p.bakedItem);
    // Exports use a compressed bake only when asked to (it is an approximation of the live picture).
    const exportOk = ctx.quality !== 'final' || p.bakedQuality !== 'compressed' || p.exportFromBake;
    // A frame size other than the one baked (an Output with another aspect ratio) needs the generators to lay out again: live.
    const [bw, bh] = p.bakedCanvas.split('x').map(Number);
    const sizeOk = !bw || (Math.abs(ctx.canvas.width / ctx.proxy - bw) <= 2 && Math.abs(ctx.canvas.height / ctx.proxy - bh) <= 2);
    if (!info || !itemOk || !exportOk || !sizeOk || (!fresh && p.followEdits)) {
      const out = await live();
      return { ...out, stale: info ? stale : 1 };
    }

    const total = Math.max(1, Math.round(info.duration * (info.fps || ctx.time.fps)));
    const f = ctx.time.frame;
    const idx = ctx.time.loop ? ((f % total) + total) % total : Math.min(total - 1, Math.max(0, f));
    const bakedLong = Math.max(info.width, info.height);
    const wanted = bakedLong * ctx.proxy;
    const maxSide = wanted < bakedLong - 0.5 ? Math.ceil(wanted) : 0;
    const frame = await ctx.host.assetFrame(p.baked, idx / (info.fps || ctx.time.fps), maxSide);
    if (!frame) {
      const out = await live();
      return { ...out, stale: 1 };
    }
    // The baked picture keeps the size and pixel unit of what it replaced (a Pixelate before it makes `unit` art pixels).
    const unit0 = Number(p.bakedUnit);
    const w0 = Number(p.bakedWidth);
    const unit = Number.isFinite(unit0) && unit0 > 0 && w0 > 0 ? unit0 * (frame.width / w0) : ctx.unitFor(frame.width, frame.height);
    return { image: { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit }, stale };
  },
});
