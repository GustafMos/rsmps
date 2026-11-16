/**
 * Depth conventions in ONE place.
 *
 *  PICTURE DEPTH ("depth map"): a normal picture, r = g = b = d in 0..1, WHITE = NEAR, black = far, alpha 1.
 *    Made by Depth from Picture; read by Picture to Splats ("White = near", the default), Depth Slice, Lens Blur (focus depth is a
 *    value on the same 0..1 scale), Image to 3D relief (bright stands out). Depth from Picture writes it as rgba16float so
 *    a splat grid does not see 8-bit steps; any consumer reads `.r` / luma and does not care about the format.
 *
 *  SCENE DEPTH (the 3D family's `depth` output): rgba16float, r = g = b = distance from the camera to the surface along the viewing ray,
 *    in scene units (linear), a = 1 where something was hit and 0 elsewhere. Read by Picture to Splats with "From 3D nodes".
 *
 *  Converting: a near and a far distance define the line between them: picture 1 = `near` units away, picture 0 = `far` units away.
 *    z = far + (near - far) * d          d = (far - z) / (far - near)
 *  Picture to Splats does the same with its Near distance / Far distance, so a picture depth made from a scene depth with the same
 *  two numbers is read back as the same distances.
 */

export interface DepthRange {
  near: number;
  far: number;
}

/** Picture depth (1 = near) to scene distance. */
export function pictureToScene(d: number, r: DepthRange): number {
  return r.far + (r.near - r.far) * d;
}

/** Scene distance to picture depth (1 = near), clamped to 0..1. */
export function sceneToPicture(z: number, r: DepthRange): number {
  const span = r.far - r.near;
  if (Math.abs(span) < 1e-9) return 0.5;
  return Math.min(1, Math.max(0, (r.far - z) / span));
}

/** WGSL twins of the two functions above (uniform-driven: pass `near` and `far` as numbers, never bake them into the text). */
export const DEPTH_WGSL = /* wgsl */ `
fn dp_pictureToScene(d: f32, near: f32, far: f32) -> f32 { return far + (near - far) * d; }
fn dp_sceneToPicture(z: f32, near: f32, far: f32) -> f32 {
  let span = far - near;
  if (abs(span) < 1e-9) { return 0.5; }
  return clamp((far - z) / span, 0.0, 1.0);
}`;
