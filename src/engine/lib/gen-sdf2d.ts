/**
 * Small GPU signed distance fields of a picture's silhouette (jump flooding), shared by Image to 3D and SDF 3D (2D shape input).
 *
 * `occupancy` samples the picture on a grid (grid texel = one art pixel when the picture has an art grid) and thresholds it.
 * `signedField` turns that into the field: r = signed distance to the silhouette edge in GRID CELLS (negative inside), measured from
 * the cell centre, rgba16float. About 2 + log2(grid) tiny passes on a grid that is at most 512 on its long side.
 * `profileMask` turns a drawing into the silhouette of its surface of revolution (for the lathe mode).
 */
import type { ImageValue, NodeGpu } from '../types';

export interface Grid {
  gw: number;
  gh: number;
}

/** Grid for a picture: follows the art grid when the picture has one, else at most `cap` cells on the long side. */
export function gridFor(img: { width: number; height: number; cell?: number }, resolution: number, cap = 256): Grid {
  let gw: number;
  const long = Math.max(img.width, img.height);
  if (resolution >= 1) gw = Math.min(resolution, long);
  else if (img.cell && img.cell > 1.001) gw = Math.min(512, long / img.cell);
  else gw = Math.min(cap, long);
  const k = Math.max(1, Math.round(gw)) / long;
  return { gw: Math.max(1, Math.round(img.width * k)), gh: Math.max(1, Math.round(img.height * k)) };
}

const OCC_WGSL = (fromBrightness: boolean, nearest: boolean) => /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureSampleLevel(src, ${nearest ? 'smpNearest' : 'smp'}, uv, 0.0);
  let v = ${fromBrightness ? 'luma(unpremul(c).rgb) * c.a' : 'c.a'};
  let o = select(0.0, 1.0, v > u.thr);
  return vec4f(o, o, o, 1.0);
}`;

/** r = 1 where the picture's alpha (or brightness) exceeds `threshold`. */
export function occupancy(gpu: NodeGpu, image: ImageValue, grid: Grid, o: { threshold: number; fromBrightness: boolean; nearest: boolean }): ImageValue {
  return gpu.pass({
    label: 'sdf2d occupancy',
    size: { width: grid.gw, height: grid.gh },
    textures: { src: image },
    uniforms: { thr: o.threshold },
    wgsl: OCC_WGSL(o.fromBrightness, o.nearest),
  });
}

const OCC_AT = /* wgsl */ `
fn occAt(t: texture_2d<f32>, c: vec2i, dims: vec2i) -> bool {
  if (c.x < 0 || c.y < 0 || c.x >= dims.x || c.y >= dims.y) { return false; }
  return textureLoad(t, c, 0).r > 0.5;
}`;

const JFA_INIT = /* wgsl */ `${OCC_AT}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2i(textureDimensions(occ));
  let c = vec2i(floor(px));
  let me = occAt(occ, c, dims);
  let edge = occAt(occ, c + vec2i(1, 0), dims) != me || occAt(occ, c - vec2i(1, 0), dims) != me || occAt(occ, c + vec2i(0, 1), dims) != me || occAt(occ, c - vec2i(0, 1), dims) != me;
  if (edge) { return vec4f(f32(c.x), f32(c.y), 1.0, 0.0); }
  return vec4f(-1.0, -1.0, 0.0, 0.0);
}`;

const JFA_STEP = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2i(textureDimensions(prev));
  let c = vec2i(floor(px));
  let k = i32(u.k);
  var best = vec4f(-1.0, -1.0, 0.0, 0.0);
  var bd = 1e12;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = c + vec2i(dx, dy) * k;
      if (q.x < 0 || q.y < 0 || q.x >= dims.x || q.y >= dims.y) { continue; }
      let s = textureLoad(prev, q, 0);
      if (s.z > 0.5) {
        let d = distance(vec2f(c), s.xy);
        if (d < bd) { bd = d; best = s; }
      }
    }
  }
  return best;
}`;

const JFA_FINAL = /* wgsl */ `${OCC_AT}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2i(textureDimensions(occ));
  let c = vec2i(floor(px));
  let s = textureLoad(prev, c, 0);
  var d = 4000.0;
  if (s.z > 0.5) { d = distance(vec2f(c), s.xy); }
  let g = (d + 0.5) * select(1.0, -1.0, occAt(occ, c, dims));
  return vec4f(g, 0.0, 0.0, 1.0);
}`;

const FIELD_BLUR = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2i(textureDimensions(src));
  let c = vec2i(floor(px));
  var sum = 0.0;
  var wsum = 0.0;
  for (var dy = -2; dy <= 2; dy++) {
    for (var dx = -2; dx <= 2; dx++) {
      let w = (3.0 - abs(f32(dx)) * 0.9) * (3.0 - abs(f32(dy)) * 0.9);
      sum += textureLoad(src, clamp(c + vec2i(dx, dy), vec2i(0), dims - 1), 0).r * w;
      wsum += w;
    }
  }
  return vec4f(sum / wsum, 0.0, 0.0, 1.0);
}`;

/** Signed distance field (cells) of an occupancy picture. `smooth` blurs the lattice out of the zero contour (curved outlines). Recycles its temporaries. */
export function signedField(gpu: NodeGpu, occ: ImageValue, smooth = false): ImageValue {
  const size = { width: occ.width, height: occ.height };
  let cur = gpu.pass({ label: 'sdf2d jfa init', size, textures: { occ }, wgsl: JFA_INIT, format: 'rgba16float' });
  let k = 1;
  while (k * 2 < Math.max(size.width, size.height)) k *= 2;
  for (; k >= 1; k = Math.floor(k / 2)) {
    const prev = cur;
    cur = gpu.pass({ label: 'sdf2d jfa step', size, textures: { prev }, uniforms: { k }, wgsl: JFA_STEP, format: 'rgba16float' });
    gpu.recycle(prev);
  }
  const out = gpu.pass({ label: 'sdf2d field', size, textures: { prev: cur, occ }, wgsl: JFA_FINAL, format: 'rgba16float' });
  gpu.recycle(cur);
  if (!smooth) return out;
  const blurred = gpu.pass({ label: 'sdf2d blur', size, textures: { src: out }, wgsl: FIELD_BLUR, format: 'rgba16float' });
  gpu.recycle(out);
  return blurred;
}

/**
 * Lathe: the silhouette of the drawing's surface of revolution. For every row the radius is the farthest occupied pixel from the
 * vertical centre line; the result is symmetric about it. Two passes (row radii, then the mask).
 */
export function profileMask(gpu: NodeGpu, occ: ImageValue): ImageValue {
  const radii = gpu.pass({
    label: 'lathe radii',
    size: { width: 1, height: occ.height },
    textures: { occ },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2i(textureDimensions(occ));
  let y = i32(floor(px.y));
  let cx = f32(dims.x) * 0.5;
  var r = 0.0;
  for (var x = 0; x < dims.x; x++) {
    if (textureLoad(occ, vec2i(x, y), 0).r > 0.5) { r = max(r, abs(f32(x) + 0.5 - cx)); }
  }
  return vec4f(r, 0.0, 0.0, 1.0);
}`,
    format: 'rgba16float',
  });
  const mask = gpu.pass({
    label: 'lathe mask',
    size: { width: occ.width, height: occ.height },
    textures: { radii },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let r = textureLoad(radii, vec2i(0, i32(floor(px.y))), 0).r;
  let o = select(0.0, 1.0, abs(px.x - u.size.x * 0.5) < r);
  return vec4f(o, o, o, 1.0);
}`,
  });
  gpu.recycle(radii);
  return mask;
}

/**
 * WGSL for reading a field in a march shader. Needs textures `fld` (signed field) and, for the blocky variant, `occ`; uniforms
 * `grid` (vec2 cells) and `cellW` (object units per cell). `sd2(pc)` takes a position in CELLS from the top-left of the grid and
 * returns the signed distance in CELLS (a lower bound). The blocky variant is exact for staircase (pixel art) silhouettes.
 */
export const SDF2D_WGSL = (blocky: boolean): string => /* wgsl */ `
fn fieldAt(pc: vec2f) -> f32 { return textureSampleLevel(fld, smp, pc / u.grid, 0.0).r; }
${
  blocky
    ? `fn occCell(c: vec2i) -> bool {
  let dims = vec2i(u.grid);
  if (c.x < 0 || c.y < 0 || c.x >= dims.x || c.y >= dims.y) { return false; }
  return textureLoad(occ, c, 0).r > 0.5;
}
fn sd2in(pc: vec2f) -> f32 {
  let g = fieldAt(pc);
  if (abs(g) > 3.0) { return g - sign(g) * 1.5; }
  let ci = vec2i(floor(pc));
  let me = occCell(ci);
  var best = 1.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let k = ci + vec2i(dx, dy);
      if (occCell(k) != me) {
        let lo = vec2f(k);
        let q = max(max(lo - pc, pc - (lo + 1.0)), vec2f(0.0));
        best = min(best, length(q));
      }
    }
  }
  return select(best, -best, me);
}`
    : `fn sd2in(pc: vec2f) -> f32 { return fieldAt(pc) * 0.92; }`
}
fn sd2(pc: vec2f) -> f32 {
  let pcl = clamp(pc, vec2f(0.0), u.grid);
  return sd2in(pcl) + length(pc - pcl);
}
`;
