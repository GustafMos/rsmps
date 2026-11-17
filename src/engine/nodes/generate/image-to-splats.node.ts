import { defineNode } from '../../define';
import type { CameraValue } from '../../types';
import { renderPictureSplats, type DepthEncoding, type DepthGuess } from '../../lib/splat-render';
import { viewSetup } from '../../lib/splat-math';

/**
 * Picture to Splats: a picture (and optionally its depth) becomes a cloud of Gaussian splats ON THE GPU, one splat per sampled pixel of
 * a grid, and is drawn from any camera: soft, painterly 2.5D parallax. Nothing is read back and nothing is sorted: the vertex shader turns
 * the instance index into a grid cell, unprojects the cell through the capture camera with its depth and builds the splat's covariance from
 * the neighbouring depths (flat along the estimated surface normal, as wide as the cell's footprint, so the capture view has no holes).
 * Back-to-front order comes from an occlusion-compatible traversal of the grid (lib/splat-math.ts `pictureOrder`), computed from the two
 * camera positions, so it is exact for a single-layer depth picture and works for video frames at full speed.
 */
export default defineNode({
  id: 'image-to-splats',
  title: 'Picture to Splats',
  category: 'generate',
  description:
    'Turns a picture into soft 3D splats and lets you move a camera around it: quick 2.5D parallax from any photo, video frame or 3D render. Wire a depth picture (Depth from Picture, an AI depth map, or the Depth output of 3D Object / SDF 3D / Image to 3D) for real relief; without one the depth is a labeled GUESS (a flat card, brightness, or a center bulge). Splats are generated on the GPU, one per sampled pixel, so video works every frame. Depth jumps stretch splats into ragged smears: Edge break drops or shrinks them.',
  keywords: ['depth', '2.5d', 'parallax', 'point cloud', 'quick splat', 'splat', 'gaussian', 'depth map', 'photo to 3d', 'ken burns', 'dolly', 'camera move', 'z depth', 'relief', 'midas', 'depth anything'],
  inputs: {
    image: { type: 'image', required: true, label: 'Picture' },
    depth: { type: 'image', label: 'Depth' },
    camera: { type: 'camera', label: 'Camera (view)' },
    captureCamera: { type: 'camera', label: 'Capture camera' },
    size: { type: 'image', label: 'Size from' },
  },
  outputs: { image: { type: 'image', label: 'Image' }, depth: { type: 'image', label: 'Depth' } },
  optionalOutputs: ['depth'],
  params: {
    density: { type: 'number', default: 640, min: 16, max: 2048, softMax: 1280, step: 1, integer: true, label: 'Splats across', group: 'Splats', hint: 'Grid samples along the picture’s long side: 640 on a 16:9 picture is about 230,000 splats. More = sharper and slower.' },
    splatSize: { type: 'number', default: 1, min: 0.2, max: 3, step: 0.01, label: 'Splat size', group: 'Splats', hint: '1 overlaps neighbors just enough to leave no holes when viewed from the capture camera.' },
    thickness: { type: 'number', default: 0.3, min: 0, max: 3, step: 0.01, label: 'Thickness', group: 'Splats', hint: 'How thick each splat is along the surface (in cells). 0 = paper thin.' },
    splatShape: {
      type: 'enum',
      default: 'gaussian',
      label: 'Splat shape',
      group: 'Splats',
      options: [
        { value: 'gaussian', label: 'Soft' },
        { value: 'sharp', label: 'Sharp' },
        { value: 'square', label: 'Square' },
      ],
    },
    jitter: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Jitter', group: 'Splats', hint: 'Shifts every splat randomly inside its cell (the same shift every frame): breaks up the regular grid for a painterly texture.' },
    opacity: { type: 'number', default: 1, min: 0, max: 1.5, step: 0.01, label: 'Opacity', group: 'Splats' },
    depthEncoding: {
      type: 'enum',
      default: 'luma-near-white',
      label: 'Depth picture is',
      group: 'Depth',
      hint: 'How the wired Depth picture is read. Depth-estimation tools usually make near = white. "From 3D nodes" reads the Depth output of 3D Object / SDF 3D / Image to 3D: distance in scene units in red, alpha 1 where something was hit.',
      options: [
        { value: 'luma-near-white', label: 'White = near' },
        { value: 'luma-near-black', label: 'Black = near' },
        { value: 'scene', label: 'From 3D nodes' },
      ],
    },
    near: { type: 'number', default: 3.5, min: 0.05, max: 100, step: 0.01, label: 'Near distance', group: 'Depth', hint: 'Scene units from the capture camera of the nearest depth (brightness encodings only).', visibleIf: (p) => p.depthEncoding !== 'scene' },
    far: { type: 'number', default: 5.5, min: 0.05, max: 200, step: 0.01, label: 'Far distance', group: 'Depth', hint: 'Distance of the farthest depth. The further apart near and far are, the stronger the parallax.', visibleIf: (p) => p.depthEncoding !== 'scene' },
    guess: {
      type: 'enum',
      default: 'bulge',
      label: 'Guess depth',
      group: 'Depth',
      hint: 'Used when no Depth is wired. Only used when no Depth picture is wired. A GUESS, not a measurement (add Depth from Picture for a better one): a flat card, brightness (bright = near), a dome bulging at the center, or both. Wire a real depth map for believable results.',
      options: [
        { value: 'flat', label: 'Flat card' },
        { value: 'luminance', label: 'Brightness' },
        { value: 'bulge', label: 'Center bulge' },
        { value: 'luminance-bulge', label: 'Brightness + bulge' },
      ],
    },
    edgeBreak: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Edge break', group: 'Depth edges', hint: 'Splats stretched across a depth jump (the rubber-sheet look) are dropped or shrunk. 0 = off (ragged smears), 1 = even gentle slopes are cut.' },
    edgeMode: {
      type: 'enum',
      default: 'shrink',
      label: 'Stretched splats',
      group: 'Depth edges',
      options: [
        { value: 'shrink', label: 'Shrink' },
        { value: 'drop', label: 'Drop' },
      ],
      visibleIf: (p) => (p.edgeBreak as number) > 0,
    },
    captureFov: { type: 'number', default: 40, min: 5, max: 120, step: 1, unit: 'deg', label: 'Capture FOV', group: 'Capture camera', hint: 'The lens the picture was taken with (on the short side). Ignored when a Capture camera is wired.' },
    captureDistance: { type: 'number', default: 4.5, min: 0.1, max: 100, step: 0.01, label: 'Capture distance', group: 'Capture camera', hint: 'Where the picture sits: the capture camera is this far in front of the center of the scene. Also the default view. Ignored when a Capture camera is wired.' },
    background: { type: 'color', default: [0, 0, 0, 0], label: 'Background', group: 'Output', hint: 'Color behind the splats. Fully transparent by default.' },
  },
  summary: (p, wired) => `${p.density} wide · ${wired?.has('depth') ? (p.depthEncoding === 'scene' ? 'depth from 3D' : 'depth wired') : `No depth wired: showing a ${p.guess === 'flat' ? 'flat' : p.guess === 'bulge' ? 'center bulge' : p.guess === 'luminance' ? 'brightness' : 'brightness bulge'} guess. Add Depth from Picture.`}`,
  async render(ctx) {
    const p = ctx.params;
    const img = ctx.in.image;
    const size = ctx.in.size ?? img;
    const W = Math.round(size.width);
    const H = Math.round(size.height);
    const long = Math.max(img.width, img.height);
    const gw = Math.max(1, Math.round(p.density * (img.width / long)));
    const gh = Math.max(1, Math.round(p.density * (img.height / long)));
    const virtual: CameraValue = { kind: 'camera', projection: 'perspective', fov: p.captureFov, orthoSize: 4, position: [0, 0, -p.captureDistance], target: [0, 0, 0], roll: 0, shift: [0, 0] };
    const captureCam = ctx.in.captureCamera ?? virtual;
    const viewCam = ctx.in.camera ?? captureCam;
    const r = await renderPictureSplats({
      gpu: ctx.gpu,
      image: img,
      depth: ctx.in.depth,
      view: viewSetup(viewCam, W, H),
      capture: viewSetup(captureCam, img.width, img.height),
      grid: { w: gw, h: gh },
      size: { width: W, height: H, unit: size.unit },
      encoding: p.depthEncoding as DepthEncoding,
      guess: p.guess as DepthGuess,
      near: Math.min(p.near, p.far),
      far: Math.max(p.near, p.far),
      thickness: p.thickness,
      sizeMul: p.splatSize,
      edgeThreshold: p.edgeBreak <= 0 ? 0 : 1.5 + 30 * (1 - p.edgeBreak) * (1 - p.edgeBreak),
      edgeMode: p.edgeMode as 'drop' | 'shrink',
      jitter: p.jitter,
      opacity: p.opacity,
      shape: p.splatShape as 'gaussian' | 'sharp' | 'square',
      background: p.background,
      wantDepth: ctx.wants('depth'),
      antialias: false,
    });
    return { image: r.image, depth: r.depth };
  },
});
