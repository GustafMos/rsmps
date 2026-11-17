import { defineNode } from '../../define';
import { rgba, rotationZYX } from '../../lib/gen-common';
import { BOX_BOUNDS_WGSL, build3dShader, cameraUniforms, checkFrame, isSpinning, LIGHT_PARAMS, lightVector, marchUniforms, QUALITY_PARAM, resolveCamera, run3d, SHADE_PARAMS, XFORM_PARAMS, type LightP, type XformP } from '../../lib/gen-3d';
import { DEFORM_PARAMS, deformAnimated, deformFeatures, deformGrow, deformKey, deformStepScale, deformUniforms, deformWgsl, type DeformP } from '../../lib/gen-deform';
import { gridFor, occupancy, profileMask, SDF2D_WGSL, signedField } from '../../lib/gen-sdf2d';
import { materialKey, materialTextures, materialUniforms, materialWgsl } from '../../lib/gen-material';
import type { ColorValue } from '../../types';

interface P extends XformP, LightP, DeformP {
  mode: 'extrude' | 'lathe';
  depth: number;
  sides: 'edge-pixels' | 'colour' | 'image' | 'darkened';
  sideColor: ColorValue;
  darken: number;
  alphaThreshold: number;
  resolution: number;
  silhouette: 'auto' | 'blocky' | 'smooth';
  bevel: number;
  backFace: 'same' | 'mirrored' | 'colour';
  backColor: ColorValue;
  relief: number;
  reliefBothSides: boolean;
  rim: number;
  ao: number;
  shadows: boolean;
  quality: string;
}

export default defineNode({
  id: 'image-to-3d',
  title: 'Image to 3D',
  category: 'generate',
  description:
    'Turns a picture into a solid object: the picture is its front (and back) face, transparent pixels are holes and it has thickness. Pixel-art sprites become chunky voxel-like objects, logos get colored walls. Mix in a depth map for relief, or spin the silhouette around a vertical axis (Lathe) for a vase or bottle from a drawing. Works on animated and video input every frame; use the Camera node and the depth output for compositing.',
  keywords: ['extrude', 'logo', 'sprite', 'voxel', 'relief', 'thickness', '2.5d', 'lathe', 'revolve', 'emboss', 'bas-relief', 'depth map', 'displace 3d', 'morph', 'melt', 'wobble', 'coin', 'card', '3d'],
  inputs: {
    image: { type: 'image', label: 'Picture', required: true },
    side: { type: 'image', label: 'Side image' },
    back: { type: 'image', label: 'Back image' },
    depthMap: { type: 'image', label: 'Depth map' },
    displaceMap: { type: 'image', label: 'Displace map' },
    camera: { type: 'camera', label: 'Camera' },
    material: { type: 'material', label: 'Material' },
    size: { type: 'image', label: 'Size from' },
  },
  outputs: { image: { type: 'image', label: 'Image' }, depth: { type: 'image', label: 'Depth' } },
  optionalOutputs: ['depth'],
  params: {
    mode: {
      type: 'enum',
      default: 'extrude',
      label: 'Mode',
      options: [
        { value: 'extrude', label: 'Extrude' },
        { value: 'lathe', label: 'Lathe' },
      ],
    },
    depth: { type: 'number', default: 0.3, min: 0.01, max: 4, step: 0.01, softMax: 3, label: 'Thickness', group: 'Solid', hint: 'Scene units. The picture’s longer side is 2 units.', visibleIf: (p) => p.mode === 'extrude' },
    alphaThreshold: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.01, label: 'Alpha threshold', group: 'Solid', hint: 'Pixels with less alpha than this are holes.' },
    resolution: { type: 'number', default: 0, min: 0, max: 1024, step: 1, integer: true, softMax: 512, label: 'Silhouette grid', group: 'Solid', hint: '0 = automatic: follows the art grid of a pixelated picture, otherwise at most 256 cells on the long side.' },
    silhouette: {
      type: 'enum',
      default: 'auto',
      label: 'Silhouette edges',
      group: 'Solid',
      options: [
        { value: 'auto', label: 'Automatic' },
        { value: 'blocky', label: 'Blocky' },
        { value: 'smooth', label: 'Smooth' },
      ],
    },
    bevel: { type: 'number', default: 0, min: 0, max: 0.5, step: 0.005, label: 'Bevel', group: 'Solid', hint: '0 = sharp edges.', visibleIf: (p) => p.mode === 'extrude' },
    sides: {
      type: 'enum',
      default: 'edge-pixels',
      label: 'Side walls',
      group: 'Walls and back',
      options: [
        { value: 'edge-pixels', label: 'Edge pixels' },
        { value: 'colour', label: 'One color' },
        { value: 'image', label: 'Side image' },
        { value: 'darkened', label: 'Edge pixels, darkened' },
      ],
    },
    sideColor: { type: 'color', default: [0.55, 0.55, 0.6, 1], label: 'Wall color', group: 'Walls and back', visibleIf: (p) => p.sides === 'colour' || p.sides === 'image' },
    darken: { type: 'number', default: 0.6, min: 0, max: 1.5, step: 0.01, label: 'Wall brightness', group: 'Walls and back', visibleIf: (p) => p.sides === 'darkened' },
    backFace: {
      type: 'enum',
      default: 'same',
      label: 'Back face',
      group: 'Walls and back',
      hint: 'Ignored when a Back image is wired. Same = the picture shows through (reads reversed from behind); Mirrored reads correctly from behind.',
      visibleIf: (p) => p.mode === 'extrude',
      options: [
        { value: 'same', label: 'Same picture' },
        { value: 'mirrored', label: 'Mirrored picture' },
        { value: 'colour', label: 'One color' },
      ],
    },
    backColor: { type: 'color', default: [0.5, 0.5, 0.55, 1], label: 'Back color', group: 'Walls and back', visibleIf: (p) => p.backFace === 'colour' && p.mode === 'extrude' },
    relief: { type: 'number', default: 0, min: -1, max: 1, step: 0.005, label: 'Relief', group: 'Depth map', hint: 'Wire a Depth map: bright parts stand out by this many units (negative = sink in). The walls follow.', visibleIf: (p) => p.mode === 'extrude' },
    reliefBothSides: { type: 'bool', default: false, label: 'Relief both sides', group: 'Depth map', visibleIf: (p) => p.mode === 'extrude' },
    ...XFORM_PARAMS,
    ...LIGHT_PARAMS,
    ...SHADE_PARAMS,
    ...QUALITY_PARAM,
    ...DEFORM_PARAMS,
  },
  summary: (p) => `${p.mode === 'lathe' ? 'lathe' : `extrude ${p.depth}`} · ${p.sides}${p.cel ? ' · cel' : ''}`,
  render(ctx) {
    const p = ctx.params as unknown as P;
    const img = ctx.in.image!;
    const size = ctx.in.size ?? ctx.canvas;
    checkFrame(ctx.gpu, size.width, size.height);
    const lathe = p.mode === 'lathe';
    const dep = lathe ? null : ctx.in.depthMap;
    const sideImg = p.sides === 'image' ? ctx.in.side : null;
    const backImg = lathe ? null : ctx.in.back;
    const dmap = ctx.in.displaceMap;
    const mat = ctx.in.material;
    const reliefOn = !!dep && p.relief !== 0;
    const feat = deformFeatures(p, !!dmap);
    const blocky = p.silhouette === 'blocky' || (p.silhouette === 'auto' && (img.cell ?? 1) > 1.001);

    // --- silhouette field (cached by the engine with the node result) ---------------------------------
    const grid = gridFor(img, p.resolution);
    let occ = occupancy(ctx.gpu, img, grid, { threshold: Math.max(0.001, p.alphaThreshold), fromBrightness: false, nearest: blocky });
    if (lathe) {
      const prof = profileMask(ctx.gpu, occ);
      ctx.gpu.recycle(occ);
      occ = prof;
    }
    const fld = signedField(ctx.gpu, occ, !blocky);

    // --- transform / camera / light ----------------------------------------------------------------
    const phase = isSpinning(p) || deformAnimated(p) ? ctx.time.phase : 0;
    const R = rotationZYX(p.rotX + 360 * p.spinX * phase, p.rotY + 360 * p.spinY * phase, p.rotZ + 360 * p.spinZ * phase);
    const cam = resolveCamera(p, ctx.in.camera, size.width, size.height);
    const long = Math.max(img.width, img.height);
    const hx = img.width / long;
    const hy = img.height / long;
    const halfD = lathe ? hx : p.depth / 2;
    const reach = (reliefOn ? Math.abs(p.relief) : 0) + p.bevel + deformGrow(p);
    const objScale = Math.max(0.001, p.objectScale);
    const stepScale = Math.min(0.9, deformStepScale(p) / (1 + (reliefOn ? Math.abs(p.relief) * 2.5 : 0)) * (blocky ? 1 : 0.95));
    const cellW = (2 * hx) / grid.gw;

    const sample = blocky ? 'smpNearest' : 'smp';
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
${SDF2D_WGSL(blocky)}
${feat && Object.values(feat).some((v) => v) ? deformWgsl(feat) : 'fn dfPoint(p: vec3f) -> vec3f { return p; }\nfn dfDist(p0: vec3f, p1: vec3f, d: f32) -> f32 { return d; }'}
fn toLocal(pw: vec3f) -> vec3f {
  let q = pw - u.objPos;
  return vec3f(dot(u.t0, q), dot(u.t1, q), dot(u.t2, q)) / u.objScale;
}
fn mapL(p0: vec3f) -> f32 {
  let p1 = dfPoint(p0);
  ${
    lathe
      ? `let rho = length(p1.xz);
  let pc = vec2f(0.5 + rho / (2.0 * u.half.x), 0.5 - p1.y / (2.0 * u.half.y)) * u.grid;
  var d = sd2(pc) * u.cellW;`
      : `let pc = vec2f(p1.x / (2.0 * u.half.x) + 0.5, 0.5 - p1.y / (2.0 * u.half.y)) * u.grid;
  let d2 = sd2(pc) * u.cellW;
  var zf = u.halfD;
  var zbk = u.halfD;
  ${
    reliefOn
      ? `let ruv = clamp(pc / u.grid, vec2f(0.0), vec2f(1.0));
  let lum = luma(textureSampleLevel(dep, smp, ruv, 0.0).rgb);
  zf += u.relief * lum;
  zbk += u.relief * lum * u.reliefBoth;`
      : ''
  }
  let dz = max(-p1.z - zf, p1.z - zbk);
  let w = vec2f(d2 + u.bevel, dz + u.bevel);
  var d = min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0))) - u.bevel;`
  }
  return dfDist(p0, p1, d);
}
fn map(pw: vec3f) -> f32 { return mapL(toLocal(pw)) * u.objScale; }
`,
      bounds: /* wgsl */ `
${BOX_BOUNDS_WGSL}
fn bounds(ro: vec3f, rd: vec3f) -> vec2f {
  let q = ro - u.objPos;
  let rl = vec3f(dot(u.t0, q), dot(u.t1, q), dot(u.t2, q)) / u.objScale;
  let dl = vec3f(dot(u.t0, rd), dot(u.t1, rd), dot(u.t2, rd));
  return boxSpan(rl, dl, u.bbox) * u.objScale;
}`,
      surf: /* wgsl */ `
fn pic(uv: vec2f) -> vec4f {
  let c = textureSampleLevel(img, ${sample}, uv, 0.0);
  return unpremul(c);
}
fn picOr(uv: vec2f, fallback: vec3f) -> vec3f {
  let c = pic(uv);
  return select(fallback, c.rgb, c.a > 0.02);
}
fn surf(pw: vec3f, nw: vec3f, rd: vec3f) -> vec3f {
  let pl = dfPoint(toLocal(pw));
  let nl = vec3f(dot(u.t0, nw), dot(u.t1, nw), dot(u.t2, nw));
  ${
    lathe
      ? `let rho = length(pl.xz);
  let dirR = select(vec2f(1.0, 0.0), pl.xz / max(rho, 1e-6), rho > 1e-6);
  let nm = vec2f(dot(nl.xz, dirR), nl.y);
  let inset = u.cellW * ${blocky ? '0.5' : '0.75'};
  let pin = vec2f(rho, pl.y) - normalize(nm + vec2f(1e-6)) * inset;
  let uvm = vec2f(0.5 + pin.x / (2.0 * u.half.x), 0.5 - pin.y / (2.0 * u.half.y));
  var col = picOr(uvm, u.sideCol.rgb);
  ${
    sideImg
      ? `col = textureSampleLevel(side, smp, vec2f(fract(atan2(pl.z, pl.x) / TAU), clamp(0.5 - pl.y / (2.0 * u.half.y), 0.0, 1.0)), 0.0).rgb;`
      : p.sides === 'colour'
        ? 'col = u.sideCol.rgb;'
        : p.sides === 'darkened'
          ? 'col = col * u.darken;'
          : ''
  }
  return col;`
      : `let uv = vec2f(pl.x / (2.0 * u.half.x) + 0.5, 0.5 - pl.y / (2.0 * u.half.y));
  let isFront = nl.z < 0.0;
  var face = picOr(uv, u.sideCol.rgb);
  if (!isFront) {
    ${
      backImg
        ? 'face = textureSampleLevel(back, smp, vec2f(1.0 - uv.x, uv.y), 0.0).rgb;'
        : p.backFace === 'colour'
          ? 'face = u.backCol.rgb;'
          : p.backFace === 'mirrored'
            ? 'face = picOr(vec2f(1.0 - uv.x, uv.y), u.sideCol.rgb);'
            : ''
    }
  }
  let inset = u.cellW * ${blocky ? '0.5' : '0.75'};
  let dirW = normalize(nl.xy + vec2f(1e-6));
  let pin = pl.xy - dirW * inset;
  let uvw = vec2f(pin.x / (2.0 * u.half.x) + 0.5, 0.5 - pin.y / (2.0 * u.half.y));
  var wall = picOr(uvw, u.sideCol.rgb);
  ${
    sideImg
      ? 'wall = textureSampleLevel(side, smp, vec2f(fract(atan2(pl.y, pl.x) / TAU), clamp(pl.z / max(2.0 * u.halfD, 1e-4) + 0.5, 0.0, 1.0)), 0.0).rgb;'
      : p.sides === 'colour'
        ? 'wall = u.sideCol.rgb;'
        : p.sides === 'darkened'
          ? 'wall = wall * u.darken;'
          : ''
  }
  let wallness = 1.0 - smoothstep(0.55, 0.9, abs(nl.z));
  return mix(face, wall, wallness);`
  }
}`,
    });

    const uniforms = {
      ...cameraUniforms(cam, size.width, size.height),
      ...marchUniforms({ light: lightVector(p), p, quality: p.quality, stepScale, nEps: blocky ? 0 : cellW * 0.7 * objScale }),
      ...deformUniforms(p, phase),
      objPos: [p.posX, p.posY, p.posZ],
      objScale,
      t0: [R[0], R[3], R[6]],
      t1: [R[1], R[4], R[7]],
      t2: [R[2], R[5], R[8]],
      grid: [grid.gw, grid.gh],
      cellW,
      half: [hx, hy],
      halfD,
      bbox: [hx, hy, halfD + reach + 0.02],
      bevel: p.bevel,
      relief: p.relief,
      reliefBoth: p.reliefBothSides ? 1 : 0,
      darken: p.darken,
      sideCol: rgba(p.sideColor),
      backCol: rgba(p.backColor),
      ...(mat ? materialUniforms(mat) : {}),
    };
    const out = run3d(ctx.gpu, {
      label: `image-to-3d ${lathe ? 'lathe' : 'extrude'} ${blocky ? 'blocky' : 'smooth'} ${reliefOn ? 'relief' : ''} ${deformKey(feat)} ${materialKey(mat)}`,
      wgsl: code,
      uniforms,
      textures: { img, fld, occ: blocky ? occ : null, dep: reliefOn ? dep : null, side: sideImg, back: backImg, dmap: feat.map ? dmap : null, ...(mat ? materialTextures(mat) : {}) },
      size,
      quality: p.quality,
      wantDepth: ctx.wants('depth'),
    });
    ctx.gpu.recycle(fld);
    ctx.gpu.recycle(occ);
    return { image: out.image, depth: out.depth };
  },
});
