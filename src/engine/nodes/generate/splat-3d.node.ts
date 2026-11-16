import { defineNode } from '../../define';
import { XFORM_PARAMS, resolveCamera, type XformP } from '../../lib/gen-3d';
import { rotationZYX } from '../../lib/gen-common';
import { decimateCloud, estimateUp, IDENTITY3, ORIENT_Y_DOWN, ORIENT_Z_UP, type SplatCloud } from '../../lib/splat-cloud';
import { parseSplatBytes, SplatError } from '../../lib/splat-ply';
import { maxSplatsFor, renderSplats, type SplatLook } from '../../lib/splat-render';
import { mul3, viewSetup } from '../../lib/splat-math';
import type { Host, ImageValue, NodeGpu } from '../../types';

/**
 * Gaussian Splat: renders a 3D Gaussian Splatting scan (a `.ply` from the usual trainers, or a `.splat`) with the family's camera.
 *
 * Parsed once per file (WeakMap keyed by the ArrayBuffer the host returns, like lib/model-render.ts: a pure function of the bytes).
 * Rendering is lib/splat-render.ts: EWA-projected quads, depth sorted back to front on the CPU only when the view changes (a counting sort,
 * deterministic), or order-independent weighted blending for draft playback. Spherical harmonics: DEGREE 1 only (higher degrees are skipped).
 * Perspective and orthographic cameras are exact; fisheye / panoramic / cylindrical lenses render with a perspective lens instead.
 */
const parsed = new WeakMap<ArrayBuffer, SplatCloud | { error: string }>();

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

const ORIENT = { asis: IDENTITY3, ydown: ORIENT_Y_DOWN, zup: ORIENT_Z_UP } as const;

export const SPLAT_XFORM = {
  ...XFORM_PARAMS,
  rotX: { ...XFORM_PARAMS.rotX, default: 0 },
  rotY: { ...XFORM_PARAMS.rotY, default: 0 },
};

function clearFrame(gpu: NodeGpu, size: { width: number; height: number; unit?: number }, bg: readonly number[], depth: boolean): { image: ImageValue; depth: ImageValue | null } {
  const image = gpu.pass({
    label: 'splat clear',
    size,
    uniforms: { bg: [bg[0] ?? 0, bg[1] ?? 0, bg[2] ?? 0, bg[3] ?? 0] },
    wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.bg.rgb * u.bg.a, u.bg.a); }',
  });
  return { image, depth: depth ? gpu.pass({ label: 'splat clear depth', size, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0); }', format: 'rgba16float' }) : null };
}

export default defineNode({
  id: 'splat-3d',
  title: 'Gaussian Splat',
  category: 'generate',
  description:
    'Renders a Gaussian splat scan (a .ply from a 3D Gaussian Splatting trainer, or a .splat file) with the same Camera, transform and spin as the other 3D nodes. Soft splats are depth sorted for an exact picture; draft playback uses a cheaper order-independent blend. Colour includes view-dependent shine (spherical harmonics degree 1; higher degrees are skipped). Crop away floaters, make the splats sharp or square for a chunky pixel-art look. Perspective and orthographic cameras are exact; fisheye, panoramic and cylindrical cameras are drawn with a perspective lens. Compressed splat files (.compressed.ply, .spz) are not supported.',
  keywords: ['splat', 'splats', '3dgs', 'gaussian', 'gaussian splatting', 'point cloud', 'radiance', 'nerf', 'ply', 'scan', 'photogrammetry', '3d scan', 'capture', 'reconstruction', 'depth'],
  inputs: { size: { type: 'image', label: 'Size from' }, camera: { type: 'camera', label: 'Camera' } },
  outputs: { image: { type: 'image', label: 'Image' }, depth: { type: 'image', label: 'Depth' } },
  optionalOutputs: ['depth'],
  params: {
    file: { type: 'assets', default: [], accept: 'splat', label: 'Splat file', hint: 'A .ply (standard 3D Gaussian Splatting, binary) or .splat file. With several files, each batch item uses its own. Nothing chosen = an empty frame.' },
    autoFit: { type: 'bool', default: true, label: 'Fit to view', group: 'Object', hint: 'Centre the scene and scale it (ignoring stray floaters) to fill the same space as the 3D Object shapes. Off = the file’s own units.' },
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
    splatSize: { type: 'number', default: 1, min: 0.05, max: 4, step: 0.01, label: 'Splat size', group: 'Look', hint: 'Multiplies every splat’s size. Below 1 shows the individual points, above 1 fills gaps.' },
    opacityMul: { type: 'number', default: 1, min: 0, max: 3, step: 0.01, label: 'Opacity', group: 'Look', hint: 'Multiplies every splat’s opacity (above 1 makes faint splats more solid).' },
    minOpacity: { type: 'number', default: 0.02, min: 0, max: 1, step: 0.005, label: 'Min opacity', group: 'Look', hint: 'Removes splats whose opacity (after the multiplier) is below this. Raising it cleans up haze and floaters.' },
    shape: {
      type: 'enum',
      default: 'gaussian',
      label: 'Splat shape',
      group: 'Look',
      hint: 'Soft = the real Gaussian. Sharp = hard-edged ellipses. Square = screen-aligned squares (a chunky, voxel-like look that suits pixel art). Sharp and Square make splats opaque above half opacity.',
      options: [
        { value: 'gaussian', label: 'Soft' },
        { value: 'sharp', label: 'Sharp' },
        { value: 'square', label: 'Square' },
      ],
    },
    exposure: { type: 'number', default: 0, min: -4, max: 4, step: 0.01, label: 'Exposure', hint: 'In stops.', group: 'Look' },
    saturation: { type: 'number', default: 1, min: 0, max: 2, step: 0.01, label: 'Saturation', group: 'Look' },
    tint: { type: 'color', default: [1, 1, 1, 1], label: 'Tint', group: 'Look', hint: 'Multiplies every colour.' },
    viewDependent: { type: 'bool', default: true, label: 'View-dependent', group: 'Look', hint: 'Spherical harmonics degree 1 from the file, when it has them: colours shift a little with the viewing angle. Turn off for the flat base colour.' },
    antialias: { type: 'bool', default: true, label: 'Fade tiny splats', group: 'Look', hint: 'Compensates the 0.3 px low-pass filter so splats smaller than a pixel fade out instead of making the distance too bright.' },
    cropMode: {
      type: 'enum',
      default: 'none',
      label: 'Crop',
      group: 'Crop',
      hint: 'Cuts away floaters. The crop lives in the fitted scene space (the whole scene is about 2 wide) and turns with the object.',
      options: [
        { value: 'none', label: 'Off' },
        { value: 'box', label: 'Box' },
        { value: 'sphere', label: 'Sphere' },
      ],
    },
    cropInvert: { type: 'bool', default: false, label: 'Invert crop', hint: 'Keep the outside instead.', group: 'Crop', visibleIf: (p) => p.cropMode !== 'none' },
    cropX: { type: 'number', default: 0, min: -8, max: 8, step: 0.01, label: 'Crop center X', group: 'Crop', visibleIf: (p) => p.cropMode !== 'none' },
    cropY: { type: 'number', default: 0, min: -8, max: 8, step: 0.01, label: 'Crop center Y', group: 'Crop', visibleIf: (p) => p.cropMode !== 'none' },
    cropZ: { type: 'number', default: 0, min: -8, max: 8, step: 0.01, label: 'Crop center Z', group: 'Crop', visibleIf: (p) => p.cropMode !== 'none' },
    cropSizeX: { type: 'number', default: 1, min: 0.01, max: 8, step: 0.01, label: 'Box half width', group: 'Crop', visibleIf: (p) => p.cropMode === 'box' },
    cropSizeY: { type: 'number', default: 1, min: 0.01, max: 8, step: 0.01, label: 'Box half height', group: 'Crop', visibleIf: (p) => p.cropMode === 'box' },
    cropSizeZ: { type: 'number', default: 1, min: 0.01, max: 8, step: 0.01, label: 'Box half depth', group: 'Crop', visibleIf: (p) => p.cropMode === 'box' },
    cropRadius: { type: 'number', default: 1, min: 0.01, max: 8, step: 0.01, label: 'Sphere radius', group: 'Crop', visibleIf: (p) => p.cropMode === 'sphere' },
    maxSplats: {
      type: 'number',
      default: 1_000_000,
      min: 1000,
      max: 4_000_000,
      softMax: 2_000_000,
      step: 1000,
      integer: true,
      label: 'Max splats',
      group: 'Quality',
      hint: 'A scene with more splats keeps the largest and most opaque ones (the same ones every time). Memory is 100 bytes per splat.',
    },
    quality: {
      type: 'enum',
      default: 'auto',
      label: 'Blending',
      group: 'Quality',
      hint: 'Sorted = exact back-to-front order (sorted again only when the camera moves). Draft = cheap order-independent blend, a little different in dense areas. Automatic uses Sorted for export and still preview, Draft while playing at reduced resolution.',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'sorted', label: 'Sorted' },
        { value: 'draft', label: 'Draft' },
      ],
    },
    background: { type: 'color', default: [0, 0, 0, 0], label: 'Background', group: 'Quality', hint: 'Colour behind the splats. Fully transparent by default.' },
  },
  summary: (p, wired) => {
    const n = (p.file as string[]).length;
    const cam = wired?.has('camera') ? ' · wired camera (fisheye/panoramic → perspective)' : '';
    return n === 0 ? 'no splat file' : `${n === 1 ? 'splat' : `${n} splat files`} · ${p.shape} · ${p.quality}${p.maxSplats < 1_000_000 ? ` · max ${p.maxSplats.toLocaleString('en-US')}` : ''}${cam}`;
  },
  async render(ctx) {
    const p = ctx.params;
    const size = ctx.in.size ?? ctx.canvas;
    const W = Math.round(size.width);
    const H = Math.round(size.height);
    const wantDepth = ctx.wants('depth');
    if (!p.file.length) {
      const c = clearFrame(ctx.gpu, size, p.background, wantDepth);
      return { image: c.image, depth: c.depth };
    }
    const assetId = p.file[ctx.item.index % p.file.length];
    const full = await loadSplatCloud(ctx.host, assetId);
    const cloud = decimateCloud(full, Math.min(p.maxSplats, maxSplatsFor(ctx.gpu.device)));
    if (cloud.count === 0) throw new Error('This splat file has no usable splats.');

    // --- object matrix: world = A (p - centre) + t ---------------------------------------------------------------
    const spinning = p.spinX !== 0 || p.spinY !== 0 || p.spinZ !== 0;
    const phase = spinning ? ctx.time.phase : 0;
    const R = rotationZYX(p.rotX + 360 * p.spinX * phase, p.rotY + 360 * p.spinY * phase, p.rotZ + 360 * p.spinZ * phase);
    const orient = p.orientation === 'auto' ? estimateUp(full).matrix : ORIENT[p.orientation as keyof typeof ORIENT];
    const fitK = p.autoFit ? 0.95 / full.core.radius : 1;
    const s = fitK * Math.max(0.001, p.objectScale);
    const A = mul3(R, orient).map((v) => v * s);
    const xf = { A, t: [p.posX, p.posY, p.posZ] as [number, number, number], centre: p.autoFit ? full.core.centre : ([0, 0, 0] as [number, number, number]), fitK };

    const cam = resolveCamera(p as unknown as XformP, ctx.in.camera, W, H);
    const view = viewSetup(cam, W, H);
    const sorted = p.quality === 'sorted' || (p.quality === 'auto' && (ctx.quality === 'final' || ctx.proxy >= 1));
    const look: SplatLook = {
      sizeMul: p.splatSize,
      opacityMul: p.opacityMul,
      minOpacity: p.minOpacity,
      shape: p.shape as SplatLook['shape'],
      exposure: p.exposure,
      saturation: p.saturation,
      tint: p.tint,
      viewDependent: p.viewDependent,
      antialias: p.antialias,
      crop: { mode: p.cropMode as SplatLook['crop']['mode'], invert: p.cropInvert, centre: [p.cropX, p.cropY, p.cropZ], half: [p.cropSizeX, p.cropSizeY, p.cropSizeZ], radius: p.cropRadius },
      background: p.background,
    };
    const r = await renderSplats({ gpu: ctx.gpu, cloud, view, xf, look, size, sorted, wantDepth });
    return { image: r.image, depth: r.depth };
  },
});
