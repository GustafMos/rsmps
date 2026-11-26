/**
 * The view / look half of the Gaussian Splat node, shared with Splat from Video (`splat-train`): the object transform (fit, up axis,
 * rotation, spin, move), the camera, the look and crop, and the render call. One implementation, so a trained scene looks exactly like the
 * same .ply loaded into Gaussian Splat.
 */
import type { CameraValue, CanvasInfo, ImageValue, NodeGpu, ParamSchema } from '../types';
import { XFORM_PARAMS, resolveCamera, type XformP } from './gen-3d';
import { cameraBasis, type V3 } from './gen-camera';
import { spunRotation, rotationZYX } from './gen-common';
import { decimateCloud, estimateUp, IDENTITY3, ORIENT_Y_DOWN, ORIENT_Z_UP, type Mat3, type SplatCloud } from './splat-cloud';
import { maxSplatsFor, renderSplats, type SplatLook, type SplatXform } from './splat-render';
import { mul3, viewSetup } from './splat-math';

export const SPLAT_XFORM = {
  ...XFORM_PARAMS,
  rotX: { ...XFORM_PARAMS.rotX, default: 0 },
  rotY: { ...XFORM_PARAMS.rotY, default: 0 },
};

/** Look, crop and quality params of Gaussian Splat (everything after the transform). */
export const SPLAT_LOOK_PARAMS = {
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
  tint: { type: 'color', default: [1, 1, 1, 1], label: 'Tint', group: 'Look', hint: 'Multiplies every color.' },
  viewDependent: { type: 'bool', default: true, label: 'View-dependent', group: 'Look', hint: 'Spherical harmonics degree 1 from the file, when it has them: colors shift a little with the viewing angle. Turn off for the flat base color.' },
  antialias: {
    type: 'bool',
    default: false,
    label: 'Fade tiny splats',
    group: 'Look',
    hint: 'Mip-Splatting style: compensates the 0.3 px low-pass filter so splats smaller than a pixel fade out instead of making the distance too bright. Only for files trained that way: standard trainers (Brush, the original 3DGS) are not, and with it on their scenes look washed out and see-through.',
  },
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
  background: { type: 'color', default: [0, 0, 0, 0], label: 'Background', group: 'Quality', hint: 'Color behind the splats. Fully transparent by default.' },
} satisfies ParamSchema;

const ORIENT = { asis: IDENTITY3, ydown: ORIENT_Y_DOWN, zup: ORIENT_Z_UP } as const;

/** The params the scene functions read (Gaussian Splat's and Splat from Video's share these names). */
export interface SplatSceneParams extends XformP {
  autoFit: boolean;
  orientation?: string;
  splatSize: number;
  opacityMul: number;
  minOpacity: number;
  shape: string;
  exposure: number;
  saturation: number;
  tint: readonly number[];
  viewDependent: boolean;
  antialias: boolean;
  cropMode: string;
  cropInvert: boolean;
  cropX: number;
  cropY: number;
  cropZ: number;
  cropSizeX: number;
  cropSizeY: number;
  cropSizeZ: number;
  cropRadius: number;
  maxSplats: number;
  quality: string;
  background: readonly number[];
  posX: number;
  posY: number;
  posZ: number;
  objectScale: number;
}

/** world = A (p - centre) + t: orientation (preset, or the file's up hint / the estimate when 'auto' or absent), rotation + spin, fit, move. */
export function sceneXform(full: SplatCloud, p: SplatSceneParams, phase: number): SplatXform & { R: Mat3 } {
  const spinning = p.spinX !== 0 || p.spinY !== 0 || p.spinZ !== 0;
  const ph = spinning ? phase : 0;
  const R = spunRotation(p, ph) as Mat3;
  const orient = !p.orientation || p.orientation === 'auto' ? estimateUp(full).matrix : ORIENT[p.orientation as keyof typeof ORIENT];
  const fitK = p.autoFit ? 0.95 / full.core.radius : 1;
  const s = fitK * Math.max(0.001, p.objectScale);
  const RO = mul3(R, orient) as Mat3;
  const A = RO.map((v) => v * s) as Mat3;
  return { A, R: RO, t: [p.posX, p.posY, p.posZ], centre: p.autoFit ? full.core.centre : [0, 0, 0], fitK };
}

/** A camera given in the file's frame, carried through the same transform as the splats (for "the original camera move" outputs). */
export function cameraThroughXform(xf: SplatXform & { R: Mat3 }, cam: { position: V3; forward: V3; right: V3 }, base: Omit<CameraValue, 'position' | 'target' | 'roll'>): CameraValue {
  const ap = (v: V3): V3 => [xf.A[0] * v[0] + xf.A[1] * v[1] + xf.A[2] * v[2], xf.A[3] * v[0] + xf.A[4] * v[1] + xf.A[5] * v[2], xf.A[6] * v[0] + xf.A[7] * v[1] + xf.A[8] * v[2]];
  const rv = (v: V3): V3 => [xf.R[0] * v[0] + xf.R[1] * v[1] + xf.R[2] * v[2], xf.R[3] * v[0] + xf.R[4] * v[1] + xf.R[5] * v[2], xf.R[6] * v[0] + xf.R[7] * v[1] + xf.R[8] * v[2]];
  const d = ap([cam.position[0] - xf.centre[0], cam.position[1] - xf.centre[1], cam.position[2] - xf.centre[2]]);
  const position: V3 = [d[0] + xf.t[0], d[1] + xf.t[1], d[2] + xf.t[2]];
  const f = rv(cam.forward);
  const r = rv(cam.right);
  const det = xf.R[0] * (xf.R[4] * xf.R[8] - xf.R[5] * xf.R[7]) - xf.R[1] * (xf.R[3] * xf.R[8] - xf.R[5] * xf.R[6]) + xf.R[2] * (xf.R[3] * xf.R[7] - xf.R[4] * xf.R[6]);
  // a mirroring orientation preset flips handedness: keep the picture unmirrored by flipping right as the scene flips
  const right: V3 = det < 0 ? [-r[0], -r[1], -r[2]] : r;
  const target: V3 = [position[0] + f[0], position[1] + f[1], position[2] + f[2]];
  const b = cameraBasis({ position, target, roll: 0 });
  const roll = (Math.atan2(right[0] * b.up[0] + right[1] * b.up[1] + right[2] * b.up[2], right[0] * b.right[0] + right[1] * b.right[1] + right[2] * b.right[2]) * 180) / Math.PI;
  return { ...base, position, target, roll };
}

export async function renderSplatScene(a: {
  gpu: NodeGpu;
  full: SplatCloud;
  p: SplatSceneParams;
  size: { width: number; height: number; unit?: number };
  camera: CameraValue | null;
  phase: number;
  final: boolean;
  proxy: number;
  wantDepth: boolean;
}): Promise<{ image: ImageValue; depth: ImageValue | null }> {
  const { p, size } = a;
  const W = Math.round(size.width);
  const H = Math.round(size.height);
  const cloud = decimateCloud(a.full, Math.min(p.maxSplats, maxSplatsFor(a.gpu.device)));
  if (cloud.count === 0) throw new Error('This splat file has no usable splats.');
  const xf = sceneXform(a.full, p, a.phase);
  const cam = resolveCamera(p, a.camera, W, H);
  const view = viewSetup(cam, W, H);
  const sorted = p.quality === 'sorted' || (p.quality === 'auto' && (a.final || a.proxy >= 1));
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
  const r = await renderSplats({ gpu: a.gpu, cloud, view, xf, look, size, sorted, wantDepth: a.wantDepth });
  return { image: r.image, depth: r.depth };
}

export function clearSplatFrame(gpu: NodeGpu, size: { width: number; height: number; unit?: number }, bg: readonly number[], depth: boolean): { image: ImageValue; depth: ImageValue | null } {
  const image = gpu.pass({
    label: 'splat clear',
    size,
    uniforms: { bg: [bg[0] ?? 0, bg[1] ?? 0, bg[2] ?? 0, bg[3] ?? 0] },
    wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(u.bg.rgb * u.bg.a, u.bg.a); }',
  });
  return { image, depth: depth ? gpu.pass({ label: 'splat clear depth', size, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0); }', format: 'rgba16float' }) : null };
}

export type { CanvasInfo };
