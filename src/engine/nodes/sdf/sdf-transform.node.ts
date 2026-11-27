import { defineNode } from '../../define';
import { sdfMove, sdfValue } from '../../lib/sdf-scene';

/**
 * SDF Move: moves, turns and scales a whole sub-scene as one, so a group of shapes can be placed like a single shape.
 * Same parameter names as SDF Shape and 3D Object (`posX..`, `rotX..`, `objectScale`).
 */
export default defineNode({
  id: 'sdf-transform',
  title: 'SDF Move',
  category: 'sdf',
  description: 'Moves, turns and scales everything that comes in as one piece. Use it to place a group of shapes like a single shape.',
  keywords: ['sdf', 'move', 'transform', 'rotate', 'scale', 'position', 'group', 'model'],
  inputs: { scene: { type: 'sdf', required: true, label: 'Shapes' } },
  outputs: { sdf: { type: 'sdf', label: 'Moved' } },
  params: {
    posX: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, scrubSpan: 8, label: 'Move X', group: 'Place' },
    posY: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, scrubSpan: 8, label: 'Move Y', group: 'Place', hint: 'Up is positive.' },
    posZ: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, scrubSpan: 8, label: 'Move Z', group: 'Place', hint: 'Away from the camera is positive.' },
    rotX: { type: 'number', default: 0, min: -360, max: 360, step: 1, scrubSpan: 360, unit: 'deg', label: 'Rotate X', group: 'Place' },
    rotY: { type: 'number', default: 0, min: -360, max: 360, step: 1, scrubSpan: 360, unit: 'deg', label: 'Rotate Y', group: 'Place' },
    rotZ: { type: 'number', default: 0, min: -360, max: 360, step: 1, scrubSpan: 360, unit: 'deg', label: 'Rotate Z', group: 'Place' },
    objectScale: { type: 'number', default: 1, min: 0.01, max: 20, step: 0.01, scrubSpan: 4, label: 'Scale', group: 'Place' },
  },
  summary: (p) => `${p.posX}, ${p.posY}, ${p.posZ}`,
  render(ctx) {
    const v = ctx.in.scene;
    if (!v.root) return { sdf: v };
    const p = ctx.params;
    const node = sdfMove(ctx.path, v.root, { pos: [p.posX, p.posY, p.posZ], rot: [p.rotX, p.rotY, p.rotZ], scale: Math.max(0.001, p.objectScale) });
    return { sdf: sdfValue(node, v.picture) };
  },
});
