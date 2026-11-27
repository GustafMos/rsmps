/**
 * Stabilize: steadies shaky handheld video, and smooths the large jumps of a hyperlapse (a Stop Motion node with Auto shoot).
 *
 * Two stages, like every node that must look at a whole clip (PROCESS MODE, docs/ENGINE.md):
 *   1. ANALYSE (the process job, once, saved with the project): every frame is read at about 256 px, corners are followed from each
 *      frame into the next (lib/stabilize.ts: patch matching over an image pyramid, a RANSAC similarity fit that ignores moving
 *      subjects) and the motion between neighbouring frames is stored as one small array: x, y, rotation, zoom, confidence per frame.
 *      No model, no network. A frame identical to the one before it (a held shot of a stop motion) is not analysed again.
 *   2. RENDER (a pure function of the stored track, the settings and the frame): the motions are added up to a camera path, the
 *      path is smoothed (or held), and every frame is moved by "smoothed minus real", so the picture is steady. Export is exact.
 * Until the clip has been analysed the picture passes through unchanged.
 */
import { defineNode } from '../../define';
import {
  ANALYSIS_SIDE,
  MotionTracker,
  planStabilize,
  sigmaFrames,
  toGrey,
  trackFrames,
  type SmoothOptions,
  type StabilizePlan,
} from '../../lib/stabilize';
import type { ImageValue, ProcessCtx } from '../../types';

const EDGE_INDEX: Record<string, number> = { clear: 0, stretch: 1, zoom: 1, mirror: 2, neighbours: 4 };
const TRACK_DOTS = 256;

/** The smoothing options the settings stand for. `loop`: the project loops, so smooth round the loop. */
function smoothOptions(p: { mode: unknown; smoothness: number; fixRotation: boolean; fixZoom: boolean; strength: number }, fps: number, loop: boolean): SmoothOptions {
  return {
    mode: p.mode === 'locked' ? 'locked' : 'smooth',
    sigma: sigmaFrames(p.smoothness, fps),
    loop,
    fixRotation: !!p.fixRotation,
    fixZoom: !!p.fixZoom,
    strength: p.strength,
  };
}

/**
 * The plan for the stored track and the settings. A render of every frame needs the same plan, so the last one per node is kept
 * (a pure memo of a pure function: same inputs, same plan; it never changes what a frame looks like).
 */
const PLANS = new Map<string, { key: string; plan: StabilizePlan }>();
function planFor(nodeId: string, track: Float32Array, stamp: string, o: SmoothOptions, aspect: number): StabilizePlan {
  const key = `${stamp}|${track.length}|${o.mode}|${o.sigma}|${o.loop}|${o.fixRotation}|${o.fixZoom}|${o.strength}|${aspect.toFixed(4)}`;
  const hit = PLANS.get(nodeId);
  if (hit && hit.key === key) return hit.plan;
  const plan = planStabilize(track, o, aspect);
  if (PLANS.size > 16) PLANS.delete(PLANS.keys().next().value as string);
  PLANS.set(nodeId, { key, plan });
  return plan;
}

/** The analysis job: read every frame small, follow the camera, store the track. */
async function analyse(job: ProcessCtx): Promise<{ meta: Record<string, unknown> }> {
  const total = Math.max(1, job.frames);
  // Read at about twice the analysis size and average down: a straight shrink of a 4K frame would alias.
  const proxy = Math.min(1, Math.max(0.02, (ANALYSIS_SIDE * 2) / Math.max(job.canvas.width, job.canvas.height, 1)));
  const tracker = new MotionTracker();
  let size = { w: 0, h: 0 };
  for (let f = 0; f < total; f++) {
    await job.yield();
    const pulled = await job.pull('image', { frame: f, proxy, quality: 'final' });
    let rgba: Uint8ClampedArray;
    let w = 0;
    let h = 0;
    try {
      const v = pulled.value;
      if (!(v && typeof v === 'object' && 'texture' in v)) throw new Error([...pulled.errors.values()][0] ?? 'The picture before the Stabilize node is empty. Connect a picture first.');
      const img = v as ImageValue;
      w = img.width;
      h = img.height;
      // premultiplied = over black, what a video holds
      rgba = await job.gpu.read(img, false);
    } finally {
      pulled.release();
    }
    const g = toGrey(rgba, w, h, ANALYSIS_SIDE);
    if (!size.w) size = { w: g.w, h: g.h };
    tracker.push(g);
    job.progress((f + 1) / total, `Frame ${f + 1} of ${total}${tracker.stats.uncertain ? `, ${tracker.stats.uncertain} uncertain` : ''}`, { frame: f + 1, frames: total });
  }
  const track = tracker.result();
  job.store.array('track', track);
  const p = job.params as unknown as { mode: string; smoothness: number; fixRotation: boolean; fixZoom: boolean; strength: number };
  const zoom = trackFrames(track) > 1 ? planStabilize(track, smoothOptions(p, job.fps, job.loop), size.w / Math.max(1, size.h)).zoom : 1;
  const st = tracker.stats;
  return {
    meta: {
      frames: total,
      fps: job.fps,
      uncertain: st.uncertain,
      repeated: st.repeated,
      width: size.w,
      height: size.h,
      zoom: Math.round(zoom * 1000) / 1000,
      cpuMsPerFrame: Math.round((st.cpuMs / total) * 100) / 100,
      item: job.item.dependent ? job.item.index : null,
    },
  };
}

export default defineNode({
  id: 'stabilize',
  title: 'Stabilize',
  category: 'transform',
  description:
    'Steadies shaky handheld video and smooths a hyperlapse. Press Analyse once: the camera motion of the whole clip is measured (no AI, nothing leaves your device) and saved. After that the picture is moved against the shake, either keeping the slow pans and walks (Smooth camera) or holding the first framing like a tripod (Locked off). Until it is analysed the picture passes through unchanged.',
  keywords: ['stabilize', 'stabilise', 'stabilization', 'stabilisation', 'steady', 'shake', 'handheld', 'hyperlapse', 'time lapse', 'timelapse', 'smooth camera', 'tripod', 'deshake', 'warp stabilizer', 'gimbal', 'jitter', 'video'],
  guide: {
    does: 'Steadies shaky handheld video by moving the picture against the shake.',
    steps: [
      'Wire the video into Image.',
      'Press Analyse once in its settings: the camera motion of the whole clip is measured and saved.',
      'Choose Smooth camera to keep slow pans, or hold the first frame still.',
    ],
    needs: [
      { input: 'image', hint: 'The shaky video.' },
    ],
    seeAlso: ['stop-motion', 'fake-360'],
  },
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    mode: {
      type: 'enum',
      default: 'smooth',
      options: [
        { value: 'smooth', label: 'Smooth camera' },
        { value: 'locked', label: 'Locked off' },
      ],
      label: 'Mode',
      hint: 'Smooth camera keeps the pans and walks you meant and removes the shake. Locked off tries to hold the first framing like a tripod.',
    },
    smoothness: {
      type: 'number',
      default: 1,
      min: 0.1,
      max: 20,
      softMax: 6,
      step: 0.1,
      unit: 's',
      label: 'Smoothness',
      visibleIf: (p) => p.mode !== 'locked',
      hint: 'How many seconds the camera path is smoothed over. Longer = steadier but a pan starts a little late. With the project loop on, the smoothing wraps round so the loop point does not jump. For a hyperlapse of shots a few seconds apart, use several of its shots.',
    },
    fixRotation: { type: 'bool', default: true, label: 'Fix rotation', hint: 'Also take out the tilt of the horizon.' },
    fixZoom: { type: 'bool', default: false, label: 'Fix zoom', hint: 'Also take out the camera moving in and out. Off by default: the zoom is the least certain thing to measure.' },
    strength: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Strength', hint: '0 = the picture as shot, 1 = fully stabilised.' },
    edges: {
      type: 'enum',
      default: 'zoom',
      options: [
        { value: 'zoom', label: 'Zoom in to hide' },
        { value: 'mirror', label: 'Mirror' },
        { value: 'stretch', label: 'Stretch' },
        { value: 'clear', label: 'Transparent' },
        { value: 'neighbours', label: 'Fill from nearby frames' },
      ],
      label: 'Edges',
      hint: 'What shows where the moved picture does not reach the frame. Zoom in to hide enlarges the whole clip just enough; Fill from nearby frames borrows the missing strip from the frames before and after.',
    },
    maxZoom: { type: 'number', default: 1.5, min: 1, max: 4, step: 0.01, label: 'Max zoom', visibleIf: (p) => p.edges === 'zoom', hint: 'The most Zoom in to hide may enlarge the picture. Where that is not enough the edge is stretched.' },
    showTrack: { type: 'bool', default: false, label: 'Show track', hint: 'Draws the camera path in the corner: orange = as shot, blue = stabilised, white dot = this frame.' },
  },
  process: {
    title: 'Analyse',
    description: 'Measure the camera motion of the whole clip once and store it.',
    // Until it has run the picture passes through; once it has, the old track stays in use while the clip is edited (the badge says stale).
    standIn: 'last',
    // A silently un-stabilised export is not what anyone wants.
    required: 'always',
    auto: false,
    gpu: true,
    // The analysis depends only on the pictures: every setting of this node is applied afterwards, at render time.
    signature: (_p, sigs) => `stabilize1|${sigs.image ?? ''}`,
    estimate: (_p, project) => ({ frames: Math.max(1, Math.round(project.duration * project.fps)), note: 'every frame is read once at about 256 px; no model, no network' }),
    run: (job) => analyse(job as unknown as ProcessCtx),
  },
  summary: (p) => `${p.mode === 'locked' ? 'locked off' : `smooth ${p.smoothness} s`}${p.strength < 1 ? ` · ${Math.round(p.strength * 100)}%` : ''}`,
  async render(ctx) {
    const src = ctx.in.image;
    const p = ctx.params;
    if (!src || p.strength <= 0) return { image: src };
    const ps = ctx.process!;
    const result = ps.servable ? ps.result : null;
    const itemOk = !result || result.meta.item === null || result.meta.item === undefined || result.meta.item === ctx.item.index;
    const track = result && itemOk ? await ps.array('track') : null;
    if (!result || !(track instanceof Float32Array) || trackFrames(track) < 2) return { image: src };

    const n = trackFrames(track);
    const t = ctx.time;
    const f = t.loop ? ((t.frame % n) + n) % n : Math.min(n - 1, Math.max(0, t.frame));
    const plan = planFor(ctx.nodeId, track, `${result.signature}|${result.createdAt}`, smoothOptions(p, t.fps, t.loop), src.width / src.height);
    const zoom = p.edges === 'zoom' ? Math.min(Math.max(1, plan.zoom), Math.max(1, p.maxZoom)) : 1;
    const map = (i: number) => [plan.maps[i * 4], plan.maps[i * 4 + 1], plan.maps[i * 4 + 2], plan.maps[i * 4 + 3]];

    // Fill from nearby frames: the frames just before and after, moved the same way, show what lies beyond this frame's edge.
    const near: { image: ImageValue; m: number[] }[] = [];
    if (p.edges === 'neighbours') {
      const seen = new Set<number>([f]);
      for (const d of [-1, 1, -2, 2]) {
        const j = t.loop ? (((f + d) % n) + n) % n : Math.min(n - 1, Math.max(0, f + d));
        if (seen.has(j)) continue;
        seen.add(j);
        const image = await ctx.pull('image', { seconds: j / t.fps });
        if (image) near.push({ image, m: map(j) });
      }
    }
    const [n1, n2, n3, n4] = [near[0], near[1], near[2], near[3]];
    const slot = (x: { image: ImageValue; m: number[] } | undefined) => x?.m ?? [1, 0, 0, 0];
    const wgsl = /* wgsl */ `
fn srcPos(px: vec2f, m: vec4f) -> vec2f {
  let L = max(u.size.x, u.size.y);
  let q = (px - 0.5 * u.size) / L / u.zoom;
  let s = vec2f(m.x * q.x - m.y * q.y, m.y * q.x + m.x * q.y) + m.zw;
  return s * L + 0.5 * u.size;
}
fn edgeDist(p: vec2f) -> f32 { return min(min(p.x, u.size.x - p.x), min(p.y, u.size.y - p.y)); }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var p = srcPos(px, u.m0);
  let e0 = edgeDist(p);
  let cl = textureSampleLevel(src, smp, clamp(p / u.size, vec2f(0.0), vec2f(1.0)), 0.0);
  if (u.edge < 0.5) {
    if (e0 <= -0.5) { return vec4f(0.0); }
    return cl * clamp(e0 + 0.5, 0.0, 1.0);
  }
  if (u.edge > 3.5) {
    var acc = cl * clamp(e0 + 0.5, 0.0, 1.0);
    var rest = 1.0 - clamp(e0 + 0.5, 0.0, 1.0);
    ${[n1, n2, n3, n4]
      .map((x, i) =>
        x
          ? `if (rest > 0.001) {
      let pn = srcPos(px, u.m${i + 1});
      let cv = clamp(edgeDist(pn) + 0.5, 0.0, 1.0);
      acc += textureSampleLevel(n${i + 1}, smp, clamp(pn / u.size, vec2f(0.0), vec2f(1.0)), 0.0) * (cv * rest);
      rest = rest * (1.0 - cv);
    }`
          : '',
      )
      .join('\n    ')}
    return acc + cl * rest;
  }
  if (u.edge > 1.5) {
    var st = p / u.size;
    st = 1.0 - abs(1.0 - fract(st * 0.5) * 2.0);
    return textureSampleLevel(src, smp, clamp(st, vec2f(0.0), vec2f(1.0)), 0.0);
  }
  return cl;
}`;
    let image = ctx.gpu.pass({
      label: 'stabilize',
      size: src,
      textures: { src, n1: n1?.image ?? null, n2: n2?.image ?? null, n3: n3?.image ?? null, n4: n4?.image ?? null },
      uniforms: { m0: map(f), m1: slot(n1), m2: slot(n2), m3: slot(n3), m4: slot(n4), zoom, edge: EDGE_INDEX[p.edges as string] ?? 1 },
      wgsl,
    });

    if (p.showTrack) {
      const count = Math.min(TRACK_DOTS, n);
      const data = new Float32Array(count * 4);
      let ext = 1e-4;
      for (let k = 0; k < count; k++) {
        const i = count === n ? k : Math.round((k * (n - 1)) / (count - 1));
        data[k * 4] = plan.real.x[i];
        data[k * 4 + 1] = plan.real.y[i];
        data[k * 4 + 2] = plan.smooth.x[i];
        data[k * 4 + 3] = plan.smooth.y[i];
        ext = Math.max(ext, Math.abs(plan.real.x[i]), Math.abs(plan.real.y[i]), Math.abs(plan.smooth.x[i]), Math.abs(plan.smooth.y[i]));
      }
      const trk = ctx.gpu.dataTexture(data, count, 1);
      const out = ctx.gpu.pass({
        label: 'stabilize track',
        size: image,
        textures: { src: image, trk },
        uniforms: { count, ext, now: [plan.real.x[f], plan.real.y[f], plan.smooth.x[f], plan.smooth.y[f]] },
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var c = textureSampleLevel(src, smp, uv, 0.0);
  let bw = u.size.x * 0.3;
  let bh = bw * 0.75;
  let o = vec2f(u.size.x * 0.03, u.size.y - bh - u.size.x * 0.03);
  let l = px - o;
  if (l.x < 0.0 || l.y < 0.0 || l.x > bw || l.y > bh) { return c; }
  c = vec4f(c.rgb * 0.45, 1.0);
  let sc = 0.45 * bh / u.ext;
  let mid = vec2f(bw * 0.5, bh * 0.5);
  let r = max(1.2, u.size.x * 0.004);
  var col = vec3f(0.0);
  var hit = 0.0;
  let n = i32(u.count);
  for (var i = 0; i < n; i++) {
    let d = textureLoad(trk, vec2i(i, 0), 0);
    if (distance(l, mid + d.xy * sc) < r) { col = vec3f(1.0, 0.62, 0.15); hit = 1.0; }
    if (distance(l, mid + d.zw * sc) < r) { col = vec3f(0.35, 0.7, 1.0); hit = 1.0; }
  }
  if (distance(l, mid + u.now.xy * sc) < r * 2.0) { col = vec3f(1.0, 0.62, 0.15); hit = 1.0; }
  if (distance(l, mid + u.now.zw * sc) < r * 2.0) { col = vec3f(1.0); hit = 1.0; }
  return vec4f(mix(c.rgb, col, hit), 1.0);
}`,
      });
      ctx.gpu.recycle(image);
      image = out;
    }
    return { image };
  },
});
