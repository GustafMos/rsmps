import { defineNode } from '../../define';
import { cameraBasis, PROJECTION_ID } from '../../lib/gen-camera';
import { GEN_HASH_WGSL } from '../../lib/gen-common';
import { rad, rgba4 } from '../../lib/copy-wgsl';
import { PRELUDE } from '../../gpu/prelude';
import type { CameraValue, NodeGpu } from '../../types';

/**
 * 3D Array: the input picture as textured cards instanced in 3D, one instanced draw call.
 *
 * No per-instance buffer exists: the vertex shader derives every card's place from `instance_index` and a few uniforms (layout, counts,
 * spacing, time), so changing a number never uploads or recompiles anything and the CPU cost does not depend on the card count. A depth
 * buffer (4x MSAA, depth24plus) gives correct overlaps; transparency is an alpha test written as a per-sample coverage mask (alpha 0..1
 * maps to 0..4 of the 4 samples, dithered per pixel), so cut-out edges stay anti-aliased while depth stays exact (no sorting needed).
 * Perspective and orthographic are exact; fisheye / panorama / cylinder are projected per vertex, so cards are subdivided (more as there are
 * fewer cards) to keep their edges smooth.
 *
 * Travel along Z wraps: card slot s = (index - travel * phase) mod count, so with whole spacings per loop the picture is identical at the
 * loop point and the stream never ends. Colours are attached to the card ("by copy", loops when the colour period divides the travel) or to
 * the depth on screen ("by depth", always loops).
 */
export const MAX_CARDS = 20_000;
const MAX_MSAA_BYTES = 700 * 1024 * 1024;
const LAYOUT = { grid: 0, tunnel: 1, ring: 2, helix: 3 } as const;

const SHADER = /* wgsl */ `
${PRELUDE}
${GEN_HASH_WGSL}
struct Fr {
  camPos: vec4f, camRight: vec4f, camUp: vec4f, camFwd: vec4f, view: vec4f, depth: vec4f,
  p0: vec4f,  // layout, countX, countY, countZ
  p1: vec4f,  // spacing x, y, z, card width
  p2: vec4f,  // card height, radius, ring step (rad), card roll step (rad)
  p3: vec4f,  // travel (slots), orbit (rad), align to ring, double sided
  p4: vec4f,  // sheet columns, rows, vary (0 none, 1 order, 2 random), seed
  p5: vec4f,  // hue step (turns), brightness step, tint mode, colour by (0 copy, 1 depth)
  tintA: vec4f, tintB: vec4f, fogC: vec4f,
  fog: vec4f, // start, end, enabled, crisp
  p6: vec4f,  // total cards, 0, 0, 0
};
@group(0) @binding(0) var<uniform> fr: Fr;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var smpL: sampler;
@group(0) @binding(3) var smpN: sampler;

fn pmodf(a: f32, b: f32) -> f32 { return a - b * floor(a / b); }
fn pmodi(a: i32, b: i32) -> i32 { let m = max(b, 1); return ((a % m) + m) % m; }

fn project(wp: vec3f) -> vec4f {
  let d = wp - fr.camPos.xyz;
  let v = vec3f(dot(d, fr.camRight.xyz), dot(d, fr.camUp.xyz), dot(d, fr.camFwd.xyz));
  let proj = i32(fr.camPos.w);
  let near = fr.depth.x; let far = fr.depth.y;
  let sw = fr.view.x; let sh = fr.view.y; let sx = fr.view.z; let sy = fr.view.w;
  let tanH = fr.camRight.w;
  if (proj == 1) {
    return vec4f((v.x / tanH + sx * v.z) * sw, (v.y / tanH + sy * v.z) * sh, far * (v.z - near) / (far - near), v.z);
  }
  if (proj == 0) {
    let h = fr.camFwd.w;
    return vec4f((v.x / h + sx) * sw, (v.y / h + sy) * sh, (v.z - near) / (far - near), 1.0);
  }
  let l = max(length(v), 1e-6);
  let dir = v / l;
  let z = clamp((l - near) / (far - near), 0.0, 1.0);
  if (proj == 2) {
    let th = acos(clamp(dir.z, -1.0, 1.0));
    let r = th / (fr.camUp.w * 0.5);
    let xl = length(v.xy);
    var d2 = vec2f(0.0);
    if (xl > 1e-6) { d2 = v.xy / xl; }
    let uf = d2 * r;
    return vec4f((uf.x + sx) * sw, (uf.y + sy) * sh, z, 1.0);
  }
  let lon = atan2(dir.x, dir.z);
  var ny = 0.0;
  if (proj == 3) { ny = asin(clamp(dir.y, -1.0, 1.0)) / (PI * 0.5); }
  else {
    let hr = max(length(dir.xz), 1e-6);
    ny = (dir.y / hr) / tan(clamp(fr.camUp.w * 0.5, 0.01, 1.5));
  }
  return vec4f(lon / PI + sx * sw, ny + sy * sh, z, 1.0);
}

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) cardInfo: vec4f,   // card index (colour), depth position 0..1, 0, 0
  @location(2) @interpolate(flat) sheet: vec4f,  // sheet offset xy, scale zw
  @location(3) dist: f32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let sub = max(i32(fr.depth.z + 0.5), 1);
  let q = i32(vi) / 6;
  let corner = i32(vi) % 6;
  var kx = array<f32, 6>(0.0, 1.0, 0.0, 1.0, 1.0, 0.0);
  var ky = array<f32, 6>(0.0, 0.0, 1.0, 0.0, 1.0, 1.0);
  let uvq = (vec2f(f32(q % sub), f32(q / sub)) + vec2f(kx[corner], ky[corner])) / f32(sub);

  let lay = i32(fr.p0.x + 0.5);
  let cxn = i32(fr.p0.y + 0.5); let cyn = i32(fr.p0.z + 0.5); let czn = i32(fr.p0.w + 0.5);
  let i = i32(ii);
  let sp = fr.p1.xyz;
  let R = fr.p2.y;
  var pos = vec3f(0.0); var rgt = vec3f(1.0, 0.0, 0.0); var upv = vec3f(0.0, 1.0, 0.0);
  var zn = 0.0;
  var iz = 0;
  if (lay == 0) {
    let ix = i % cxn; let iy = (i / cxn) % cyn; iz = i / (cxn * cyn);
    let s = pmodf(f32(iz) - fr.p3.x, f32(czn));
    pos = vec3f((f32(ix) - f32(cxn - 1) * 0.5) * sp.x, (f32(iy) - f32(cyn - 1) * 0.5) * sp.y, s * sp.z);
    let roll = s * fr.p2.w;
    rgt = vec3f(cos(roll), sin(roll), 0.0); upv = vec3f(-sin(roll), cos(roll), 0.0);
    zn = s / f32(czn);
  } else if (lay == 1) {
    let ix = i % cxn; iz = i / cxn;
    let s = pmodf(f32(iz) - fr.p3.x, f32(czn));
    let a = 6.28318530718 * f32(ix) / f32(cxn) + s * fr.p2.z + fr.p3.y;
    pos = vec3f(R * sin(a), R * cos(a), s * sp.z);
    let roll = s * fr.p2.w - fr.p3.z * a;
    rgt = vec3f(cos(roll), sin(roll), 0.0); upv = vec3f(-sin(roll), cos(roll), 0.0);
    zn = s / f32(czn);
  } else if (lay == 2) {
    let ix = i % cxn; let iy = i / cxn; iz = iy;
    let a = 6.28318530718 * f32(ix) / f32(cxn) + fr.p3.y;
    pos = vec3f(R * sin(a), (f32(iy) - f32(cyn - 1) * 0.5) * sp.y, -R * cos(a));
    rgt = vec3f(cos(a), 0.0, sin(a)); upv = vec3f(0.0, 1.0, 0.0);
    zn = f32(iy) / f32(cyn);
  } else {
    iz = i;
    let s = pmodf(f32(iz) - fr.p3.x, f32(czn));
    let a = s * fr.p2.z + fr.p3.y;
    pos = vec3f(R * sin(a), (s - f32(czn - 1) * 0.5) * sp.y, -R * cos(a));
    rgt = vec3f(cos(a), 0.0, sin(a)); upv = vec3f(0.0, 1.0, 0.0);
    zn = s / f32(czn);
  }
  // sprite sheet
  let sc = fr.p4.x; let sr = fr.p4.y;
  let nsheet = i32(sc * sr + 0.5);
  var cell = 0;
  if (nsheet > 1) {
    if (fr.p4.z > 1.5) { cell = i32(floor(rnd4(i, 3, i32(fr.p4.w)).x * f32(nsheet))); }
    else if (fr.p4.z > 0.5) { cell = pmodi(i, nsheet); }
    cell = min(cell, nsheet - 1);
  }
  let shx = i32(sc + 0.5);
  let sheet = vec4f(f32(cell % shx) / sc, f32(cell / shx) / sr, 1.0 / sc, 1.0 / sr);

  let hx = fr.p1.w * 0.5; let hy = fr.p2.x * 0.5;
  let wp = pos + rgt * (hx * (uvq.x * 2.0 - 1.0)) + upv * (hy * (1.0 - uvq.y * 2.0));
  var o: VOut;
  o.clip = project(wp);
  o.uv = uvq;
  o.cardInfo = vec4f(f32(select(i, iz, lay == 3)), zn, 0.0, 0.0);
  o.sheet = sheet;
  o.dist = length(wp - fr.camPos.xyz);
  return o;
}

struct FOut { @location(0) color: vec4f, @builtin(sample_mask) mask: u32 };

@fragment fn fs(i: VOut, @builtin(front_facing) front: bool) -> FOut {
  let uvt = i.sheet.xy + i.uv * i.sheet.zw;
  let dim = vec2f(textureDimensions(tex));
  let dx = dpdx(uvt * dim); let dy = dpdy(uvt * dim);
  let tpp = max(length(dx), length(dy));
  var t: vec4f;
  if (tpp > 1.25) {
    let o = vec2f(0.25 * tpp) / dim;
    t = 0.25 * (textureSampleLevel(tex, smpL, uvt + vec2f(-o.x, -o.y), 0.0) + textureSampleLevel(tex, smpL, uvt + vec2f(o.x, -o.y), 0.0) +
                textureSampleLevel(tex, smpL, uvt + vec2f(-o.x, o.y), 0.0) + textureSampleLevel(tex, smpL, uvt + vec2f(o.x, o.y), 0.0));
  } else if (fr.fog.w > 0.5) {
    t = textureSampleLevel(tex, smpN, uvt, 0.0);
  } else {
    t = textureSampleLevel(tex, smpL, uvt, 0.0);
  }
  var out: FOut;
  out.mask = 0u;
  out.color = vec4f(0.0);
  if (!front && fr.p3.w < 0.5) { discard; }
  let c = unpremul(t);
  let n = select(i.cardInfo.x, i.cardInfo.y * 1024.0, fr.p5.w > 0.5);  // colour position: card index, or depth
  var rgb = c.rgb;
  if (fr.p5.x != 0.0) { var h = rgbToHsv(rgb); h.x = fract(h.x + fr.p5.x * n); rgb = hsvToRgb(h); }
  rgb = rgb * max(0.0, 1.0 + fr.p5.y * n);
  let g = select(saturate(i.cardInfo.x / max(fr.p6.x - 1.0, 1.0)), i.cardInfo.y, fr.p5.w > 0.5);
  let grad = mix(fr.tintA.rgb, fr.tintB.rgb, g);
  if (fr.p5.z > 1.5) { rgb = grad; } else if (fr.p5.z > 0.5) { rgb = rgb * grad; }
  var a = c.a;
  if (fr.fog.z > 0.5) {
    let f = saturate((i.dist - fr.fog.x) / max(fr.fog.y - fr.fog.x, 0.0001));
    rgb = mix(rgb, fr.fogC.rgb, f);
    a = a * mix(1.0, fr.fogC.a, f);
  }
  let dither = fract(dot(i.clip.xy, vec2f(0.7548776662, 0.56984029)));
  let cov = i32(floor(a * 4.0 + dither));
  if (cov <= 0) { discard; }
  out.mask = (1u << u32(min(cov, 4))) - 1u;
  out.color = vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), 1.0);
  return out;
}
`;

interface Pipe {
  pipeline: GPURenderPipeline;
  layout: GPUBindGroupLayout;
  linear: GPUSampler;
  nearest: GPUSampler;
  groups: WeakMap<GPUBuffer, WeakMap<GPUTexture, GPUBindGroup>>;
}
const pipes = new WeakMap<GPUDevice, Promise<Pipe>>();

function getPipe(device: GPUDevice): Promise<Pipe> {
  let p = pipes.get(device);
  if (!p) {
    p = (async () => {
      const module = device.createShaderModule({ label: 'array-3d', code: SHADER });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error');
      if (errors.length) throw new Error(`array-3d shader failed to compile: ${errors.map((e) => `line ${e.lineNum}: ${e.message}`).join('; ')}`);
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
      });
      const pipeline = device.createRenderPipeline({
        label: 'array-3d',
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal' },
        multisample: { count: 4 },
      });
      return {
        pipeline,
        layout,
        linear: device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
        nearest: device.createSampler({ magFilter: 'nearest', minFilter: 'nearest', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' }),
        groups: new WeakMap(),
      };
    })();
    pipes.set(device, p);
    p.catch(() => pipes.delete(device));
  }
  return p;
}

/** Camera used when none is wired: frames the layout so the first render already looks right. */
function defaultCamera(layout: keyof typeof LAYOUT, o: { cx: number; cy: number; cz: number; sx: number; sy: number; sz: number; w: number; h: number; radius: number }): CameraValue {
  const base = { kind: 'camera' as const, orthoSize: 4, roll: 0, shift: [0, 0] as [number, number] };
  if (layout === 'grid') {
    const fov = 50;
    const half = Math.max((o.cx * o.sx) / 2 + o.w / 2, (o.cy * o.sy) / 2 + o.h / 2);
    const d = (half / Math.tan((fov * Math.PI) / 360)) * 1.1;
    return { ...base, projection: 'perspective', fov, position: [0, 0, -d], target: [0, 0, 0] };
  }
  if (layout === 'tunnel') return { ...base, projection: 'perspective', fov: 75, position: [0, 0, -o.sz * 0.6], target: [0, 0, o.cz * o.sz] };
  const fov = 40;
  const ringH = layout === 'ring' ? o.cy * o.sy : o.cz * o.sy;
  const d = Math.max(o.radius * 2.6, (ringH / 2 / Math.tan((fov * Math.PI) / 360)) * 1.1 + o.radius);
  return { ...base, projection: 'perspective', fov, position: [0, d * 0.15, -d], target: [0, 0, 0] };
}

export default defineNode({
  id: 'array-3d',
  title: '3D Array',
  category: 'generate',
  description:
    'Your picture as cards in 3D space: a grid, a tunnel of rings receding away, a carousel ring or a helix. Cards can stream towards the camera forever (they wrap round), fade into fog, and change hue or colour from card to card. Uses the same Camera node as 3D Object. One draw call, up to 20,000 cards.',
  keywords: ['instances', 'cloner', 'cards', 'depth', 'tunnel', 'parallax', '3d grid', '3d array', 'array', 'duplicate', 'carousel', 'helix', 'ring', 'fly through', 'infinite', 'wall of images', 'billboards'],
  inputs: { image: { type: 'image', required: true, label: 'Picture' }, camera: { type: 'camera', label: 'Camera' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    layout: {
      type: 'enum',
      default: 'grid',
      label: 'Layout',
      options: [
        { value: 'grid', label: 'Grid' },
        { value: 'tunnel', label: 'Tunnel' },
        { value: 'ring', label: 'Ring / carousel' },
        { value: 'helix', label: 'Helix' },
      ],
    },
    outputSize: {
      type: 'enum',
      default: 'canvas',
      label: 'Output size',
      options: [
        { value: 'canvas', label: 'Project canvas' },
        { value: 'input', label: 'Same as picture' },
      ],
    },
    countX: { type: 'number', default: 5, min: 1, max: 1000, softMax: 40, step: 1, integer: true, label: 'Count X', hint: 'Grid: across. Tunnel and ring: cards around the circle.', visibleIf: (p) => p.layout !== 'helix' },
    countY: { type: 'number', default: 3, min: 1, max: 1000, softMax: 40, step: 1, integer: true, label: 'Count Y', hint: 'Grid: down. Ring: rows stacked up the cylinder.', visibleIf: (p) => p.layout === 'grid' || p.layout === 'ring' },
    countZ: { type: 'number', default: 8, min: 1, max: 1000, softMax: 60, step: 1, integer: true, label: 'Count Z', hint: 'Grid and tunnel: depth. Helix: number of cards.', visibleIf: (p) => p.layout !== 'ring' },
    spacingX: { type: 'number', default: 1.2, min: 0.01, max: 50, step: 0.01, label: 'Spacing X', visibleIf: (p) => p.layout === 'grid' },
    spacingY: { type: 'number', default: 1.2, min: 0.01, max: 50, step: 0.01, label: 'Spacing Y', hint: 'Grid and ring: between rows. Helix: rise per card.', visibleIf: (p) => p.layout === 'grid' || p.layout === 'ring' || p.layout === 'helix' },
    spacingZ: { type: 'number', default: 1.5, min: 0.01, max: 50, step: 0.01, label: 'Spacing Z', visibleIf: (p) => p.layout === 'grid' || p.layout === 'tunnel' },
    cardWidth: { type: 'number', default: 1, min: 0.01, max: 50, step: 0.01, label: 'Card width', hint: 'Scene units. The height follows the picture’s proportions.' },
    radius: { type: 'number', default: 2, min: 0, max: 100, step: 0.05, label: 'Radius', visibleIf: (p) => p.layout !== 'grid' },
    stepRotate: { type: 'number', default: 12, min: -360, max: 360, step: 0.5, unit: 'deg', label: 'Turn per step', hint: 'Tunnel: each ring is turned this much more than the one before. Helix: angle between cards.', visibleIf: (p) => p.layout === 'tunnel' || p.layout === 'helix' },
    cardRoll: { type: 'number', default: 0, min: -360, max: 360, step: 0.5, unit: 'deg', label: 'Card roll per step', hint: 'Each deeper card is rolled this much about the view axis.', visibleIf: (p) => p.layout === 'grid' || p.layout === 'tunnel' },
    alignRing: { type: 'bool', default: false, label: 'Tops outward', visibleIf: (p) => p.layout === 'tunnel' },
    travel: { type: 'number', default: 0, min: -32, max: 32, step: 1, integer: true, unit: 'cycles', label: 'Travel', hint: 'Whole spacings the stream moves per loop along Z (helix: up). Cards wrap round so it never ends. 0 = still.', group: 'Motion', visibleIf: (p) => p.layout !== 'ring' },
    orbit: { type: 'number', default: 0, min: -16, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Turn', hint: 'Spins the ring / tunnel / helix about its axis.', group: 'Motion', visibleIf: (p) => p.layout !== 'grid' },
    doubleSided: { type: 'bool', default: true, label: 'Show card backs', hint: 'Backs show the picture mirrored.' },
    crisp: { type: 'bool', default: false, label: 'Crisp', hint: 'Nearest-neighbour when a card is shown larger than its picture.' },
    colourBy: {
      type: 'enum',
      default: 'copy',
      label: 'Color steps follow',
      options: [
        { value: 'copy', label: 'Follows card' },
        { value: 'depth', label: 'Follows depth' },
      ],
      group: 'Color per card',
    },
    hueStep: { type: 'number', default: 0, min: -180, max: 180, step: 0.5, unit: 'deg', label: 'Hue shift per card', hint: 'By depth: per 1/1024 of the depth range.', group: 'Color per card' },
    brightnessStep: { type: 'number', default: 0, min: -0.5, max: 0.5, step: 0.005, label: 'Card brightness', hint: 'Brightness change per card.', group: 'Color per card' },
    tintMode: {
      type: 'enum',
      default: 'off',
      label: 'Color gradient',
      options: [
        { value: 'off', label: 'Off' },
        { value: 'multiply', label: 'Multiply' },
        { value: 'fill', label: 'Fill' },
      ],
      group: 'Color per card',
    },
    tintA: { type: 'color', default: [1, 0.3, 0.2, 1], label: 'Near color', hint: 'Color of the near (first) card.', group: 'Color per card', visibleIf: (p) => p.tintMode !== 'off' },
    tintB: { type: 'color', default: [0.2, 0.5, 1, 1], label: 'Far color', hint: 'Color of the far (last) card.', group: 'Color per card', visibleIf: (p) => p.tintMode !== 'off' },
    fog: { type: 'bool', default: false, label: 'Depth fog', group: 'Fog' },
    fogColor: { type: 'color', default: [0, 0, 0, 1], label: 'Fog color', hint: 'With transparency in the colour, far cards fade out instead of fading to a colour.', group: 'Fog', visibleIf: (p) => p.fog === true },
    fogStart: { type: 'number', default: 4, min: 0, max: 500, step: 0.1, label: 'Fog starts', hint: 'Distance from the camera.', group: 'Fog', visibleIf: (p) => p.fog === true },
    fogEnd: { type: 'number', default: 14, min: 0.1, max: 500, step: 0.1, label: 'Fully fogged at', group: 'Fog', visibleIf: (p) => p.fog === true },
    sheetColumns: { type: 'number', default: 1, min: 1, max: 64, step: 1, integer: true, label: 'Sheet columns', hint: 'The picture is a sheet of equal sprites: each card shows one.', group: 'Sprite sheet' },
    sheetRows: { type: 'number', default: 1, min: 1, max: 64, step: 1, integer: true, label: 'Sprite sheet rows', group: 'Sprite sheet' },
    vary: {
      type: 'enum',
      default: 'sequence',
      label: 'Sprite pick', hint: 'Which sprite each card shows.',
      options: [
        { value: 'sequence', label: 'In order' },
        { value: 'random', label: 'Random' },
      ],
      group: 'Sprite sheet',
    },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', group: 'Sprite sheet' },
  },
  summary: (p) => {
    const n = p.layout === 'grid' ? p.countX * p.countY * p.countZ : p.layout === 'tunnel' ? p.countX * p.countZ : p.layout === 'ring' ? p.countX * p.countY : p.countZ;
    return `${p.layout} · ${n} cards${p.travel ? ` · travel ${p.travel}/loop` : ''}`;
  },
  async render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    const out = p.outputSize === 'input' ? src : ctx.canvas;
    const layout = p.layout as keyof typeof LAYOUT;
    const cx = Math.max(1, Math.round(p.countX));
    const cy = Math.max(1, Math.round(p.countY));
    const cz = Math.max(1, Math.round(p.countZ));
    const total = layout === 'grid' ? cx * cy * cz : layout === 'tunnel' ? cx * cz : layout === 'ring' ? cx * cy : cz;
    if (total > MAX_CARDS) {
      throw new Error(`3D Array: ${total.toLocaleString('en-US')} cards is more than the ${MAX_CARDS.toLocaleString('en-US')} limit. Lower the counts (now ${layout === 'grid' ? `${cx} × ${cy} × ${cz}` : layout === 'tunnel' ? `${cx} × ${cz}` : layout === 'ring' ? `${cx} × ${cy}` : `${cz}`}).`);
    }
    const device = ctx.gpu.device;
    const gpu: NodeGpu = ctx.gpu;
    const W = Math.round(out.width);
    const H = Math.round(out.height);
    if (W > device.limits.maxTextureDimension2D || H > device.limits.maxTextureDimension2D || W * H * 4 * 8 > MAX_MSAA_BYTES) {
      throw new Error(`3D Array: the output (${W}x${H}) is too large to render with anti-aliasing. Use a smaller frame.`);
    }
    const sheetC = Math.max(1, Math.round(p.sheetColumns));
    const sheetR = Math.max(1, Math.round(p.sheetRows));
    const cellAspect = (src.height / sheetR) / (src.width / sheetC);
    const cardW = p.cardWidth;
    const cardH = cardW * cellAspect;
    const moving = p.travel !== 0 || p.orbit !== 0;
    const phase = moving ? ctx.time.phase : 0;

    const cam =
      ctx.in.camera ??
      defaultCamera(layout, { cx, cy, cz, sx: p.spacingX, sy: p.spacingY, sz: p.spacingZ, w: cardW, h: cardH, radius: p.radius });
    const basis = cameraBasis(cam);
    // bounding sphere of the layout, for the depth range
    const ext =
      layout === 'grid'
        ? Math.hypot(cx * p.spacingX, cy * p.spacingY, cz * p.spacingZ) / 2 + Math.hypot(cardW, cardH)
        : layout === 'tunnel'
          ? Math.hypot(p.radius + cardW, (cz * p.spacingZ) / 2)
          : layout === 'ring'
            ? Math.hypot(p.radius + cardW, (cy * p.spacingY) / 2 + cardH)
            : Math.hypot(p.radius + cardW, (cz * p.spacingY) / 2 + cardH);
    const centre: [number, number, number] = layout === 'grid' ? [0, 0, (cz * p.spacingZ) / 2] : layout === 'tunnel' ? [0, 0, (cz * p.spacingZ) / 2] : [0, 0, 0];
    const dist = Math.hypot(basis.position[0] - centre[0], basis.position[1] - centre[1], basis.position[2] - centre[2]);
    const exotic = cam.projection !== 'perspective' && cam.projection !== 'orthographic';
    const reach = ext * 1.1;
    const near = cam.projection === 'perspective' ? Math.max(dist - reach, dist * 0.002, 0.02) : exotic ? Math.max(dist - reach, 0) : dist - reach;
    const far = Math.max(dist + reach, near + 1e-3);
    const sub = exotic ? Math.max(1, Math.min(12, Math.floor(Math.sqrt(200_000 / total)))) : 1;
    const short = Math.min(W, H);
    const tintMode = p.tintMode === 'fill' ? 2 : p.tintMode === 'multiply' ? 1 : 0;
    const fc = rgba4(p.fogColor);
    const data = new Float32Array([
      ...basis.position, PROJECTION_ID[cam.projection] ?? 1,
      ...basis.right, Math.tan((Math.min(cam.projection === 'fisheye' ? 359 : 179, Math.max(1, cam.fov)) * Math.PI) / 360),
      ...basis.up, (Math.min(360, Math.max(1, cam.fov)) * Math.PI) / 180,
      ...basis.forward, Math.max(0.001, cam.orthoSize) / 2,
      short / W, short / H, cam.shift[0] * 2, cam.shift[1] * 2,
      near, far, sub, 0,
      LAYOUT[layout], cx, cy, cz,
      p.spacingX, p.spacingY, p.spacingZ, cardW,
      cardH, p.radius, rad(p.stepRotate), rad(p.cardRoll),
      p.travel * phase, Math.PI * 2 * p.orbit * phase, p.alignRing ? 1 : 0, p.doubleSided ? 1 : 0,
      sheetC, sheetR, sheetC * sheetR > 1 ? (p.vary === 'random' ? 2 : 1) : 0, p.seed,
      p.hueStep / 360, p.brightnessStep, tintMode, p.colourBy === 'depth' ? 1 : 0,
      ...rgba4(p.tintA),
      ...rgba4(p.tintB),
      ...fc,
      p.fogStart, Math.max(p.fogEnd, p.fogStart + 0.01), p.fog ? 1 : 0, p.crisp ? 1 : 0,
      total, 0, 0, 0,
    ]);

    const pipe = await getPipe(device);
    const image = gpu.alloc(W, H, out.unit ?? 1);
    const ubo = gpu.scratch(data.byteLength, GPUBufferUsage.UNIFORM, 'array-3d frame');
    device.queue.writeBuffer(ubo, 0, data);
    let byTex = pipe.groups.get(ubo);
    if (!byTex) pipe.groups.set(ubo, (byTex = new WeakMap()));
    let group = byTex.get(src.texture);
    if (!group) {
      group = device.createBindGroup({
        layout: pipe.layout,
        entries: [
          { binding: 0, resource: { buffer: ubo, size: data.byteLength } },
          { binding: 1, resource: gpu.view(src.texture) },
          { binding: 2, resource: pipe.linear },
          { binding: 3, resource: pipe.nearest },
        ],
      });
      byTex.set(src.texture, group);
    }
    const msaa = gpu.scratchTexture({ width: W, height: H, format: 'rgba8unorm', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT, label: 'array-3d msaa' });
    const depth = gpu.scratchTexture({ width: W, height: H, format: 'depth24plus', sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT, label: 'array-3d depth' });
    const enc = device.createCommandEncoder({ label: 'array-3d' });
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: gpu.view(msaa), resolveTarget: gpu.view(image.texture), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 0] }],
      depthStencilAttachment: { view: gpu.view(depth), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    rp.setPipeline(pipe.pipeline);
    rp.setBindGroup(0, group);
    rp.draw(6 * sub * sub, total); // the one draw call
    rp.end();
    device.queue.submit([enc.finish()]);
    gpu.releaseScratchTexture(msaa);
    gpu.releaseScratchTexture(depth);
    gpu.releaseScratch(ubo);
    return { image };
  },
});
