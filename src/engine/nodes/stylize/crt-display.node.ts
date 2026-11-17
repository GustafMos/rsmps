import { defineNode } from '../../define';
import { SOFTCLIP_WGSL, pullFrames } from '../../lib/fx-video';
import { loopFrame } from '../../lib/fx-util';
import { assertTextureSize } from '../../lib/pixel-gpu';
import type { ImageValue } from '../../types';
import { gaussianBlur } from '../filter/blur.node';

/**
 * Parameter bundles for the look presets. A preset wins over the matching params below;
 * choose "Custom" to edit every control yourself.
 */
const PRESETS: Record<string, Record<string, number | string | boolean>> = {
  arcade: {
    blendDither: 0.25, colorBleed: 0.1, scanStrength: 0.9, beamWidth: 0.18, beamBloom: 0.16, interlace: 0,
    maskType: 'shadow', maskPitch: 0.5, maskStrength: 0.65, glow: 0.8, halation: 0.3, curveX: 0.1, curveY: 0.1,
    saturation: 1.2, brightness: 1.1, colorTemp: 7500, vignette: 0.4, convergence: 0.8, phosphor: 'rgb', noise: 0,
  },
  consumer: {
    blendDither: 0.7, colorBleed: 1.0, scanStrength: 0.55, beamWidth: 0.24, beamBloom: 0.2, interlace: 0,
    maskType: 'shadow', maskPitch: 0.5, maskStrength: 0.5, glow: 0.55, halation: 0.4, curveX: 0.18, curveY: 0.16,
    saturation: 1.0, brightness: 1.1, colorTemp: 8500, vignette: 0.45, convergence: 1.0, phosphor: 'rgb', noise: 0.06,
  },
  trinitron: {
    blendDither: 0.3, colorBleed: 0.1, scanStrength: 0.75, beamWidth: 0.17, beamBloom: 0.15, interlace: 0,
    maskType: 'aperture', maskPitch: 0.5, maskStrength: 0.55, glow: 0.4, halation: 0.15, curveX: 0.03, curveY: 0.02,
    saturation: 1.1, brightness: 1.1, colorTemp: 7000, vignette: 0.25, convergence: 0.3, phosphor: 'rgb', noise: 0,
  },
  portable: {
    blendDither: 0.85, colorBleed: 0.8, scanStrength: 0.4, beamWidth: 0.28, beamBloom: 0.2, interlace: 0,
    maskType: 'shadow', maskPitch: 0.75, maskStrength: 0.8, glow: 0.7, halation: 0.45, curveX: 0.3, curveY: 0.28,
    saturation: 0.95, brightness: 1.15, colorTemp: 9300, vignette: 0.6, convergence: 1.6, phosphor: 'rgb', noise: 0.15, blackLevel: 0.03, glare: 0.5,
  },
  terminal: {
    blendDither: 0.5, colorBleed: 0, scanStrength: 0.7, beamWidth: 0.2, beamBloom: 0.25, interlace: 0,
    maskType: 'none', maskPitch: 0.5, maskStrength: 0, glow: 1.1, halation: 0.5, curveX: 0.2, curveY: 0.18,
    saturation: 1, brightness: 1.15, colorTemp: 6500, vignette: 0.45, convergence: 0, phosphor: 'green', noise: 0.04,
  },
  lcd: {
    blendDither: 0.1, colorBleed: 0, scanStrength: 0.8, beamWidth: 0.22, beamBloom: 0.08, interlace: 0,
    maskType: 'none', maskPitch: 0.5, maskStrength: 0, glow: 0.1, halation: 0, curveX: 0, curveY: 0, cornerRadius: 0,
    saturation: 1, brightness: 1.05, colorTemp: 6500, vignette: 0, convergence: 0, phosphor: 'rgb', noise: 0, blackLevel: 0,
  },
};

const MASKS = ['none', 'aperture', 'slot', 'shadow', 'pvm'];
const PHOSPHORS: Record<string, [number, number, number] | null> = { rgb: null, green: [0.3, 1, 0.35], amber: [1, 0.62, 0.12], white: [0.95, 0.97, 1] };

/** Red/blue gain for a colour temperature: 9300 K is bluish, 6500 K neutral, lower is warm. */
function temperatureGain(kelvin: number): [number, number, number] {
  const t = Math.max(-1.5, Math.min(1.5, (kelvin - 6500) / 2800));
  return [1 - 0.17 * t, 1 - 0.02 * Math.abs(t), 1 + 0.23 * t];
}

export default defineNode({
  id: 'crt-display',
  title: 'CRT Display',
  category: 'stylize',
  description:
    'A physically motivated cathode-ray-tube emulation in linear light, built for pixel art: every picture row becomes one scan line locked to the art pixels, the beam blends dithering into gradients, and a phosphor mask, glow, curved glass, convergence error and more complete the tube. Enlarge pixel art here (Output size) so the mask has room to appear.',
  keywords: ['crt', 'tube', 'television', 'monitor', 'scanlines', 'phosphor', 'aperture grille', 'trinitron', 'shadow mask', 'retro', 'arcade', 'pvm', 'curvature', 'pixel art', 'bloom'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    preset: {
      type: 'enum',
      default: 'custom',
      label: 'Look',
      hint: 'A preset overrides the controls it lists (lines, mask, glow, curvature, color, noise). Choose Custom to use every control below as set.',
      options: [
        { value: 'custom', label: 'Custom' },
        { value: 'arcade', label: 'Arcade monitor' },
        { value: 'consumer', label: 'Consumer TV' },
        { value: 'trinitron', label: 'Trinitron / PVM' },
        { value: 'portable', label: 'Old portable TV' },
        { value: 'terminal', label: 'Green terminal' },
        { value: 'lcd', label: 'Clean LCD' },
      ],
    },
    outputScale: {
      type: 'enum',
      default: 'auto',
      label: 'Output size',
      group: 'Picture',
      hint: 'The phosphor mask is finer than a pixel of pixel art, so the picture must be enlarged first. Auto enlarges small images by a whole number so the result is about 1000 px tall; "Same" keeps the input size.',
      options: [
        { value: 'same', label: 'Same as input' },
        { value: 'auto', label: 'Auto' },
        { value: '2', label: '×2' },
        { value: '3', label: '×3' },
        { value: '4', label: '×4' },
        { value: '6', label: '×6' },
        { value: '8', label: '×8' },
      ],
    },
    sourceLines: { type: 'number', default: 0, min: 0, max: 4096, softMax: 1080, step: 1, integer: true, label: 'Picture lines', group: 'Picture', hint: '0 = auto: the picture height when it is 600 or less, otherwise 240. Each picture line becomes one scan line.' },
    blendDither: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Blend dither', group: 'Picture', hint: 'Horizontal beam softness. Higher blends checkerboard dither into smooth gradients like a real tube.' },
    colorBleed: { type: 'number', default: 0.2, min: 0, max: 2, step: 0.01, label: 'Color bleed', group: 'Picture', hint: 'Red and blue smear wider than green.' },
    phosphor: {
      type: 'enum',
      default: 'rgb',
      label: 'Phosphor',
      group: 'Picture',
      options: [
        { value: 'rgb', label: 'Color' },
        { value: 'green', label: 'Green monochrome' },
        { value: 'amber', label: 'Amber monochrome' },
        { value: 'white', label: 'White monochrome' },
      ],
    },
    scanStrength: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, label: 'Scan lines', group: 'Scan lines' },
    beamWidth: { type: 'number', default: 0.2, min: 0.1, max: 0.8, step: 0.01, label: 'Beam width', group: 'Scan lines', hint: 'Width of a dark line, in line spacings.' },
    beamBloom: { type: 'number', default: 0.15, min: 0, max: 0.6, step: 0.01, label: 'Bright lines grow', group: 'Scan lines', hint: 'Bright lines get fatter and fill the gaps.' },
    interlace: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Interlace flicker', group: 'Scan lines', hint: 'Alternate lines dim on alternate frames. Animates; off by default.' },
    maskType: {
      type: 'enum',
      default: 'aperture',
      label: 'Phosphor mask',
      group: 'Mask',
      options: [
        { value: 'none', label: 'None' },
        { value: 'aperture', label: 'Aperture grille' },
        { value: 'slot', label: 'Slot mask' },
        { value: 'shadow', label: 'Shadow mask' },
        { value: 'pvm', label: 'Fine' },
      ],
    },
    maskPitch: { type: 'number', default: 0.5, min: 0.25, max: 16, softMax: 8, step: 0.05, unit: 'px', label: 'Mask pitch', group: 'Mask', hint: 'Width of one red-green-blue triad, in source pixels (never narrower than 3 output pixels). 1 = one triad per art pixel.' },
    maskStrength: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Mask strength', group: 'Mask' },
    maskComp: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Brightness comp', group: 'Mask', hint: '1 = the mask does not darken the picture.' },
    glow: { type: 'number', default: 0.5, min: 0, max: 2, step: 0.01, label: 'Glow', group: 'Glow' },
    glowRadius: { type: 'number', default: 5, min: 0.5, max: 80, softMax: 40, step: 0.5, unit: 'px', label: 'Glow size', group: 'Glow' },
    halation: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Halation', group: 'Glow', hint: 'A faint wide reddish haze from glass scatter.' },
    curveX: { type: 'number', default: 0.12, min: 0, max: 1, step: 0.01, label: 'Curvature X', group: 'Geometry' },
    curveY: { type: 'number', default: 0.12, min: 0, max: 1, step: 0.01, label: 'Curvature Y', group: 'Geometry' },
    overscan: { type: 'number', default: 0, min: -0.2, max: 0.3, step: 0.005, unit: 'norm', label: 'Overscan', group: 'Geometry', hint: 'Fraction of the picture hidden at the edges (negative shrinks the picture).' },
    cornerRadius: { type: 'number', default: 0.05, min: 0, max: 0.3, step: 0.005, unit: 'norm', label: 'Corner radius', group: 'Geometry' },
    edgeSoftness: { type: 'number', default: 0.006, min: 0.0005, max: 0.05, step: 0.0005, unit: 'norm', label: 'Edge softness', group: 'Geometry' },
    bezelReflection: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Bezel reflection', group: 'Geometry', hint: 'A faint mirror image of the picture edge on the bezel.' },
    blackOutside: { type: 'bool', default: true, label: 'Black outside', group: 'Geometry', hint: 'Off = transparent outside the screen.' },
    gamma: { type: 'number', default: 2.4, min: 1.6, max: 3.2, step: 0.01, label: 'Tube gamma', group: 'Color' },
    brightness: { type: 'number', default: 1.05, min: 0.25, max: 3, step: 0.01, label: 'Brightness', group: 'Color' },
    contrast: { type: 'number', default: 1, min: 0.5, max: 1.6, step: 0.01, label: 'Contrast', group: 'Color' },
    saturation: { type: 'number', default: 1.05, min: 0, max: 2, step: 0.01, label: 'Saturation', group: 'Color' },
    colorTemp: { type: 'number', default: 6500, min: 3000, max: 12000, step: 100, label: 'Color temp', group: 'Color', hint: '9300 is the bluish look of many consumer sets.' },
    blackLevel: { type: 'number', default: 0.01, min: 0, max: 0.2, step: 0.005, label: 'Black level', group: 'Color', hint: 'A tube is never perfectly black.' },
    persistence: { type: 'number', default: 0, min: 0, max: 3, softMax: 3, step: 1, integer: true, label: 'Persistence', group: 'Persistence', hint: 'Ghost of the previous frames. Each one costs a re-render of the input.' },
    persistDecay: { type: 'number', default: 0.55, min: 0, max: 0.95, step: 0.01, label: 'Persistence decay', group: 'Persistence', visibleIf: (p) => (p.persistence as number) > 0 },
    vignette: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Vignette', group: 'Screen' },
    glare: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Glass glare', group: 'Screen' },
    convergence: { type: 'number', default: 0.6, min: 0, max: 8, softMax: 4, step: 0.05, unit: 'px', label: 'Convergence error', group: 'Screen', hint: 'Red and blue drift apart toward the edges.' },
    noise: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Static noise', group: 'Screen', hint: 'Changes every frame; off by default.' },
    hum: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Hum bar', group: 'Screen', hint: 'A dark band rolling up the screen.' },
    humCycles: { type: 'number', default: 1, min: 1, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Hum bar speed', group: 'Screen', visibleIf: (p) => (p.hum as number) > 0 },
  },
  summary: (p) => (p.preset !== 'custom' ? `${p.preset} preset` : `${p.maskType} mask · ${Math.round(p.scanStrength * 100)}% lines`),
  async render(ctx) {
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const p = { ...ctx.params } as Record<string, number | string | boolean> & typeof ctx.params;
    if (p.preset !== 'custom') Object.assign(p, PRESETS[p.preset] ?? {});

    // --- output size -------------------------------------------------------------------
    let scale = 1;
    if (p.outputScale === 'auto') scale = Math.max(1, Math.min(8, Math.round(1000 / src.height)));
    else if (p.outputScale !== 'same') scale = Number(p.outputScale);
    const W = src.width * scale;
    const H = src.height * scale;
    assertTextureSize(gpu, W, H, 'CRT Display');
    const out = { width: W, height: H, unit: src.unit * scale };
    const lines = p.sourceLines > 0 ? Math.round(p.sourceLines) : src.height <= 600 ? src.height : 240;
    const lineSpacing = H / lines;

    // --- persistence: ghosts of earlier frames fold into the source (linear light) ---------
    let picture: ImageValue = src;
    const ghosts = Math.min(3, Math.round(p.persistence as number));
    if (ghosts > 0 && p.persistDecay > 0) {
      const frames: ImageValue[] = [];
      for (let k = 1; k <= ghosts; k++) {
        const f = await pullFrames(ctx as never, 'image', -k);
        if (f && f.width === src.width && f.height === src.height) frames.push(f);
      }
      if (frames.length) {
        const textures: Record<string, ImageValue> = { cur: src };
        frames.forEach((f, i) => (textures[`g${i}`] = f));
        picture = gpu.pass({
          label: 'crt-persistence',
          size: src,
          textures,
          uniforms: { decay: p.persistDecay, gamma: p.gamma },
          format: 'rgba16float',
          wgsl: /* wgsl */ `
fn lin(c: vec4f) -> vec3f { return pow(max(c.rgb, vec3f(0.0)), vec3f(u.gamma)); }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var acc = lin(textureSampleLevel(cur, smpNearest, uv, 0.0));
  var k = 1.0;
  ${frames
    .map((_, i) => `k = k * u.decay; acc = acc + (vec3f(1.0) - min(acc, vec3f(1.0))) * lin(textureSampleLevel(g${i}, smpNearest, uv, 0.0)) * k;`)
    .join('\n  ')}
  // back to gamma-encoded so the beam pass can treat every input the same way
  return vec4f(pow(min(acc, vec3f(1.0)), vec3f(1.0 / u.gamma)), 1.0);
}`,
        });
      }
    }

    // --- (b) horizontal beam response: one row per picture line, output width ------------------
    const tint = PHOSPHORS[p.phosphor as string];
    const sigma = 0.12 + p.blendDither * 1.1;
    const exactRows = lines === src.height;
    const beam = gpu.pass({
      label: 'crt-beam',
      size: { width: W, height: lines, unit: out.unit },
      format: 'rgba16float',
      textures: { pic: picture },
      uniforms: {
        sigma,
        bleed: p.colorBleed,
        gamma: p.gamma,
        mono: tint ? 1 : 0,
        tint: tint ?? [1, 1, 1],
        field: 0,
        interlace: 0,
      },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let ws = f32(textureDimensions(pic).x);
  let rowUv = (floor(px.y) + 0.5) / u.size.y;
  let sg = max(vec3f(u.sigma) * (vec3f(1.0) + vec3f(u.bleed, 0.0, u.bleed)), vec3f(0.06));
  var acc = vec3f(0.0);
  var wsum = vec3f(0.0);
  for (var k = -12; k <= 12; k++) {
    let off = f32(k) * 0.5;
    let c = textureSampleLevel(pic, ${exactRows ? 'smpNearest' : 'smp'}, vec2f(uv.x + off / ws, rowUv), 0.0);
    let w = exp(-(off * off) / (2.0 * sg * sg));
    acc += pow(max(c.rgb, vec3f(0.0)), vec3f(u.gamma)) * w;
    wsum += w;
  }
  var rgb = acc / wsum;
  if (u.mono > 0.5) { rgb = vec3f(luma(rgb)) * u.tint; }
  return vec4f(rgb, 1.0);
}`,
    });

    // --- (c)(d)(f) screen pass: scan lines, mask, geometry, convergence ----------------------
    const maskIndex = Math.max(0, MASKS.indexOf(p.maskType as string));
    const pitch = Math.max(3, p.maskPitch * scale) * (p.maskType === 'pvm' ? 0.66 : 1);
    const maskStrength = p.maskStrength * (p.maskType === 'pvm' ? 0.7 : 1);
    const interlaceOn = p.interlace > 0;
    const field = interlaceOn ? loopFrame(ctx.time) % 2 : 0;
    const tube = gpu.pass({
      label: 'crt-tube',
      size: out,
      format: 'rgba16float',
      textures: { beam },
      uniforms: {
        lines,
        spacing: lineSpacing,
        scan: p.scanStrength,
        bw: p.beamWidth,
        bloomW: p.beamBloom,
        interlace: p.interlace,
        field,
        maskType: maskIndex,
        pitch,
        mstrength: maskStrength,
        mcomp: p.maskComp,
        curve: [p.curveX * 0.35, p.curveY * 0.35],
        overscan: p.overscan,
        corner: p.cornerRadius,
        edge: p.edgeSoftness,
        conv: p.convergence * scale,
        bezel: p.bezelReflection,
      },
      wgsl: /* wgsl */ `
fn maskWeights(px: vec2f) -> vec3f {
  let sg = 0.17;
  let avg = sg * 2.5066;
  var w = vec3f(1.0);
  var norm = 1.0;
  let ph = fract(px.x / u.pitch);
  if (u.maskType > 0.5) {
    var raw = vec3f(0.0);
    for (var c = 0; c < 3; c++) {
      let centre = (f32(c) + 0.5) / 3.0;
      var d = abs(ph - centre);
      d = min(d, 1.0 - d);
      var e = exp(-(d * d) / (2.0 * sg * sg));
      if (u.maskType > 2.5 && u.maskType < 3.5) {
        // shadow mask: round dots on a staggered lattice
        let rowH = u.pitch * 0.866;
        let rowIdx = floor(px.y / rowH);
        let shifted = fract((px.x + select(0.0, u.pitch * 0.5, (i32(rowIdx) & 1) == 1)) / u.pitch);
        var dx = abs(shifted - centre);
        dx = min(dx, 1.0 - dx);
        let dy = (fract(px.y / rowH) - 0.5);
        e = exp(-(dx * dx) / (2.0 * sg * sg)) * exp(-(dy * dy) / (2.0 * 0.3 * 0.3));
      }
      if (u.maskType > 1.5 && u.maskType < 2.5) {
        // slot mask: gaps every two scan lines, staggered between neighbouring stripes
        let cell = u.spacing * 2.0;
        let stag = select(0.0, 0.5, c == 1);
        let g = fract(px.y / cell + stag);
        e = e * (1.0 - 0.85 * (1.0 - smoothstep(0.0, 0.12, g)));
      }
      if (c == 0) { raw.r = e; } else if (c == 1) { raw.g = e; } else { raw.b = e; }
    }
    var a = avg;
    if (u.maskType > 2.5 && u.maskType < 3.5) { a = avg * 0.3 * 2.5066; }
    if (u.maskType > 1.5 && u.maskType < 2.5) { a = avg * (1.0 - 0.15 * 0.85); }
    let boosted = raw / a;
    let plain = raw;
    w = mix(vec3f(1.0), mix(plain, boosted, u.mcomp), u.mstrength);
  }
  return w;
}
fn sdRound(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
fn lineLoad(l: i32, x: f32) -> vec3f {
  let n = i32(u.lines);
  if (l < 0 || l >= n) { return vec3f(0.0); }
  return textureSampleLevel(beam, smp, vec2f(x, (f32(l) + 0.5) / u.lines), 0.0).rgb;
}
fn scanChannel(v: f32, x: f32, ch: i32) -> f32 {
  let base = i32(floor(v - 0.5));
  var acc = 0.0;
  var nearest = 0.0;
  var bestD = 9.0;
  for (var j = -1; j <= 2; j++) {
    let l = base + j;
    var i = lineLoad(l, x);
    var val = i.r;
    if (ch == 1) { val = i.g; }
    if (ch == 2) { val = i.b; }
    if (u.interlace > 0.0) {
      let parity = f32(((l % 2) + 2) % 2);
      val = val * (1.0 - u.interlace * 0.65 * abs(parity - u.field));
    }
    let d = v - (f32(l) + 0.5);
    let w = u.bw + u.bloomW * clamp(val, 0.0, 1.0);
    acc += val * exp(-(d * d) / (2.0 * w * w)) / (w * 2.5066);
    if (abs(d) < bestD) { bestD = abs(d); nearest = val; }
  }
  return mix(nearest, acc, u.scan);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var c = uv * 2.0 - 1.0;
  c = c * (1.0 - u.overscan * 2.0);
  let wc = vec2f(c.x * (1.0 + u.curve.x * c.y * c.y * 2.0), c.y * (1.0 + u.curve.y * c.x * c.x * 2.0));
  let wuv = wc * 0.5 + 0.5;
  let sd = sdRound(wc, vec2f(1.0), u.corner * 2.0);
  let cover = 1.0 - smoothstep(-u.edge * 2.0, 0.0, sd);
  let dir = wc;
  var rgb = vec3f(0.0);
  let cs = vec2f(u.conv) / u.size;
  let uvR = wuv + dir * cs;
  let uvB = wuv - dir * cs;
  if (cover > 0.0) {
    rgb.r = scanChannel(clamp(uvR.y, 0.0, 1.0) * u.lines, clamp(uvR.x, 0.0, 1.0), 0);
    rgb.g = scanChannel(clamp(wuv.y, 0.0, 1.0) * u.lines, clamp(wuv.x, 0.0, 1.0), 1);
    rgb.b = scanChannel(clamp(uvB.y, 0.0, 1.0) * u.lines, clamp(uvB.x, 0.0, 1.0), 2);
    rgb = rgb * maskWeights(px);
  } else if (u.bezel > 0.0) {
    // faint mirror image of the picture edge on the bezel
    let m = 1.0 - abs(1.0 - abs(wuv));
    let dist = length(max(abs(wc) - vec2f(1.0), vec2f(0.0)));
    let fade = exp(-dist * 9.0) * u.bezel * 0.18;
    rgb = vec3f(scanChannel(m.y * u.lines, m.x, 0), scanChannel(m.y * u.lines, m.x, 1), scanChannel(m.y * u.lines, m.x, 2)) * fade;
  }
  return vec4f(rgb, cover);
}`,
    });

    // --- (e) glow and halation, from the bright part of the tube -----------------------------
    const needGlow = p.glow > 0 || p.halation > 0;
    let glowTex: ImageValue | null = null;
    let haloTex: ImageValue | null = null;
    if (needGlow) {
      const bright = gpu.pass({
        label: 'crt-bright',
        size: out,
        textures: { tube },
        uniforms: {},
        wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let t = textureSampleLevel(tube, smpNearest, uv, 0.0).rgb;
  let b = max(t - vec3f(0.12), vec3f(0.0));
  return vec4f(pow(clamp(b, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}`,
      });
      if (p.glow > 0) glowTex = gaussianBlur(gpu, bright, p.glowRadius * scale);
      if (p.halation > 0) haloTex = gaussianBlur(gpu, bright, Math.max(p.glowRadius * 6, 12) * scale);
    }

    // --- (g)(h) colour, vignette, glare, noise, hum, display encode --------------------------
    const hasNoise = p.noise > 0;
    const hasHum = p.hum > 0;
    const frame = hasNoise ? loopFrame(ctx.time) : 0;
    const phase = hasHum ? ctx.time.phase : 0;
    const gain = temperatureGain(p.colorTemp as number);
    const image = gpu.pass({
      label: 'crt-display',
      size: out,
      textures: { tube, glowTex, haloTex },
      uniforms: {
        glow: glowTex ? p.glow : 0,
        halation: haloTex ? p.halation : 0,
        gain,
        bright: p.brightness,
        black: p.blackLevel,
        contrast: p.contrast,
        sat: p.saturation,
        vig: p.vignette,
        glare: p.glare,
        noise: p.noise,
        frame,
        hum: p.hum,
        humPos: hasHum ? (phase * Math.round(p.humCycles as number)) % 1 : 0,
        black2: p.blackOutside,
      },
      wgsl: /* wgsl */ `${SOFTCLIP_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let t = textureSampleLevel(tube, smpNearest, uv, 0.0);
  var x = t.rgb;
  ${glowTex ? 'x += pow(textureSampleLevel(glowTex, smp, uv, 0.0).rgb, vec3f(2.2)) * u.glow;' : ''}
  ${haloTex ? 'x += pow(textureSampleLevel(haloTex, smp, uv, 0.0).rgb, vec3f(2.2)) * vec3f(1.0, 0.42, 0.3) * u.halation * 0.8;' : ''}
  let c = uv * 2.0 - 1.0;
  x = x * u.gain * u.bright;
  let l = luma(x);
  x = mix(vec3f(l), x, u.sat);
  x = x * (1.0 - u.vig * smoothstep(0.35, 1.35, length(c)));
  if (u.hum > 0.0) {
    let d = fract(uv.y - u.humPos + 0.5) - 0.5;
    x = x * (1.0 - u.hum * 0.4 * exp(-(d * d) / (2.0 * 0.06 * 0.06)));
  }
  if (u.glare > 0.0) {
    let g = c - vec2f(-0.5, -0.55);
    x += vec3f(u.glare * 0.10 * exp(-dot(g * vec2f(1.0, 1.6), g * vec2f(1.0, 1.6)) * 3.2));
  }
  x += vec3f(u.black * 0.05);
  var e = pow(softClip(max(x, vec3f(0.0))), vec3f(1.0 / 2.2));
  e = (e - 0.5) * u.contrast + 0.5;
  if (u.noise > 0.0) { e += (hash31(vec3f(px, u.frame)) - 0.5) * u.noise * 0.25; }
  e = clamp(e, vec3f(0.0), vec3f(1.0));
  if (u.black2 > 0.5) { return vec4f(e * t.a + select(vec3f(0.0), e, t.a <= 0.0), 1.0); }
  return vec4f(e * t.a, t.a);
}`,
    });
    return { image };
  },
});
