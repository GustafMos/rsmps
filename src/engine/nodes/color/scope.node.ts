import { defineNode } from '../../define';
import { REC709_LUMA } from '../../lib/color-math';
import { fl } from '../../lib/color-wgsl';

const KR = REC709_LUMA[0];
const KB = REC709_LUMA[2];
const HEADER = /* wgsl */ `
struct P { w: u32, h: u32, sx: u32, sy: u32, mode: u32, grat: u32, gain: f32, pad: f32 };
@group(0) @binding(0) var<uniform> p: P;
`;

/** Pass 1: one thread per sample of the (already decimated) picture, one atomic add per bin. */
const ACCUMULATE = /* wgsl */ `${HEADER}
@group(0) @binding(1) var smallTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> bins: array<atomic<u32>>;
fn lvl(v: f32) -> u32 { return u32(clamp(v, 0.0, 1.0) * f32(p.h - 1u) + 0.5); }
fn addAt(plane: u32, x: u32, y: u32) {
  if (x < p.w && y < p.h) { atomicAdd(&bins[plane * p.w * p.h + y * p.w + x], 1u); }
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.sx || id.y >= p.sy) { return; }
  let c = textureLoad(smallTex, vec2i(id.xy), 0);
  let rgb = clamp(c.rgb, vec3f(0.0), vec3f(1.0));
  let y = dot(rgb, vec3f(${fl(REC709_LUMA[0])}, ${fl(REC709_LUMA[1])}, ${fl(REC709_LUMA[2])}));
  let top = p.h - 1u;
  if (p.mode == 0u) {
    addAt(0u, id.x, top - lvl(y));
  } else if (p.mode == 1u) {
    for (var ch = 0u; ch < 3u; ch++) { addAt(1u + ch, id.x, top - lvl(rgb[ch])); }
  } else if (p.mode == 2u) {
    let third = p.w / 3u;
    for (var ch = 0u; ch < 3u; ch++) { addAt(1u + ch, ch * third + id.x / 3u, top - lvl(rgb[ch])); }
  } else if (p.mode == 3u) {
    addAt(0u, u32(clamp(y, 0.0, 1.0) * 255.0 + 0.5), 0u);
  } else if (p.mode == 4u) {
    for (var ch = 0u; ch < 3u; ch++) { addAt(1u + ch, u32(clamp(rgb[ch], 0.0, 1.0) * 255.0 + 0.5), 0u); }
  } else {
    let cb = (rgb.b - y) / ${fl(2 * (1 - KB))};
    let cr = (rgb.r - y) / ${fl(2 * (1 - KR))};
    let x = u32(clamp(cb + 0.5, 0.0, 1.0) * f32(p.w - 1u) + 0.5);
    let yy = u32(clamp(0.5 - cr, 0.0, 1.0) * f32(p.h - 1u) + 0.5);
    addAt(0u, x, yy);
  }
}`;

/** Pass 2: one thread per output pixel turns the bins into the picture (with a little smoothing and the graticule). */
const DRAW = /* wgsl */ `${HEADER}
@group(0) @binding(1) var<storage, read> bins: array<u32>;
@group(0) @binding(2) var outTex: texture_storage_2d<rgba8unorm, write>;
fn cnt(plane: u32, x: i32, y: i32) -> f32 {
  let xx = u32(clamp(x, 0, i32(p.w) - 1));
  let yy = u32(clamp(y, 0, i32(p.h) - 1));
  return f32(bins[plane * p.w * p.h + yy * p.w + xx]);
}
fn vsmooth(plane: u32, x: i32, y: i32) -> f32 { return 0.25 * cnt(plane, x, y - 1) + 0.5 * cnt(plane, x, y) + 0.25 * cnt(plane, x, y + 1); }
fn tent(plane: u32, x: i32, y: i32) -> f32 {
  var s = 0.0;
  for (var j = -1; j <= 1; j++) { for (var i = -1; i <= 1; i++) {
    s += cnt(plane, x + i, y + j) * (select(2.0, 1.0, i != 0) * select(2.0, 1.0, j != 0));
  } }
  return s / 16.0 * 4.0;
}
fn cbcr(c: vec3f) -> vec2f {
  let y = dot(c, vec3f(${fl(REC709_LUMA[0])}, ${fl(REC709_LUMA[1])}, ${fl(REC709_LUMA[2])}));
  return vec2f((c.b - y) / ${fl(2 * (1 - KB))}, (c.r - y) / ${fl(2 * (1 - KR))});
}
fn line(d: f32) -> f32 { return 1.0 - smoothstep(0.0, 1.0, abs(d)); }
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= p.w || id.y >= p.h) { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  let W = f32(p.w);
  let H = f32(p.h);
  var col = vec3f(0.035, 0.037, 0.045);
  var grat = 0.0;
  let nSamples = f32(p.sx * p.sy);
  if (p.mode <= 2u) {
    let norm = 24.0 / f32(p.sy);
    if (p.mode == 0u) {
      let v = 1.0 - exp(-vsmooth(0u, x, y) * p.gain * norm);
      col += v * vec3f(0.75, 0.95, 0.8);
    } else if (p.mode == 1u) {
      let v = vec3f(vsmooth(1u, x, y), vsmooth(2u, x, y), vsmooth(3u, x, y));
      col += vec3f(1.0) - exp(-v * p.gain * norm);
    } else {
      let third = i32(p.w / 3u);
      let t = min(x / max(third, 1), 2);
      let v = 1.0 - exp(-vsmooth(u32(t) + 1u, x, y) * p.gain * norm / 3.0);
      var tint = vec3f(1.0, 0.35, 0.35);
      if (t == 1) { tint = vec3f(0.35, 1.0, 0.45); }
      if (t == 2) { tint = vec3f(0.4, 0.55, 1.0); }
      col += v * tint;
      grat = max(grat, line(f32(x - t * third)) * select(0.0, 0.3, t > 0));
    }
    for (var k = 0; k <= 4; k++) { grat = max(grat, line(f32(y) - (H - 1.0) * (1.0 - f32(k) * 0.25)) * 0.2); }
  } else if (p.mode <= 4u) {
    let bin = i32(f32(x) / W * 256.0);
    let fy = (H - 1.0 - f32(y) + 0.5) / H;
    let denom = log(1.0 + nSamples * 0.1);
    if (p.mode == 3u) {
      let f = clamp(log(1.0 + cnt(0u, bin, 0) * p.gain) / denom, 0.0, 1.0);
      if (fy < f) { col += vec3f(0.62); }
    } else {
      var add = vec3f(0.0);
      for (var ch = 0; ch < 3; ch++) {
        let f = clamp(log(1.0 + cnt(u32(ch) + 1u, bin, 0) * p.gain) / denom, 0.0, 1.0);
        if (fy < f) { add[ch] = 0.7; }
      }
      col += add;
    }
    for (var k = 0; k <= 4; k++) { grat = max(grat, line(f32(x) - (W - 1.0) * f32(k) * 0.25) * 0.2); }
  } else {
    let v = 1.0 - exp(-tent(0u, x, y) * p.gain);
    let q = vec2f((f32(x) + 0.5) / W - 0.5, 0.5 - (f32(y) + 0.5) / H);
    let lum = 0.65;
    let chroma = vec3f(lum + ${fl(2 * (1 - KR))} * q.y, 0.0, lum + ${fl(2 * (1 - KB))} * q.x);
    let g = (lum - ${fl(KR)} * chroma.r - ${fl(KB)} * chroma.b) / ${fl(REC709_LUMA[1])};
    col += v * mix(vec3f(1.0), clamp(vec3f(chroma.r, g, chroma.b), vec3f(0.0), vec3f(1.0)), 0.6);
    let r = length(q) * W;
    for (var k = 1; k <= 4; k++) { grat = max(grat, line(r - 0.125 * f32(k) * W) * 0.18); }
    grat = max(grat, line((f32(x) + 0.5) - W * 0.5) * 0.12);
    grat = max(grat, line((f32(y) + 0.5) - H * 0.5) * 0.12);
    // Skin-tone line (123 degrees from +Cb toward +Cr) and 75% colour-bar targets
    let a = 2.14675498;
    let along = dot(q, vec2f(cos(a), sin(a)));
    let across = (q.x * sin(a) - q.y * cos(a)) * W;
    if (along > 0.0 && along < 0.5) { grat = max(grat, line(across) * 0.35); }
    for (var i = 0; i < 6; i++) {
      var tc = vec3f(0.75, 0.0, 0.0);
      if (i == 1) { tc = vec3f(0.75, 0.75, 0.0); }
      if (i == 2) { tc = vec3f(0.0, 0.75, 0.0); }
      if (i == 3) { tc = vec3f(0.0, 0.75, 0.75); }
      if (i == 4) { tc = vec3f(0.0, 0.0, 0.75); }
      if (i == 5) { tc = vec3f(0.75, 0.0, 0.75); }
      let cc = cbcr(tc);
      let tp = vec2f(W * 0.5 + cc.x * W, H * 0.5 - cc.y * H);
      let dd = abs(vec2f(f32(x) + 0.5, f32(y) + 0.5) - tp);
      grat = max(grat, line(max(dd.x, dd.y) - 5.0) * 0.55);
    }
  }
  if (p.grat == 0u) { grat = 0.0; }
  col = mix(col, vec3f(0.9), clamp(grat, 0.0, 1.0));
  textureStore(outTex, vec2i(id.xy), vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0));
}`;

export default defineNode({
  id: 'scope',
  title: 'Scope',
  category: 'color',
  description:
    'Draws a waveform, RGB parade, histogram or vectorscope of its input as a picture, so you can look at it in the viewer or feed it to a Picture-in-Picture. Scopes are display-referred: they read the values as stored, with Rec.709 luma and chroma.',
  keywords: ['scope', 'waveform', 'parade', 'rgb parade', 'histogram', 'vectorscope', 'vector scope', 'monitor', 'levels', 'analyse', 'analyze', 'grade', 'exposure', 'skin tone line'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Scope' } },
  params: {
    type: {
      type: 'enum',
      default: 'waveform',
      label: 'Scope',
      options: [
        { value: 'waveform', label: 'Waveform' },
        { value: 'parade', label: 'RGB parade' },
        { value: 'histogram', label: 'Histogram' },
        { value: 'vectorscope', label: 'Vectorscope' },
      ],
    },
    channels: {
      type: 'enum',
      default: 'luma',
      label: 'Channels',
      options: [
        { value: 'luma', label: 'Luma' },
        { value: 'rgb', label: 'RGB overlay' },
      ],
      visibleIf: (p) => p.type === 'waveform' || p.type === 'histogram',
    },
    resolution: { type: 'number', default: 384, min: 128, max: 1024, softMax: 768, step: 8, integer: true, label: 'Height', hint: 'Height of the scope picture; waveforms, parades and histograms are twice as wide, the vectorscope is square.' },
    samples: { type: 'number', default: 192, min: 32, max: 512, softMax: 256, step: 8, integer: true, label: 'Samples', hint: 'The picture is decimated to this many sample rows (waveform) or this many samples per side (histogram, vectorscope) before counting.' },
    gain: { type: 'number', default: 1, min: 0.1, max: 10, softMax: 6, step: 0.05, label: 'Brightness' },
    graticule: { type: 'bool', default: true, label: 'Graticule', hint: 'Reference lines: 0, 25, 50, 75 and 100%; on the vectorscope the 75% color-bar targets and the skin-tone line.' },
  },
  summary: (p) => p.type,
  render(ctx) {
    const p = ctx.params;
    const gpu = ctx.gpu;
    const device = gpu.device;
    const H = Math.round(p.resolution);
    const W = p.type === 'vectorscope' ? H : H * 2;
    const mode = p.type === 'waveform' ? (p.channels === 'rgb' ? 1 : 0) : p.type === 'parade' ? 2 : p.type === 'histogram' ? (p.channels === 'rgb' ? 4 : 3) : 5;
    const waveLike = mode <= 2;
    const SX = waveLike ? W : Math.round(p.samples);
    const SY = Math.round(p.samples);

    // Decimate with a small box filter so the counts are not aliased by a sparse point sample.
    const small = gpu.pass({
      label: 'scope-decimate',
      size: { width: SX, height: SY },
      textures: { src: ctx.in.image },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var sum = vec4f(0.0);
  let cell = 1.0 / u.size;
  for (var j = 0; j < 4; j++) {
    for (var i = 0; i < 4; i++) {
      let o = (vec2f(f32(i), f32(j)) + 0.5) / 4.0 - 0.5;
      sum += textureSampleLevel(src, smp, uv + o * cell, 0.0);
    }
  }
  return sum / 16.0;
}`,
    });
    const out = gpu.alloc(W, H, ctx.unitFor(W, H));
    const binsBytes = 4 * W * H * 4;
    const bins = gpu.scratch(binsBytes, GPUBufferUsage.STORAGE, 'scope-bins', { clear: true });
    const ubo = gpu.scratch(32, GPUBufferUsage.UNIFORM, 'scope-uniforms');
    try {
      const params = new ArrayBuffer(32);
      new Uint32Array(params).set([W, H, SX, SY, mode, p.graticule ? 1 : 0]);
      new Float32Array(params)[6] = p.gain;
      device.queue.writeBuffer(ubo, 0, params);
      const accPipe = gpu.computePipeline('scope-accumulate', ACCUMULATE);
      const drawPipe = gpu.computePipeline('scope-draw', DRAW);
      const accGroup = device.createBindGroup({
        layout: accPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ubo, size: 32 } },
          { binding: 1, resource: gpu.view(small.texture) },
          { binding: 2, resource: { buffer: bins, size: binsBytes } },
        ],
      });
      const drawGroup = device.createBindGroup({
        layout: drawPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ubo, size: 32 } },
          { binding: 1, resource: { buffer: bins, size: binsBytes } },
          { binding: 2, resource: gpu.view(out.texture) },
        ],
      });
      const encoder = device.createCommandEncoder({ label: 'scope' });
      const a = encoder.beginComputePass();
      a.setPipeline(accPipe);
      a.setBindGroup(0, accGroup);
      a.dispatchWorkgroups(Math.ceil(SX / 8), Math.ceil(SY / 8));
      a.end();
      const d = encoder.beginComputePass();
      d.setPipeline(drawPipe);
      d.setBindGroup(0, drawGroup);
      d.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8));
      d.end();
      device.queue.submit([encoder.finish()]);
    } finally {
      gpu.releaseScratch(bins);
      gpu.releaseScratch(ubo);
      gpu.recycle(small);
    }
    return { image: out };
  },
});
