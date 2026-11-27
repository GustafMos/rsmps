import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { MEDIA_TIMELINE_ID, activeVideo, clipEnd, editEnd, formatTime, normalizeEdit, resolveFades, weightAt, type EditClip, type MediaEdit } from '../../lib/media-edit';
import type { ImageValue } from '../../types';

/**
 * A small video editor in one node. Wire any number of picture sources into `Clips` (Media In, generators, whole effect chains) and
 * sound sources into `Sounds`; the `edit` param says which clip plays when. The edit is pure data (lib/media-edit.ts); the strip
 * under the graph edits it.
 *
 * Picture: for the current time only the clips that are on screen are pulled (the `clips` input is lazy), so a source that is not
 * showing is never evaluated. Visible clips are fitted onto the project canvas and composited bottom to top.
 * Sound: the same edit applied to sound. A clip made from a file with sound plays that file directly, at the right offset; a clip
 * for a wired `Sounds` source gates that wire (a live wire cannot be moved in time).
 * Length: with `setsLength` the project is exactly as long as the last clip (`projectLength`).
 */
export default defineNode({
  id: MEDIA_TIMELINE_ID,
  title: 'Media Timeline',
  category: 'time',
  description: 'A small video editor: arrange the clips wired into it on tracks (trim, move, fade, cross-dissolve) and get one picture and one sound out. Can set the length of the whole project.',
  keywords: ['edit', 'editor', 'sequence', 'cut', 'trim', 'clips', 'video editor', 'montage', 'concatenate', 'join', 'cross dissolve', 'timeline', 'nle'],
  guide: {
    does: 'A small video editor: arranges the clips you wire into it on tracks and gives you one picture and one sound.',
    steps: [
      'Wire your video clips into Clips and your sounds into Sounds. Each new wire goes on the end.',
      'Arrange, trim, fade and layer them in the strip under the graph.',
      'Wire Image and Sound into your output.',
    ],
    needs: [
      { input: 'clips', hint: 'The video clips to arrange.' },
    ],
    seeAlso: ['media-in', 'image-out'],
  },
  inputs: {
    clips: { type: 'image', multi: true, lazy: true, label: 'Clips' },
    sounds: { type: 'audio', multi: true, label: 'Sounds' },
  },
  outputs: { image: { type: 'image', label: 'Image' }, audio: { type: 'audio', label: 'Sound' } },
  params: {
    edit: { type: 'json', default: { clips: [] }, label: 'Edit', hint: 'The clips on the tracks. Edited in the strip under the graph (open it from the inspector).' },
    setsLength: { type: 'bool', default: false, label: 'Set project length', hint: 'The whole project (playback and export) becomes exactly as long as this edit.' },
    fit: {
      type: 'enum',
      default: 'contain',
      options: [
        { value: 'contain', label: 'Fit inside' },
        { value: 'cover', label: 'Fill' },
        { value: 'stretch', label: 'Stretch' },
      ],
      label: 'Clip fit',
    },
    background: { type: 'color', default: [0, 0, 0, 0], label: 'Background', hint: 'Shown where no clip covers the frame. Transparent by default.' },
  },
  summary: (p) => {
    const e = normalizeEdit(p.edit);
    const n = e.clips.filter((c) => c.kind === 'video' || !c.link).length;
    return `${n} clip${n === 1 ? '' : 's'} · ${formatTime(editEnd(e))}`;
  },
  projectLength: (p) => {
    if (!p.setsLength) return null;
    const end = editEnd(normalizeEdit(p.edit));
    return end > 0 ? end : null;
  },
  async render(ctx) {
    const edit = normalizeEdit(ctx.params.edit);
    const { fit, background } = ctx.params;
    const { width, height, unit } = ctx.canvas;
    const t = ctx.time.seconds;
    const gpu = ctx.gpu;

    // Only what is on screen now is evaluated (the input is lazy): off-screen sources cost nothing.
    const layers: { image: ImageValue; weight: number }[] = [];
    for (const a of activeVideo(edit, t)) {
      const image = await ctx.pull('clips', { seconds: a.local, wire: a.clip.source });
      if (image) layers.push({ image, weight: a.weight });
    }

    // One clip, fully opaque, already the frame size, nothing behind it: hand it on untouched.
    if (layers.length === 1 && layers[0].weight >= 0.999 && layers[0].image.width === width && layers[0].image.height === height && background[3] <= 0) {
      return { image: layers[0].image };
    }

    let acc = gpu.pass({
      label: 'edit-background',
      size: { width, height, unit },
      uniforms: { bg: background },
      wgsl: /* wgsl */ `fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.bg.rgb * u.bg.a, u.bg.a); }`,
    });
    for (const { image: fg, weight } of layers) {
      let sx = 1;
      let sy = 1;
      if (fit !== 'stretch') {
        const k = fit === 'contain' ? Math.min(width / fg.width, height / fg.height) : Math.max(width / fg.width, height / fg.height);
        sx = (fg.width * k) / width;
        sy = (fg.height * k) / height;
      }
      const same = fg.width === width && fg.height === height && sx === 1 && sy === 1;
      const prev = acc;
      acc = gpu.pass({
        label: 'edit-layer',
        size: { width, height, unit },
        textures: { bg: prev, fg },
        uniforms: { fsize: [sx, sy], weight },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let b = textureSampleLevel(bg, smpNearest, uv, 0.0);
  let fuv = (uv - 0.5) / u.fsize + 0.5;
  if (fuv.x < 0.0 || fuv.y < 0.0 || fuv.x > 1.0 || fuv.y > 1.0) { return b; }
  let f = ${same ? 'textureSampleLevel(fg, smpNearest, fuv, 0.0)' : 'sampleCrisp(fg, fuv, vec2f(textureDimensions(fg)) / (u.fsize * u.size))'} * u.weight;
  return f + b * (1.0 - f.a);
}`,
      });
      gpu.recycle(prev);
    }
    return { image: acc };
  },

  audio: defineAudio({
    perWire: true,
    loadAssetsOnlyWhenWired: true,
    assets: (p) => [...new Set(normalizeEdit(p.edit).clips.filter((c) => c.kind === 'audio' && c.asset && !c.mute).map((c) => c.asset as string))],
    create: () => ({ src: null as unknown, clips: [] as EditClip[], fades: new Map<string, { fadeIn: number; fadeOut: number }>() }),
    process(st, io) {
      if (st.src !== io.params.edit) {
        st.src = io.params.edit;
        const edit: MediaEdit = normalizeEdit(io.params.edit);
        st.clips = edit.clips.filter((c) => c.kind === 'audio' && !c.mute);
        st.fades = resolveFades(edit);
      }
      const n = io.frames;
      const sr = io.sampleRate;
      const t0 = io.time.seconds;
      const t1 = t0 + n / sr;
      const [ol, or] = io.out.audio;
      const wires = io.inWires?.sounds;
      for (const c of st.clips) {
        if (t1 <= c.start || t0 >= clipEnd(c)) continue;
        const fades = st.fades.get(c.id);
        if (c.asset) {
          // A file's own sound, read at the clip's offset (linear interpolation).
          if (!io.time.playing) continue;
          const a = io.assets.get(c.asset);
          if (!a || a.frames < 2) continue;
          const last = a.frames - 1;
          for (let i = 0; i < n; i++) {
            const t = t0 + i / sr;
            const g = weightAt(c, t, fades);
            if (g <= 0) continue;
            const pos = (c.in + (t - c.start)) * a.sampleRate;
            const i0 = Math.floor(pos);
            if (i0 < 0 || i0 >= last) continue;
            const f = pos - i0;
            ol[i] += (a.left[i0] * (1 - f) + a.left[i0 + 1] * f) * g;
            or[i] += (a.right[i0] * (1 - f) + a.right[i0 + 1] * f) * g;
          }
        } else {
          // A wired live source: gated and faded in place.
          const w = wires?.[c.source];
          if (!w) continue;
          for (let i = 0; i < n; i++) {
            const g = weightAt(c, t0 + i / sr, fades);
            if (g <= 0) continue;
            ol[i] += w[0][i] * g;
            or[i] += w[1][i] * g;
          }
        }
      }
    },
  }),
});
