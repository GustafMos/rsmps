import { defineNode } from '../../define';
import { sdfShape, sdfValue } from '../../lib/sdf-scene';
import type { ColorValue, SdfShapeKind } from '../../types';

/**
 * SDF Shape: one solid shape of an SDF Scene (sphere, box, ... or an extruded picture) with its own position, rotation, size and colour.
 * Its `sdf` output is plain data (lib/sdf-scene.ts): nothing is drawn here, the SDF Scene renders everything inside it in one pass.
 * Position, rotation and scale use the names of the 3D family (`posX..`, `rotX..`, `objectScale`) so the viewer's handles can drive them.
 */

const SHAPES: readonly SdfShapeKind[] = ['sphere', 'box', 'rbox', 'torus', 'capsule', 'cylinder', 'cone', 'plane', 'octa', 'image2d'];
const HAS_RADIUS = ['sphere', 'torus', 'capsule', 'cylinder', 'cone', 'octa'];
const HAS_WIDTH = ['box', 'rbox', 'image2d'];
const HAS_HEIGHT = ['box', 'rbox', 'capsule', 'cylinder', 'cone'];
const HAS_DEPTH = ['box', 'rbox', 'image2d'];

const is = (list: readonly string[]) => (p: Record<string, unknown>) => list.includes(p.shape as string);

export default defineNode({
  id: 'sdf-shape',
  title: 'SDF Shape',
  category: 'sdf',
  description: 'One solid shape for an SDF Scene: sphere, box, rounded box, torus, capsule, cylinder, cone, plane, octahedron or an extruded picture. Move, turn, size and colour it on its own. Combine shapes with SDF Combine.',
  keywords: ['sdf', 'sphere', 'box', 'torus', 'capsule', 'cylinder', 'cone', 'primitive', 'solid', 'model', 'blob', '3d'],
  inputs: { picture: { type: 'image', label: 'Picture' } },
  outputs: { sdf: { type: 'sdf', label: 'Shape' } },
  params: {
    shape: {
      type: 'enum',
      default: 'sphere',
      label: 'Shape',
      group: 'Shape',
      options: [
        { value: 'sphere', label: 'Sphere' },
        { value: 'box', label: 'Box' },
        { value: 'rbox', label: 'Rounded box' },
        { value: 'torus', label: 'Torus' },
        { value: 'capsule', label: 'Capsule' },
        { value: 'cylinder', label: 'Cylinder' },
        { value: 'cone', label: 'Cone' },
        { value: 'plane', label: 'Plane' },
        { value: 'octa', label: 'Octahedron' },
        { value: 'image2d', label: 'Extruded picture' },
      ],
    },
    radius: { type: 'number', default: 0.5, min: 0.01, max: 10, step: 0.01, label: 'Radius', group: 'Shape', hint: 'Sphere, ring of the torus, capsule, cylinder, cone and octahedron.', visibleIf: is(HAS_RADIUS) },
    sizeX: { type: 'number', default: 1, min: 0.01, max: 20, step: 0.01, label: 'Width', group: 'Shape', hint: 'Box width. For a picture: its longer side.', visibleIf: is(HAS_WIDTH) },
    sizeY: { type: 'number', default: 1, min: 0.01, max: 20, step: 0.01, label: 'Height', group: 'Shape', visibleIf: is(HAS_HEIGHT) },
    sizeZ: { type: 'number', default: 1, min: 0.01, max: 20, step: 0.01, label: 'Depth', group: 'Shape', hint: 'Box depth. For a picture: how thick it is extruded.', visibleIf: is(HAS_DEPTH) },
    tube: { type: 'number', default: 0.15, min: 0.01, max: 5, step: 0.01, label: 'Tube radius', group: 'Shape', visibleIf: is(['torus']) },
    posX: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, scrubSpan: 8, label: 'Move X', group: 'Place', hint: 'Scene units. Wire a number here to move the shape.' },
    posY: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, scrubSpan: 8, label: 'Move Y', group: 'Place', hint: 'Up is positive.' },
    posZ: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, scrubSpan: 8, label: 'Move Z', group: 'Place', hint: 'Away from the camera is positive.' },
    rotX: { type: 'number', default: 0, min: -360, max: 360, step: 1, scrubSpan: 360, unit: 'deg', label: 'Rotate X', group: 'Place', visibleIf: (p) => p.shape !== 'sphere' },
    rotY: { type: 'number', default: 0, min: -360, max: 360, step: 1, scrubSpan: 360, unit: 'deg', label: 'Rotate Y', group: 'Place', visibleIf: (p) => p.shape !== 'sphere' },
    rotZ: { type: 'number', default: 0, min: -360, max: 360, step: 1, scrubSpan: 360, unit: 'deg', label: 'Rotate Z', group: 'Place', visibleIf: (p) => p.shape !== 'sphere' },
    objectScale: { type: 'number', default: 1, min: 0.01, max: 20, step: 0.01, scrubSpan: 4, label: 'Scale', group: 'Place', hint: 'Makes the whole shape bigger or smaller about its own position.' },
    color: { type: 'color', default: [0.8, 0.8, 0.85, 1], label: 'Color', group: 'Look' },
  },
  summary: (p) => String(p.shape).replace('rbox', 'rounded box').replace('octa', 'octahedron').replace('image2d', 'picture'),
  render(ctx) {
    const p = ctx.params as Record<string, unknown> & { shape: SdfShapeKind; radius: number; sizeX: number; sizeY: number; sizeZ: number; tube: number; objectScale: number; color: ColorValue };
    const kind = SHAPES.includes(p.shape) ? p.shape : 'sphere';
    // an extruded picture needs its picture: without one the shape is not there (the scene renders without it)
    if (kind === 'image2d' && !ctx.in.picture) return { sdf: sdfValue(null) };
    // half sizes, the convention of the shared distance functions (lib/sdf-prims.ts)
    let size: [number, number, number];
    switch (kind) {
      case 'box':
      case 'rbox':
        size = [p.sizeX / 2, p.sizeY / 2, p.sizeZ / 2];
        break;
      case 'torus':
        size = [p.radius, p.tube, 0];
        break;
      case 'capsule':
      case 'cylinder':
      case 'cone':
        size = [p.radius, p.sizeY / 2, 0];
        break;
      case 'image2d':
        size = [p.sizeX / 2, p.sizeZ / 2, 0];
        break;
      case 'plane':
        size = [0, 0, 0];
        break;
      default:
        size = [p.radius, 0, 0];
    }
    const node = sdfShape(ctx.path, kind, {
      pos: [p.posX as number, p.posY as number, p.posZ as number],
      rot: kind === 'sphere' ? [0, 0, 0] : [p.rotX as number, p.rotY as number, p.rotZ as number],
      size,
      scale: Math.max(0.001, p.objectScale),
      color: [p.color[0], p.color[1], p.color[2]],
    });
    return { sdf: sdfValue(node, kind === 'image2d' ? ctx.in.picture : null) };
  },
});
