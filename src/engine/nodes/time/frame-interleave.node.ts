import { defineNode } from '../../define';
import { cycleFrames, cycleHint, interleaveFrame, interleaveSeconds, parseOffsets, parsePattern, type InterleaveOpts } from '../../lib/interleave';
import { mod } from '../../lib/util-time';
import type { ImageValue } from '../../types';

/** Texture scale of an image inside the canvas for each fit mode (1 = fills the frame exactly). */
function fitScale(fit: string, img: { width: number; height: number }, canvas: { width: number; height: number }): [number, number] {
  if (fit === 'as-is' || fit === 'stretch') return [1, 1];
  const k = fit === 'contain' ? Math.min(canvas.width / img.width, canvas.height / img.height) : Math.max(canvas.width / img.width, canvas.height / img.height);
  return [(img.width * k) / canvas.width, (img.height * k) / canvas.height];
}

/** WGSL helper shared by both passes: places a texture in the frame with scale `fs`, crisp when enlarging, nearest when 1:1. */
const SAMPLE = /* wgsl */ `
fn place(t: texture_2d<f32>, uv: vec2f, fs: vec2f) -> vec4f {
  let fuv = (uv - 0.5) / fs + 0.5;
  if (fuv.x < 0.0 || fuv.y < 0.0 || fuv.x > 1.0 || fuv.y > 1.0) { return vec4f(0.0); }
  let dims = vec2f(textureDimensions(t));
  if (fs.x == 1.0 && fs.y == 1.0 && dims.x == u.size.x && dims.y == u.size.y) { return textureSampleLevel(t, smpNearest, fuv, 0.0); }
  return sampleCrisp(t, fuv, dims / (fs * u.size));
}`;

/**
 * Weaves several video sources into one picture, frame by frame. Only the source that the current output frame needs is evaluated
 * (the input is lazy): exactly one pull per frame, two with Blend. With Blend 0 and a source that already has the frame size the pulled
 * picture is handed on untouched: no pass, no copy. All the maths is in lib/interleave.ts.
 */
export default defineNode({
  id: 'frame-interleave',
  title: 'Frame Interleave',
  category: 'time',
  description:
    'Weave two or more videos frame by frame: frame 1 from video 1, frame 2 from video 2, and so on (flicker film, A/B strobe). Either every source keeps running in step with the project, or every frame of every source is shown, which makes the result as long as all of them together. Wire order is the order of the sources. No sound: take it from one source or a Media Timeline.',
  keywords: ['interleave', 'alternate', 'flicker', 'weave', 'combine frames', 'strobe', 'flicker film', 'A/B', 'every other frame', 'frame by frame', 'shuffle', 'merge videos', 'sequence'],
  inputs: { sources: { type: 'image', multi: true, lazy: true, label: 'Sources' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'in-step',
      options: [
        { value: 'in-step', label: 'Alternate' },
        { value: 'every-frame', label: 'Every frame' },
      ],
      label: 'Mode',
      hint: 'Alternate: output frame n shows source (n mod count) at its own frame n (v1 f1, v2 f2, v1 f3 ...), the length is unchanged. Every frame: v1 f1, v2 f1, v1 f2, v2 f2 ... nothing is skipped.',
    },
    timing: {
      type: 'enum',
      default: 'longer',
      options: [
        { value: 'longer', label: 'Longer' },
        { value: 'same-length', label: 'Same length' },
      ],
      label: 'Timing',
      hint: 'Longer: every source frame is shown, so the result holds the frames of all sources. Keep the length: all sources show the same moment within a cycle (v1 f1, v2 f1, v1 f3, v2 f3 ...) and time moves at normal speed.',
      visibleIf: (p) => p.mode === 'every-frame',
    },
    setsLength: {
      type: 'bool',
      default: false,
      label: 'Set project length',
      hint: 'The whole project becomes the length of one source times the number of sources (and the hold). Needs "Length of one source".',
      visibleIf: (p) => p.mode === 'every-frame' && p.timing === 'longer',
    },
    baseSeconds: {
      type: 'number',
      default: 0,
      min: 0,
      max: 36000,
      step: 0.01,
      unit: 's',
      label: 'Source length',
      hint: 'Filled in from the first wired Media In. Used for the project length and as the point where sources wrap. 0 = follow the project length.',
    },
    pattern: {
      type: 'string',
      default: '',
      label: 'Pattern',
      hint: 'How many frames in a row each source holds per cycle, one number per source: "2,1" = two frames of source 1, then one of source 2. Empty = 1 each.',
    },
    hold: { type: 'number', default: 1, min: 1, max: 100, softMax: 12, step: 1, integer: true, label: 'Hold', hint: 'Show each step for this many frames (shoot on twos = 2).' },
    offsets: { type: 'string', default: '', label: 'Start offsets', hint: 'Frames each source starts later, one number per source: "0,12".' },
    loopSources: { type: 'bool', default: true, label: 'Loop sources', hint: 'A source past its length starts over (otherwise it stays on its last frame).' },
    blend: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Blend', hint: '0 = hard cuts. Above 0 each picture is mixed with the previous one (one extra evaluation and pass per frame).' },
    fit: {
      type: 'enum',
      default: 'contain',
      options: [
        { value: 'as-is', label: 'As is' },
        { value: 'contain', label: 'Fit inside' },
        { value: 'cover', label: 'Fill' },
        { value: 'stretch', label: 'Stretch' },
      ],
      label: 'Fit to frame',
      hint: 'For sources of different sizes. Sources that already have the frame size are never copied.',
    },
    count: { type: 'number', default: 0, min: 0, max: 4096, integer: true, label: 'Sources', hint: 'Number of wires. Kept up to date by the editor.', visibleIf: () => false },
    frames: { type: 'number', default: 0, min: 0, max: 100000000, integer: true, label: 'Project frames', hint: 'Kept up to date by the editor (used for the loop hint).', visibleIf: () => false },
  },
  summary: (p) => {
    const n = Math.max(1, p.count);
    const pat = parsePattern(p.pattern, n);
    const parts = [`${n} source${n === 1 ? '' : 's'}`, p.mode === 'in-step' ? 'alternate' : 'every frame'];
    if (p.mode === 'every-frame') {
      const total = pat.pattern.reduce((a, b) => a + b, 0);
      parts.push(p.timing === 'longer' ? `${Math.round((total / Math.min(...pat.pattern)) * 100) / 100}× longer` : 'same length');
    }
    if (p.hold > 1) parts.push(`hold ${p.hold}`);
    if (!pat.valid) parts.push(pat.message);
    const hint = cycleHint(cycleFrames(pat.pattern, p.hold), p.frames);
    if (hint) parts.push(hint);
    return parts.join(' · ');
  },
  projectLength: (p) => {
    if (!p.setsLength || p.mode !== 'every-frame' || p.timing !== 'longer' || p.count < 2 || !(p.baseSeconds > 0)) return null;
    const s = interleaveSeconds(p.baseSeconds, parsePattern(p.pattern, p.count).pattern, p.hold);
    return s > 0 ? s : null;
  },
  async render(ctx) {
    const p = ctx.params;
    const { fps, duration } = ctx.time; // reading `duration` / `frame` makes the node per-frame (it must: it picks a different wire)
    const total = Math.max(1, Math.round(duration * fps));
    const n = mod(ctx.time.frame, total);
    const count = Math.max(1, p.count);
    const opts: InterleaveOpts = {
      mode: p.mode as InterleaveOpts['mode'],
      timing: p.timing as InterleaveOpts['timing'],
      pattern: parsePattern(p.pattern, count).pattern,
      hold: p.hold,
      offsets: parseOffsets(p.offsets),
      baseFrames: p.baseSeconds > 0 ? Math.max(1, Math.round(p.baseSeconds * fps)) : total,
      loopSources: p.loopSources,
    };
    const cur = interleaveFrame(n, fps, count, opts);
    const image = await ctx.pull('sources', { seconds: cur.sourceSeconds, wire: cur.wire });
    if (!image) return { image: null };

    // The picture of the previous step (across the loop seam too), only when it can differ from this one.
    let prev: ImageValue | null = null;
    if (p.blend > 0) {
      const prevN = cur.step > 0 ? cur.step * opts.hold - 1 : ctx.time.loop ? total - 1 : -1;
      if (prevN >= 0) {
        const pf = interleaveFrame(prevN, fps, count, opts);
        // A still source shows the same picture at every time: same wire = same picture, nothing to blend.
        const same = pf.wire === cur.wire && (pf.sourceFrame === cur.sourceFrame || !ctx.inputVaries('sources'));
        if (!same) prev = await ctx.pull('sources', { seconds: pf.sourceSeconds, wire: pf.wire });
      }
    }

    const canvas = ctx.canvas;
    const fit = p.fit;
    const sc = fit === 'as-is' ? ([1, 1] as [number, number]) : fitScale(fit, image, canvas);
    const needsFit = fit !== 'as-is' && (sc[0] !== 1 || sc[1] !== 1 || image.width !== canvas.width || image.height !== canvas.height);
    const size = fit === 'as-is' ? image : { width: canvas.width, height: canvas.height, unit: canvas.unit };

    if (!prev) {
      if (!needsFit) return { image }; // the common case: the pulled picture itself, no pass
      return {
        image: ctx.gpu.pass({
          label: 'interleave-fit',
          size,
          textures: { ta: image },
          uniforms: { sa: sc },
          wgsl: `${SAMPLE}\nfn fx(uv: vec2f, px: vec2f) -> vec4f { return place(ta, uv, u.sa); }`,
        }),
      };
    }
    const sp = fit === 'as-is' ? ([1, 1] as [number, number]) : fitScale(fit, prev, canvas);
    return {
      image: ctx.gpu.pass({
        label: 'interleave-blend',
        size,
        textures: { ta: image, tb: prev },
        uniforms: { sa: sc, sb: sp, k: p.blend },
        wgsl: `${SAMPLE}\nfn fx(uv: vec2f, px: vec2f) -> vec4f { return mix(place(ta, uv, u.sa), place(tb, uv, u.sb), u.k); }`,
      }),
    };
  },
});
