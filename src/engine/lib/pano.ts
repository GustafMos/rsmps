/**
 * Shared 360 maths (WGSL) for the nodes that show or build an equirectangular panorama (Fake 360, Sweep 360).
 *
 * World directions: x right, y up, z straight ahead (longitude 0, latitude 0). Longitude grows to the right, latitude upwards.
 * `rotX` pitches (positive looks up), `rotY` yaws (positive looks right), `rotZ` rolls (positive = clockwise as seen through the camera).
 *
 * `panoView(uv, mode)` is the direction a pixel of the OUTPUT picture looks at: mode 0 = the whole panorama (2:1), 1 = tiny planet
 * (stereographic, ground in the middle), anything else = a pinhole look-around view. It reads the uniforms `output size` (`u.size`),
 * `u.zoom` (planet), `u.lookView` (radians), `u.lookTurn` and `u.lookTilt` (radians), so the node must declare them.
 */
export const PANO_WGSL = /* wgsl */ `
fn rotX(v: vec3f, a: f32) -> vec3f {
  // pitch: positive looks up
  let c = cos(a); let s = sin(a);
  return vec3f(v.x, v.y * c + v.z * s, -v.y * s + v.z * c);
}
fn rotY(v: vec3f, a: f32) -> vec3f {
  // yaw: positive looks right
  let c = cos(a); let s = sin(a);
  return vec3f(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}
fn rotZ(v: vec3f, a: f32) -> vec3f {
  // roll: positive turns the camera clockwise, so its right edge goes down
  let c = cos(a); let s = sin(a);
  return vec3f(v.x * c + v.y * s, -v.x * s + v.y * c, v.z);
}
fn panoView(uv: vec2f, mode: i32) -> vec3f {
  if (mode == 0) {
    let lon = (uv.x - 0.5) * TAU;
    let lat = (0.5 - uv.y) * PI;
    return vec3f(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  }
  if (mode == 1) {
    // stereographic little planet: the ground (straight down) in the middle, the sky round the edge
    let p = vec2f((uv.x - 0.5) * 2.0 * u.size.x / u.size.y, (0.5 - uv.y) * 2.0);
    let th = 2.0 * atan(length(p) / u.zoom);
    let ph = atan2(p.x, p.y);
    let lat = th - PI * 0.5;
    return vec3f(cos(lat) * sin(ph), sin(lat), cos(lat) * cos(ph));
  }
  let t = tan(u.lookView * 0.5);
  let p = vec2f((uv.x - 0.5) * 2.0 * t, (0.5 - uv.y) * 2.0 * t * u.size.y / u.size.x);
  let d = normalize(vec3f(p.x, p.y, 1.0));
  return rotY(rotX(d, u.lookTilt), u.lookTurn);
}
`;
