/**
 * The SDF Scene renderer: ONE sphere-tracing pass for a whole `SdfValue`, built on the same march, camera, light, material, depth and
 * edge anti-aliasing code as SDF 3D (lib/gen-3d.ts, lib/sdf-prims.ts).
 *
 * The shader is generated from the tree's STRUCTURE (lib/sdf-scene.ts `sdfStructure`): which shapes, which operators, which modifiers. Every
 * number is read from `u.q0 .. u.qN`, the vec4 slots of `packSdf` in pre-order, so animating or dragging anything compiles nothing.
 * The scene's own Move / Rotate / Size are NOT in the tree here: like SDF 3D they are the object frame (`objPos`, `objScale`, `t0..t2`),
 * which keeps materials and the bounding sphere in the object's own frame. The `sdf` output of the SDF Scene node wraps the same
 * transform around the tree (`sceneMove`), so a scene wired into another carries it.
 */
import { applyCameraLight, BOX_BOUNDS_WGSL, build3dShader, cameraUniforms, checkFrame, groundOn, groundUniforms, lightVector, marchUniforms, resolveCamera, run3d, type GroundP, type LightP, type XformP } from './gen-3d';
import { spunRotation } from './gen-common';
import { materialKey, materialShadowFactor, materialTextures, materialUniforms } from './gen-material';
import { SDF2D_WGSL } from './gen-sdf2d';
import { materialShadeWgsl, preparePicture, SD_CALL, SD_FUNCS, SD_OPS_WGSL, TO_LOCAL_WGSL } from './sdf-prims';
import { checkSdfSize, packSdf, repeatAxes, sdfBounds, sdfMove, sdfStepScale, sdfStructure, sdfUsesPicture, slotsOf } from './sdf-scene';
import type { CameraValue, ImageValue, MaterialValue, NodeGpu, SdfNode, SdfValue, UniformValue } from '../types';

const AXIS = ['x', 'y', 'z'] as const;

const NOISE_WGSL = /* wgsl */ `
fn sdHash3(p: vec3f) -> f32 {
  var q = fract(p * 0.3183099 + vec3f(0.1, 0.2, 0.3));
  q = q * 17.0;
  return fract(q.x * q.y * q.z * (q.x + q.y + q.z));
}
fn sdfNoise(x: vec3f) -> f32 {
  let i = floor(x);
  let f = fract(x);
  let w = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(sdHash3(i), sdHash3(i + vec3f(1.0, 0.0, 0.0)), w.x), mix(sdHash3(i + vec3f(0.0, 1.0, 0.0)), sdHash3(i + vec3f(1.0, 1.0, 0.0)), w.x), w.y);
  let b = mix(mix(sdHash3(i + vec3f(0.0, 0.0, 1.0)), sdHash3(i + vec3f(1.0, 0.0, 1.0)), w.x), mix(sdHash3(i + vec3f(0.0, 1.0, 1.0)), sdHash3(i + vec3f(1.0, 1.0, 1.0)), w.x), w.y);
  return mix(a, b, w.z) * 2.0 - 1.0;
}
`;

/** WGSL of `fn scene(pin: vec3f) -> Sd` for this tree (pure function of its structure). */
export function sdfSceneFn(root: SdfNode | null): string {
  if (!root) return 'fn scene(pin: vec3f) -> Sd { return Sd(1000.0, vec3f(0.0)); }';
  const lines: string[] = [];
  let slot = 0;
  let counter = 0;
  const emit = (node: SdfNode, P: string): string => {
    const id = counter++;
    const o = slot;
    slot += slotsOf(node);
    const q = (k: number) => `u.q${o + k}`;
    switch (node.t) {
      case 'shape': {
        lines.push(`let l${id} = vec3f(dot(${q(3)}.xyz, ${P} - ${q(0)}.xyz), dot(${q(4)}.xyz, ${P} - ${q(0)}.xyz), dot(${q(5)}.xyz, ${P} - ${q(0)}.xyz)) / ${q(0)}.w;`);
        lines.push(`let r${id} = Sd(${SD_CALL[node.shape]}(l${id}, ${q(1)}) * ${q(0)}.w, ${q(2)}.xyz);`);
        return `r${id}`;
      }
      case 'combine': {
        const kids = node.children.map((c) => emit(c, P));
        if (!kids.length) {
          lines.push(`let r${id} = Sd(1000.0, vec3f(0.0));`);
          return `r${id}`;
        }
        if (kids.length === 1) return kids[0];
        const op = node.op === 'union' ? 'opUnion' : node.op === 'subtract' ? 'opSub' : 'opInter';
        lines.push(`var r${id} = ${kids[0]};`);
        for (let i = 1; i < kids.length; i++) lines.push(`r${id} = ${op}(r${id}, ${kids[i]}, max(${q(0)}.x, 1e-4));`);
        return `r${id}`;
      }
      case 'move': {
        lines.push(`let m${id} = vec3f(dot(${q(1)}.xyz, ${P} - ${q(0)}.xyz), dot(${q(2)}.xyz, ${P} - ${q(0)}.xyz), dot(${q(3)}.xyz, ${P} - ${q(0)}.xyz)) / ${q(0)}.w;`);
        const kid = emit(node.child, `m${id}`);
        lines.push(`var r${id} = ${kid};`, `r${id}.d = r${id}.d * ${q(0)}.w;`);
        return `r${id}`;
      }
      case 'mod': {
        let Pc = P;
        switch (node.mod) {
          case 'mirror': {
            const flags = node.axes.map((a, i) => (a ? `m${id}.${AXIS[i]} = abs(m${id}.${AXIS[i]});` : ''));
            lines.push(`var m${id} = ${P};`, ...flags.filter(Boolean));
            Pc = `m${id}`;
            break;
          }
          case 'repeat': {
            lines.push(`var m${id} = ${P};`);
            repeatAxes(node).forEach((on, i) => {
              if (!on) return;
              const c = AXIS[i];
              const n = `${q(0)}.${c}`;
              const sp = `${q(1)}.${c}`;
              lines.push(`m${id}.${c} = m${id}.${c} - ${sp} * (clamp(floor(m${id}.${c} / ${sp} + (${n} - 1.0) * 0.5 + 0.5), 0.0, ${n} - 1.0) - (${n} - 1.0) * 0.5);`);
            });
            Pc = `m${id}`;
            break;
          }
          case 'twist':
          case 'bend': {
            const a = AXIS[node.axis];
            const b = AXIS[(node.axis + 1) % 3];
            const c = AXIS[(node.axis + 2) % 3];
            lines.push(`let ang${id} = ${q(0)}.x * ${P}.${a};`, `let cs${id} = cos(ang${id});`, `let sn${id} = sin(ang${id});`, `var m${id} = ${P};`);
            // twist turns the plane across the axis, bend turns the plane that holds the axis
            if (node.mod === 'twist') lines.push(`m${id}.${b} = cs${id} * ${P}.${b} - sn${id} * ${P}.${c};`, `m${id}.${c} = sn${id} * ${P}.${b} + cs${id} * ${P}.${c};`);
            else lines.push(`m${id}.${a} = cs${id} * ${P}.${a} - sn${id} * ${P}.${b};`, `m${id}.${b} = sn${id} * ${P}.${a} + cs${id} * ${P}.${b};`);
            Pc = `m${id}`;
            break;
          }
        }
        const kid = emit(node.child, Pc);
        if (node.mod === 'round') lines.push(`var r${id} = ${kid};`, `r${id}.d = r${id}.d - ${q(0)}.x;`);
        else if (node.mod === 'shell') lines.push(`var r${id} = ${kid};`, `r${id}.d = abs(r${id}.d) - ${q(0)}.x;`);
        else if (node.mod === 'displace') lines.push(`var r${id} = ${kid};`, `r${id}.d = r${id}.d + ${q(0)}.x * sdfNoise(${P} * ${q(0)}.y + vec3f(cos(${q(0)}.z), sin(${q(0)}.z), 0.0) * 1.7);`);
        else return kid;
        return `r${id}`;
      }
    }
  };
  const out = emit(root, 'pin');
  return `fn scene(pin: vec3f) -> Sd {\n  ${lines.join('\n  ')}\n  return ${out};\n}`;
}

/** Distinct shape kinds in the tree (their distance functions are the only ones put in the shader). */
function shapeKinds(root: SdfNode | null): string[] {
  const kinds = new Set<string>();
  const go = (n: SdfNode) => {
    if (n.t === 'shape') kinds.add(n.shape);
    else if (n.t === 'combine') n.children.forEach(go);
    else go(n.child);
  };
  if (root) go(root);
  return [...kinds];
}

const hasMod = (root: SdfNode | null, mod: string): boolean => {
  let found = false;
  const go = (n: SdfNode) => {
    if (n.t === 'mod' && n.mod === mod) found = true;
    if (n.t === 'combine') n.children.forEach(go);
    else if (n.t !== 'shape') go(n.child);
  };
  if (root) go(root);
  return found;
};

export interface SdfRenderParams extends XformP, LightP, GroundP {
  rim: number;
  ao: number;
  shadows: boolean;
  quality: string;
  shape2dFrom: 'alpha' | 'brightness';
  shape2dThreshold: number;
}

/** The full WGSL of the tracing pass for a tree (a pure function of its structure and of `material` / `shadows`). */
export function sdfShader(root: SdfNode | null, o: { material: MaterialValue | null; shadows: boolean; infinite: boolean; ground?: boolean }): string {
  const kinds = shapeKinds(root);
  return build3dShader({
    shadows: o.shadows,
    ground: o.ground,
    shade: o.material ? materialShadeWgsl(o.material) : undefined,
    map: /* wgsl */ `
${SD_OPS_WGSL}
${kinds.includes('image2d') ? SDF2D_WGSL(false) : ''}
${kinds.map((k) => SD_FUNCS[k]).join('\n')}
${hasMod(root, 'displace') ? NOISE_WGSL : ''}
${TO_LOCAL_WGSL}
${sdfSceneFn(root)}
fn map(pw: vec3f) -> f32 { return scene(toLocal(pw)).d * u.objScale; }
`,
    bounds: /* wgsl */ `
${BOX_BOUNDS_WGSL}
fn bounds(ro: vec3f, rd: vec3f) -> vec2f {
  ${o.infinite ? 'return vec2f(0.0, u.farT);' : 'return sphereSpan(ro, rd, u.bsW, u.bsR * u.objScale);'}
}`,
    surf: /* wgsl */ `
fn surf(pw: vec3f, nw: vec3f, rd: vec3f) -> vec3f {
  return scene(toLocal(pw)).c;
}`,
  });
}

/**
 * The scene wrapped in its own Move / Rotate / Size: what the SDF Scene node outputs on its `sdf` socket. `matrix` is the (spun) rotation.
 * A scene with nothing in it stays empty.
 */
export function sceneMove(id: string, value: SdfValue, p: Pick<XformP, 'posX' | 'posY' | 'posZ' | 'objectScale' | 'rotX' | 'rotY' | 'rotZ' | 'spinX' | 'spinY' | 'spinZ' | 'spinAround'>, phase: number): SdfValue {
  if (!value.root) return value;
  const R = spunRotation(p, phase);
  const spinning = p.spinX !== 0 || p.spinY !== 0 || p.spinZ !== 0;
  const move = sdfMove(id, value.root, { pos: [p.posX, p.posY, p.posZ], rot: [p.rotX, p.rotY, p.rotZ], scale: Math.max(0.001, p.objectScale), matrix: spinning ? [...R] : undefined });
  return value.picture ? { kind: 'sdf', root: move, picture: value.picture } : { kind: 'sdf', root: move };
}

export interface SdfRenderInput {
  value: SdfValue;
  p: SdfRenderParams;
  size: { width: number; height: number; unit?: number };
  camera: CameraValue | null;
  material: MaterialValue | null;
  /** Clock phase 0..1 (only read when the scene spins). */
  phase: number;
  wantDepth: boolean;
}

/** Render the scene: image and (when asked) depth, in the conventions of SDF 3D (docs/ENGINE.md, "Depth encoding"). */
export function renderSdf(gpu: NodeGpu, r: SdfRenderInput): { image: ImageValue; depth: ImageValue | null } {
  const { value, size } = r;
  const p = applyCameraLight(r.p, r.camera);
  checkFrame(gpu, size.width, size.height);
  const root = value.root;
  checkSdfSize(root);
  if (!root) {
    const clear = (format?: 'rgba16float') => gpu.pass({ label: 'sdf-scene empty', size, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return vec4f(0.0); }', ...(format ? { format } : {}) });
    return { image: clear(), depth: r.wantDepth ? clear('rgba16float') : null };
  }
  const usesPic = sdfUsesPicture(root) && !!value.picture;
  const R = spunRotation(p, r.phase);
  const objScale = Math.max(0.001, p.objectScale);
  const b = sdfBounds(root);
  const infinite = !Number.isFinite(b.radius);
  const c = b.center;
  const cam = resolveCamera(p, r.camera, size.width, size.height);
  const uniforms: Record<string, UniformValue> = {
    ...cameraUniforms(cam, size.width, size.height),
    objPos: [p.posX, p.posY, p.posZ],
    objScale,
    t0: [R[0], R[3], R[6]],
    t1: [R[1], R[4], R[7]],
    t2: [R[2], R[5], R[8]],
    bsW: [p.posX + (R[0] * c[0] + R[1] * c[1] + R[2] * c[2]) * objScale, p.posY + (R[3] * c[0] + R[4] * c[1] + R[5] * c[2]) * objScale, p.posZ + (R[6] * c[0] + R[7] * c[1] + R[8] * c[2]) * objScale],
    bsR: infinite ? 0 : b.radius * 1.02,
    farT: 80,
  };
  if (groundOn(p)) {
    // the floor is at the bottom of the bounding sphere (a scene that repeats forever: one unit under the object)
    const rW = infinite ? 1.5 * objScale : b.radius * 1.02 * objScale;
    const cW = uniforms.bsW as number[];
    Object.assign(uniforms, groundUniforms(p, cam, { bottom: infinite ? p.posY - objScale : cW[1] - rW, center: cW, radius: rW, opacity: materialShadowFactor(r.material) }));
  }
  const packed = packSdf(root);
  for (let i = 0; i < packed.length; i += 4) uniforms[`q${i / 4}`] = [packed[i], packed[i + 1], packed[i + 2], packed[i + 3]];
  let occ: ImageValue | null = null;
  let fld: ImageValue | null = null;
  if (usesPic && value.picture) {
    const prep = preparePicture(gpu, value.picture, { from: p.shape2dFrom, threshold: p.shape2dThreshold });
    occ = prep.occ;
    fld = prep.fld;
    Object.assign(uniforms, prep.uniforms);
  }
  Object.assign(uniforms, marchUniforms({ light: lightVector(p), p, quality: p.quality, stepScale: 0.9 * sdfStepScale(root), nEps: usesPic ? 0.01 : 0 }));
  const mat = r.material;
  if (mat) Object.assign(uniforms, materialUniforms(mat));
  // a picture shape without a picture would read an unbound field: such shapes are dropped by SDF Shape, so this holds
  const wgsl = sdfShader(root, { material: mat, shadows: p.shadows, infinite, ground: groundOn(p) });
  const out = run3d(gpu, {
    label: `sdf-scene${groundOn(p) ? ' ground' : ''} ${sdfStructure(root)} ${materialKey(mat)}`.slice(0, 200),
    wgsl,
    uniforms,
    textures: { fld, ...(mat ? materialTextures(mat) : {}) },
    size,
    quality: p.quality,
    wantDepth: r.wantDepth,
  });
  if (fld) gpu.recycle(fld);
  if (occ) gpu.recycle(occ);
  return out;
}
