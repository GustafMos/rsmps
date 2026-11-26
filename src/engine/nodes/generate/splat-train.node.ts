import { defineNode } from '../../define';
import { cameraAt, pathKeyOf, poseOf, sceneFrame, toTool, transformCloud, mulMV, intrinsicsOf, type CameraPath, type ColmapCamera, type ColmapImage } from '../../lib/colmap';
import { candidateTimes, lumaThumb, selectFrames, sharpnessOf, type FrameCandidate } from '../../lib/frame-select';
import { parsePly, SplatError, writeSplatPly } from '../../lib/splat-ply';
import { colmapTextForSizes } from '../../lib/scan-export';
import { isScanData, normalizeScan } from '../../lib/scan-data';
import { cameraThroughXform, clearSplatFrame, renderSplatScene, sceneXform, SPLAT_LOOK_PARAMS, SPLAT_XFORM, type SplatSceneParams } from '../../lib/splat-scene';
import type { SplatCloud } from '../../lib/splat-cloud';
import { stableStringify } from '../../lib/stable-json';
import type { V3 } from '../../lib/gen-camera';
import type { CameraValue, ImageValue, ProcessCtx, SplatTrainOutput } from '../../types';

/**
 * Splat from Video: a clip (or a photo set) in, a moving 3D Gaussian splat scene out. DESKTOP ONLY: its process drives two optional
 * add-on programs through the desktop app (COLMAP finds the cameras, Brush trains the splats; desktop/addons/splat-train.mjs,
 * docs/SPLATS.md). Until the process has run the clip passes through (stand-in 'bypass'), so the graph keeps playing.
 *
 * Process: choose frames (lib/frame-select.ts: spaced along the camera motion, sharpest in each window) -> pull them through the graph
 * (anything upstream applies) -> host.splatTrain (encode, run COLMAP + Brush, read back) -> the cloud is moved into this tool's frame
 * (lib/colmap.ts: y up, the mirror convention) and stored as a standard .ply with `comment up +y` (the splat asset rule) -> the solved
 * cameras are stored as a camera path keyed by clip time.
 * Render: exactly Gaussian Splat's view / look code (lib/splat-scene.ts) on the stored cloud. The `camera` OUTPUT is the solved camera at
 * the current time, carried through the same object transform, so wiring it into this node's own Camera input shows the original shot
 * (match-moving).
 */

const parsedPly = new WeakMap<ArrayBuffer, SplatCloud | { error: string }>();
function cloudOf(bytes: ArrayBuffer): SplatCloud {
  let hit = parsedPly.get(bytes);
  if (!hit) {
    try {
      hit = parsePly(bytes);
    } catch (e) {
      hit = { error: e instanceof SplatError ? e.message : `Could not read the trained splats: ${e instanceof Error ? e.message : String(e)}` };
    }
    parsedPly.set(bytes, hit);
  }
  if ('error' in hit) throw new Error(hit.error);
  return hit;
}

export interface SolveRecord {
  path: CameraPath;
  report: Record<string, unknown>;
  frames: { name: string; seconds: number }[];
  registered: number;
}

const ADDON_NAMES: Record<string, string> = { colmap: 'COLMAP', brush: 'Brush' };

/** Frames for the job: straight RGBA at most `maxSide` on the long side, plus their clip times. */
async function chooseFrames(job: ProcessCtx, p: { frames: number; maxSide: number; rangeStart: number; rangeEnd: number }, phase: (f: number, note: string) => void) {
  const longCanvas = Math.max(job.canvas.width, job.canvas.height);
  const end = p.rangeEnd > p.rangeStart ? Math.min(p.rangeEnd, job.duration) : job.duration;
  const start = Math.min(Math.max(0, p.rangeStart), Math.max(0, end - 1 / job.fps));
  const times = candidateTimes(start, end, job.fps, Math.min(600, p.frames * 4));
  const scan = Math.min(1, 256 / longCanvas);
  const cands: FrameCandidate[] = [];
  for (let i = 0; i < times.length; i++) {
    await job.yield();
    const pulled = await job.pull('image', { seconds: times[i], proxy: scan, quality: 'preview' });
    try {
      const err = [...pulled.errors.values()][0];
      if (err) throw new Error(err);
      const img = pulled.value as ImageValue | null;
      if (!img || img.kind !== 'image') throw new Error('Wire a clip into the Clip input, or choose photos.');
      const px = await job.gpu.read(img, true);
      const luma = lumaThumb(px, img.width, img.height, img.width, img.height);
      const tw = 48;
      const th = Math.max(8, Math.round((48 * img.height) / img.width));
      cands.push({ seconds: times[i], sharpness: sharpnessOf(luma, img.width, img.height), thumb: lumaThumb(px, img.width, img.height, tw, th) });
    } finally {
      pulled.release();
    }
    phase((i + 1) / times.length, `Looking at the clip: ${i + 1} of ${times.length}`);
  }
  // pick: evenly along the motion, at least ~1% of the picture changed between two picks, sharpest in each window
  const sel = selectFrames(cands, p.frames, 0.01);
  return { seconds: sel.picks.map((i) => cands[i].seconds), proxy: Math.min(1, p.maxSide / longCanvas), candidates: cands.length };
}

export default defineNode({
  id: 'splat-train',
  title: 'Splat from Video',
  category: 'generate',
  description:
    'Turns a clip (or a set of photos) into a 3D Gaussian splat scene you can fly through, and gives back the camera move of the original shot. Desktop app only: it runs two optional add-on programs on your computer, COLMAP (finds where the camera was) and Brush (trains the splats). Works best on a sharp, steady 20 to 60 second walk around a still, textured subject. Until you press Reconstruct the clip passes through.',
  keywords: ['reconstruct', 'photogrammetry', '3dgs', 'train', 'scan', 'nerf', 'capture', 'colmap', 'brush', 'gaussian splatting', 'splat', 'structure from motion', 'match move', 'camera track'],
  requires: ['desktop'],
  inputs: { image: { type: 'image', lazy: true, label: 'Clip' }, camera: { type: 'camera', label: 'Camera' } },
  outputs: { image: { type: 'image', label: 'Image' }, depth: { type: 'image', label: 'Depth' }, camera: { type: 'camera', label: 'Solved camera' } },
  optionalOutputs: ['depth', 'camera'],
  params: {
    photos: { type: 'assets', default: [], accept: 'image-video', batch: false, label: 'Photos', group: 'Source', hint: 'A photo set instead of the clip: pictures taken while walking around the subject, all used (in this order). Leave empty to use the Clip input. A 3D Scan chosen below is used instead of both.' },
    scan: { type: 'json', default: null, label: 'Scan', visibleIf: () => false },
    refine: { type: 'bool', default: false, label: 'Refine cameras', group: 'Source', hint: 'Only with a 3D Scan: also correct small errors in the phone\'s saved camera positions before training. Slower; try it when the result looks doubled or soft.', visibleIf: (p) => isScanData(p.scan) },
    frames: { type: 'number', default: 80, min: 10, max: 300, step: 1, integer: true, label: 'Frames', group: 'Source', hint: 'How many frames of the clip to use. They are spread along the camera movement (a stretch where the camera stands still gives none) and the sharpest frame of each stretch is taken.' },
    maxSide: { type: 'number', default: 1280, min: 480, max: 2560, step: 16, integer: true, label: 'Max side', group: 'Source', hint: 'Frames are made at most this many pixels on their long side before solving and training.' },
    rangeStart: { type: 'number', default: 0, min: 0, max: 3600, step: 0.1, unit: 's', label: 'Use from', group: 'Source', hint: 'Start of the part of the clip to use.' },
    rangeEnd: { type: 'number', default: 0, min: 0, max: 3600, step: 0.1, unit: 's', label: 'Use until', group: 'Source', hint: 'End of the part of the clip to use. 0 = to the end.' },
    trainQuality: {
      type: 'enum',
      default: 'normal',
      label: 'Quality preset',
      group: 'Reconstruction',
      hint: 'Training length and resolution. Draft: 3,000 steps at up to 960 px (a minute or two on a recent graphics card). Normal: 10,000 steps at up to 1280 px. High: 30,000 steps at up to 1600 px (several times longer).',
      options: [
        { value: 'draft', label: 'Draft' },
        { value: 'normal', label: 'Normal' },
        { value: 'high', label: 'High' },
      ],
    },
    matcher: {
      type: 'enum',
      default: 'auto',
      label: 'Matcher',
      group: 'Reconstruction',
      hint: 'How COLMAP pairs frames. Sequential compares each frame with its neighbors (video). Exhaustive compares every pair (photo sets; slow above about 150). Automatic picks by the source.',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'sequential', label: 'Sequential' },
        { value: 'exhaustive', label: 'Exhaustive' },
      ],
    },
    solver: {
      type: 'enum',
      default: 'auto',
      label: 'Camera solver',
      group: 'Reconstruction',
      hint: 'Incremental adds one frame at a time (robust, the default). Global solves all frames at once (often faster on long clips).',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'incremental', label: 'Incremental' },
        { value: 'global', label: 'Global' },
      ],
    },
    keepPoses: { type: 'bool', default: true, label: 'Keep poses', group: 'Reconstruction', hint: 'Keep the solved cameras (in the app data folder, the last 3 frame sets) so training again with another quality skips the camera solving.' },
    autoFit: { type: 'bool', default: true, label: 'Fit to view', group: 'Object', hint: 'Center the scene and scale it (ignoring stray floaters) to fill the same space as the 3D Object shapes. Off = the units COLMAP chose.' },
    ...SPLAT_XFORM,
    ...SPLAT_LOOK_PARAMS,
    // trained scenes carry their sky and background as many faint splats: Gaussian Splat's 0.02 cut punched holes in them (stage 0: 21.2 -> 24.4 dB)
    minOpacity: { ...SPLAT_LOOK_PARAMS.minOpacity, default: 0 },
  },
  summary: (p, wired) => {
    const n = isScanData(p.scan) ? normalizeScan(p.scan).shots.length : 0;
    if (n) return `3D Scan, ${n} photos · ${p.trainQuality}`;
    const src = (p.photos as string[]).length ? `${(p.photos as string[]).length} photos` : wired && !wired.has('image') ? 'no clip' : `${p.frames} frames`;
    return `${src} · ${p.trainQuality}`;
  },
  process: {
    title: 'Reconstruct',
    description: 'Solve the cameras (COLMAP) and train the splats (Brush) once, on this computer. Takes minutes; the clip plays on meanwhile.',
    standIn: 'bypass',
    required: 'always',
    gpu: true,
    signature: (p, sigs) => `${stableStringify({ scan: isScanData(p.scan) ? p.scan : null, refine: p.refine, photos: p.photos, frames: p.frames, maxSide: p.maxSide, rangeStart: p.rangeStart, rangeEnd: p.rangeEnd, q: p.trainQuality, m: p.matcher, s: p.solver })}|${(p.photos as string[]).length || isScanData(p.scan) ? '' : sigs.image}`,
    estimate: (p) => ({ frames: (isScanData(p.scan) ? normalizeScan(p.scan).shots.length : 0) || (p.photos as string[]).length || p.frames, note: 'COLMAP + Brush run on this computer; minutes to an hour' }),
    async run(job) {
      const p = job.params;
      const host = job.host.splatTrain;
      if (!host) throw new Error('Splat from Video runs only in the RSMPS desktop app: it starts COLMAP and Brush on your computer.');
      const st = await host.status();
      if (!st.available) throw new Error(`Missing add-on${st.missing.length > 1 ? 's' : ''}: ${st.missing.map((m) => ADDON_NAMES[m] ?? m).join(' and ')}. Install ${st.missing.length > 1 ? 'them' : 'it'} in Plugins > Official add-ons (nothing is downloaded until you press Install there).`);
      // a 3D Scan (picked in the panel) brings its photos AND where the phone was for each; it wins over Photos and the Clip
      const scan = isScanData(p.scan) ? normalizeScan(p.scan) : null;
      if (scan && scan.shots.length < 3) throw new Error('The chosen 3D Scan has fewer than 3 photos.');
      const photos = scan ? scan.shots.map((s) => s.asset) : (p.photos as string[]);
      let frameTimes: number[];
      let proxy = 1;
      const pick = (f: number, note: string) => job.progress(0.08 * f, note);
      if (photos.length) {
        if (photos.length < 3) throw new Error('Choose at least 3 photos.');
        frameTimes = photos.map((_, i) => i / job.fps);
      } else {
        const ch = await chooseFrames(job, p, pick);
        frameTimes = ch.seconds;
        proxy = ch.proxy;
        if (frameTimes.length < 3) throw new Error('The clip hardly changes from frame to frame: there is no camera movement to reconstruct from.');
      }
      const frame = async (i: number) => {
        await job.yield();
        if (photos.length) {
          const f = await job.host.assetFrame(photos[i], 0, p.maxSide);
          if (!f) throw new Error(`Photo ${i + 1} could not be read.`);
          return { pixels: await job.gpu.read({ kind: 'image', texture: f.texture, width: f.width, height: f.height, unit: 1 }, true), width: f.width, height: f.height };
        }
        const pulled = await job.pull('image', { seconds: frameTimes[i], proxy, quality: 'final' });
        try {
          const err = [...pulled.errors.values()][0];
          if (err) throw new Error(err);
          const img = pulled.value as ImageValue;
          return { pixels: await job.gpu.read(img, true), width: img.width, height: img.height };
        } finally {
          pulled.release();
        }
      };
      const out = await host.train({
        settings: { input: scan ? 'scan' : photos.length ? 'photos' : 'video', quality: p.trainQuality as 'draft', matcher: p.matcher as 'auto', solver: p.solver as 'auto', keepPoses: p.keepPoses, refine: !!scan && p.refine },
        frameCount: frameTimes.length,
        frame,
        ...(scan ? { known: (sizes: { width: number; height: number }[]) => colmapTextForSizes(scan, sizes, sizes.map((_, i) => frameName(i))) } : {}),
        signal: job.signal,
        onProgress: (f, note) => job.progress(0.08 + 0.9 * f, note),
      });
      job.progress(0.98, 'Storing the splats');
      const rec = toolFrameResult(out, frameTimes);
      job.store.blob('splat', new Uint8Array(writeSplatPly(rec.cloud, '+y')), 'application/x-ply');
      job.store.json('solve', rec.solve);
      return { meta: { splats: rec.cloud.count, registered: rec.solve.registered, frames: frameTimes.length } };
    },
  },
  async render(ctx) {
    const p = ctx.params;
    const ps = ctx.process;
    const size = ctx.canvas;
    const wantDepth = ctx.wants('depth');
    if (!ps?.servable || !ps.result) {
      const s = await ps!.standIn();
      return { image: (s.image as ImageValue | null) ?? clearSplatFrame(ctx.gpu, size, p.background, false).image, depth: null, camera: null };
    }
    const bytes = await ps.bytes('splat');
    if (!bytes) throw new Error('The trained splats are missing from this project (cleared storage or another computer). Press Reconstruct again.');
    const full = cloudOf(bytes);
    const sp = p as unknown as SplatSceneParams;
    const spinning = p.spinX !== 0 || p.spinY !== 0 || p.spinZ !== 0;
    const phase = spinning ? ctx.time.phase : 0;
    let camera: CameraValue | null = null;
    if (ctx.wants('camera')) {
      const solve = await ps.json<SolveRecord>('solve');
      const at = solve ? cameraAt(solve.path, ctx.time.seconds) : null;
      if (solve && at) camera = cameraThroughXform(sceneXform(full, sp, phase), at, { kind: 'camera', projection: 'perspective', fov: solve.path.fov, orthoSize: 2, shift: solve.path.shift });
    }
    const r = await renderSplatScene({ gpu: ctx.gpu, full, p: sp, size, camera: ctx.in.camera, phase, final: ctx.quality === 'final', proxy: ctx.proxy, wantDepth });
    return { image: r.image, depth: r.depth, camera };
  },
});

/** The trained cloud and the solved cameras in this tool's frame (pure: tested with the stage-0 model). */
export function toolFrameResult(out: SplatTrainOutput, frameTimes: number[]): { cloud: SplatCloud; solve: SolveRecord } {
  const images: ColmapImage[] = out.model.images.map((im, i) => ({ id: i + 1, q: im.q, t: im.t, cameraId: im.cameraId, name: im.name }));
  const poses = images.map(poseOf);
  const fr = sceneFrame(poses, Float64Array.from(out.model.points));
  const cloud = transformCloud(parsePly(out.ply), fr);
  const cam = out.model.cameras[0] as ColmapCamera;
  const { fx, fy, cx, cy } = intrinsicsOf(cam);
  const short = Math.min(cam.width, cam.height);
  const timeOf = (name: string) => {
    const m = /(\d+)\.\w+$/.exec(name);
    return m ? (frameTimes[Number(m[1])] ?? 0) : 0;
  };
  const keys = poses
    .map((ps) => pathKeyOf(timeOf(ps.name), toTool(fr, ps.centre), norm(mulMV(fr.M, ps.forward)), norm(mulMV(fr.M, ps.right))))
    .sort((a, b) => a.seconds - b.seconds);
  return {
    cloud,
    solve: {
      path: { keys, width: cam.width, height: cam.height, fov: (2 * Math.atan(short / 2 / ((fx + fy) / 2)) * 180) / Math.PI, shift: [(cx - cam.width / 2) / short, -(cy - cam.height / 2) / short] },
      report: out.report,
      frames: frameTimes.map((seconds, i) => ({ name: frameName(i), seconds })),
      registered: images.length,
    },
  };
}

const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Name of frame `i` as sent to the desktop app (the index is read back from it). */
export const frameName = (i: number) => `frame_${String(i).padStart(4, '0')}.jpg`;
