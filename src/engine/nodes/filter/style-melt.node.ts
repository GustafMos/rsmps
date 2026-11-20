import { defineNode } from '../../define';
import { gaussianBlur } from './blur.node';

/**
 * Style melt: a transition in which picture A is first repainted with the colours and texture of picture B, then
 * changes shape into B, and B then settles into itself. It is the look of the neural "style transfer" transitions of
 * the late 2010s, made here WITHOUT a neural network, from the two things style transfer visibly does:
 *
 *   - it keeps the large shapes of one picture (the "content") and paints them with the small-scale texture and the
 *     colours of the other (the "style"). So every picture is split into its broad shapes (a blur) and its texture
 *     (the picture minus that blur). The output is the broad shapes of one plus the texture of the other, with the
 *     broad colours pulled toward the other's;
 *   - the texture does not sit where it sat in its own picture: it arrives in patches, rearranged, and it runs along
 *     the edges of the content. So the texture is read in irregular patches, each from a shifted place, and the
 *     reading position is pushed along the outlines of the broad shapes.
 *
 * The three changes are staggered: colour and texture lead, the shapes follow in the middle, and all of the
 * rearranging fades out toward both ends, so progress 0 is exactly A and progress 1 is exactly B.
 * A real network invents new texture that fits; this only moves existing texture around. It reads as the same family
 * of effect, not as the same thing.
 */
export function meltWeights(t: number): { style: number; shape: number; lead: number } {
  const x = Math.min(1, Math.max(0, t));
  const smooth = (a: number, b: number, v: number) => {
    const k = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return k * k * (3 - 2 * k);
  };
  return {
    /** How much is rearranged: none at both ends, all in the middle. */
    style: Math.pow(Math.sin(Math.PI * x), 0.7),
    /** Whose broad shapes: A, then B. */
    shape: smooth(0.3, 0.7, x),
    /** Whose colour and texture: runs ahead of the shapes. */
    lead: smooth(0.02, 0.5, x),
  };
}

export default defineNode({
  id: 'style-melt',
  title: 'Style Melt',
  category: 'filter',
  description: 'A transition where picture A is repainted with the texture and colours of picture B, melts into its shapes and settles as B: the look of the "AI style transfer" transitions in music videos, made without a neural network.',
  keywords: ['transition', 'style transfer', 'ai', 'neural', 'morph', 'melt', 'dream', 'deep dream', 'texture', 'mgmt', 'music video', 'between two clips', 'dissolve', 'trippy', 'psychedelic', 'painting'],
  inputs: {
    a: { type: 'image', required: true, label: 'A (from)' },
    b: { type: 'image', required: true, label: 'B (to)' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    drive: {
      type: 'enum',
      default: 'manual',
      options: [
        { value: 'manual', label: 'Progress setting' },
        { value: 'loop', label: 'A to B over the loop' },
        { value: 'pingpong', label: 'A to B and back' },
      ],
      label: 'Driven by',
      hint: 'Progress setting: move or wire Progress yourself. The other two run the transition over the length of the project.',
    },
    progress: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.001, label: 'Progress', hint: '0 = picture A, 1 = picture B. Wire a number here to animate it.', visibleIf: (p) => p.drive === 'manual' },
    strength: { type: 'number', default: 1, min: 0, max: 2, step: 0.01, label: 'Strength', hint: 'How wild the middle of the transition is. 0 is a soft dissolve.' },
    patch: { type: 'number', default: 6, min: 1, max: 30, step: 0.1, label: 'Patch size %', hint: 'Size of the pieces of texture that are moved around, percent of the picture width.' },
    shuffle: { type: 'number', default: 0.6, min: 0, max: 2, step: 0.01, label: 'Shuffle', hint: 'How far a piece of texture lands from where it came from.' },
    flow: { type: 'number', default: 0.6, min: 0, max: 2, step: 0.01, label: 'Follow outlines', hint: 'How much the texture is dragged along the outlines of the shapes.' },
    detail: { type: 'number', default: 1.5, min: 0.3, max: 8, step: 0.1, label: 'Texture size %', hint: 'What counts as texture: details smaller than this, percent of the picture width.' },
    boost: { type: 'number', default: 0.8, min: 0, max: 3, step: 0.01, label: 'Texture boost', hint: 'Makes the borrowed texture stronger in the middle of the transition.' },
    churn: { type: 'number', default: 1, min: 0, max: 6, step: 0.05, label: 'Churn', hint: 'How much the patches crawl during one loop. 0 = they only move with Progress.' },
    seed: { type: 'number', default: 1, min: 0, max: 999, step: 1, integer: true, label: 'Seed' },
  },
  summary: (p) => (p.drive === 'manual' ? `${Math.round(p.progress * 100)}%` : p.drive === 'loop' ? 'A to B over the loop' : 'A to B and back'),
  render(ctx) {
    const p = ctx.params;
    const a = ctx.in.a;
    const b = ctx.in.b;
    if (!a || !b) return { image: a ?? b };
    const ph = ctx.time.phase;
    const t = p.drive === 'loop' ? ph : p.drive === 'pingpong' ? 0.5 - 0.5 * Math.cos(ph * Math.PI * 2) : p.progress;
    if (t <= 0 && p.drive === 'manual') return { image: a };
    const w = meltWeights(t);
    const r = Math.max(1, (p.detail / 100) * a.width);
    const blurA = gaussianBlur(ctx.gpu, a, r);
    const blurB = gaussianBlur(ctx.gpu, b, (r * b.width) / a.width);
    const meanA = gaussianBlur(ctx.gpu, blurA, r * 8);
    const meanB = gaussianBlur(ctx.gpu, blurB, (r * 8 * b.width) / a.width);
    const image = ctx.gpu.pass({
      label: 'style-melt',
      size: a,
      textures: { a, b, blurA, blurB, meanA, meanB },
      uniforms: {
        style: Math.min(2, w.style * p.strength),
        shape: w.shape,
        lead: w.lead,
        cell: Math.max(0.005, p.patch / 100),
        shuffle: p.shuffle,
        flow: p.flow,
        boost: p.boost,
        phase: ph,
        churn: p.churn,
        seed: p.seed * 9.7,
      },
      wgsl: /* wgsl */ `
fn lumAt(uv: vec2f) -> f32 {
  return luma(mix(textureSampleLevel(blurA, smp, uv, 0.0).rgb, textureSampleLevel(blurB, smp, uv, 0.0).rgb, u.shape));
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let aspect = u.size.x / u.size.y;
  // the outline direction of the broad shapes (at right angles to the slope of their brightness)
  let e = vec2f(3.0) / u.size;
  let g = vec2f(lumAt(uv + vec2f(e.x, 0.0)) - lumAt(uv - vec2f(e.x, 0.0)), lumAt(uv + vec2f(0.0, e.y)) - lumAt(uv - vec2f(0.0, e.y)));
  let along = vec2f(-g.y, g.x) / (length(g) + 0.02);
  // a slow swirl, so the whole picture breathes while it changes
  let q = uv * vec2f(aspect, 1.0);
  let swirl = vec2f(loopNoise(q * 3.0 + u.seed, u.phase, u.churn), loopNoise(q * 3.0 + u.seed + 31.0, u.phase, u.churn)) - 0.5;
  let warp = (along * u.flow * 0.03 * (loopNoise(q * 9.0 + u.seed, u.phase, u.churn) - 0.5) * 2.0 + swirl * 0.03) * u.style;
  let uw = uv + warp / vec2f(aspect, 1.0);

  // irregular patches: each reads the texture from a place shifted by its own random step
  let cp = q / u.cell;
  let gid = floor(cp);
  var best = 1.0e9;
  var id = gid;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let c = gid + vec2f(f32(i), f32(j));
      let site = c + 0.5 + 0.4 * (vec2f(loopNoise(c * 0.37 + u.seed, u.phase, u.churn), loopNoise(c * 0.37 + u.seed + 7.0, u.phase, u.churn)) - 0.5) * 2.0;
      let d = distance(cp, site);
      if (d < best) { best = d; id = c; }
    }
  }
  let jump = (hash22(id + u.seed) - 0.5) * 2.0 * u.cell * u.shuffle * u.style;
  let up = uw + jump / vec2f(aspect, 1.0);

  // broad shapes: A's, then B's, with the broad colour running ahead toward B
  let la = textureSampleLevel(blurA, smp, uw, 0.0);
  let lb = textureSampleLevel(blurB, smp, uw, 0.0);
  var base = mix(la, lb, u.shape);
  let ma = textureSampleLevel(meanA, smp, uw, 0.0);
  let mb = textureSampleLevel(meanB, smp, uw, 0.0);
  base += (mix(ma, mb, u.lead) - mix(ma, mb, u.shape)) * min(u.style, 1.0);

  // texture: A's own where it is, B's in shuffled patches; B's leads
  let ta = textureSampleLevel(a, smp, uw, 0.0) - la;
  let tb = textureSampleLevel(b, smp, up, 0.0) - textureSampleLevel(blurB, smp, up, 0.0);
  let tex = mix(ta, tb, u.lead) * (1.0 + u.boost * u.style);

  let o = base + tex;
  let al = clamp(o.a, 0.0, 1.0);
  return vec4f(clamp(o.rgb, vec3f(0.0), vec3f(al)), al);
}`,
    });
    return { image };
  },
});
