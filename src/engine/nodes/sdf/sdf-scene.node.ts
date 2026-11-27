import { defineNode } from '../../define';
import { SDF_SCENE_EXTRA_INPUTS } from '../../lib/sdf-scene-params';

/**
 * SDF Scene: the place where SDF modelling happens. Adding it from the menu creates a GROUP (`sdfScene: true`, see src/engine/sdf-scene-group.ts)
 * with a Scene Output and one Sphere inside; double-click it to open it, and add SDF Shape, Combine, Move and Modify nodes in there. These
 * nodes cannot be added anywhere else. The scene draws what is inside (`image`, `depth`) and gives the whole scene as an `sdf` that can be wired into
 * another SDF Scene and combined there.
 *
 * This registered definition is the menu entry and describes the sockets for wire filtering; the real node is the group, whose
 * definition comes from its own params (`groupDefOf`). A node of this type that reaches the engine unwrapped (a hand-edited file) renders nothing.
 */
export default defineNode({
  id: 'sdf-scene',
  title: 'SDF Scene',
  category: 'sdf',
  description:
    'A place to model with SDF shapes. It starts with one sphere; double-click it to open it and add more shapes, combine them smoothly, mirror or repeat them. It draws the result, and can also be wired into another SDF Scene.',
  keywords: ['sdf', 'scene', 'model', 'modelling', '3d', 'signed distance', 'raymarch', 'blob', 'metaball', 'smooth union'],
  inputs: { ...SDF_SCENE_EXTRA_INPUTS },
  outputs: { image: { type: 'image', label: 'Image' }, depth: { type: 'image', label: 'Depth' }, sdf: { type: 'sdf', label: 'Scene' } },
  params: {},
  render: () => ({}),
});
