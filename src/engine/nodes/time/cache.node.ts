import { defineNode } from '../../define';

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
 */
const hidden = () => false;

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
        { value: 'cache', label: 'When baked, use the cache' },
        { value: 'live', label: 'Always live' },
      ],
      label: 'Use',
      hint: 'Always live ignores the baked picture and calculates the nodes before this one as usual (the bake is kept).',
    },
    followEdits: {
      type: 'bool',
      default: false,
      label: 'Go live when the graph before it changes',
      hint: 'Off: the baked picture stays until you bake again, and the node only reports that it is out of date. On: any edit before this node makes it live again.',
    },
    exportFromBake: {
      type: 'bool',
      default: false,
      label: 'Export from a compressed bake',
      hint: 'A lossless bake is always used when exporting. A compressed bake is only an approximation, so exports re-render live unless this is on.',
    },
    baked: { type: 'string', default: '', label: 'Baked sequence', visibleIf: hidden },
    bakedSignature: { type: 'string', default: '', label: 'Baked from', visibleIf: hidden },
    bakedQuality: { type: 'string', default: '', label: 'Bake quality', visibleIf: hidden },
    bakedItem: { type: 'string', default: '', label: 'Baked for item', visibleIf: hidden },
    bakedUnit: { type: 'string', default: '', label: 'Baked unit', visibleIf: hidden },
    bakedWidth: { type: 'string', default: '', label: 'Baked width', visibleIf: hidden },
    bakedCanvas: { type: 'string', default: '', label: 'Baked frame size', visibleIf: hidden },
  },
  summary: (p) => (p.baked ? `${p.mode === 'live' ? 'live (baked kept)' : 'baked'}${p.bakedQuality === 'compressed' ? ' · compressed' : ''}` : 'not baked: pass-through'),
  async render(ctx) {
    const p = ctx.params;
    const live = async () => ({ image: await ctx.pull('image'), stale: 0 });
    if (!p.baked || p.mode === 'live') return live();

    const sig = ctx.inputSignature('image');
    const info = ctx.host.assetInfo(p.baked);
    const fresh = !!info && p.bakedSignature === sig;
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
