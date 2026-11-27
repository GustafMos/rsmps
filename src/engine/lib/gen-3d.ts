import { SPIN_AROUND_PARAM } from './gen-common';
/**
 * Shared pieces of the 3D family (3D Object, Image to 3D, SDF 3D): the camera ray, the light, the sphere-tracing march with
 * cheap edge anti-aliasing, SDF ambient occlusion and soft shadows, the quality levels and the depth output.
 *
 * Every node of the family generates ONE shader per STRUCTURE (which shapes, which deform features, which texture inputs). Every
 * number goes through `uniforms`, so dragging a slider never compiles anything (docs/ENGINE.md rule 24).
 *
 * DEPTH OUTPUT (all 3D nodes): `rgba16float`, r = g = b = distance from the camera to the surface along the viewing ray, in scene
 * units; a = 1 where a surface was hit, 0 elsewhere (then rgb = 0). Linear, not premultiplied, not anti-aliased, one ray per pixel.
 */
import { cameraBasis, PROJECTION_ID, simpleCamera } from './gen-camera';
import type { CameraValue, ImageValue, NodeGpu, ParamSchema, UniformValue } from '../types';

export const LIGHT_PARAMS = {
  lightAzimuth: { type: 'number', default: -35, min: -180, max: 180, step: 1, unit: 'deg', label: 'Light azimuth', hint: 'Left to right.', group: 'Lighting' },
  lightElevation: { type: 'number', default: 40, min: -90, max: 90, step: 1, unit: 'deg', label: 'Light height', group: 'Lighting' },
  ambient: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Ambient light', group: 'Lighting' },
  specular: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Shininess', group: 'Lighting' },
  gloss: { type: 'number', default: 32, min: 2, max: 256, step: 1, label: 'Highlight focus', group: 'Lighting' },
  cel: { type: 'bool', default: false, label: 'Cel shading', group: 'Lighting', hint: 'Posterises the light into a few flat bands. Great for pixel art.' },
  celSteps: { type: 'number', default: 3, min: 2, max: 8, step: 1, integer: true, label: 'Shading bands', group: 'Lighting', visibleIf: (p: Record<string, unknown>) => p.cel === true },
} satisfies ParamSchema;

/** Extra shading of the raymarched members of the family (Image to 3D, SDF 3D). */
export const SHADE_PARAMS = {
  rim: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Rim light', group: 'Lighting', hint: 'Light on the edges facing away from the viewer (a cheap matcap look).' },
  ao: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Ambient occlusion', group: 'Lighting', hint: 'Darkens creases and contact areas (5 extra distance reads per pixel).' },
  shadows: { type: 'bool', default: false, label: 'Soft shadows', group: 'Lighting', hint: 'The object shadows itself. Costs about 20 extra steps per pixel.' },
} satisfies ParamSchema;

export const QUALITY_PARAM = {
  quality: {
    type: 'enum',
    default: 'normal',
    label: 'Quality',
    group: 'Quality',
    hint: 'Draft marches at half resolution (about 4x faster). High traces 4 rays per pixel. During playback at a reduced proxy the frame is already smaller.',
    options: [
      { value: 'draft', label: 'Draft' },
      { value: 'normal', label: 'Normal' },
      { value: 'high', label: 'High' },
    ],
  },
} satisfies ParamSchema;

/**
 * Anti-aliasing of the raymarched SDF nodes. `edges` is the cheap analytic edge estimate every node always had (4 rays at Quality High);
 * `off` switches it off; `x2` / `x4` shade 2 / 4 rays per pixel and average them; `best` is 4 rays for a paused full-size frame and for exports and
 * `edges` while playing (the engine tells a node ctx.quality 'final' and ctx.proxy 1 then).
 */
export const AA_PARAM = {
  antiAlias: {
    type: 'enum',
    default: 'edges',
    absent: 'edges',
    label: 'Anti-aliasing',
    group: 'Quality',
    hint: 'Smooths jagged edges and shimmering surface detail. Edges only is cheap and always on. 2x and 4x shade several rays per pixel (slower). 4x when paused or export keeps playback fast and gives clean stills and files.',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'edges', label: 'Edges only' },
      { value: 'x2', label: '2x supersampling' },
      { value: 'x4', label: '4x supersampling' },
      { value: 'best', label: '4x when paused or export' },
    ],
  },
} satisfies ParamSchema;

/** Rays per pixel and whether the near-miss edge estimate runs, for an Anti-aliasing setting. `fullQuality` = export or a paused full-size frame. */
export function aaPlan(mode: string | undefined, quality: string, fullQuality: boolean): { samples: number; edges: boolean } {
  const base = quality === 'high' ? 4 : 1;
  switch (mode) {
    case 'off':
      return { samples: 1, edges: false };
    case 'x2':
      return { samples: Math.max(2, base), edges: true };
    case 'x4':
      return { samples: 4, edges: true };
    case 'best':
      return { samples: fullQuality ? 4 : base, edges: true };
    default:
      return { samples: base, edges: true };
  }
}

/**
 * GROUND SHADOW ("shadow catcher"). An invisible, endless floor under the object that only shows the object's shadow: where the floor
 * is in shadow the node outputs black with alpha = strength x how dark it is, everywhere else on the floor alpha 0, so laid over a
 * photo or the AR camera it darkens the real floor. The shadow has NO depth: the depth output never includes the floor.
 * Off by default (old projects are unchanged). The floor is the plane y = ground height (scene units, y up); the shadow fades out with
 * distance from the object, so there is no horizon.
 */
export const GROUND_PARAMS = {
  groundShadow: { type: 'bool', default: false, label: 'Ground shadow', group: 'Ground shadow', hint: 'The object casts a shadow on an invisible floor under it. Over a photo or the AR camera it darkens the real floor.' },
  groundStrength: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Shadow strength', group: 'Ground shadow', hint: '0 = no shadow, 1 = fully black.', visibleIf: (p: Record<string, unknown>) => p.groundShadow === true },
  groundSoftness: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Shadow softness', group: 'Ground shadow', hint: 'Sharp to very soft edge.', visibleIf: (p: Record<string, unknown>) => p.groundShadow === true },
  groundHeight: {
    type: 'number',
    default: 0,
    min: -10,
    max: 10,
    step: 0.01,
    scrubSpan: 4,
    label: 'Ground height',
    group: 'Ground shadow',
    hint: '0 puts the floor at the lowest point of the object (in AR: on the surface you placed it on). Positive raises it, negative lowers it.',
    visibleIf: (p: Record<string, unknown>) => p.groundShadow === true,
  },
} satisfies ParamSchema;

/** "Light from camera": a camera that knows the real light of a room (World AR Camera) can drive the light of the 3D node. */
export const LIGHT_FROM_CAMERA_PARAM = {
  lightFromCamera: { type: 'bool', default: true, label: 'Light from camera', group: 'Lighting', hint: 'When the wired camera knows the light of the room (the World AR Camera with "Match the room\'s light"), use it instead of the light below. No effect with other cameras.' },
} satisfies ParamSchema;

export interface GroundP {
  groundShadow?: boolean;
  groundStrength?: number;
  groundSoftness?: number;
  groundHeight?: number;
  lightFromCamera?: boolean;
}

/** The node's params with the light of the wired camera in place of its own light (when it has one and "Light from camera" is not off). */
export function applyCameraLight<T extends { lightAzimuth: number; lightElevation: number; ambient: number }>(p: T & GroundP, cam: CameraValue | null): T {
  const l = cam?.light;
  if (!l || p.lightFromCamera === false) return p;
  return { ...p, lightAzimuth: l.azimuth, lightElevation: l.elevation, ambient: Math.min(1, Math.max(0, l.ambient)) };
}

/** Does this node draw the ground shadow? */
export const groundOn = (p: GroundP): boolean => p.groundShadow === true;

/**
 * Uniforms of the ground shadow (see GROUND_WGSL). `bottom` = the lowest world y of the object, `center` / `radius` = a world sphere around
 * it. A camera that knows where the real surface is (`cam.ground`, scene y) wins over `bottom`; the node's Ground height is added on top.
 */
export function groundUniforms(p: GroundP, cam: CameraValue | null, o: { bottom: number; center: readonly number[]; radius: number; opacity?: number }): Record<string, UniformValue> {
  const base = cam && typeof cam.ground === 'number' && Number.isFinite(cam.ground) ? cam.ground : o.bottom;
  return {
    gY: base + (p.groundHeight ?? 0),
    gStr: Math.min(1, Math.max(0, p.groundStrength ?? 0.6)) * (o.opacity ?? 1),
    gSoft: Math.min(1, Math.max(0, p.groundSoftness ?? 0.35)),
    gR: Math.max(0.05, o.radius),
    gC: [o.center[0], o.center[1], o.center[2]],
  };
}

/**
 * WGSL of the ground shadow for a shader that has `fn map(p: vec3f) -> f32` (a lower bound of the distance) and the uniforms of
 * `groundUniforms` plus `u.light`. `groundAlpha(ro, rd)` = shadow amount 0..1 of the floor point a camera ray meets (0 when it meets no
 * floor). The shadow ray is marched through `map` like the soft shadows of the SDF renderers; contact darkening is the same distance
 * based occlusion as `calcAO`, taken straight up from the floor.
 */
export const GROUND_WGSL = /* wgsl */ `
fn gVis(p: vec3f, L: vec3f) -> f32 {
  let R = max(u.gR, 0.05);
  let k = 64.0 * pow(0.047, u.gSoft);
  let tmax = min(2.5 * R / max(L.y, 0.05) + R, 24.0 * R);
  var res = 1.0;
  var t = 0.03 * R;
  for (var i = 0; i < 64; i++) {
    let h = map(p + L * t);
    res = min(res, k * h / t);
    t += clamp(h, 0.02 * R, 0.3 * R);
    if (res < 0.003 || t > tmax) { break; }
  }
  res = clamp(res, 0.0, 1.0);
  return res * res * (3.0 - 2.0 * res);
}
fn gAO(p: vec3f) -> f32 {
  let R = max(u.gR, 0.05);
  var occ = 0.0;
  var sca = 1.0;
  for (var i = 0; i < 5; i++) {
    let h = R * (0.03 + 0.2 * f32(i) / 4.0);
    occ += (h - map(p + vec3f(0.0, h, 0.0))) * sca;
    sca *= 0.8;
  }
  return clamp(1.0 - 1.5 * occ / (0.23 * R), 0.0, 1.0);
}
fn groundAlpha(ro: vec3f, rd: vec3f) -> f32 {
  if (ro.y <= u.gY + 1e-5 || rd.y > -1e-5) { return 0.0; }
  let t = (u.gY - ro.y) / rd.y;
  let p = vec3f(ro.x + rd.x * t, u.gY, ro.z + rd.z * t);
  let L = normalize(u.light);
  let R = max(u.gR, 0.05);
  let reach = 2.0 * R / max(L.y, 0.2);
  let dc = length(p.xz - u.gC.xz);
  let fade = 1.0 - smoothstep(1.5 * R + 0.6 * reach, 4.0 * R + 1.4 * reach, dc);
  if (fade <= 0.0 || u.gStr <= 0.0) { return 0.0; }
  let lit = smoothstep(0.0, 0.12, L.y);
  var vis = 1.0;
  if (lit > 0.0) { vis = mix(1.0, gVis(p, L), lit); }
  let dark = 1.0 - vis * mix(1.0, gAO(p), 0.8);
  return clamp(u.gStr * dark * fade, 0.0, 1.0);
}
`;

/** Move / scale / rotate / spin of the object plus the simple built-in camera: the same params and defaults as 3D Object. */
export const XFORM_PARAMS = {
  posX: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, scrubSpan: 8, label: 'Move X', group: 'Object', hint: 'Scene units (the object is about 2 wide). Wire a number here to move it.' },
  posY: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, scrubSpan: 8, label: 'Move Y', hint: 'Up is positive.', group: 'Object' },
  posZ: { type: 'number', default: 0, min: -20, max: 20, step: 0.01, scrubSpan: 8, label: 'Move Z', hint: 'Away from the camera is positive.', group: 'Object' },
  objectScale: { type: 'number', default: 1, min: 0.01, max: 20, step: 0.01, scrubSpan: 4, label: 'Object scale', group: 'Object' },
  x: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Frame X', group: 'Built-in camera', hint: 'Ignored when a Camera is wired in.' },
  y: { type: 'number', default: 0.5, min: -0.5, max: 1.5, step: 0.005, unit: 'norm', label: 'Frame Y', hint: 'Position in the frame (built-in camera only).', group: 'Built-in camera' },
  scale: { type: 'number', default: 0.6, min: 0.02, max: 3, step: 0.005, unit: 'norm', label: 'Frame size', group: 'Built-in camera', hint: 'Fraction of the frame’s shorter side. Ignored when a Camera is wired in.' },
  cameraType: {
    type: 'enum',
    default: 'perspective',
    label: 'Built-in camera',
    group: 'Built-in camera',
    options: [
      { value: 'perspective', label: 'Perspective' },
      { value: 'orthographic', label: 'Orthographic' },
    ],
  },
  fov: { type: 'number', default: 30, min: 5, max: 90, step: 1, unit: 'deg', label: 'Perspective', group: 'Built-in camera', hint: 'Higher = camera closer, stronger perspective.', visibleIf: (p: Record<string, unknown>) => p.cameraType === 'perspective' },
  rotX: { type: 'number', default: 25, min: -360, max: 360, step: 1, scrubSpan: 360, unit: 'deg', label: 'Rotate X', hint: 'Tilt.', group: 'Rotation' },
  rotY: { type: 'number', default: 35, min: -360, max: 360, step: 1, scrubSpan: 360, unit: 'deg', label: 'Rotate Y', hint: 'Turn.', group: 'Rotation' },
  rotZ: { type: 'number', default: 0, min: -360, max: 360, step: 1, scrubSpan: 360, unit: 'deg', label: 'Rotate Z', hint: 'Roll.', group: 'Rotation' },
  spinX: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin X', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
  spinY: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin Y', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
  spinZ: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Spin Z', group: 'Rotation', hint: 'Whole turns per loop, so it loops exactly.' },
  spinAround: SPIN_AROUND_PARAM,
} satisfies ParamSchema;

export interface XformP {
  posX: number;
  posY: number;
  posZ: number;
  objectScale: number;
  x: number;
  y: number;
  scale: number;
  cameraType: string;
  fov: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  spinX: number;
  spinY: number;
  spinZ: number;
  spinAround?: string;
}
export interface LightP {
  lightAzimuth: number;
  lightElevation: number;
  ambient: number;
  specular: number;
  gloss: number;
  cel: boolean;
  celSteps: number;
}

export const lightVector = (p: Pick<LightP, 'lightAzimuth' | 'lightElevation'>): [number, number, number] => {
  const az = (p.lightAzimuth * Math.PI) / 180;
  const el = (p.lightElevation * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
};

export const isSpinning = (p: Pick<XformP, 'spinX' | 'spinY' | 'spinZ'>): boolean => p.spinX !== 0 || p.spinY !== 0 || p.spinZ !== 0;

/** The wired camera, or the equivalent of the simple built-in one. */
export function resolveCamera(p: XformP, wired: CameraValue | null, width: number, height: number): CameraValue {
  return wired ?? simpleCamera({ ortho: p.cameraType === 'orthographic', fovDeg: p.fov, frameSize: p.scale, x: p.x, y: p.y, width, height });
}

/** Camera uniforms read by RAY_WGSL (and by `pixAt`). `pixK` = world size of one pixel (per unit distance, except orthographic). */
export function cameraUniforms(cam: CameraValue, width: number, height: number): Record<string, UniformValue> {
  const b = cameraBasis(cam);
  const short = Math.min(width, height);
  const fovTan = Math.tan((Math.min(cam.projection === 'fisheye' ? 359 : 179, Math.max(1, cam.fov)) * Math.PI) / 360);
  const fovRad = (Math.min(360, Math.max(1, cam.fov)) * Math.PI) / 180;
  const orthoHalf = Math.max(0.001, cam.orthoSize) / 2;
  const pixK =
    cam.projection === 'orthographic' ? (2 * orthoHalf) / short : cam.projection === 'perspective' ? (2 * fovTan) / short : cam.projection === 'fisheye' ? fovRad / short : (2 * Math.PI) / width;
  return {
    proj: PROJECTION_ID[cam.projection] ?? 1,
    camPos: b.position,
    camRight: b.right,
    camUp: b.up,
    camFwd: b.forward,
    fovTan,
    fovRad,
    orthoHalf,
    shift: cam.shift,
    pixK,
  };
}

/** Ray for frame coordinates: `uf` in short-side units (y up), `ff` the full frame -1..1 (y up). Identical to the one 3D Object always had. */
export const RAY_WGSL = /* wgsl */ `
fn makeRay(uf: vec2f, ff: vec2f, ro: ptr<function, vec3f>, rd: ptr<function, vec3f>) -> bool {
  let proj = i32(u.proj);
  *ro = u.camPos;
  if (proj == 0) {
    *ro = u.camPos + u.camRight * (uf.x * u.orthoHalf) + u.camUp * (uf.y * u.orthoHalf);
    *rd = u.camFwd;
  } else if (proj == 1) {
    *rd = normalize(u.camFwd + u.camRight * (uf.x * u.fovTan) + u.camUp * (uf.y * u.fovTan));
  } else if (proj == 2) {
    let r = length(uf);
    if (r > 1.0) { return false; }
    let th = r * u.fovRad * 0.5;
    let dir2 = select(vec2f(0.0), uf / r, r > 1e-6);
    *rd = u.camFwd * cos(th) + (u.camRight * dir2.x + u.camUp * dir2.y) * sin(th);
  } else if (proj == 3) {
    let lon = ff.x * PI;
    let lat = ff.y * PI * 0.5;
    *rd = u.camFwd * (cos(lat) * cos(lon)) + u.camRight * (cos(lat) * sin(lon)) + u.camUp * sin(lat);
  } else {
    let lon = ff.x * PI;
    *rd = normalize(u.camFwd * cos(lon) + u.camRight * sin(lon) + u.camUp * (ff.y * tan(clamp(u.fovRad * 0.5, 0.01, 1.5))));
  }
  return true;
}
`;

/** Frame coordinates for an output texel centre -> ray (used by the raymarched members). */
export const FRAME_WGSL = /* wgsl */ `
fn rayAt(px: vec2f, ro: ptr<function, vec3f>, rd: ptr<function, vec3f>) -> bool {
  let short = min(u.size.x, u.size.y);
  let c = u.size * 0.5;
  let p = vec2f(px.x - c.x, -(px.y - c.y));
  let uf = p / (short * 0.5) - u.shift * 2.0;
  let ff = vec2f(p.x / c.x, p.y / c.y) - vec2f(u.shift.x * 2.0 * short / u.size.x, u.shift.y * 2.0 * short / u.size.y);
  return makeRay(uf, ff, ro, rd);
}
fn pixAt(t: f32) -> f32 { return select(u.pixK * t, u.pixK, u.proj < 0.5); }
`;

export interface Shader3dParts {
  /** Defines `fn map(p: vec3f) -> f32` (world space signed distance; a lower bound) and anything it needs. */
  map: string;
  /** Defines `fn surf(p: vec3f, n: vec3f, rd: vec3f) -> vec3f`: base colour of the surface at a hit (sRGB 0..1). */
  surf: string;
  /** Defines `fn bounds(ro: vec3f, rd: vec3f) -> vec2f`: ray entry and exit of a bounding volume (exit < entry = miss). */
  bounds: string;
  /** Soft shadows compiled in (structure). */
  shadows: boolean;
  /** The ground shadow is compiled in (structure; needs `groundUniforms`). */
  ground?: boolean;
  /** Replaces the default lighting: defines `fn shadeSurf(base, n, rd, ao, sh, p in world space) -> vec4f` (rgb + alpha). `gScr` = screen uv of the ray. */
  shade?: string;
}

/** Uniforms every march shader reads. */
export function marchUniforms(o: {
  light: readonly number[];
  p: LightP & { rim?: number; ao?: number };
  quality: string;
  stepScale: number;
  alpha?: number;
  /** Smallest distance used to estimate normals (scene units): raise it to hide the lattice of a sampled field. */
  nEps?: number;
  /** Anti-aliasing plan (`aaPlan`); absent = what the node always did. */
  aaPlan?: { samples: number; edges: boolean };
}): Record<string, UniformValue> {
  const plan = o.aaPlan ?? aaPlan('edges', o.quality, false);
  return {
    light: [...o.light],
    ambient: o.p.ambient,
    spec: o.p.specular,
    gloss: o.p.gloss,
    cel: o.p.cel,
    steps: Math.max(2, Math.round(o.p.celSteps)),
    rim: o.p.rim ?? 0,
    aoAmt: o.p.ao ?? 0,
    stepScale: o.stepScale,
    maxSteps: o.quality === 'draft' ? 56 : o.quality === 'high' ? 128 : 88,
    aa: plan.samples,
    edgeAA: plan.edges ? 1 : 0,
    depthMode: 0,
    alpha: o.alpha ?? 1,
    nEps: o.nEps ?? 0,
  };
}

export const DEFAULT_SHADE_WGSL = /* wgsl */ `
fn shadeSurf(base: vec3f, n: vec3f, rd: vec3f, ao: f32, sh: f32, p: vec3f) -> vec4f {
  let L = normalize(u.light);
  let diff = max(dot(n, L), 0.0) * sh;
  let H = normalize(L - rd);
  var s = pow(max(dot(n, H), 0.0), u.gloss) * select(1.0, 0.0, diff <= 0.0);
  var lit = diff;
  if (u.cel > 0.5) {
    let st = u.steps;
    lit = min(floor(diff * st), st - 1.0) / (st - 1.0);
    s = step(0.55, s);
  }
  let rimv = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 3.0) * u.rim;
  var col = base * (u.ambient * ao + (1.0 - u.ambient) * lit) + vec3f(u.spec * s * sh);
  col += mix(base, vec3f(1.0), 0.6) * rimv;
  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

/** The full `wgsl` of a pass for a raymarched member of the family. */
export function build3dShader(parts: Shader3dParts): string {
  return /* wgsl */ `
${RAY_WGSL}
${FRAME_WGSL}
${parts.map}
${parts.bounds}
${parts.surf}
${parts.shade ?? DEFAULT_SHADE_WGSL}

fn calcNormal(p: vec3f, e0: f32) -> vec3f {
  let e = vec2f(1.0, -1.0) * e0;
  return normalize(e.xyy * map(p + e.xyy) + e.yyx * map(p + e.yyx) + e.yxy * map(p + e.yxy) + e.xxx * map(p + e.xxx));
}

// ambient occlusion from the distance function: 5 reads along the normal
fn calcAO(p: vec3f, n: vec3f, scl: f32) -> f32 {
  var occ = 0.0;
  var sca = 1.0;
  for (var i = 0; i < 5; i++) {
    let h = scl * (0.02 + 0.12 * f32(i) / 4.0);
    occ += (h - map(p + n * h)) * sca;
    sca *= 0.9;
  }
  return clamp(1.0 - 2.0 * occ / scl, 0.0, 1.0);
}

${parts.ground ? GROUND_WGSL : ''}

${
  parts.shadows
    ? `fn softShadow(ro: vec3f, rd: vec3f, tmax: f32, scl: f32) -> f32 {
  var res = 1.0;
  var t = 0.04 * scl;
  for (var i = 0; i < 24; i++) {
    let h = map(ro + rd * t);
    res = min(res, 8.0 * h / t);
    t += clamp(h, 0.01 * scl, 0.4 * scl);
    if (res < 0.003 || t > tmax) { break; }
  }
  res = clamp(res, 0.0, 1.0);
  return res * res * (3.0 - 2.0 * res);
}`
    : ''
}

struct Mr { t: f32, hit: f32, cone: f32, tc: f32 };

fn march(ro: vec3f, rd: vec3f, t0: f32, t1: f32) -> Mr {
  var t = t0;
  var minC = 1e9;
  var tc = t0;
  var hit = 0.0;
  let nmax = i32(u.maxSteps);
  for (var i = 0; i < 160; i++) {
    if (i >= nmax) { break; }
    let h = map(ro + rd * t);
    let pw = pixAt(t);
    let c = h / pw;
    if (c < minC) { minC = c; tc = t; }
    if (c < 0.25) { hit = 1.0; break; }
    t += h * u.stepScale;
    if (t > t1) { break; }
  }
  // a ray that skimmed the surface and ran out of steps counts as a hit
  if (hit < 0.5 && t <= t1 && minC < 0.5) { hit = 1.0; t = tc; }
  return Mr(t, hit, minC, tc);
}

var<private> gScr: vec2f;

fn colourAt(ro: vec3f, rd: vec3f, t: f32) -> vec4f {
  let p = ro + rd * t;
  let pw = pixAt(t);
  let n = calcNormal(p, max(pw * 0.6, max(u.nEps, 1e-5)));
  let base = surf(p, n, rd);
  let scl = max(8.0 * pw, 0.05);
  var ao = 1.0;
  if (u.aoAmt > 0.001) { ao = mix(1.0, calcAO(p, n, scl), u.aoAmt); }
  var sh = 1.0;
  ${parts.shadows ? 'sh = softShadow(p + n * 2.0 * pw, normalize(u.light), 4.0, max(pw * 40.0, 0.2));' : ''}
  return shadeSurf(base, n, rd, ao, sh, p);
}

// straight colour in rgb, coverage in a, hit distance in w of the second result
fn sampleAt(px: vec2f, tOut: ptr<function, f32>) -> vec4f {
  var ro = vec3f(0.0);
  var rd = vec3f(0.0, 0.0, 1.0);
  *tOut = 0.0;
  gScr = px / u.size;
  if (!rayAt(px, &ro, &rd)) { return vec4f(0.0); }
  ${parts.ground ? 'var gnd = 0.0;\n  if (u.depthMode < 0.5) { gnd = groundAlpha(ro, rd); }' : ''}
  let b = bounds(ro, rd);
  if (b.y < b.x || b.y < 0.0) { return ${parts.ground ? 'vec4f(0.0, 0.0, 0.0, gnd)' : 'vec4f(0.0)'}; }
  let m = march(ro, rd, max(b.x, 0.0), b.y);
  if (m.hit > 0.5) {
    *tOut = m.t;
    if (u.depthMode > 0.5) { return vec4f(0.0, 0.0, 0.0, 1.0); }
    let c = colourAt(ro, rd, m.t);
    return vec4f(c.rgb, c.a);
  }
  // near miss: partial coverage, coloured from the closest approach
  let cov = clamp(0.5 - m.cone, 0.0, 0.5);
  if (cov < 0.02 || u.depthMode > 0.5 || u.edgeAA < 0.5) { return ${parts.ground ? 'vec4f(0.0, 0.0, 0.0, gnd)' : 'vec4f(0.0)'}; }
  let c = colourAt(ro, rd, m.tc);
  ${
    parts.ground
      ? `let oa = cov * c.a;
  let ta = oa + gnd * (1.0 - oa);
  return vec4f(c.rgb * oa / max(ta, 1e-5), ta);`
      : 'return vec4f(c.rgb, cov * c.a);'
  }
}

// a sample that shows the object (a ground shadow sample is black, so it never lends its colour to a toon edge)
fn solid(s: vec4f) -> bool {
  return s.a > 0.5${parts.ground ? ' && (s.r + s.g + s.b) > 0.0' : ''};
}

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var t = 0.0;
  if (u.depthMode > 0.5) {
    let s = sampleAt(px, &t);
    return vec4f(t, t, t, s.a);
  }
  if (u.aa < 1.5) {
    let s = sampleAt(px, &t);
    let a = s.a * u.alpha;
    return vec4f(s.rgb * a, a);
  }
  if (u.aa < 3.0) {
    // 2x: a tilted pair of sub-pixel rays
    let r0 = sampleAt(px + vec2f(-0.125, -0.375), &t);
    let r1 = sampleAt(px + vec2f(0.125, 0.375), &t);
    let sum2 = r0.a + r1.a;
    if (sum2 < 0.01) { return vec4f(0.0); }
    var col2 = (r0.rgb * r0.a + r1.rgb * r1.a) / sum2;
    if (u.cel > 0.5) { col2 = select(r1.rgb, r0.rgb, solid(r0)); }
    let a2 = min(sum2 * 0.5, 1.0) * u.alpha;
    return vec4f(col2 * a2, a2);
  }
  let s0 = sampleAt(px + vec2f(-0.375, -0.125), &t);
  let s1 = sampleAt(px + vec2f(0.125, -0.375), &t);
  let s2 = sampleAt(px + vec2f(0.375, 0.125), &t);
  let s3 = sampleAt(px + vec2f(-0.125, 0.375), &t);
  let sum = s0.a + s1.a + s2.a + s3.a;
  if (sum < 0.01) { return vec4f(0.0); }
  var col = (s0.rgb * s0.a + s1.rgb * s1.a + s2.rgb * s2.a + s3.rgb * s3.a) / sum;
  if (u.cel > 0.5) { col = select(select(select(s3.rgb, s2.rgb, solid(s2)), s1.rgb, solid(s1)), s0.rgb, solid(s0)); }
  let a = min(sum * 0.25, 1.0) * u.alpha;
  return vec4f(col * a, a);
}
`;
}

const UPSCALE_WGSL = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  return textureSampleLevel(src, smp, uv, 0.0);
}`;

export interface Run3d {
  wgsl: string;
  uniforms: Record<string, UniformValue>;
  textures: Record<string, ImageValue | { texture: GPUTexture } | null>;
  size: { width: number; height: number; unit?: number };
  quality: string;
  label: string;
  wantDepth: boolean;
}

/**
 * Run a march shader: colour at full or half resolution (Draft), then the optional depth pass. Returns the finished images.
 * The draft pass is bilinearly enlarged by a tiny second pass; the temporary half-size picture is recycled at once.
 */
export function run3d(gpu: NodeGpu, r: Run3d): { image: ImageValue; depth: ImageValue | null } {
  const { width, height } = r.size;
  const draft = r.quality === 'draft' && width > 8 && height > 8;
  let image: ImageValue;
  if (draft) {
    const lw = Math.max(1, Math.round(width / 2));
    const lh = Math.max(1, Math.round(height / 2));
    const low = gpu.pass({ label: r.label, size: { width: lw, height: lh, unit: r.size.unit }, uniforms: r.uniforms, textures: r.textures, wgsl: r.wgsl });
    image = gpu.pass({ label: `${r.label} upscale`, size: r.size, textures: { src: low }, wgsl: UPSCALE_WGSL });
    gpu.recycle(low);
  } else {
    image = gpu.pass({ label: r.label, size: r.size, uniforms: r.uniforms, textures: r.textures, wgsl: r.wgsl });
  }
  let depth: ImageValue | null = null;
  if (r.wantDepth) {
    depth = gpu.pass({ label: `${r.label} depth`, size: r.size, uniforms: { ...r.uniforms, depthMode: 1, aa: 1 }, textures: r.textures, wgsl: r.wgsl, format: 'rgba16float' });
  }
  return { image, depth };
}

/** Ray / axis-aligned box (in a local frame given by the three rows) -> (entry, exit); WGSL helper source. */
export const BOX_BOUNDS_WGSL = /* wgsl */ `
fn boxSpan(ro: vec3f, rd: vec3f, h: vec3f) -> vec2f {
  let inv = 1.0 / select(rd, vec3f(1e-6), abs(rd) < vec3f(1e-6));
  let t1 = (-h - ro) * inv;
  let t2 = (h - ro) * inv;
  let tn = min(t1, t2);
  let tf = max(t1, t2);
  return vec2f(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
}
fn sphereSpan(ro: vec3f, rd: vec3f, c: vec3f, r: f32) -> vec2f {
  let bc = c - ro;
  let tca = dot(bc, rd);
  let d2 = dot(bc, bc) - tca * tca;
  if (d2 > r * r) { return vec2f(1.0, -1.0); }
  let thc = sqrt(r * r - d2);
  return vec2f(tca - thc, tca + thc);
}
`;

/** Throws a readable error for a frame the march cannot handle. */
export function checkFrame(gpu: NodeGpu, w: number, h: number): void {
  const max = gpu.device.limits.maxTextureDimension2D;
  if (w > max || h > max) throw new Error(`The output (${w}x${h}) is larger than this graphics card allows (${max}).`);
}
