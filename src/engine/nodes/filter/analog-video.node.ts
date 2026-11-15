import { defineNode } from '../../define';
import { YIQ_WGSL } from '../../lib/fx-video';
import { loopFrame } from '../../lib/fx-util';

/** Parameter bundles for the look presets. A preset overrides the controls it lists; choose Custom to use them all as set. */
const PRESETS: Record<string, Record<string, number>> = {
  console: { composite: 0.85, subcarrier: 2.4, chromaBlur: 2.5, chromaShift: 1, lumaBlur: 0.5, ringing: 0.25, ringWidth: 1.5, ghost: 0, jitter: 0, wobble: 0, noise: 0.02, colorNoise: 0, tracking: 0, headSwitch: 0, dropouts: 0, wrinkle: 0, tearing: 0 },
  rf: { composite: 0.6, subcarrier: 2.8, chromaBlur: 4, chromaShift: 2, lumaBlur: 1, ringing: 0.3, ringWidth: 2, ghost: 0.25, ghostDelay: 14, jitter: 0.5, wobble: 0.5, noise: 0.16, colorNoise: 0.25, tracking: 0, headSwitch: 0, dropouts: 0, wrinkle: 0, tearing: 0 },
  vhs: { composite: 0.25, subcarrier: 3, chromaBlur: 7, chromaShift: 4, lumaBlur: 1.2, ringing: 0.2, ringWidth: 2, ghost: 0, jitter: 0.6, wobble: 0.6, noise: 0.08, colorNoise: 0.12, tracking: 0.25, headSwitch: 0.8, dropouts: 0.25, wrinkle: 0, tearing: 0 },
  wornVhs: { composite: 0.35, subcarrier: 3, chromaBlur: 9, chromaShift: 6, lumaBlur: 1.8, ringing: 0.35, ringWidth: 2.5, ghost: 0.15, ghostDelay: 10, jitter: 1.2, wobble: 1.2, noise: 0.18, colorNoise: 0.25, tracking: 0.6, headSwitch: 1, dropouts: 0.7, wrinkle: 0.6, tearing: 0.3 },
  broadcast: { composite: 0.15, subcarrier: 3, chromaBlur: 1.2, chromaShift: 0.3, lumaBlur: 0, ringing: 0.1, ringWidth: 1.5, ghost: 0, jitter: 0, wobble: 0, noise: 0, colorNoise: 0, tracking: 0, headSwitch: 0, dropouts: 0, wrinkle: 0, tearing: 0 },
};

export default defineNode({
  id: 'analog-video',
  title: 'Analog Video',
  category: 'stylize',
  description:
    'Degrades the picture the way an analogue video signal would, before it reaches the screen: colour bleed, ringing, composite rainbow and dot crawl, ghosting, line jitter, tracking noise, tape dropouts and more. Feed the result into CRT Display.',
  keywords: ['vhs', 'composite', 'ntsc', 'tape', 'rf', 'signal', 'chroma', 'dot crawl', 'rainbow', 'jitter', 'tracking', 'glitch', 'retro', 'console', 'dropout'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    preset: {
      type: 'enum',
      default: 'custom',
      label: 'Look',
      hint: 'A preset overrides the controls it lists. Choose Custom to use every control below as set.',
      options: [
        { value: 'custom', label: 'Custom (use the controls)' },
        { value: 'console', label: 'Composite (console)' },
        { value: 'rf', label: 'RF (noisy)' },
        { value: 'vhs', label: 'VHS' },
        { value: 'wornVhs', label: 'Worn VHS' },
        { value: 'broadcast', label: 'Broadcast clean' },
      ],
    },
    animate: { type: 'bool', default: false, label: 'Animate (new noise every frame)', hint: 'Off = one frozen frame of noise and jitter. On = changes every frame and loops with the project.' },
    composite: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'Composite artefacts', group: 'Signal', hint: 'Rainbow fringes on fine patterns and dither, like an NTSC console.' },
    subcarrier: { type: 'number', default: 2.4, min: 1.5, max: 8, step: 0.05, unit: 'px', label: 'Subcarrier period', group: 'Signal', hint: 'Pixels per colour-carrier cycle. Closer to 2 turns a one-pixel checkerboard into solid colour.' },
    dotCrawl: { type: 'bool', default: false, label: 'Dot crawl', group: 'Signal', hint: 'The carrier pattern flips every frame (needs Animate).' },
    chromaBlur: { type: 'number', default: 2, min: 0, max: 40, softMax: 20, step: 0.1, unit: 'px', label: 'Colour bandwidth blur', group: 'Signal' },
    chromaShift: { type: 'number', default: 0.8, min: -30, max: 30, softMax: 12, step: 0.1, unit: 'px', label: 'Colour delay', group: 'Signal', hint: 'Colour arrives late and smears to the right.' },
    lumaBlur: { type: 'number', default: 0.4, min: 0, max: 12, softMax: 6, step: 0.1, unit: 'px', label: 'Brightness blur', group: 'Signal' },
    ringing: { type: 'number', default: 0.2, min: 0, max: 1.5, step: 0.01, label: 'Ringing / halos', group: 'Signal' },
    ringWidth: { type: 'number', default: 1.5, min: 0.5, max: 8, softMax: 5, step: 0.1, unit: 'px', label: 'Ringing width', group: 'Signal' },
    ghost: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Ghosting', group: 'Reception', hint: 'A faint delayed copy of the picture.' },
    ghostDelay: { type: 'number', default: 12, min: -200, max: 200, softMax: 80, step: 0.5, unit: 'px', label: 'Ghost offset', group: 'Reception' },
    noise: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Noise', group: 'Reception' },
    colorNoise: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Colour noise', group: 'Reception' },
    jitter: { type: 'number', default: 0, min: 0, max: 20, softMax: 8, step: 0.05, unit: 'px', label: 'Line jitter', group: 'Tape' },
    wobble: { type: 'number', default: 0, min: 0, max: 40, softMax: 12, step: 0.05, unit: 'px', label: 'Line wobble', group: 'Tape' },
    wobbleCycles: { type: 'number', default: 0, min: 0, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Wobble drift (per loop)', group: 'Tape', hint: '0 = the wobble stands still.', visibleIf: (p) => (p.wobble as number) > 0 },
    tracking: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Tracking noise band', group: 'Tape' },
    trackPos: { type: 'number', default: 0.8, min: 0, max: 1, step: 0.01, unit: 'norm', label: 'Tracking band position', group: 'Tape', visibleIf: (p) => (p.tracking as number) > 0 },
    trackCycles: { type: 'number', default: 0, min: 0, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Tracking band rolls (per loop)', group: 'Tape', visibleIf: (p) => (p.tracking as number) > 0 },
    headSwitch: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Head-switching noise', group: 'Tape', hint: 'The ragged strip at the bottom of VHS pictures.' },
    dropouts: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Tape dropouts', group: 'Tape', hint: 'Short white horizontal streaks.' },
    wrinkle: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Tape wrinkle', group: 'Tape', hint: 'The bottom edge bends sideways.' },
    tearing: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Tearing', group: 'Sync' },
    tearPos: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, unit: 'norm', label: 'Tear position', group: 'Sync', visibleIf: (p) => (p.tearing as number) > 0 },
    rollOffset: { type: 'number', default: 0, min: 0, max: 1, step: 0.005, unit: 'norm', label: 'Vertical hold offset', group: 'Sync' },
    rollCycles: { type: 'number', default: 0, min: 0, max: 8, step: 1, integer: true, unit: 'cycles', label: 'Vertical roll (per loop)', group: 'Sync', hint: 'Whole rolls per loop. 0 = steady picture.' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed' },
  },
  summary: (p) => (p.preset !== 'custom' ? p.preset : `composite ${Math.round(p.composite * 100)}%`),
  render(ctx) {
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const p = { ...ctx.params } as Record<string, number | string | boolean> & typeof ctx.params;
    if (p.preset !== 'custom') {
      // preset values are authored in unit pixels; convert the length ones like the kernel does
      const lengths = ['subcarrier', 'chromaBlur', 'chromaShift', 'lumaBlur', 'ringWidth', 'ghostDelay', 'jitter', 'wobble'];
      for (const [k, v] of Object.entries(PRESETS[p.preset] ?? {})) p[k] = lengths.includes(k) ? v * src.unit : v;
    }
    const unit = src.unit;
    const clean =
      p.composite <= 0 && p.chromaBlur < 0.05 && p.chromaShift === 0 && p.lumaBlur < 0.05 && p.ringing <= 0 && p.ghost <= 0 && p.noise <= 0 && p.colorNoise <= 0 &&
      p.jitter <= 0 && p.wobble <= 0 && p.tracking <= 0 && p.headSwitch <= 0 && p.dropouts <= 0 && p.wrinkle <= 0 && p.tearing <= 0 && p.rollCycles === 0 && p.rollOffset === 0;
    if (clean) return { image: src };

    const animate = p.animate === true;
    const frame = animate ? loopFrame(ctx.time) : 0;
    const crawl = animate && p.dotCrawl ? (frame % 2) * Math.PI : 0;
    let current = src;

    // 1. composite encode + decode: the source of rainbowing and dot crawl
    if (p.composite > 0) {
      const period = Math.max(1.2, p.subcarrier);
      const taps = Math.min(16, Math.ceil(period * 2));
      current = gpu.pass({
        label: 'analog-composite',
        size: src,
        format: 'rgba16float',
        textures: { src: current },
        uniforms: { amount: p.composite, period, taps, crawl },
        wgsl: /* wgsl */ `${YIQ_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let centre = textureSampleLevel(src, smpNearest, uv, 0.0);
  let x0 = floor(px.x);
  let row = floor(px.y);
  let lp = PI * row + u.crawl;
  let n = i32(u.taps);
  let ry = u.period;
  var yAcc = 0.0; var yW = 0.0; var iAcc = 0.0; var qAcc = 0.0; var cW = 0.0;
  for (var k = -n; k <= n; k++) {
    let xk = x0 + f32(k);
    let s = unpremul(textureSampleLevel(src, smpNearest, vec2f((xk + 0.5) / u.size.x, uv.y), 0.0));
    let yiq = rgbToYiq(s.rgb);
    let ph = TAU * xk / u.period + lp;
    let comp = yiq.x + yiq.y * cos(ph) + yiq.z * sin(ph);
    let wc = 0.5 + 0.5 * cos(PI * f32(k) / f32(n + 1));
    let wy = select(0.0, 0.5 + 0.5 * cos(PI * f32(k) / (ry + 1.0)), abs(f32(k)) <= ry);
    yAcc += comp * wy; yW += wy;
    iAcc += comp * cos(ph) * wc; qAcc += comp * sin(ph) * wc; cW += wc;
  }
  let dec = clamp(yiqToRgb(vec3f(yAcc / yW, 2.0 * iAcc / cW, 2.0 * qAcc / cW)), vec3f(0.0), vec3f(1.0));
  let orig = unpremul(centre);
  return vec4f(mix(orig.rgb, dec, u.amount) * orig.a, orig.a);
}`,
      });
    }

    // 2. bandwidth: chroma smear and delay, luma softening, ringing halos
    if (p.chromaBlur >= 0.05 || p.chromaShift !== 0 || p.lumaBlur >= 0.05 || p.ringing > 0) {
      const cs = Math.max(p.chromaBlur, 0.3);
      const ls = Math.max(p.lumaBlur, 0.3);
      const rs = Math.max(p.ringWidth, 0.5);
      const step = Math.max(1, Math.max(cs, ls, rs) * 3 / 18);
      current = gpu.pass({
        label: 'analog-bandwidth',
        size: src,
        format: 'rgba16float',
        textures: { src: current },
        uniforms: { cs, ls, rs, shift: p.chromaShift, step, ring: p.ringing, cOn: p.chromaBlur >= 0.05 || p.chromaShift !== 0, lOn: p.lumaBlur >= 0.05 },
        wgsl: /* wgsl */ `${YIQ_WGSL}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let centre = textureSampleLevel(src, smpNearest, uv, 0.0);
  let c0 = unpremul(centre);
  var yL = 0.0; var yR = 0.0; var wL = 0.0; var wR = 0.0; var iq = vec2f(0.0); var wC = 0.0;
  for (var k = -18; k <= 18; k++) {
    let off = f32(k) * u.step;
    let s = unpremul(textureSampleLevel(src, smpNearest, vec2f(uv.x + off / u.size.x, uv.y), 0.0));
    let yiq = rgbToYiq(s.rgb);
    let wl = exp(-(off * off) / (2.0 * u.ls * u.ls));
    let wr = exp(-(off * off) / (2.0 * u.rs * u.rs));
    yL += yiq.x * wl; wL += wl;
    yR += yiq.x * wr; wR += wr;
    // chroma comes from a position delayed by 'shift' texels
    let offc = off - u.shift;
    let sc = unpremul(textureSampleLevel(src, smpNearest, vec2f(uv.x + (offc) / u.size.x, uv.y), 0.0));
    let wcw = exp(-(off * off) / (2.0 * u.cs * u.cs));
    iq += rgbToYiq(sc.rgb).yz * wcw; wC += wcw;
  }
  let own = rgbToYiq(c0.rgb);
  var y = own.x;
  if (u.lOn > 0.5) { y = yL / wL; }
  y = y + u.ring * (y - yR / wR);
  var c = own.yz;
  if (u.cOn > 0.5) { c = iq / wC; }
  let rgb = clamp(yiqToRgb(vec3f(y, c)), vec3f(0.0), vec3f(1.0));
  return vec4f(rgb * c0.a, c0.a);
}`,
      });
    }

    // 3. reception and tape: ghosts, noise, jitter, tracking, dropouts, wrinkle, tearing, roll
    const needs =
      p.ghost > 0 || p.noise > 0 || p.colorNoise > 0 || p.jitter > 0 || p.wobble > 0 || p.tracking > 0 || p.headSwitch > 0 || p.dropouts > 0 || p.wrinkle > 0 || p.tearing > 0 || p.rollCycles > 0 || p.rollOffset > 0;
    if (needs) {
      const phase = animate ? ctx.time.phase : 0;
      const roll = (p.rollOffset as number) + (animate ? phase * Math.round(p.rollCycles as number) : 0);
      current = gpu.pass({
        label: 'analog-tape',
        size: src,
        textures: { src: current },
        uniforms: {
          ghost: p.ghost,
          ghostDelay: p.ghostDelay,
          noise: p.noise,
          cnoise: p.colorNoise,
          jitter: p.jitter,
          wobble: p.wobble,
          wobbleScale: Math.max(8, src.height * 0.18),
          wobblePhase: animate ? ctx.time.phase * Math.PI * 2 * Math.round(p.wobbleCycles as number) : 0,
          tracking: p.tracking,
          trackPos: ((p.trackPos as number) + (animate ? ctx.time.phase * Math.round(p.trackCycles as number) : 0)) % 1,
          head: p.headSwitch,
          dropouts: p.dropouts,
          wrinkle: p.wrinkle,
          tearing: p.tearing,
          tearPos: p.tearPos,
          roll,
          frame: frame * 1.37 + (p.seed as number) * 11.1,
          unitPx: unit,
          chromaCell: Math.max(1, p.chromaBlur),
        },
        wgsl: /* wgsl */ `${YIQ_WGSL}
fn sampleAt(x: f32, y: f32) -> vec4f {
  return textureSampleLevel(src, smp, vec2f(x / u.size.x, y / u.size.y), 0.0);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let row = floor(px.y);
  var vy = uv.y;
  var dx = 0.0;
  var noiseBoost = 0.0;
  var sat = 1.0;
  // vertical hold roll with a dark sync bar at the seam
  var rollBar = 0.0;
  if (u.roll != 0.0) {
    vy = fract(uv.y + u.roll);
    let d = abs(fract(uv.y + u.roll + 0.5) - 0.5);
    rollBar = 1.0 - smoothstep(0.0, 0.02, d);
  }
  let yy = vy * u.size.y;
  dx += (hash21(vec2f(row, u.frame + 3.1)) - 0.5) * 2.0 * u.jitter;
  dx += sin(row * TAU / u.wobbleScale + u.wobblePhase) * u.wobble;
  // tape wrinkle: the bottom edge bends sideways
  let wr = smoothstep(0.8, 1.0, uv.y);
  dx += u.wrinkle * wr * wr * 14.0 * u.unitPx * sin(uv.y * 40.0 + hash21(vec2f(1.0, u.frame)) * 3.0);
  // tearing band
  let tb = abs(uv.y - u.tearPos);
  if (u.tearing > 0.0 && tb < 0.05) {
    dx += u.tearing * 40.0 * u.unitPx * (1.0 - tb / 0.05) * (0.5 + hash21(vec2f(row, u.frame)));
  }
  // tracking noise band
  let tk = abs(fract(uv.y - u.trackPos + 0.5) - 0.5);
  if (u.tracking > 0.0 && tk < 0.045) {
    let f = 1.0 - tk / 0.045;
    dx += (hash21(vec2f(row, u.frame + 7.7)) - 0.5) * u.tracking * 30.0 * u.unitPx * f;
    noiseBoost += u.tracking * f * 0.8;
    sat = sat * (1.0 - 0.6 * f * u.tracking);
  }
  // head switching strip at the bottom
  let hs = smoothstep(0.972, 0.985, uv.y);
  if (u.head > 0.0 && hs > 0.0) {
    dx += (hash21(vec2f(row, u.frame + 1.3)) - 0.5) * u.head * 60.0 * u.unitPx * hs;
    noiseBoost += u.head * hs * 0.6;
  }
  var c = sampleAt(px.x + dx, yy);
  var rgb = unpremul(c).rgb;
  if (u.ghost > 0.0) {
    let g1 = unpremul(sampleAt(px.x + dx - u.ghostDelay, yy)).rgb;
    let g2 = unpremul(sampleAt(px.x + dx - u.ghostDelay * 2.0, yy)).rgb;
    rgb = rgb + (g1 * 0.6 + g2 * 0.25) * u.ghost - rgb * u.ghost * 0.15;
  }
  var yiq = rgbToYiq(clamp(rgb, vec3f(0.0), vec3f(1.5)));
  yiq.y = yiq.y * sat; yiq.z = yiq.z * sat;
  if (u.cnoise > 0.0) {
    let cell = floor(px.x / u.chromaCell);
    yiq.y += (hash21(vec2f(cell, row + u.frame)) - 0.5) * u.cnoise * 0.5;
    yiq.z += (hash21(vec2f(cell + 91.0, row + u.frame)) - 0.5) * u.cnoise * 0.5;
  }
  let n = hash31(vec3f(px, u.frame)) - 0.5;
  yiq.x += n * (u.noise * 0.35 + noiseBoost);
  var out = clamp(yiqToRgb(yiq), vec3f(0.0), vec3f(1.0));
  // tape dropouts: short bright streaks
  if (u.dropouts > 0.0) {
    let seg = floor(px.x / (48.0 * u.unitPx));
    let h = hash31(vec3f(row, seg, u.frame + 17.0));
    if (h < u.dropouts * 0.012) {
      let start = hash21(vec2f(row, seg)) * 20.0 * u.unitPx;
      let len = (10.0 + hash21(vec2f(seg, row + 5.0)) * 26.0) * u.unitPx;
      let rel = px.x - seg * 48.0 * u.unitPx;
      if (rel > start && rel < start + len) { out = mix(out, vec3f(1.0), 0.92); }
    }
  }
  out = out * (1.0 - rollBar * 0.9);
  return premul(vec4f(out, c.a));
}`,
      });
    }
    return { image: current };
  },
});
