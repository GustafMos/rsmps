import { defineNode } from '../../define';
import { isSpinning } from '../../lib/gen-3d';
import { renderSdf, sceneMove, type SdfRenderParams } from '../../lib/sdf-render';
import { SDF_SCENE_EXTRA_INPUTS, SDF_SCENE_PARAMS } from '../../lib/sdf-scene-params';
import { sdfValue } from '../../lib/sdf-scene';

/**
 * Scene Output: the node inside every SDF Scene that takes the one `sdf` to draw. It holds the render settings (camera, material, lights,
 * quality, the scene's own Move / Rotate / Scale). The SDF Scene node you see in the graph is a group around it that shows these settings
 * and its camera / material inputs; this node is not added from the menu.
 *
 * Outputs: `image`, `depth` (only made when wired, same conventions as SDF 3D) and `sdf`: the whole scene wrapped in its own transform,
 * so it can be wired into another SDF Scene and combined there.
 */
export default defineNode({
  id: 'sdf-render',
  title: 'Scene Output',
  category: 'sdf',
  hidden: true,
  description: 'The end of an SDF Scene: the one shape tree it draws, with the camera, material, light and quality settings.',
  keywords: ['sdf', 'scene', 'output', 'render'],
  inputs: { scene: { type: 'sdf', required: true, label: 'Scene' }, ...SDF_SCENE_EXTRA_INPUTS },
  outputs: { image: { type: 'image', label: 'Image' }, depth: { type: 'image', label: 'Depth' }, sdf: { type: 'sdf', label: 'Scene' } },
  optionalOutputs: ['depth'],
  params: { ...SDF_SCENE_PARAMS },
  summary: (p) => `${p.quality}${p.cel ? ' · cel' : ''}`,
  render(ctx) {
    const p = ctx.params as unknown as SdfRenderParams;
    const size = ctx.in.size ?? ctx.canvas;
    const value = ctx.in.scene;
    const phase = isSpinning(p) ? ctx.time.phase : 0;
    const out = renderSdf(ctx.gpu, { value, p, size, camera: ctx.in.camera, material: ctx.in.material, phase, wantDepth: ctx.wants('depth') });
    return { image: out.image, depth: out.depth, sdf: sceneMove(ctx.path, value, p, phase) ?? sdfValue(null) };
  },
});
