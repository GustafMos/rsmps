import type { ImageValue, NodeGpu } from '../types';
import { mod } from './util-time';

/**
 * Shared mechanism of Slit Scan and Time Displace: "every pixel shows its own moment".
 *
 * N time slices (the same input at N different frames) are blended per pixel by a position 0..1 that picks between the two
 * nearest slices. Cost model (docs/RECIPES.md "Video feedback and time tricks"):
 *  - pulls: one per DISTINCT frame needed (slices that land on the same frame share a pull, the current frame is never pulled),
 *    and none at all when the input is static (`ctx.inputVaries` false: every slice would be the same picture);
 *  - passes: ceil(N / SLICE_GROUP) instead of N. The GPU layer has no texture arrays, so each pass binds SLICE_GROUP slices as
 *    separate textures and adds their weighted sum to the running total.
 */
export const SLICE_GROUP = 8;

export interface SliceCtx {
  time: { seconds: number; fps: number; duration: number; loop: boolean };
  in: Record<string, unknown>;
  inputVaries(input: never): boolean;
  pull(input: never, at: { seconds: number }): Promise<unknown>;
}

const isImage = (v: unknown): v is ImageValue => !!v && typeof v === 'object' && 'texture' in (v as object);

/**
 * The input at `current frame + offsets[i]` frames for each i. Same-sized images only (a slice of another size falls back to the
 * current frame). A static input returns the current picture for every slice without reading the clock, so the node stays static.
 */
export async function pullSliceFrames(ctx: SliceCtx, input: string, offsets: number[]): Promise<ImageValue[]> {
  const cur = ctx.in[input] as ImageValue;
  if (!ctx.inputVaries(input as never)) return offsets.map(() => cur);
  const t = ctx.time;
  const total = Math.max(1, Math.round(t.duration * t.fps));
  const curFrame = Math.max(0, Math.round(t.seconds * t.fps));
  const norm = (f: number) => (t.loop ? mod(f, total) : Math.max(0, f));
  const got = new Map<number, ImageValue>([[norm(curFrame), cur]]);
  const out: ImageValue[] = [];
  for (const off of offsets) {
    const f = norm(curFrame + off);
    let img = got.get(f);
    if (!img) {
      const v = await ctx.pull(input as never, { seconds: f / t.fps });
      img = isImage(v) && v.width === cur.width && v.height === cur.height ? v : cur;
      got.set(f, img);
    }
    out.push(img);
  }
  return out;
}

/** WGSL snippet: the 0..1 slice position of a pixel. With a map: luma of texture `tmap`; otherwise u.dir picks rows / columns / rings. */
export function slicePosWgsl(hasMap: boolean): string {
  return hasMap
    ? 'var pos = luma(textureSampleLevel(tmap, smp, uv, 0.0).rgb);'
    : `var pos = uv.y;
  if (u.dir > 0.5 && u.dir < 1.5) { pos = uv.x; }
  if (u.dir > 1.5) { pos = clamp(length((uv - 0.5) * vec2f(u.size.x / u.size.y, 1.0)) / 0.7071, 0.0, 1.0); }`;
}

export interface BlendSlicesOptions {
  /** 0 rows, 1 columns, 2 rings (ignored with a map). */
  dir?: number;
  map?: ImageValue | null;
  /** 0 = hard bands, 1 = linear blend between the two nearest slices. */
  soft: number;
  reverse?: boolean;
  label?: string;
}

/** Blend `slices` (slice k sits at position k / (N - 1)) into one picture, SLICE_GROUP slices per pass. */
export function blendSlices(gpu: NodeGpu, slices: ImageValue[], o: BlendSlicesOptions): ImageValue {
  const n = slices.length;
  const hasMap = !!o.map;
  let acc: ImageValue | null = null;
  for (let base = 0; base < n; base += SLICE_GROUP) {
    const cnt = Math.min(SLICE_GROUP, n - base);
    const last = base + cnt >= n;
    const textures: Record<string, ImageValue | null> = { acc, tmap: o.map ?? null };
    let sum = '';
    for (let j = 0; j < cnt; j++) {
      textures[`s${j}`] = slices[base + j];
      sum += `  { let k = u.base + ${j}.0; let w = mix(f32(floor(s + 0.5) == k), max(0.0, 1.0 - abs(s - k)), u.soft); c += textureSampleLevel(s${j}, smpNearest, uv, 0.0) * w; }\n`;
    }
    const next: ImageValue = gpu.pass({
      label: o.label ?? 'time-slices',
      size: slices[0],
      format: last ? 'rgba8unorm' : 'rgba16float',
      textures,
      uniforms: { base, n, soft: o.soft, dir: o.dir ?? 0, reverse: !!o.reverse },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  ${slicePosWgsl(hasMap)}
  if (u.reverse > 0.5) { pos = 1.0 - pos; }
  let s = clamp(pos, 0.0, 1.0) * (u.n - 1.0);
  var c = ${acc ? 'textureSampleLevel(acc, smpNearest, uv, 0.0)' : 'vec4f(0.0)'};
${sum}  return c;
}`,
    });
    if (acc) gpu.recycle(acc);
    acc = next;
  }
  return acc as ImageValue;
}
