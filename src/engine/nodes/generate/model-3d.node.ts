import { defineNode } from '../../define';
import { modelFilesSummary, renderModel } from '../../lib/model-render';

/**
 * 3D Model (legacy id, kept so saved graphs keep working). The same thing now lives in the 3D Object node: pick
 * "Custom model…" in its Shape list. This node is hidden from the add menu; all rendering is in lib/model-render.ts.
 */
export default defineNode({
  id: 'model-3d',
  hidden: true,
  title: '3D Model',
  category: 'generate',
  description:
    'Renders an imported 3D model (.glb, self-contained .gltf, or .obj) with the same cameras and lighting as the 3D Object node. Up to 2 million triangles; Draco/meshopt-compressed and multi-file .gltf are not supported (export as .glb). Skins and animations are ignored.',
  keywords: ['glb', 'gltf', 'obj', 'mesh', 'import', 'model', '3d', 'low poly', 'render', 'wavefront'],
  inputs: {
    size: { type: 'image', label: 'Size from' },
    camera: { type: 'camera', label: 'Camera' },
    texture: { type: 'image', label: 'Texture' },
  },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    model: { type: 'assets', default: [], accept: 'model', label: '3D model', hint: 'A .glb, .gltf or .obj file. With several files, each batch item uses its own.' },
    autoFit: { type: 'bool', default: true, label: 'Fit to view', hint: 'Centre the model and scale it to fill the same space as the 3D Object shapes.', group: 'Object' },
    posX: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, label: 'Move X', group: 'Object', hint: 'Scene units.' },
    posY: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, label: 'Move Y (up)', group: 'Object' },
    posZ: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, label: 'Move Z (away)', group: 'Object' },
    objectScale: { type: 'number', default: 1, min: 0.01, max: 20, step: 0.01, label: 'Model scale', group: 'Object' },
    rotX: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate X (tilt)', group: 'Rotation' },
    rotY: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate Y (turn)', group: 'Rotation' },
    rotZ: { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate Z (roll)', group: 'Rotation' },
    spinX: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin X (turns per loop)', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
    spinY: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin Y (turns per loop)', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
    spinZ: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin Z (turns per loop)', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
    shading: {
      type: 'enum',
      default: 'smooth',
      label: 'Shading',
      group: 'Look',
      options: [
        { value: 'smooth', label: 'Smooth' },
        { value: 'flat', label: 'Flat (faceted, low-poly look)' },
        { value: 'unlit', label: 'Unlit (colours only)' },
      ],
    },
    colorMode: {
      type: 'enum',
      default: 'model',
      label: 'Colour',
      group: 'Look',
      options: [
        { value: 'model', label: 'As in the file' },
        { value: 'tint', label: 'Tint the file’s colours' },
        { value: 'override', label: 'One flat colour' },
      ],
    },
    baseColor: { type: 'color', default: [0.8, 0.8, 0.85, 1], label: 'Tint / colour', group: 'Look', visibleIf: (p) => p.colorMode !== 'model' },
    nearestTexture: { type: 'bool', default: false, label: 'Crisp texture (no smoothing)', group: 'Look', hint: 'Nearest-neighbour texture sampling, for pixel-art textures.' },
    backFaces: { type: 'bool', default: false, label: 'Show back faces', group: 'Look', hint: 'Draw both sides of every triangle, not only the ones the file marks double-sided.' },
    wireframe: { type: 'bool', default: false, label: 'Wireframe overlay', group: 'Look', hint: 'Limited to 300,000 triangles.' },
    wireColor: { type: 'color', default: [0, 0, 0, 0.6], label: 'Wireframe colour', group: 'Look', visibleIf: (p) => p.wireframe === true },
    cameraType: {
      type: 'enum',
      default: 'perspective',
      label: 'Built-in camera',
      group: 'Built-in camera',
      options: [
        { value: 'perspective', label: 'Perspective' },
        { value: 'orthographic', label: 'Orthographic (flat)' },
      ],
    },
    fov: { type: 'number', default: 30, min: 5, max: 90, step: 1, unit: 'deg', label: 'Perspective strength', group: 'Built-in camera', visibleIf: (p) => p.cameraType === 'perspective' },
    x: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Frame position X (built-in camera)', group: 'Built-in camera', hint: 'Ignored when a Camera is wired in.' },
    y: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Frame position Y (built-in camera)', group: 'Built-in camera' },
    scale: { type: 'number', default: 0.6, min: 0.02, max: 3, step: 0.005, unit: 'norm', label: 'Size in frame (built-in camera)', group: 'Built-in camera', hint: 'Fraction of the frame’s shorter side. Ignored when a Camera is wired in.' },
    lightAzimuth: { type: 'number', default: -35, min: -180, max: 180, step: 1, unit: 'deg', label: 'Light from (left/right)', group: 'Lighting' },
    lightElevation: { type: 'number', default: 40, min: -90, max: 90, step: 1, unit: 'deg', label: 'Light height', group: 'Lighting' },
    ambient: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Ambient light', group: 'Lighting' },
    specular: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Shininess', group: 'Lighting' },
    gloss: { type: 'number', default: 32, min: 2, max: 256, step: 1, label: 'Highlight tightness', group: 'Lighting' },
    cel: { type: 'bool', default: false, label: 'Flat (cel) shading', group: 'Lighting', hint: 'Posterises the light into a few flat bands. Great for pixel art.' },
    celSteps: { type: 'number', default: 3, min: 2, max: 8, step: 1, integer: true, label: 'Shading bands', group: 'Lighting', visibleIf: (p) => p.cel === true },
  },
  summary: (p) => `${modelFilesSummary(p)} · ${p.shading}${p.cel ? ` · ${p.celSteps}-band cel` : ''}`,
  async render(ctx) {
    const image = await renderModel(ctx, ctx.params, ctx.in.size ?? ctx.canvas, ctx.in.camera, ctx.in.texture);
    return { image };
  },
});
