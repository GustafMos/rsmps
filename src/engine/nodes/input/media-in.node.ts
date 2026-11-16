import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin } from '../../audio/dsp';
import { clipLocal, clipMap, clipSourceTime, type ClipParams } from '../../lib/media-time';

const FADE_MS = 4;

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
  outputs: { image: { type: 'image', label: 'Image' }, audio: { type: 'audio', label: 'Sound' } },
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
    fps: {
      type: 'number',
      default: 0,
      min: 0,
      max: 240,
      softMax: 60,
      step: 1,
      unit: 'hz',
      label: 'Frame rate',
      hint: 'Play the clip at this many of ITS frames per second (slower or faster than recorded). 0 = the rate stored in the file. Handy for scanned sequences and stop motion.',
    },
    fullRes: {
      type: 'bool',
      default: false,
      label: 'Full resolution',
      hint: 'Off: media larger than the project frame is read at project size, which saves a lot of memory and looks the same. Turn on to crop or zoom into a large source.',
    },
    loopVideo: { type: 'bool', default: true, label: 'Loop video', hint: 'Repeat the clip when the project is longer than it.' },
    offset: { type: 'number', default: 0, unit: 's', step: 0.01, label: 'Start offset' },
    volume: { type: 'number', default: 0, min: -60, max: 24, step: 0.1, unit: 'db', label: 'Volume', group: 'Sound', hint: 'Only used when the Sound output is connected.' },
    mute: { type: 'bool', default: false, label: 'Mute', group: 'Sound' },
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
      // In / out, frame-rate reinterpretation, offset and looping: one shared mapping (lib/media-time.ts), also used by the sound.
      seconds = clipSourceTime({ duration: info.duration, fps: info.fps }, ctx.params, ctx.time.seconds);
    }
    // Decode no larger than needed. A 4K clip in a 1080p project is read at project size (a quarter of the
    // memory at every node downstream) unless the user asks for full resolution, e.g. to crop into it.
    const srcLong = Math.max(info.width, info.height);
    const wanted = ctx.params.fullRes ? srcLong * ctx.proxy : Math.min(srcLong * ctx.proxy, Math.max(ctx.canvas.width, ctx.canvas.height));
    const maxSide = wanted < srcLong - 0.5 ? Math.ceil(wanted) : 0;
    const frame = await ctx.host.assetFrame(assetId, seconds, maxSide);
    if (!frame) throw new Error(`Could not decode "${info.name}".`);
    return {
      image: { kind: 'image', texture: frame.texture, width: frame.width, height: frame.height, unit: ctx.unitFor(frame.width, frame.height) },
    };
  },
  /**
   * Sound of the current batch item's video, in sync with the picture. Uses the same clip-time mapping as `render`:
   * in/out trim, offset, loop inside the trimmed span, and the frame-rate reinterpretation as a playback speed (resampled,
   * so pitch follows speed like tape). Short fades at loop wraps, seeks and trim edges. Silent for images, image sequences
   * and videos without sound. `keepPitch` is not offered: the granular shifter works on live input, not on a varispeed read.
   */
  audio: defineAudio({
    // Only the CURRENT batch item's sound track is decoded, and only if something listens to the Sound output.
    loadAssetsOnlyWhenWired: true,
    assets: (p, item) => (p.assets.length ? [p.assets[item % p.assets.length]] : []),
    create: (ctx) => ({ expected: -1, fadeLeft: 0, fadeTotal: Math.max(1, Math.round((FADE_MS / 1000) * ctx.sampleRate)), g: 1 }),
    process(st, io) {
      const p = io.params;
      const n = io.frames;
      const ids = p.assets as string[];
      if (!io.time.playing || p.mute || ids.length === 0) {
        st.expected = -1;
        return;
      }
      const asset = io.assets.get(ids[io.time.item % ids.length]);
      if (!asset || asset.frames < 2) {
        st.expected = -1;
        return;
      }
      const sr = asset.sampleRate;
      const info = { duration: asset.video?.duration ?? asset.frames / sr, fps: asset.video?.fps ?? 0 };
      const cp = p as ClipParams;
      const map = clipMap(info, cp);
      const startPos = map.a * sr;
      const endPos = Math.min(asset.frames, (map.a + map.span) * sr);
      const spanS = endPos - startPos;
      if (spanS < 2) return;
      const loop = p.loopVideo as boolean;
      const local = clipLocal(map, cp, io.time.seconds);
      let pos = loop ? startPos + (((local % map.span) + map.span) % map.span) * sr : (map.a + local) * sr;
      const rate = map.rate;
      if (st.expected < 0 || Math.abs(pos - st.expected) > 1.5 * Math.max(1, rate)) st.fadeLeft = st.fadeTotal; // seek
      const fadeSrc = Math.max(1, st.fadeTotal * Math.max(rate, 0.01));
      const target = dbToLin(p.volume);
      const g0 = st.g;
      const L = asset.left;
      const R = asset.right;
      const last = asset.frames - 1;
      const [ol, or] = io.out.audio;
      for (let i = 0; i < n; i++) {
        if (loop) {
          if (pos >= endPos) pos -= spanS * Math.ceil((pos - endPos + 1e-9) / spanS);
          else if (pos < startPos) pos += spanS * Math.ceil((startPos - pos) / spanS);
        }
        if (pos >= startPos && pos < endPos) {
          let g = Math.min(1, (pos - startPos) / fadeSrc, (endPos - pos) / fadeSrc);
          if (st.fadeLeft > 0) {
            g *= 1 - st.fadeLeft / st.fadeTotal;
            st.fadeLeft--;
          }
          g *= g0 + ((target - g0) * (i + 1)) / n;
          const i1 = Math.floor(pos);
          const t = pos - i1;
          const i0 = i1 > 0 ? i1 - 1 : 0;
          const i2 = Math.min(last, i1 + 1);
          const i3 = Math.min(last, i1 + 2);
          const l = ((0.5 * (L[i3] - L[i0]) + 1.5 * (L[i1] - L[i2])) * t + (L[i0] - 2.5 * L[i1] + 2 * L[i2] - 0.5 * L[i3])) * t + 0.5 * (L[i2] - L[i0]);
          const r = ((0.5 * (R[i3] - R[i0]) + 1.5 * (R[i1] - R[i2])) * t + (R[i0] - 2.5 * R[i1] + 2 * R[i2] - 0.5 * R[i3])) * t + 0.5 * (R[i2] - R[i0]);
          ol[i] = (l * t + L[i1]) * g;
          or[i] = (r * t + R[i1]) * g;
        }
        pos += rate;
      }
      st.g = target;
      st.expected = pos;
    },
  }),
});
