import { defineNode } from '../../define';
import type { SplatCloud } from '../../lib/splat-cloud';
import { parseSplatBytes, SplatError } from '../../lib/splat-ply';
import { clearSplatFrame, renderSplatScene, SPLAT_LOOK_PARAMS, SPLAT_XFORM, type SplatSceneParams } from '../../lib/splat-scene';
import type { Host } from '../../types';

/**
 * Gaussian Splat: renders a 3D Gaussian Splatting scan (a `.ply` from the usual trainers, or a `.splat`) with the family's camera.
 *
 * Parsed once per file (WeakMap keyed by the ArrayBuffer the host returns, like lib/model-render.ts: a pure function of the bytes).
 * Rendering is lib/splat-render.ts: EWA-projected quads, depth sorted back to front on the CPU only when the view changes (a counting sort,
 * deterministic), or order-independent weighted blending for draft playback. Spherical harmonics: DEGREE 1 only (higher degrees are skipped).
 * Perspective and orthographic cameras are exact; fisheye / panoramic / cylindrical lenses render with a perspective lens instead.
 */
const parsed = new WeakMap<ArrayBuffer, SplatCloud | { error: string }>();

export { SPLAT_XFORM };

export async function loadSplatCloud(host: Host, assetId: string): Promise<SplatCloud> {
  if (!host.assetBytes) throw new Error('This app build cannot load splat files (the host has no assetBytes).');
  const bytes = await host.assetBytes(assetId);
  if (!bytes) throw new Error('The splat file is missing. Choose it again in the node.');
  let hit = parsed.get(bytes);
  if (!hit) {
    try {
      hit = parseSplatBytes(bytes);
    } catch (e) {
      hit = { error: e instanceof SplatError ? e.message : `Could not read this splat file: ${e instanceof Error ? e.message : String(e)}` };
    }
    parsed.set(bytes, hit);
  }
  if ('error' in hit) throw new Error(hit.error);
  return hit;
}

export default defineNode({
  id: 'splat-3d',
  title: 'Gaussian Splat',
  category: 'generate',
  description:
    'Renders a Gaussian splat scan (a .ply from a 3D Gaussian Splatting trainer, or a .splat file) with the same Camera, transform and spin as the other 3D nodes. Soft splats are depth sorted for an exact picture; draft playback uses a cheaper order-independent blend. Color includes view-dependent shine (spherical harmonics degree 1; higher degrees are skipped). Crop away floaters, make the splats sharp or square for a chunky pixel-art look. Perspective and orthographic cameras are exact; fisheye, panoramic and cylindrical cameras are drawn with a perspective lens. Compressed splat files (.compressed.ply, .spz) are not supported.',
  keywords: ['splat', 'splats', '3dgs', 'gaussian', 'gaussian splatting', 'point cloud', 'radiance', 'nerf', 'ply', 'scan', 'photogrammetry', '3d scan', 'capture', 'reconstruction', 'depth'],
  inputs: { size: { type: 'image', label: 'Size from' }, camera: { type: 'camera', label: 'Camera' } },
  outputs: { image: { type: 'image', label: 'Image' }, depth: { type: 'image', label: 'Depth' } },
  optionalOutputs: ['depth'],
  params: {
    file: { type: 'assets', default: [], accept: 'splat', label: 'Splat file', hint: 'A .ply (standard 3D Gaussian Splatting, binary) or .splat file. With several files, each batch item uses its own. Nothing chosen = an empty frame.' },
    autoFit: { type: 'bool', default: true, label: 'Fit to view', group: 'Object', hint: 'Center the scene and scale it (ignoring stray floaters) to fill the same space as the 3D Object shapes. Off = the file’s own units.' },
    orientation: {
      type: 'enum',
      default: 'auto',
      label: 'Up axis',
      group: 'Object',
      hint: 'Which way is up in the file. Many scans are upside down (the trainer’s COLMAP frame has y pointing down). Automatic reads a note in the file if there is one, finds the ground plane of a flat scene, and otherwise assumes y-down. It is a guess: pick a preset if it is wrong.',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'asis', label: 'As in the file' },
        { value: 'ydown', label: 'Y down' },
        { value: 'zup', label: 'Z up' },
      ],
    },
    ...SPLAT_XFORM,
    ...SPLAT_LOOK_PARAMS,
  },
  summary: (p, wired) => {
    const n = (p.file as string[]).length;
    const cam = wired?.has('camera') ? ' · wired camera (fisheye/panoramic → perspective)' : '';
    return n === 0 ? 'no splat file' : `${n === 1 ? 'splat' : `${n} splat files`} · ${p.shape} · ${p.quality}${p.maxSplats < 1_000_000 ? ` · max ${p.maxSplats.toLocaleString('en-US')}` : ''}${cam}`;
  },
  async render(ctx) {
    const p = ctx.params;
    const size = ctx.in.size ?? ctx.canvas;
    const wantDepth = ctx.wants('depth');
    if (!p.file.length) {
      const c = clearSplatFrame(ctx.gpu, size, p.background, wantDepth);
      return { image: c.image, depth: c.depth };
    }
    const assetId = p.file[ctx.item.index % p.file.length];
    const full = await loadSplatCloud(ctx.host, assetId);
    const spinning = p.spinX !== 0 || p.spinY !== 0 || p.spinZ !== 0;
    return renderSplatScene({ gpu: ctx.gpu, full, p: p as unknown as SplatSceneParams, size, camera: ctx.in.camera, phase: spinning ? ctx.time.phase : 0, final: ctx.quality === 'final', proxy: ctx.proxy, wantDepth });
  },
});
