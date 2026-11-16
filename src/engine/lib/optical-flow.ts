import type { ImageValue, NodeGpu } from '../types';

/**
 * Pyramidal Lucas-Kanade optical flow on the GPU (fragment passes only, no readbacks, no state).
 *
 * Encoding of a flow image (what `Optical Flow` outputs on `flow`, rgba16float, at the flow resolution):
 *   r = horizontal motion, g = vertical motion, both as a FRACTION OF THE IMAGE WIDTH / HEIGHT per frame, motion from the
 *   previous frame to this one, positive = right / down. A bright spot that moves 2 texels right in a 64 texel wide picture has
 *   r = 2 / 64 = 0.03125. The unit is resolution independent: sample it at any size and multiply by that size to get pixels.
 *   b = luma of the CURRENT frame at flow resolution (carried so the next frame can reuse it instead of recomputing the previous
 *       frame's picture: `Optical Flow` and `Motion Smear` find it through `ctx.previous()`),
 *   a = 1.
 *
 * Cost (passes per frame, L levels, I iterations): 1 luma + (L - 1) downsamples for the current frame, the same for the previous
 * frame unless its luma comes from the cache (then only its L - 1 downsamples), and L * I solver passes. Defaults L=3, I=2:
 * 11 passes with a cached previous luma, 12 without, all at flow resolution (default half size).
 */
export interface FlowOptions {
  /** Flow resolution relative to the image (0.1..1). */
  scale: number;
  /** Pyramid levels (coarse-to-fine). */
  levels: number;
  /** Solver passes per level. */
  iterations: number;
  /** Window radius in texels of the level (1 = 3x3 ... 5 = 11x11). */
  window: number;
}

export const FLOW_DEFAULTS: FlowOptions = { scale: 0.5, levels: 3, iterations: 2, window: 3 };

export interface Grid {
  width: number;
  height: number;
  unit: number;
}

/** Flow grid for an image: at least 16 texels on the short side, never larger than the image. */
export function flowGrid(src: { width: number; height: number; unit: number }, scale: number): Grid {
  const s = Math.min(1, Math.max(0.05, scale));
  const short = Math.min(src.width, src.height);
  const k = Math.min(1, Math.max(s, Math.min(16, short) / short));
  const width = Math.max(1, Math.round(src.width * k));
  const height = Math.max(1, Math.round(src.height * k));
  return { width, height, unit: src.unit * (width / src.width) };
}

/** Levels that still leave at least 6 texels on the short side. */
export function usableLevels(grid: Grid, levels: number): number {
  let n = 1;
  let w = Math.min(grid.width, grid.height);
  while (n < Math.round(levels) && Math.ceil(w / 2) >= 6) {
    w = Math.ceil(w / 2);
    n++;
  }
  return n;
}

/** Luma of an image resampled to the flow grid, stored in `.b` (rgba16float). A 2x2 box in source space, so it does not alias. */
export function lumaGrid(gpu: NodeGpu, img: ImageValue, grid: Grid): ImageValue {
  return gpu.pass({
    label: 'flow-luma',
    size: grid,
    format: 'rgba16float',
    textures: { src: img },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let d = 0.25 / u.size;
  var l = 0.0;
  l += luma(textureSampleLevel(src, smp, uv + vec2f(-d.x, -d.y), 0.0).rgb);
  l += luma(textureSampleLevel(src, smp, uv + vec2f( d.x, -d.y), 0.0).rgb);
  l += luma(textureSampleLevel(src, smp, uv + vec2f(-d.x,  d.y), 0.0).rgb);
  l += luma(textureSampleLevel(src, smp, uv + vec2f( d.x,  d.y), 0.0).rgb);
  return vec4f(0.0, 0.0, l * 0.25, 1.0);
}`,
  });
}

function downsample(gpu: NodeGpu, fine: ImageValue): ImageValue {
  return gpu.pass({
    label: 'flow-down',
    size: { width: Math.ceil(fine.width / 2), height: Math.ceil(fine.height / 2), unit: 1 },
    format: 'rgba16float',
    textures: { fine },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  return vec4f(0.0, 0.0, textureSampleLevel(fine, smp, uv, 0.0).b, 1.0);
}`,
  });
}

/** Level 0 = the flow grid luma itself (not owned: never recycled here), then `levels - 1` downsamples (owned by the caller). */
function pyramid(gpu: NodeGpu, base: ImageValue, levels: number): ImageValue[] {
  const out = [base];
  for (let l = 1; l < levels; l++) out.push(downsample(gpu, out[l - 1]));
  return out;
}

/**
 * Flow between two luma grids (see `lumaGrid`): `cur` is the current frame, `prev` the previous one. Returns the flow image in the
 * encoding above. All intermediates are recycled; the two inputs are left alone.
 */
export function flowFromLuma(gpu: NodeGpu, cur: ImageValue, prev: ImageValue, o: FlowOptions): ImageValue {
  const grid = { width: cur.width, height: cur.height, unit: cur.unit };
  const L = usableLevels(grid, o.levels);
  const A = pyramid(gpu, cur, L);
  const B = pyramid(gpu, prev, L);
  const iters = Math.max(1, Math.round(o.iterations));
  const R = Math.max(1, Math.min(6, Math.round(o.window)));
  let est: ImageValue | null = null;
  for (let l = L - 1; l >= 0; l--) {
    for (let it = 0; it < iters; it++) {
      const last = l === 0 && it === iters - 1;
      const next: ImageValue = gpu.pass({
        label: 'flow-lk',
        size: A[l],
        format: 'rgba16float',
        textures: { cur: A[l], prev: B[l], est },
        uniforms: { gscale: it === 0 ? 2 : 1, rad: R, last },
        wgsl: /* wgsl */ `
fn tap(t: texture_2d<f32>, q: vec2f) -> f32 {
  return textureSampleLevel(t, smp, q / vec2f(textureDimensions(t)), 0.0).b;
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  ${est ? 'let v0 = textureSampleLevel(est, smp, uv, 0.0).rg * u.gscale;' : 'let v0 = vec2f(0.0);'}
  let n = i32(u.rad);
  let sig = max(1.0, u.rad * 0.6);
  var sw = 0.0; var gxx = 0.0; var gxy = 0.0; var gyy = 0.0; var bx = 0.0; var by = 0.0;
  for (var j = -n; j <= n; j++) {
    for (var i = -n; i <= n; i++) {
      let o = vec2f(f32(i), f32(j));
      let w = exp(-dot(o, o) / (2.0 * sig * sig));
      let q = px + o;
      let pw = q + v0;
      let ix = (tap(prev, pw + vec2f(1.0, 0.0)) - tap(prev, pw - vec2f(1.0, 0.0))) * 0.5;
      let iy = (tap(prev, pw + vec2f(0.0, 1.0)) - tap(prev, pw - vec2f(0.0, 1.0))) * 0.5;
      let r = tap(prev, pw) - tap(cur, q);
      sw += w; gxx += w * ix * ix; gxy += w * ix * iy; gyy += w * iy * iy; bx += w * ix * r; by += w * iy * r;
    }
  }
  gxx = gxx / sw + 0.0001; gyy = gyy / sw + 0.0001; gxy = gxy / sw; bx = bx / sw; by = by / sw;
  let det = gxx * gyy - gxy * gxy;
  var d = vec2f(-(gyy * bx - gxy * by), -(gxx * by - gxy * bx)) / det;
  d = clamp(d, vec2f(-2.0), vec2f(2.0));
  let v = v0 + d;
  if (u.last > 0.5) {
    // backward vector v (current pixel came from prev + v)  ->  forward motion in fractions of the image size
    return vec4f(-v.x / u.size.x, -v.y / u.size.y, tap(cur, px), 1.0);
  }
  return vec4f(v, 0.0, 1.0);
}`,
      });
      if (est) gpu.recycle(est);
      est = next;
    }
  }
  for (let l = 1; l < L; l++) {
    gpu.recycle(A[l]);
    gpu.recycle(B[l]);
  }
  return est as ImageValue;
}

/**
 * Flow between two pictures. `prevLuma` (a flow image of the previous frame, or any image with luma in `.b` on the flow grid)
 * saves one pass and the previous picture's evaluation; otherwise `prev` is converted here.
 */
export function flowBetween(gpu: NodeGpu, cur: ImageValue, prev: ImageValue | null, prevLuma: ImageValue | null, o: FlowOptions): ImageValue {
  const grid = flowGrid(cur, o.scale);
  const curLuma = lumaGrid(gpu, cur, grid);
  const ownPrev = !prevLuma || prevLuma.width !== grid.width || prevLuma.height !== grid.height;
  const pl = ownPrev ? (prev && prev !== cur ? lumaGrid(gpu, prev, grid) : curLuma) : (prevLuma as ImageValue);
  const flow = flowFromLuma(gpu, curLuma, pl, o);
  if (ownPrev && pl !== curLuma) gpu.recycle(pl);
  gpu.recycle(curLuma);
  return flow;
}

/** Colour wheel visualisation at `size`: hue = direction (red = right, green = down-left side of the wheel...), brightness = speed. */
export function flowPreview(gpu: NodeGpu, flow: ImageValue, size: { width: number; height: number; unit: number }, fullScale: number): ImageValue {
  return gpu.pass({
    label: 'flow-preview',
    size,
    textures: { flow },
    uniforms: { fullScale: Math.max(0.01, fullScale) },
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let m = textureSampleLevel(flow, smp, uv, 0.0).rg * u.size;
  let speed = length(m);
  let hue = fract(atan2(m.y, m.x) / TAU + 1.0);
  return vec4f(hsvToRgb(vec3f(hue, 1.0, clamp(speed / u.fullScale, 0.0, 1.0))), 1.0);
}`,
  });
}

/** The input at absolute project frame `frame` (wrapped around the loop when the project loops, clamped at 0 otherwise). Null when it is missing or another size. */
export async function pullFrameAbs(
  ctx: { time: { fps: number; duration: number; loop: boolean }; pull(input: never, at: { seconds: number }): Promise<unknown> },
  input: string,
  frame: number,
  like: { width: number; height: number },
): Promise<ImageValue | null> {
  const t = ctx.time;
  const total = Math.max(1, Math.round(t.duration * t.fps));
  const f = t.loop ? ((frame % total) + total) % total : Math.max(0, frame);
  const v = (await ctx.pull(input as never, { seconds: f / t.fps })) as ImageValue | null;
  return v && typeof v === 'object' && 'texture' in v && v.width === like.width && v.height === like.height ? v : null;
}
