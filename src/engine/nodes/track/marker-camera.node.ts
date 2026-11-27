/**
 * Marker Camera: a printed square marker in the camera picture tells the app exactly where the phone is, so a 3D object stands
 * on the marker with the right perspective from every side, also while walking (which AR Camera, with motion sensors only, cannot do).
 *
 * HOW A FRAME IS MADE: the picture is shrunk to a small grey copy on the GPU, read back, and searched on the CPU (lib/marker-detect.ts).
 * The render waits for that answer, so the camera this node outputs always belongs to the very picture it was given: there is no
 * "frame or two" of delay between object and picture inside the graph. The Picture output is that same frame (flipped back when
 * the input was a mirror image, with the optional overlay or cover), so wiring it under the object keeps the two locked together.
 *
 * MEMORY: a node cannot remember the frame before, but live smoothing and "hold the pose while the marker is hidden" need exactly
 * that. A small module-level memory per node does it (as lib/motion-source.ts leaves the smoothing of sensors to the host). It is
 * only trusted when the frame asked for follows the remembered one; after a jump in time it starts afresh. An export counts
 * frames strictly one by one from its first frame, so the same export gives the same result twice. For a result that is the same
 * however you scrub, press "Analyze clip": every frame's sighting is then stored, smoothing looks at both neighbours (no trailing
 * at all), and preview and export read the same numbers.
 */
import { defineNode } from '../../define';
import { MARKER_COUNT } from '../../lib/marker-code';
import { detectMarkers, greyFromRgba } from '../../lib/marker-detect';
import { MARKER_CORNERS, awayCamera, cameraFromPose, homography, invert3, projectPoint, type Pt } from '../../lib/marker-pose';
import { analysisSize, fromClip, packSighting, shrinkToGrey, stepLive, type LiveState, type LostMode, type Sighting, type StoredFrame, type TrackResult } from '../../lib/marker-track';
import { stableStringify } from '../../lib/stable-json';
import type { ImageValue, NodeGpu, Region } from '../../types';

const ID_OPTIONS = [{ value: 'any', label: 'Any marker' }, ...Array.from({ length: MARKER_COUNT }, (_, i) => ({ value: String(i + 1), label: `Marker ${i + 1}` }))] as const;
const wantedId = (v: string): number => (v === 'any' ? -1 : Number(v) - 1);

/** The first (largest) wanted marker of a grey picture as a sighting in fractions of the picture, flipped back if it was mirrored. */
export function sightingOf(grey: Uint8Array, width: number, height: number, id: number): Sighting | null {
  const d = detectMarkers(grey, width, height, { id })[0];
  if (!d) return null;
  const c: number[] = [];
  for (const p of d.corners) c.push(d.mirrored ? 1 - p[0] / width : p[0] / width, p[1] / height);
  return { id: d.id, c, m: d.mirrored, s: d.score };
}

function greyCopy(gpu: NodeGpu, src: ImageValue, long: number): ImageValue {
  const size = analysisSize(src.width, src.height, long);
  const foot = Math.max(src.width / size.width, src.height / size.height);
  return gpu.pass({
    label: 'marker-grey',
    size: { ...size, unit: 1 },
    textures: { src },
    uniforms: { taps: Math.min(8, Math.max(1, Math.ceil(foot))) },
    // an area average, so thin far-away markers are not lost between sample points
    wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let dims = vec2f(textureDimensions(src));
  let foot = dims / u.size;
  let n = i32(u.taps);
  var acc = 0.0;
  for (var j = 0; j < n; j++) {
    for (var i = 0; i < n; i++) {
      let o = (vec2f(f32(i), f32(j)) + 0.5) / u.taps - 0.5;
      let c = textureSampleLevel(src, smp, uv + o * foot / dims, 0.0);
      acc += luma(c.rgb) + (1.0 - c.a);
    }
  }
  let v = acc / (u.taps * u.taps);
  return vec4f(v, v, v, 1.0);
}`,
  });
}

/** Memory of the live path, per node (see the note at the top). Bounded: old entries are dropped. */
const LIVE = new Map<string, { state: LiveState; at: number }>();
function remember(key: string, state: LiveState, at: number): void {
  LIVE.delete(key);
  LIVE.set(key, { state, at });
  if (LIVE.size > 64) LIVE.delete(LIVE.keys().next().value as string);
}
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;

const PICTURE_WGSL = /* wgsl */ `
fn toMarker(p: vec2f) -> vec3f {
  let q = vec3f(dot(u.i0.xyz, vec3f(p, 1.0)), dot(u.i1.xyz, vec3f(p, 1.0)), dot(u.i2.xyz, vec3f(p, 1.0)));
  return vec3f(q.xy / q.z, q.z);
}
fn toPicture(m: vec2f) -> vec2f {
  let q = vec3f(dot(u.h0.xyz, vec3f(m, 1.0)), dot(u.h1.xyz, vec3f(m, 1.0)), dot(u.h2.xyz, vec3f(m, 1.0)));
  return q.xy / q.z;
}
fn pic(p: vec2f) -> vec4f {
  var uv = p / u.size;
  if (u.mirror > 0.5) { uv.x = 1.0 - uv.x; }
  return textureSampleLevel(src, smp, uv, 0.0);
}
// the paper at marker position m, averaged over a small patch so print grain and noise do not show in the fill
fn paper(m: vec2f, along: vec2f) -> vec4f {
  return (pic(toPicture(m)) * 2.0 + pic(toPicture(m + along * 0.07)) + pic(toPicture(m - along * 0.07))) * 0.25;
}
fn seg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - a - ab * t);
}
fn stroke(col: vec4f, d: f32, wdt: f32, ink: vec3f) -> vec4f {
  let k = 1.0 - smoothstep(wdt - 0.75, wdt + 0.75, d);
  return mix(col, vec4f(ink, 1.0), k);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var col = pic(px);
  if (u.cover > 0.5) {
    let m = toMarker(px);
    let far = max(abs(m.x), abs(m.y));
    // a little larger than the black square, so its soft edge is covered too
    let edge = 0.5 + u.grow;
    if (m.z * u.wsign > 0.0 && far < edge + 0.02) {
      let s = edge + 0.07;
      let wl = 1.0 / (s + m.x); let wr = 1.0 / (s - m.x); let wb = 1.0 / (s + m.y); let wt = 1.0 / (s - m.y);
      let fill = (paper(vec2f(-s, m.y), vec2f(0.0, 1.0)) * wl + paper(vec2f(s, m.y), vec2f(0.0, 1.0)) * wr
                + paper(vec2f(m.x, -s), vec2f(1.0, 0.0)) * wb + paper(vec2f(m.x, s), vec2f(1.0, 0.0)) * wt) / (wl + wr + wb + wt);
      col = mix(fill, col, smoothstep(edge - 0.02, edge + 0.02, far));
    }
  }
  if (u.overlay > 0.5) {
    let wdt = max(2.0, min(u.size.x, u.size.y) / 250.0);
    if (u.seen > 0.5) {
      var d = min(min(seg(px, u.c0, u.c1), seg(px, u.c1, u.c2)), min(seg(px, u.c2, u.c3), seg(px, u.c3, u.c0)));
      col = stroke(col, d, wdt, vec3f(0.1, 1.0, 0.3));
      // a dot on the marker's own top-left corner, so "which way is up" can be checked
      col = stroke(col, length(px - u.c0), wdt * 3.0, vec3f(1.0, 0.9, 0.1));
    } else {
      // not in this frame: a red rim round the picture
      let rim = min(min(px.x, u.size.x - px.x), min(px.y, u.size.y - px.y));
      col = stroke(col, rim, wdt * 2.0, vec3f(1.0, 0.15, 0.1));
    }
    if (u.posed > 0.5) {
      col = stroke(col, seg(px, u.ao, u.ax), wdt, vec3f(1.0, 0.2, 0.2));
      col = stroke(col, seg(px, u.ao, u.az), wdt, vec3f(0.25, 0.45, 1.0));
      col = stroke(col, seg(px, u.ao, u.ay), wdt, vec3f(0.2, 1.0, 0.2));
    }
  }
  return col;
}`;

const STICKER_WGSL = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let q = vec3f(dot(u.i0.xyz, vec3f(px, 1.0)), dot(u.i1.xyz, vec3f(px, 1.0)), dot(u.i2.xyz, vec3f(px, 1.0)));
  // on the far side of the horizon the mapping is meaningless: park those pixels far outside the picture
  let front = q.z * u.wsign > 1e-9;
  let zz = select(1.0, q.z, front);
  // marker units to the flat picture's own 0..1, keeping its shape (the longer side spans the chosen width)
  let m = select(vec2f(99.0), q.xy / zz / u.span, front);
  let t = vec2f(m.x / u.fit.x + 0.5, 0.5 - m.y / u.fit.y);
  // soften the outline by about a pixel so the edge does not crawl
  let fw = fwidth(t);
  let e = min(min(t.x, 1.0 - t.x) / max(fw.x, 1e-6), min(t.y, 1.0 - t.y) / max(fw.y, 1e-6));
  let c = textureSampleLevel(art, smp, clamp(t, vec2f(0.0), vec2f(1.0)), 0.0);
  return c * clamp(e + 0.5, 0.0, 1.0) * u.opacity;
}`;

export default defineNode({
  id: 'marker-camera',
  title: 'Marker Camera',
  category: 'track',
  description:
    'Anchors 3D objects in the room with a printed square marker. Print the marker (button below), lay it flat, and point the camera at it: this node finds it in the picture and outputs a 3D camera that stands exactly where your phone is, so a 3D Object wired to it stands on the marker and stays there while you walk round it. Wire a Webcam (back camera) or a filmed clip into Picture in; wire Camera into the 3D Object; merge the object over this node\'s Picture output.',
  keywords: ['ar', 'augmented reality', 'marker', 'fiducial', 'aruco', 'anchor', 'grounded', 'pose', 'tracking', 'camera', '3d', 'phone', 'walk', 'room', 'table', 'print', 'qr', 'match move', 'camera tracking'],
  cpu: true,
  guide: {
    does: 'Finds a printed square marker in the camera picture and gives you a 3D camera that stays fixed to the room.',
    steps: [
      'Print the marker from its settings and lay it flat.',
      'Wire the live camera picture into Picture in.',
      'Wire Camera into the camera socket of your 3D scene so 3D objects stand on the marker.',
    ],
    needs: [
      { input: 'image', hint: 'The live camera picture that can see the marker.' },
    ],
    seeAlso: ['world-ar', 'region-overlay'],
  },
  inputs: {
    image: { type: 'image', required: true, lazy: true, label: 'Picture in' },
    sticker: { type: 'image', label: 'Flat picture' },
  },
  outputs: {
    camera: { type: 'camera', label: 'Camera' },
    picture: { type: 'image', label: 'Picture' },
    found: { type: 'number', label: 'Found' },
    regions: { type: 'regions', label: 'Marker region' },
    distance: { type: 'number', label: 'Distance' },
    position: { type: 'vector', label: 'Camera position XYZ', hint: 'Where the phone is in the scene, on one wire (the marker is at 0, 0, 0). Zero while no marker has been seen.' },
    aim: { type: 'vector', label: 'Camera turn XYZ', hint: 'Which way the phone looks, in degrees on one wire: pitch (x), yaw (y) and roll (z). Zero while no marker has been seen.' },
    flat: { type: 'image', label: 'Flat picture on marker' },
  },
  optionalOutputs: ['picture', 'flat'],
  params: {
    marker: { type: 'enum', default: 'any', label: 'Marker', options: ID_OPTIONS, hint: 'Which marker to follow when several are in view. Any = the largest one.' },
    fov: {
      type: 'number',
      default: 45,
      min: 5,
      max: 150,
      step: 0.5,
      unit: 'deg',
      label: 'Field of view',
      hint: 'Of the real camera, across the picture\'s shorter side. A phone\'s main back camera is about 40 for wide (16:9) video and about 52 for 4:3. If it is wrong the object leans or slides when you move round the marker: adjust until a tall object stands straight from every side. Browsers do not report this number, so it has to be set by eye.',
    },
    objectSize: {
      type: 'number',
      default: 1,
      min: 0.05,
      max: 20,
      step: 0.05,
      label: 'Object size',
      hint: 'How large the 3D scene is against the marker. At 1 the black square is 2 scene units wide: the standard cube (1.1 wide) covers a little over half of it, the standard ball nearly all. 2 = everything twice as large.',
    },
    floor: {
      type: 'number',
      default: -0.55,
      min: -20,
      max: 20,
      step: 0.05,
      label: 'Floor height',
      hint: 'The height of the paper in the scene. -0.55 is the underside of the standard cube, so it stands on the marker; the standard ball needs -0.95. 0 puts the paper through the middle of the scene (then lift objects with their own Move Y).',
    },
    smoothing: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Smoothing', hint: 'Calms the small trembling of the object. It smooths a lot while the camera is nearly still and little while it moves, so the object does not trail. 0 = off. After Analyze clip it smooths with no trailing at all.' },
    lost: {
      type: 'enum',
      default: 'fade',
      label: 'When lost',
      options: [
        { value: 'hold', label: 'Keep it there' },
        { value: 'fade', label: 'Fade out' },
        { value: 'hide', label: 'Hide' },
      ],
      hint: 'What happens when the marker is covered, out of view or too blurred. The object first stays where it was for the hold time. Fade out needs Found wired into the opacity of the merge; without that wire it disappears at the end of the fade. Before the marker was ever seen, nothing is shown.',
    },
    holdTime: { type: 'number', default: 0.4, min: 0, max: 10, step: 0.05, unit: 's', label: 'Hold time', hint: 'How long the object stays in place after the marker is lost, before it fades or hides. Bridges short blinks (a hand passing, a blurred frame).', visibleIf: (p) => p.lost !== 'hold' },
    analysis: {
      type: 'enum',
      default: '480',
      label: 'Search size',
      options: [
        { value: '320', label: 'Small, fastest' },
        { value: '480', label: 'Medium' },
        { value: '640', label: 'Large' },
        { value: '960', label: 'Very large, slow' },
      ],
      hint: 'The picture is searched in a small copy. Larger finds a marker further away and steadies the pose, but costs time on every frame. The marker should be at least a tenth of the picture wide.',
    },
    overlay: { type: 'bool', default: false, label: 'Show what is found', hint: 'Draws on the Picture output: a green outline on the marker (yellow dot = its top-left corner), the three axes of the scene (red x, green up, blue away), and a red rim while the marker is not in the frame.', group: 'Picture' },
    cover: { type: 'bool', default: false, label: 'Cover the marker', hint: 'Paints the black square over with the paper around it on the Picture output, so it does not show under the object. Needs the white margin around the marker to be in view.', group: 'Picture' },
    stickerSize: { type: 'number', default: 1, min: 0.1, max: 20, step: 0.05, label: 'Flat picture size', hint: 'Width of the Flat picture lying on the marker, in marker widths. 1 = exactly over the black square; 1.4 also covers the white margin.', group: 'Picture' },
    printSize: { type: 'number', default: 10, min: 1, max: 200, step: 0.5, label: 'Marker width cm', hint: 'The real width of the black square. Only used for the Distance output (centimetres from the camera to the marker).', group: 'Picture' },
  },
  summary: (p) => `${p.marker === 'any' ? 'any marker' : `marker ${p.marker}`} · ${p.fov}°`,
  process: {
    title: 'Analyze clip',
    description: 'For a filmed clip (not for a live camera): find the marker in every frame once. Afterwards the camera is instant, smoothing has no trailing, and the export is exactly what the viewer shows.',
    standIn: 'preview',
    required: 'once-run',
    gpu: true,
    signature: (p, sigs) => `${stableStringify({ marker: p.marker, analysis: p.analysis })}|${sigs.image}`,
    estimate: (_p, project) => ({ frames: Math.max(1, Math.round(project.duration * project.fps)), note: 'one search per frame' }),
    async run(job) {
      const p = job.params;
      const total = job.frames;
      const long = Number(p.analysis);
      const frames: StoredFrame[] = [];
      let size = { width: job.canvas.width, height: job.canvas.height };
      let seen = 0;
      // read the picture at about twice the search size and average it down here: the same care against aliasing as the live path
      const proxy = Math.min(1, (long * 2) / Math.max(1, job.canvas.width, job.canvas.height));
      for (let f = 0; f < total; f++) {
        await job.yield();
        const pulled = await job.pull('image', { frame: f, quality: 'final', proxy });
        try {
          const err = [...pulled.errors.values()][0];
          if (err) throw new Error(err);
          const img = pulled.value as ImageValue | null;
          if (!img) throw new Error('Marker Camera needs a picture to analyze.');
          size = { width: img.width, height: img.height };
          const a = analysisSize(img.width, img.height, long);
          const grey = shrinkToGrey(await job.gpu.read(img), img.width, img.height, a.width, a.height);
          const s = sightingOf(grey, a.width, a.height, wantedId(p.marker));
          if (s) seen++;
          frames.push(packSighting(s));
        } finally {
          pulled.release();
        }
        job.progress((f + 1) / total, `Frame ${f + 1} of ${total}: marker found in ${seen}`, { frame: f + 1, frames: total });
      }
      job.store.json('sightings', { frames, aspect: size.width / Math.max(1, size.height) });
      return { meta: { frames: total, seen, item: job.item.index } };
    },
  },
  async render(ctx) {
    const p = ctx.params;
    const { frame, fps, loop } = ctx.time;
    const id = wantedId(p.marker);
    const track = { fov: p.fov, smoothing: p.smoothing, lost: p.lost as LostMode, holdTime: p.holdTime, fps };
    const world = { fov: p.fov, markerWidth: 2 / Math.max(0.001, p.objectSize), floor: p.floor };

    let res: TrackResult | null = null;
    let sighting: Sighting | null = null;
    let img: ImageValue | null = null;
    let width = ctx.canvas.width;
    let height = ctx.canvas.height;

    const ps = ctx.process;
    if (ps?.servable && ps.result && (ps.result.meta.item === undefined || ps.result.meta.item === ctx.item.index)) {
      const done = await ps.json<{ frames: StoredFrame[]; aspect: number }>('sightings');
      if (done && done.frames.length > 0) {
        const n = done.frames.length;
        const idx = loop ? ((frame % n) + n) % n : Math.min(n - 1, Math.max(0, frame));
        // only the picture's shape matters to the pose; its real size is used when the picture is needed anyway
        if (ctx.wants('picture') || ctx.wants('flat')) img = await ctx.pull('image');
        if (img) [width, height] = [img.width, img.height];
        else [width, height] = done.aspect >= 1 ? [1000 * done.aspect, 1000] : [1000, 1000 / done.aspect];
        res = fromClip(done.frames, idx, { ...track, width, height });
        const here = done.frames[idx];
        sighting = res.seen && Array.isArray(here) ? { id: here[0], m: here[1] === 1, s: here[2], c: here.slice(3, 11) } : null;
      }
    }
    if (!res) {
      img = await ctx.pull('image');
      if (!img) return {};
      [width, height] = [img.width, img.height];
      const small = greyCopy(ctx.gpu, img, Number(p.analysis));
      const data = await ctx.gpu.read(small, false);
      sighting = sightingOf(greyFromRgba(data, small.width, small.height, true), small.width, small.height, id);
      ctx.gpu.recycle(small);
      // the memory is trusted only when this frame follows the remembered one (see the note at the top)
      const key = `${ctx.nodeId}|${ctx.quality}`;
      const prev = LIVE.get(key) ?? null;
      const step = prev ? frame - prev.state.frame : -1;
      const wrapped = !!prev && loop && frame <= 1 && step < 0;
      const follows = ctx.quality === 'final' ? step === 1 : (step >= 0 && step <= 5) || wrapped;
      // Time between the two: counted in frames while the clock runs. When the same frame comes again (a live camera with playback
      // paused, or a second output of this node being asked for) the real time that went by is used, so a paused live picture still
      // smooths and still lets go of a lost marker, and asking twice in one frame changes nothing.
      const at = now();
      const dt = !prev ? 0 : step >= 1 ? step / fps : wrapped ? 1 / fps : ctx.quality === 'final' ? 0 : Math.min(0.25, Math.max(0, at - prev.at));
      const out = stepLive(follows ? prev!.state : null, sighting, frame, dt, { ...track, width, height });
      remember(key, out.state, at);
      res = out.result;
      if (!res.seen) sighting = null;
    }

    const pose = res.pose;
    const show = !!pose && res.visible > 0;
    const camera = show ? cameraFromPose(pose, world) : awayCamera(p.fov);
    const items: Region[] = [];
    if (sighting) {
      const xs = [0, 2, 4, 6].map((i) => sighting!.c[i]);
      const ys = [1, 3, 5, 7].map((i) => sighting!.c[i]);
      items.push({ id: sighting.id, label: 'marker', score: sighting.s, box: [Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)), Math.min(1, Math.max(...xs)), Math.min(1, Math.max(...ys))] });
    }
    // where the phone is and which way it looks, as three numbers each (zero while there is nothing to follow)
    const deg = 180 / Math.PI;
    const look = [camera.target[0] - camera.position[0], camera.target[1] - camera.position[1], camera.target[2] - camera.position[2]];
    const flatLen = Math.hypot(look[0], look[2]);
    const aim: [number, number, number] = show ? [Math.atan2(look[1], flatLen) * deg, Math.atan2(look[0], -look[2]) * deg, camera.roll] : [0, 0, 0];
    const out: { camera: typeof camera; found: number; position: [number, number, number]; aim: [number, number, number]; regions: { kind: 'regions'; items: Region[] }; distance: number; picture?: ImageValue | null; flat?: ImageValue | null } = {
      camera,
      found: res.visible,
      position: show ? [camera.position[0], camera.position[1], camera.position[2]] : [0, 0, 0],
      aim,
      regions: { kind: 'regions', items },
      distance: pose ? Math.hypot(pose.t[0], pose.t[1], pose.t[2]) * p.printSize : 0,
    };
    if (!img) return out;

    // where the marker is in the picture: as measured in this frame when it is there (locked to the picture), else from the held pose
    const project = (x: number, y: number, z: number): Pt | null => (pose ? projectPoint(pose, [x, y, z], width, height, p.fov) : null);
    const posed = pose ? MARKER_CORNERS.map(([x, z]) => project(x, 0, z)) : null;
    const measured: Pt[] | null = sighting ? [0, 1, 2, 3].map((i): Pt => [sighting!.c[i * 2] * width, sighting!.c[i * 2 + 1] * height]) : null;
    const posedOk = !!posed && posed.every((c) => !!c);
    const matrices = (corners: Pt[] | null) => {
      const H = corners && homography(MARKER_CORNERS, corners);
      const inv = H && invert3(H);
      if (!H || !inv) return null;
      const mid = [(corners![0][0] + corners![2][0]) / 2, (corners![0][1] + corners![2][1]) / 2];
      // on the far side of the horizon the mapping turns inside out: only the side the marker is on counts
      const wsign = Math.sign(inv[6] * mid[0] + inv[7] * mid[1] + inv[8]) || 1;
      return { H, inv, wsign };
    };

    if (ctx.wants('picture')) {
      const quad = measured ?? (show && posedOk ? (posed as Pt[]) : null);
      const m = p.cover ? matrices(quad) : null;
      if (!res.mirrored && !p.overlay && !m) out.picture = img;
      else {
        const z: Pt = [0, 0];
        const q = measured ?? [z, z, z, z];
        const axes = pose ? [project(0, 0, 0), project(0.5, 0, 0), project(0, 0.5, 0), project(0, 0, 0.5)] : [];
        const axesOk = axes.length === 4 && axes.every((a) => !!a);
        out.picture = ctx.gpu.pass({
          label: 'marker-picture',
          size: img,
          textures: { src: img },
          uniforms: {
            mirror: res.mirrored,
            cover: !!m,
            overlay: p.overlay,
            seen: !!measured,
            posed: axesOk && show,
            // one sixth of a cell beyond the black square
            grow: 0.03,
            wsign: m?.wsign ?? 1,
            h0: m ? [m.H[0], m.H[1], m.H[2], 0] : [1, 0, 0, 0],
            h1: m ? [m.H[3], m.H[4], m.H[5], 0] : [0, 1, 0, 0],
            h2: m ? [m.H[6], m.H[7], m.H[8], 0] : [0, 0, 1, 0],
            i0: m ? [m.inv[0], m.inv[1], m.inv[2], 0] : [1, 0, 0, 0],
            i1: m ? [m.inv[3], m.inv[4], m.inv[5], 0] : [0, 1, 0, 0],
            i2: m ? [m.inv[6], m.inv[7], m.inv[8], 0] : [0, 0, 1, 0],
            c0: q[0],
            c1: q[1],
            c2: q[2],
            c3: q[3],
            ao: axesOk ? axes[0]! : z,
            ax: axesOk ? axes[1]! : z,
            ay: axesOk ? axes[2]! : z,
            az: axesOk ? axes[3]! : z,
          },
          wgsl: PICTURE_WGSL,
        });
      }
    }
    if (ctx.wants('flat')) {
      const art = ctx.in.sticker;
      // the flat picture follows the same (smoothed, held) pose as the 3D object, so the two never drift apart
      const m = art && show && posedOk ? matrices(posed as Pt[]) : null;
      const long = art ? Math.max(art.width, art.height) : 1;
      out.flat = ctx.gpu.pass({
        label: 'marker-flat',
        size: img,
        textures: { art: m ? art : null },
        uniforms: m
          ? { i0: [m.inv[0], m.inv[1], m.inv[2], 0], i1: [m.inv[3], m.inv[4], m.inv[5], 0], i2: [m.inv[6], m.inv[7], m.inv[8], 0], wsign: m.wsign, span: p.stickerSize, fit: [art!.width / long, art!.height / long], opacity: res.visible }
          : {},
        wgsl: m ? STICKER_WGSL : 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0); }',
      });
    }
    return out;
  },
});
