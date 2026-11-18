import { defineNode } from '../../define';
import { DEPTH_WGSL } from '../../lib/depth';
import { depthMaskPass } from '../../lib/depth-heuristic';

/**
 * Converts between the two depth conventions (lib/depth.ts): the 3D nodes' scene depth (distance in scene units, alpha = hit) and the
 * picture depth every 2D depth consumer reads (white = near, 0..1). Only needed when a 3D node's Depth output feeds Depth Slice, Lens Blur or
 * Image to 3D relief, or when a picture depth must feed something that wants distances.
 */
export default defineNode({
  id: 'depth-convert',
  title: 'Depth Convert',
  category: 'composite',
  description:
    'Converts a depth picture between conventions: the Depth output of the 3D nodes (distance in scene units) and a depth map (white = near), which Depth Slice, Lens Blur, Image to 3D and Picture to Splats read.',
  keywords: ['depth', 'z depth', 'depth map', 'convert', 'scene depth', 'distance', 'invert depth', 'near far'],
  inputs: { depth: { type: 'image', required: true, label: 'Depth' } },
  outputs: { depth: { type: 'image', label: 'Depth' }, mask: { type: 'mask', label: 'Mask (near = white)' } },
  optionalOutputs: ['mask'],
  params: {
    mode: {
      type: 'enum',
      default: 'scene-to-picture',
      label: 'Convert',
      options: [
        { value: 'scene-to-picture', label: '3D distance to depth map' },
        { value: 'picture-to-scene', label: 'Depth map to 3D distance' },
      ],
      hint: 'A depth map is white = near, black = far. 3D distance is the Depth output of 3D Object, SDF 3D and Image to 3D: scene units in red, alpha 1 where something was hit.',
    },
    near: { type: 'number', default: 3.5, min: 0.05, max: 100, step: 0.01, label: 'Near distance', hint: 'Scene units that map to white. Use the same two numbers as Picture to Splats.' },
    far: { type: 'number', default: 5.5, min: 0.05, max: 200, step: 0.01, label: 'Far distance', hint: 'Scene units that map to black.' },
    invert: { type: 'bool', default: false, label: 'Invert', hint: 'Flip the result (black = near).' },
  },
  summary: (p) => (p.mode === 'scene-to-picture' ? `3D to map ${p.near}-${p.far}` : `map to 3D ${p.near}-${p.far}`),
  render(ctx) {
    const p = ctx.params;
    const depth = ctx.gpu.pass({
      label: 'depth-convert',
      size: ctx.in.depth,
      format: 'rgba16float',
      textures: { src: ctx.in.depth },
      uniforms: { toPicture: p.mode === 'scene-to-picture', near: p.near, far: p.far, inv: p.invert },
      wgsl: /* wgsl */ `${DEPTH_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureSampleLevel(src, smpNearest, uv, 0.0);
  if (u.toPicture > 0.5) {
    // misses (alpha 0) are infinitely far
    var d = select(0.0, dp_sceneToPicture(c.r, u.near, u.far), c.a > 0.5);
    if (u.inv > 0.5) { d = 1.0 - d; }
    return vec4f(d, d, d, 1.0);
  }
  var d = luma(c.rgb / max(c.a, 0.004));
  if (u.inv > 0.5) { d = 1.0 - d; }
  let z = dp_pictureToScene(d, u.near, u.far);
  return vec4f(z, z, z, 1.0);
}`,
    });
    // The mask is always the depth MAP (white = near): the result when converting to a map, the input when converting from one.
    return { depth, mask: ctx.wants('mask') ? depthMaskPass(ctx.gpu, p.mode === 'scene-to-picture' ? depth : ctx.in.depth) : null };
  },
});
