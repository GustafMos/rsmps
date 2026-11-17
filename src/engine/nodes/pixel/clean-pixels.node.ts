import { defineNode } from '../../define';
import { withArtGrid } from '../../lib/art-grid';
import type { ImageValue, NodeGpu } from '../../types';

export interface CleanOptions {
  hardAlpha: boolean;
  threshold: number;
  defringe: boolean;
  orphans: boolean;
  holes: boolean;
  jaggies: boolean;
}

/** Pixel-art cleanup on an art-size image: at most two passes (alpha, orphans, holes and fringe colour in one; jaggies in a second). */
export function cleanPixels(gpu: NodeGpu, src: ImageValue, o: CleanOptions): ImageValue {
  const main = gpu.pass({
    label: 'clean-pixels',
    size: src,
    textures: { src },
    uniforms: { thr: o.hardAlpha ? o.threshold : 0.001, hard: o.hardAlpha, defringe: o.defringe, orphans: o.orphans, holes: o.holes },
    wgsl: /* wgsl */ `
fn P(x: i32, y: i32) -> vec4f {
  let d = vec2i(textureDimensions(src));
  if (x < 0 || y < 0 || x >= d.x || y >= d.y) { return vec4f(0.0); }
  return textureLoad(src, vec2i(x, y), 0);
}
fn solid(x: i32, y: i32) -> bool { return P(x, y).a >= u.thr; }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let x = i32(floor(px.x));
  let y = i32(floor(px.y));
  let s = P(x, y);
  let me = s.a >= u.thr;
  if (me) {
    if (u.orphans > 0.5) {
      var found = false;
      for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) { if ((dx != 0 || dy != 0) && solid(x + dx, y + dy)) { found = true; } } }
      if (!found) { return vec4f(0.0); }
    }
    var c = unpremul(s);
    if (u.defringe > 0.5 && c.a < 0.999) {
      // colour of a partly covered pixel = average of the fully covered neighbours, when there are any
      var sum = vec3f(0.0);
      var k = 0.0;
      for (var dy = -1; dy <= 1; dy++) { for (var dx = -1; dx <= 1; dx++) {
        let n = P(x + dx, y + dy);
        if (n.a > 0.999) { sum += unpremul(n).rgb; k += 1.0; }
      } }
      if (k > 0.0) { c = vec4f(sum / k, c.a); }
    }
    if (u.hard > 0.5) { c.a = 1.0; }
    return premul(c);
  }
  // not solid: a hole when all four neighbours are
  if (u.holes > 0.5 && solid(x, y - 1) && solid(x, y + 1) && solid(x - 1, y) && solid(x + 1, y)) {
    let a = unpremul(P(x, y - 1)).rgb;
    let b = unpremul(P(x, y + 1)).rgb;
    let l = unpremul(P(x - 1, y)).rgb;
    let r = unpremul(P(x + 1, y)).rgb;
    // the most common of the four colours (first one wins a tie)
    var best = a;
    var bestN = 0;
    for (var i = 0; i < 4; i++) {
      var cand = a;
      if (i == 1) { cand = b; } else if (i == 2) { cand = l; } else if (i == 3) { cand = r; }
      var n = 0;
      if (all(cand == a)) { n++; }
      if (all(cand == b)) { n++; }
      if (all(cand == l)) { n++; }
      if (all(cand == r)) { n++; }
      if (n > bestN) { bestN = n; best = cand; }
    }
    return premul(vec4f(best, 1.0));
  }
  if (u.hard > 0.5) { return vec4f(0.0); }
  return s;
}`,
  });
  if (!o.jaggies) return main;
  const out = gpu.pass({
    label: 'clean-jaggies',
    size: src,
    textures: { src: main },
    wgsl: /* wgsl */ `
fn A(x: i32, y: i32) -> bool {
  let d = vec2i(textureDimensions(src));
  if (x < 0 || y < 0 || x >= d.x || y >= d.y) { return false; }
  return textureLoad(src, vec2i(x, y), 0).a >= 0.5;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let x = i32(floor(px.x));
  let y = i32(floor(px.y));
  let s = textureLoad(src, vec2i(x, y), 0);
  if (s.a < 0.5) { return s; }
  let up = A(x, y - 1);
  let dn = A(x, y + 1);
  let lf = A(x - 1, y);
  let rt = A(x + 1, y);
  var count = 0;
  if (up) { count++; } if (dn) { count++; } if (lf) { count++; } if (rt) { count++; }
  if (count != 2) { return s; }
  // an elbow of a one pixel line: one vertical and one horizontal neighbour, and the corner pixel between them empty
  var elbow = false;
  if (up && rt && !A(x + 1, y - 1)) { elbow = true; }
  if (up && lf && !A(x - 1, y - 1)) { elbow = true; }
  if (dn && rt && !A(x + 1, y + 1)) { elbow = true; }
  if (dn && lf && !A(x - 1, y + 1)) { elbow = true; }
  // Neighbouring elbows must not both go (a staircase would break): only those on even (x + y) are removed. Their two neighbours are odd, so they stay and touch diagonally.
  if (elbow && ((x + y) & 1) == 0) { return vec4f(0.0); }
  return s;
}`,
  });
  gpu.recycle(main);
  return out;
}

export default defineNode({
  id: 'clean-pixels',
  title: 'Pixel Cleanup',
  category: 'pixel',
  description:
    'The usual pixel-art clean-up after scaling a picture down: hard alpha (no half-transparent edge pixels), stray single pixels removed, one-pixel holes filled, the colors of leftover edge pixels taken from their solid neighbors, and optionally the corner pixels of one-pixel-wide lines trimmed. Works on the art grid.',
  keywords: ['cleanup', 'clean up', 'orphan', 'stray', 'hole', 'fringe', 'alpha threshold', 'hard alpha', 'jaggies', 'pixel perfect', 'sprite', 'downscale'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    hardAlpha: { type: 'bool', default: true, label: 'Hard alpha', hint: 'Every pixel becomes fully opaque or fully transparent at the cutoff below.' },
    threshold: { type: 'number', default: 0.5, min: 0.01, max: 1, step: 0.01, label: 'Alpha cutoff', visibleIf: (p) => p.hardAlpha === true },
    defringe: { type: 'bool', default: true, label: 'Fix edge colors', hint: 'A partly transparent edge pixel takes the average color of the solid pixels around it (removes dark or light halos).' },
    orphans: { type: 'bool', default: true, label: 'Remove stray pixels', hint: 'A solid pixel with no solid pixel among its 8 neighbors.' },
    holes: { type: 'bool', default: true, label: 'Fill 1 px holes', hint: 'An empty pixel whose 4 neighbors are all solid takes their most common color.' },
    jaggies: { type: 'bool', default: false, label: 'Trim elbows', hint: 'For one-pixel lines: removes every other corner pixel of L-shaped steps so a line steps diagonally (pixel-perfect lines). Leave off for filled shapes.' },
  },
  summary: (p) => [p.hardAlpha && 'hard alpha', p.orphans && 'strays', p.holes && 'holes', p.jaggies && 'elbows'].filter(Boolean).join(' · ') || 'off',
  render(ctx) {
    const p = ctx.params;
    const image = withArtGrid(ctx.gpu, ctx.in.image, 0, (art) => cleanPixels(ctx.gpu, art, p));
    return { image };
  },
});
