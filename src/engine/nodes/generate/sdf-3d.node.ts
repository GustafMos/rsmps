import { defineNode } from '../../define';
import { rotationZYX } from '../../lib/gen-common';
import { BOX_BOUNDS_WGSL, build3dShader, cameraUniforms, checkFrame, isSpinning, LIGHT_PARAMS, lightVector, marchUniforms, QUALITY_PARAM, resolveCamera, run3d, SHADE_PARAMS, XFORM_PARAMS, type LightP, type XformP } from '../../lib/gen-3d';
import { DEFORM_PARAMS, deformAnimated, deformFeatures, deformGrow, deformKey, deformStepScale, deformUniforms, deformWgsl, type DeformP } from '../../lib/gen-deform';
import { gridFor, occupancy, SDF2D_WGSL, signedField } from '../../lib/gen-sdf2d';
import { materialKey, materialTextures, materialUniforms, materialWgsl } from '../../lib/gen-material';
import type { ColorValue, ParamSchema } from '../../types';

/**
 * SDF 3D. A small scene of up to 8 primitives, combined with union / subtract / intersect and smooth blends, sphere-traced in one
 * fragment pass. The shader is GENERATED for exactly the shapes in use and the features switched on (structure = the WGSL text),
 * numbers (positions, sizes, colours, blend amounts) are uniforms, so dragging a slider never compiles anything.
 *
 * Parameters: the scene is eight FIXED SLOTS (`shape1..shape8`; a slot set to "Off" costs nothing). A repeated param group or an
 * "Add shape" button would need a custom inspector (the audio timeline's JSON param has one; this does not), which is out of
 * scope here, so the slots are plain typed params and every number is a socket as usual.
 */

const SLOTS = 8;
const TYPES = ['off', 'sphere', 'box', 'rbox', 'torus', 'capsule', 'cylinder', 'cone', 'plane', 'octa', 'image2d'] as const;
type Type = (typeof TYPES)[number];
const OPS = ['union', 'subtract', 'intersect'] as const;

const slotParams: ParamSchema = {};
for (let i = 1; i <= SLOTS; i++) {
  const g = `Shape ${i}`;
  const on = (p: Record<string, unknown>) => p[`shape${i}`] !== 'off';
  const defs: Record<number, { t: Type; x: number; col: ColorValue; sm: number; size: number }> = {
    1: { t: 'sphere', x: -0.5, col: [0.3, 0.55, 1, 1], sm: 0.4, size: 0.55 },
    2: { t: 'sphere', x: 0.55, col: [1, 0.45, 0.6, 1], sm: 0.5, size: 0.5 },
  };
  const d = defs[i] ?? { t: 'off' as Type, x: 0, col: [0.9, 0.9, 0.9, 1] as ColorValue, sm: 0.3, size: 0.5 };
  slotParams[`shape${i}`] = {
    type: 'enum',
    default: d.t,
    label: `Shape ${i}`,
    group: g,
    options: [
      { value: 'off', label: 'Off' },
      { value: 'sphere', label: 'Sphere' },
      { value: 'box', label: 'Box' },
      { value: 'rbox', label: 'Rounded box' },
      { value: 'torus', label: 'Torus' },
      { value: 'capsule', label: 'Capsule' },
      { value: 'cylinder', label: 'Cylinder' },
      { value: 'cone', label: 'Cone' },
      { value: 'plane', label: 'Plane' },
      { value: 'octa', label: 'Octahedron' },
      { value: 'image2d', label: '2D picture' },
    ],
  };
  if (i > 1) {
    slotParams[`op${i}`] = {
      type: 'enum',
      default: 'union',
      label: 'Combine', hint: 'How this shape combines with the shapes before it.',
      group: g,
      visibleIf: on,
      options: [
        { value: 'union', label: 'Union' },
        { value: 'subtract', label: 'Subtract' },
        { value: 'intersect', label: 'Intersect' },
      ],
    };
    slotParams[`smooth${i}`] = { type: 'number', default: d.sm, min: 0, max: 3, step: 0.01, label: 'Smoothness', group: g, hint: 'Blend radius with the shapes before. Colors blend too. Scaled by Gooeyness.', visibleIf: on };
  }
  slotParams[`x${i}`] = { type: 'number', default: d.x, min: -10, max: 10, step: 0.01, label: 'Position X', group: g, visibleIf: on };
  slotParams[`y${i}`] = { type: 'number', default: 0, min: -10, max: 10, step: 0.01, label: 'Position Y', group: g, visibleIf: on };
  slotParams[`z${i}`] = { type: 'number', default: 0, min: -10, max: 10, step: 0.01, label: 'Position Z', group: g, visibleIf: on };
  slotParams[`rx${i}`] = { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate X', group: g, visibleIf: (p) => on(p) && p[`shape${i}`] !== 'sphere' };
  slotParams[`ry${i}`] = { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate Y', group: g, visibleIf: (p) => on(p) && p[`shape${i}`] !== 'sphere' };
  slotParams[`rz${i}`] = { type: 'number', default: 0, min: -360, max: 360, step: 1, unit: 'deg', label: 'Rotate Z', group: g, visibleIf: (p) => on(p) && p[`shape${i}`] !== 'sphere' };
  slotParams[`size${i}`] = { type: 'number', default: d.size, min: 0.01, max: 10, step: 0.01, label: 'Size', group: g, hint: 'Radius (sphere, torus ring, capsule, cylinder, cone), half width (box), half long side (picture).', visibleIf: (p) => on(p) && p[`shape${i}`] !== 'plane' };
  slotParams[`sizeB${i}`] = { type: 'number', default: 0.5, min: 0.01, max: 10, step: 0.01, label: 'Size B', group: g, hint: 'Half height (box, cylinder, cone, capsule), tube radius (torus), half depth (picture).', visibleIf: (p) => ['box', 'rbox', 'torus', 'capsule', 'cylinder', 'cone', 'image2d'].includes(p[`shape${i}`] as string) };
  slotParams[`sizeC${i}`] = { type: 'number', default: 0.5, min: 0.01, max: 10, step: 0.01, label: 'Size C', group: g, hint: 'Half depth (box).', visibleIf: (p) => p[`shape${i}`] === 'box' || p[`shape${i}`] === 'rbox' };
  slotParams[`color${i}`] = { type: 'color', default: d.col, label: 'Color', group: g, visibleIf: on };
}

interface Slot {
  type: Type;
  op: (typeof OPS)[number];
  smooth: number;
  pos: [number, number, number];
  rot: [number, number, number];
  size: [number, number, number];
  color: ColorValue;
}

interface P extends XformP, LightP, DeformP {
  gooey: number;
  morph: boolean;
  morphAmount: number;
  repeatX: boolean;
  repeatY: boolean;
  repeatZ: boolean;
  repeatSpacing: number;
  mirrorX: boolean;
  mirrorY: boolean;
  mirrorZ: boolean;
  fold: number;
  shell: number;
  shape2dFrom: 'alpha' | 'brightness';
  shape2dThreshold: number;
  textureScale: number;
  textureMix: number;
  rim: number;
  ao: number;
  shadows: boolean;
  quality: string;
  [k: string]: unknown;
}

const SD_FUNCS: Record<string, string> = {
  sphere: 'fn sdSphere(q: vec3f, s: vec4f) -> f32 { return length(q) - s.x; }',
  box: 'fn sdBoxS(q: vec3f, s: vec4f) -> f32 { let d = abs(q) - s.xyz; return length(max(d, vec3f(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0); }',
  rbox: 'fn sdRBox(q: vec3f, s: vec4f) -> f32 { let r = 0.25 * min(s.x, min(s.y, s.z)); let d = abs(q) - s.xyz + vec3f(r); return length(max(d, vec3f(0.0))) + min(max(d.x, max(d.y, d.z)), 0.0) - r; }',
  torus: 'fn sdTorus(q: vec3f, s: vec4f) -> f32 { return length(vec2f(length(q.xz) - s.x, q.y)) - s.y; }',
  capsule: 'fn sdCapsule(q: vec3f, s: vec4f) -> f32 { return length(vec3f(q.x, q.y - clamp(q.y, -s.y, s.y), q.z)) - s.x; }',
  cylinder: 'fn sdCyl(q: vec3f, s: vec4f) -> f32 { let d = vec2f(length(q.xz) - s.x, abs(q.y) - s.y); return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0))); }',
  cone: `fn sdConeS(pin: vec3f, s: vec4f) -> f32 {
  let h = 2.0 * s.y;
  let c = normalize(vec2f(s.x, h));
  let p = pin - vec3f(0.0, s.y, 0.0);
  let q = h * vec2f(c.x / c.y, -1.0);
  let w = vec2f(length(p.xz), p.y);
  let a = w - q * clamp(dot(w, q) / dot(q, q), 0.0, 1.0);
  let b = w - q * vec2f(clamp(w.x / q.x, 0.0, 1.0), 1.0);
  let k = sign(q.y);
  let d = min(dot(a, a), dot(b, b));
  let sg = max(k * (w.x * q.y - w.y * q.x), k * (w.y - q.y));
  return sqrt(d) * sign(sg);
}`,
  plane: 'fn sdPlaneS(q: vec3f, s: vec4f) -> f32 { return q.y; }',
  octa: `fn sdOctaS(pin: vec3f, s: vec4f) -> f32 {
  let p = abs(pin);
  let m = p.x + p.y + p.z - s.x;
  var q = vec3f(0.0);
  if (3.0 * p.x < m) { q = p; }
  else if (3.0 * p.y < m) { q = p.yzx; }
  else if (3.0 * p.z < m) { q = p.zxy; }
  else { return m * 0.57735027; }
  let k = clamp(0.5 * (q.z - q.y + s.x), 0.0, s.x);
  return length(vec3f(q.x, q.y - s.x + k, q.z - k));
}`,
  image2d: `fn sdPic(q: vec3f, s: vec4f) -> f32 {
  let pc = vec2f(q.x / (2.0 * u.pic.x * s.x) + 0.5, 0.5 - q.y / (2.0 * u.pic.y * s.x)) * u.grid;
  let w = vec2f(sd2(pc) * u.cellW * s.x, abs(q.z) - s.y);
  return min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0)));
}`,
};
const SD_CALL: Record<string, string> = { sphere: 'sdSphere', box: 'sdBoxS', rbox: 'sdRBox', torus: 'sdTorus', capsule: 'sdCapsule', cylinder: 'sdCyl', cone: 'sdConeS', plane: 'sdPlaneS', octa: 'sdOctaS', image2d: 'sdPic' };

function extent(s: Slot): number {
  const [a, b, c] = s.size;
  switch (s.type) {
    case 'sphere':
    case 'octa':
      return a;
    case 'box':
    case 'rbox':
      return Math.hypot(a, b, c);
    case 'torus':
    case 'capsule':
      return a + b;
    case 'cylinder':
    case 'cone':
      return Math.hypot(a, b);
    case 'image2d':
      return Math.hypot(1.0 * a * 1.42, b);
    default:
      return Infinity;
  }
}

export default defineNode({
  id: 'sdf-3d',
  title: 'SDF 3D',
  category: 'generate',
  description:
    'Build a 3D scene from up to 8 primitives (sphere, box, rounded box, torus, capsule, cylinder, cone, plane, octahedron, or an extruded picture or mask) combined with smooth blends, and render it by sphere tracing in one fast pass. Blobs, metaballs, morphing, endless repeated worlds, twist, bend and noise. The shader is generated for exactly the shapes you use.',
  keywords: ['signed distance', 'sdf', 'raymarch', 'blob', 'metaball', 'smooth union', 'morph', 'primitives', 'repeat', 'kaleidoscope', 'mirror', 'gooey', 'displace 3d', 'melt', 'wobble', 'logo', '3d'],
  inputs: {
    shape2d: { type: 'image', label: '2D shape' },
    texture: { type: 'image', label: 'Texture' },
    displaceMap: { type: 'image', label: 'Displace map' },
    camera: { type: 'camera', label: 'Camera' },
    material: { type: 'material', label: 'Material' },
    size: { type: 'image', label: 'Size from' },
  },
  outputs: { image: { type: 'image', label: 'Image' }, depth: { type: 'image', label: 'Depth' } },
  optionalOutputs: ['depth'],
  params: {
    ...slotParams,
    gooey: { type: 'number', default: 1, min: 0, max: 4, step: 0.01, label: 'Gooeyness', group: 'Blend', hint: 'Scales every smooth blend at once: 0 = hard edges, 1 = as set, higher = more liquid.' },
    morph: { type: 'bool', default: false, label: 'Morph 1 to 2', group: 'Blend', hint: 'Shapes 1 and 2 become the two ends of a morph instead of two parts.' },
    morphAmount: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.005, label: 'Morph amount', hint: 'A to B.', group: 'Blend', visibleIf: (p) => p.morph === true },
    shell: { type: 'number', default: 0, min: 0, max: 1, step: 0.005, label: 'Shell thickness', group: 'Space', hint: 'Hollows the scene into a thin skin of this thickness. 0 = solid.' },
    repeatX: { type: 'bool', default: false, label: 'Repeat along X', group: 'Space', hint: 'Endless copies. Works while the camera moves through them.' },
    repeatY: { type: 'bool', default: false, label: 'Repeat along Y', group: 'Space' },
    repeatZ: { type: 'bool', default: false, label: 'Repeat along Z', group: 'Space' },
    repeatSpacing: { type: 'number', default: 3, min: 0.3, max: 30, step: 0.05, label: 'Repeat spacing', group: 'Space', visibleIf: (p) => p.repeatX === true || p.repeatY === true || p.repeatZ === true },
    mirrorX: { type: 'bool', default: false, label: 'Mirror X', group: 'Space' },
    mirrorY: { type: 'bool', default: false, label: 'Mirror Y', group: 'Space' },
    mirrorZ: { type: 'bool', default: false, label: 'Mirror Z', group: 'Space' },
    fold: { type: 'number', default: 0, min: 0, max: 16, step: 1, integer: true, label: 'Kaleidoscope', group: 'Space', hint: '0 or 1 = off. N copies around the vertical axis.' },
    shape2dFrom: {
      type: 'enum',
      default: 'alpha',
      label: '2D shape from',
      group: '2D shape input',
      hint: 'Used by shapes set to "2D picture". Alpha for logos and cut-outs, brightness for masks.',
      options: [
        { value: 'alpha', label: 'Alpha' },
        { value: 'brightness', label: 'Brightness' },
      ],
    },
    shape2dThreshold: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: '2D shape threshold', group: '2D shape input' },
    textureScale: { type: 'number', default: 0.5, min: 0.05, max: 8, step: 0.01, label: 'Texture scale', group: 'Texture', hint: 'Wire a Texture picture: it is mapped from three sides (triplanar).' },
    textureMix: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Texture amount', group: 'Texture' },
    ...XFORM_PARAMS,
    ...LIGHT_PARAMS,
    ...SHADE_PARAMS,
    ...QUALITY_PARAM,
    ...DEFORM_PARAMS,
  },
  summary: (p) => {
    const n = Array.from({ length: SLOTS }, (_, i) => (p as Record<string, unknown>)[`shape${i + 1}`]).filter((t) => t && t !== 'off').length;
    return `${n} shape${n === 1 ? '' : 's'}${p.cel ? ' · cel' : ''}`;
  },
  render(ctx) {
    const p = ctx.params as unknown as P;
    const size = ctx.in.size ?? ctx.canvas;
    checkFrame(ctx.gpu, size.width, size.height);
    const pic = ctx.in.shape2d;
    const tex = ctx.in.texture;
    const dmap = ctx.in.displaceMap;
    const mat = ctx.in.material;

    // --- the scene description ----------------------------------------------------------------------
    const slots: Slot[] = [];
    for (let i = 1; i <= SLOTS; i++) {
      const type = p[`shape${i}`] as Type;
      if (type === 'off' || (type === 'image2d' && !pic)) continue;
      slots.push({
        type,
        op: (i > 1 ? p[`op${i}`] : 'union') as Slot['op'],
        smooth: i > 1 ? (p[`smooth${i}`] as number) : 0,
        pos: [p[`x${i}`] as number, p[`y${i}`] as number, p[`z${i}`] as number],
        rot: [p[`rx${i}`] as number, p[`ry${i}`] as number, p[`rz${i}`] as number],
        size: [p[`size${i}`] as number, p[`sizeB${i}`] as number, p[`sizeC${i}`] as number],
        color: p[`color${i}`] as ColorValue,
      });
    }
    const morph = p.morph && slots.length >= 2;
    const feat = deformFeatures(p, !!dmap);
    const hasDf = Object.entries(feat).some(([k, v]) => k !== 'cyl' && v);
    const repeat = [p.repeatX, p.repeatY, p.repeatZ];
    const mirror = [p.mirrorX, p.mirrorY, p.mirrorZ];
    const fold = p.fold >= 2;
    const shell = p.shell > 0;
    const usesPic = slots.some((s) => s.type === 'image2d');
    const textured = !!tex && p.textureMix > 0;

    // --- WGSL for exactly this structure -------------------------------------------------------------
    const types = [...new Set(slots.map((s) => s.type))];
    let sceneBody = '';
    slots.forEach((s, j) => {
      const q = `let q${j} = vec3f(dot(u.r${j}0, p - u.a${j}.xyz), dot(u.r${j}1, p - u.a${j}.xyz), dot(u.r${j}2, p - u.a${j}.xyz));
  let s${j} = Sd(${SD_CALL[s.type]}(q${j}, u.b${j}), u.c${j}.rgb);`;
      sceneBody += `\n  ${q}`;
      if (j === 0) sceneBody += `\n  var acc = s${j};`;
      else if (j === 1 && morph) sceneBody += `\n  acc = Sd(mix(acc.d, s${j}.d, u.morphAmt), mix(acc.c, s${j}.c, u.morphAmt));`;
      else sceneBody += `\n  acc = ${s.op === 'union' ? 'opUnion' : s.op === 'subtract' ? 'opSub' : 'opInter'}(acc, s${j}, u.a${j}.w);`;
    });
    const domain: string[] = [];
    if (repeat[0]) domain.push('p.x = p.x - u.repSp * floor(p.x / u.repSp + 0.5);');
    if (repeat[1]) domain.push('p.y = p.y - u.repSp * floor(p.y / u.repSp + 0.5);');
    if (repeat[2]) domain.push('p.z = p.z - u.repSp * floor(p.z / u.repSp + 0.5);');
    if (mirror[0]) domain.push('p.x = abs(p.x);');
    if (mirror[1]) domain.push('p.y = abs(p.y);');
    if (mirror[2]) domain.push('p.z = abs(p.z);');
    if (fold) domain.push(`{ let sec = TAU / u.foldN; let a = atan2(p.z, p.x); let a2 = a - sec * floor(a / sec + 0.5); let r = length(p.xz); p = vec3f(r * cos(a2), p.y, r * sin(a2)); }`);
    const infinite = repeat.some(Boolean) || slots.some((s) => !Number.isFinite(extent(s)));

    const code = build3dShader({
      shadows: p.shadows,
      shade: mat
        ? `${materialWgsl(mat)}
fn shadeSurf(base: vec3f, n: vec3f, rd: vec3f, ao: f32, sh: f32, p: vec3f) -> vec4f {
  let pl = toLocal(p);
  let nl = vec3f(dot(u.t0, n), dot(u.t1, n), dot(u.t2, n));
  return matShade(base, n, rd, ao, sh, pl, nl, gScr);
}`
        : undefined,
      map: /* wgsl */ `
struct Sd { d: f32, c: vec3f };
fn opUnion(a: Sd, b: Sd, k: f32) -> Sd {
  let h = max(k - abs(a.d - b.d), 0.0) / k;
  return Sd(min(a.d, b.d) - h * h * k * 0.25, mix(a.c, b.c, clamp(0.5 + 0.5 * (a.d - b.d) / k, 0.0, 1.0)));
}
fn opSub(a: Sd, b: Sd, k: f32) -> Sd {
  let nb = -b.d;
  let h = max(k - abs(a.d - nb), 0.0) / k;
  return Sd(max(a.d, nb) + h * h * k * 0.25, mix(a.c, b.c, clamp(0.5 + 0.5 * (nb - a.d) / k, 0.0, 1.0)));
}
fn opInter(a: Sd, b: Sd, k: f32) -> Sd {
  let h = max(k - abs(a.d - b.d), 0.0) / k;
  return Sd(max(a.d, b.d) + h * h * k * 0.25, mix(a.c, b.c, clamp(0.5 + 0.5 * (b.d - a.d) / k, 0.0, 1.0)));
}
${usesPic ? SDF2D_WGSL(false) : ''}
${types.map((t) => SD_FUNCS[t]).join('\n')}
${hasDf ? deformWgsl(feat) : 'fn dfPoint(p: vec3f) -> vec3f { return p; }\nfn dfDist(p0: vec3f, p1: vec3f, d: f32) -> f32 { return d; }'}
fn toLocal(pw: vec3f) -> vec3f {
  let q = pw - u.objPos;
  return vec3f(dot(u.t0, q), dot(u.t1, q), dot(u.t2, q)) / u.objScale;
}
fn scene(pin: vec3f) -> Sd {
  var p = pin;
  ${domain.join('\n  ')}
  let p0 = p;
  p = dfPoint(p);
  ${slots.length ? sceneBody : 'var acc = Sd(1000.0, vec3f(0.0));'}
  acc.d = dfDist(p0, p, acc.d);
  ${shell ? 'acc.d = abs(acc.d) - u.shellT;' : ''}
  return acc;
}
fn map(pw: vec3f) -> f32 { return scene(toLocal(pw)).d * u.objScale; }
`,
      bounds: /* wgsl */ `
${BOX_BOUNDS_WGSL}
fn bounds(ro: vec3f, rd: vec3f) -> vec2f {
  ${infinite ? 'return vec2f(0.0, u.farT);' : 'return sphereSpan(ro, rd, u.bsW, u.bsR * u.objScale);'}
}`,
      surf: /* wgsl */ `
fn surf(pw: vec3f, nw: vec3f, rd: vec3f) -> vec3f {
  let pl = toLocal(pw);
  var col = scene(pl).c;
  ${
    textured
      ? `let nl = vec3f(dot(u.t0, nw), dot(u.t1, nw), dot(u.t2, nw));
  let w0 = pow(abs(nl) + vec3f(1e-4), vec3f(4.0));
  let w = w0 / (w0.x + w0.y + w0.z);
  let tp = pl * u.texScale;
  let tc = unpremul(textureSampleLevel(tex, smp, tp.yz + 0.5, 0.0)).rgb * w.x + unpremul(textureSampleLevel(tex, smp, tp.xz + 0.5, 0.0)).rgb * w.y + unpremul(textureSampleLevel(tex, smp, tp.xy + 0.5, 0.0)).rgb * w.z;
  col = col * mix(vec3f(1.0), tc, u.texMix);`
      : ''
  }
  return col;
}`,
    });

    // --- numbers ----------------------------------------------------------------------------------------
    const phase = isSpinning(p) || deformAnimated(p) ? ctx.time.phase : 0;
    const R = rotationZYX(p.rotX + 360 * p.spinX * phase, p.rotY + 360 * p.spinY * phase, p.rotZ + 360 * p.spinZ * phase);
    const cam = resolveCamera(p, ctx.in.camera, size.width, size.height);
    const objScale = Math.max(0.001, p.objectScale);
    const uniforms: Record<string, number | boolean | number[]> = {
      ...cameraUniforms(cam, size.width, size.height),
      ...deformUniforms(p, phase),
      objPos: [p.posX, p.posY, p.posZ],
      objScale,
      t0: [R[0], R[3], R[6]],
      t1: [R[1], R[4], R[7]],
      t2: [R[2], R[5], R[8]],
      morphAmt: p.morphAmount,
      repSp: Math.max(0.05, p.repeatSpacing),
      foldN: Math.max(2, Math.round(p.fold)),
      shellT: p.shell,
      texScale: p.textureScale,
      texMix: p.textureMix,
    };
    let bound = 0;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    // bounding sphere about the centroid of the shapes
    if (slots.length) {
      for (const s of slots) {
        cx += s.pos[0];
        cy += s.pos[1];
        cz += s.pos[2];
      }
      cx /= slots.length;
      cy /= slots.length;
      cz /= slots.length;
      // mirrored and folded copies are spread about the origin, not about the shapes
      if (mirror.some(Boolean) || fold) cx = cy = cz = 0;
      for (const s of slots) bound = Math.max(bound, Math.hypot(s.pos[0] - cx, s.pos[1] - cy, s.pos[2] - cz) + extent(s) + s.smooth * p.gooey * 0.5);
      bound = (bound + (shell ? p.shell : 0) + deformGrow(p)) * 1.02;
    }
    uniforms.bsW = [p.posX + (R[0] * cx + R[1] * cy + R[2] * cz) * objScale, p.posY + (R[3] * cx + R[4] * cy + R[5] * cz) * objScale, p.posZ + (R[6] * cx + R[7] * cy + R[8] * cz) * objScale];
    uniforms.bsR = bound;
    uniforms.farT = 80;
    slots.forEach((s, j) => {
      const Rs = rotationZYX(s.rot[0], s.rot[1], s.rot[2]);
      uniforms[`a${j}`] = [s.pos[0], s.pos[1], s.pos[2], Math.max(1e-4, s.smooth * p.gooey)];
      uniforms[`b${j}`] = [s.size[0], s.size[1], s.size[2], 0];
      uniforms[`c${j}`] = [s.color[0], s.color[1], s.color[2], 1];
      uniforms[`r${j}0`] = [Rs[0], Rs[3], Rs[6]];
      uniforms[`r${j}1`] = [Rs[1], Rs[4], Rs[7]];
      uniforms[`r${j}2`] = [Rs[2], Rs[5], Rs[8]];
    });

    // the 2D shape input: a small signed field (jump flooding), made once per render
    let occ = null as ReturnType<typeof occupancy> | null;
    let fld = null as ReturnType<typeof signedField> | null;
    if (usesPic && pic) {
      const grid = gridFor(pic, 0, 192);
      occ = occupancy(ctx.gpu, pic, grid, { threshold: Math.max(0.001, p.shape2dThreshold), fromBrightness: p.shape2dFrom === 'brightness', nearest: false });
      fld = signedField(ctx.gpu, occ, true);
      const long = Math.max(pic.width, pic.height);
      uniforms.grid = [grid.gw, grid.gh];
      uniforms.cellW = 2 / Math.max(grid.gw, grid.gh);
      uniforms.pic = [pic.width / long, pic.height / long];
    }

    const reps = repeat.filter(Boolean).length;
    const stepScale = Math.min(deformStepScale(p), 0.9) * (reps ? 0.8 : 1) * (usesPic ? 0.9 : 1) * (fold ? 0.8 : 1);
    Object.assign(uniforms, marchUniforms({ light: lightVector(p), p, quality: p.quality, stepScale, nEps: usesPic ? 0.01 : 0 }));

    const key = `sdf-3d ${slots.map((s) => s.type[0] + s.type[1] + s.op[0]).join('')}${morph ? ' morph' : ''} r${repeat.map(Number).join('')} m${mirror.map(Number).join('')}${fold ? ' fold' : ''}${shell ? ' shell' : ''}${textured ? ' tex' : ''} ${deformKey(feat)} ${materialKey(mat)}`;
    if (mat) Object.assign(uniforms, materialUniforms(mat));
    const out = run3d(ctx.gpu, {
      label: key,
      wgsl: code,
      uniforms,
      textures: { tex: textured ? tex : null, fld, dmap: feat.map ? dmap : null, ...(mat ? materialTextures(mat) : {}) },
      size,
      quality: p.quality,
      wantDepth: ctx.wants('depth'),
    });
    if (fld) ctx.gpu.recycle(fld);
    if (occ) ctx.gpu.recycle(occ);
    return { image: out.image, depth: out.depth };
  },
});
