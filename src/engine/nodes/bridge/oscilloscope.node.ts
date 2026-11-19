import { defineNode } from '../../define';
import { defineAudio } from '../../audio/types';
import { dbToLin } from '../../audio/dsp';

/** Points of the wave handed from the sound side to the picture side. */
export const SCOPE_POINTS = 96;
const RING = 32768; // samples kept (power of two): twice the longest window, so a trigger point can be looked for
const MASK = RING - 1;
const NAMES = Array.from({ length: SCOPE_POINTS }, (_, i) => `p${i}`);

/**
 * Oscilloscope: draws the wave of a sound as a glowing line, like the screen of a sampler or a lab scope.
 *
 * Sound side (`audio`, runs in the AudioWorklet): keeps the last half second of the sound and, a hundred times a second,
 * publishes one screenful of it as 96 numbers. With Steady on, the screenful starts where the wave crosses zero going up,
 * which is what makes a held note stand still instead of sliding sideways. Each number is the strongest sample of its
 * slice of time, so a long window still shows the outline of the sound instead of a random thin trace.
 * Picture side (`render`): reads the 96 numbers through `Host.signal` and draws the line with its glow.
 * This file must only import audio code: it is bundled into the AudioWorklet.
 */
export default defineNode({
  id: 'oscilloscope',
  title: 'Oscilloscope',
  category: 'generate',
  description: 'Draws the wave of a sound as a glowing line, like the screen of a sampler or an oscilloscope. Wire any sound in: a clip, the microphone, a synth.',
  keywords: ['waveform', 'scope', 'audio', 'sound', 'wave', 'visualizer', 'visualiser', 'audio reactive', 'music', 'line', 'sampler', 'sp-404', 'lissajous', 'audio to video', 'meter', 'signal'],
  inputs: { audio: { type: 'audio', label: 'Sound' }, size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    gain: { type: 'number', default: 6, min: -24, max: 48, step: 0.5, unit: 'db', label: 'Input boost', hint: 'How tall the wave is drawn.' },
    window: { type: 'number', default: 25, min: 2, max: 250, step: 1, label: 'Time shown ms', hint: 'How much sound fits across the screen. Short: single waves. Long: the outline of the sound.' },
    steady: { type: 'bool', default: true, label: 'Steady', hint: 'Starts the picture where the wave crosses zero going up, so a held note stands still.' },
    style: {
      type: 'enum',
      default: 'line',
      options: [
        { value: 'line', label: 'Line' },
        { value: 'filled', label: 'Filled' },
        { value: 'mirror', label: 'Mirrored' },
        { value: 'dots', label: 'Dots' },
      ],
      label: 'Style',
    },
    direction: { type: 'enum', default: 'across', options: [{ value: 'across', label: 'Left to right' }, { value: 'down', label: 'Top to bottom' }], label: 'Direction' },
    thickness: { type: 'number', default: 3, min: 0.5, max: 40, step: 0.5, unit: 'px', label: 'Thickness' },
    glow: { type: 'number', default: 0.6, min: 0, max: 2, step: 0.01, label: 'Glow' },
    glowSize: { type: 'number', default: 14, min: 1, max: 120, step: 1, unit: 'px', label: 'Glow size' },
    pixels: { type: 'number', default: 0, min: 0, max: 64, step: 1, unit: 'px', label: 'Pixel size', hint: 'Above 0 the line is drawn in blocks, like a small low-resolution screen.' },
    color: { type: 'color', default: [0.82, 0.88, 1, 1], label: 'Line color' },
    glowColor: { type: 'color', default: [0.25, 0.45, 1, 1], label: 'Glow color' },
    background: { type: 'color', default: [0, 0, 0, 1], label: 'Background', hint: 'Lower its alpha to put the scope over another picture.' },
  },
  summary: (p) => `${p.style} · ${p.window} ms`,
  audio: defineAudio({
    create: (ctx) => ({ ring: new Float32Array(RING), n: 0, since: 0, every: Math.max(64, Math.round(ctx.sampleRate / 100)) }),
    process(st, io) {
      const p = io.params;
      const src = io.in.audio;
      const frames = io.frames;
      const g = dbToLin(p.gain);
      for (let i = 0; i < frames; i++) st.ring[(st.n + i) & MASK] = src ? (src[0][i] + src[1][i]) * 0.5 * g : 0;
      st.n += frames;
      st.since += frames;
      if (st.since < st.every) return;
      st.since = 0;
      const w = Math.min(RING / 2 - 1, Math.max(SCOPE_POINTS, Math.round((p.window / 1000) * io.sampleRate)));
      let start = st.n - w;
      if (p.steady) {
        // the latest upward zero crossing that still leaves a whole window after it
        for (let j = st.n - w; j > st.n - 2 * w && j > 0; j--) {
          if (st.ring[(j - 1) & MASK] < 0 && st.ring[j & MASK] >= 0) {
            start = j;
            break;
          }
        }
      }
      if (start < 0) start = 0;
      const step = w / SCOPE_POINTS;
      for (let k = 0; k < SCOPE_POINTS; k++) {
        const a = Math.floor(start + k * step);
        const b = Math.max(a + 1, Math.floor(start + (k + 1) * step));
        let best = 0;
        for (let j = a; j < b; j++) {
          const v = st.ring[j & MASK];
          if (Math.abs(v) > Math.abs(best)) best = v;
        }
        io.signal(NAMES[k], best < -1 ? -1 : best > 1 ? 1 : best);
      }
    },
  }),
  render(ctx) {
    const p = ctx.params;
    const t = ctx.time.seconds; // reading the clock makes this node re-render every frame
    const data = new Float32Array(SCOPE_POINTS * 4);
    for (let k = 0; k < SCOPE_POINTS; k++) data[k * 4] = ctx.host.signal?.(ctx.nodeId, NAMES[k], t) ?? 0;
    const wave = ctx.gpu.dataTexture(data, SCOPE_POINTS, 1);
    const size = ctx.in.size ?? ctx.canvas;
    const down = p.direction === 'down';
    const along = down ? size.height : size.width;
    // how many neighbouring pieces of the line a pixel can be near: the glow radius, in points
    const reach = Math.min(24, Math.ceil(((p.glow > 0 ? p.glowSize * 3 : 0) + p.thickness + p.pixels) / Math.max(1, along / (SCOPE_POINTS - 1))) + 1);
    const image = ctx.gpu.pass({
      label: 'oscilloscope',
      size,
      textures: { wave },
      uniforms: {
        n: SCOPE_POINTS,
        down,
        style: p.style === 'filled' ? 1 : p.style === 'mirror' ? 2 : p.style === 'dots' ? 3 : 0,
        thick: Math.max(0.25, p.thickness / 2),
        glow: p.glow,
        glowSize: Math.max(0.5, p.glowSize),
        cell: p.pixels,
        reach,
        color: p.color,
        glowColor: p.glowColor,
        bg: p.background,
      },
      wgsl: /* wgsl */ `
fn wv(i: i32) -> f32 { return textureLoad(wave, vec2i(clamp(i, 0, i32(u.n) - 1), 0), 0).r; }
// position of point i in pixels: along the screen, and up or down from the middle by its value
fn pt(i: i32, sz: vec2f) -> vec2f { return vec2f(f32(i) / (u.n - 1.0) * sz.x, (0.5 - 0.46 * wv(i)) * sz.y); }
fn segDist(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let h = clamp(dot(p - a, ab) / max(dot(ab, ab), 0.0001), 0.0, 1.0);
  return length(p - a - ab * h);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var q = px;
  if (u.cell >= 1.0) { q = (floor(px / u.cell) + 0.5) * u.cell; }
  var sz = u.size;
  if (u.down > 0.5) { q = q.yx; sz = sz.yx; }
  let fi = q.x / sz.x * (u.n - 1.0);
  let i0 = i32(floor(fi));
  let r = i32(u.reach);
  var d = 1.0e9;
  for (var k = -r; k <= r; k++) {
    let i = i0 + k;
    if (i < 0 || i >= i32(u.n) - 1) { continue; }
    let a = pt(i, sz);
    let b = pt(i + 1, sz);
    if (u.style > 2.5) { d = min(d, length(q - a)); } else { d = min(d, segDist(q, a, b)); }
    if (u.style > 1.5 && u.style < 2.5) {
      // mirrored: the same wave upside down
      d = min(d, segDist(q, vec2f(a.x, sz.y - a.y), vec2f(b.x, sz.y - b.y)));
    }
  }
  let aa = max(1.0, u.cell * 0.02);
  var line = 1.0 - smoothstep(u.thick - aa * 0.5, u.thick + aa * 0.5, d);
  if (u.cell >= 1.0) { line = step(d, u.thick + u.cell * 0.35); }
  var halo = exp(-max(d - u.thick, 0.0) / u.glowSize) * u.glow;
  // filled / mirrored: the area between the wave and the middle line glows faintly
  if (u.style > 0.5 && u.style < 2.5) {
    let v = mix(wv(i0), wv(i0 + 1), fract(fi));
    let y = (0.5 - 0.46 * v) * sz.y;
    let mid = 0.5 * sz.y;
    // within the wave's distance from the middle, and (unless mirrored) on the wave's side of it
    var inside = step(abs(q.y - mid), abs(y - mid));
    if (u.style < 1.5 && (q.y - mid) * (y - mid) < 0.0) { inside = 0.0; }
    halo = max(halo, inside * 0.45);
  }
  let light = u.color.rgb * line + u.glowColor.rgb * min(halo, 1.0) * (1.0 - line);
  let la = clamp(max(line, min(halo, 1.0)), 0.0, 1.0);
  // light over the background
  let bg = premul(u.bg);
  let rgb = min(bg.rgb * (1.0 - line) + light, vec3f(1.0));
  let a = clamp(bg.a + la * (1.0 - bg.a), 0.0, 1.0);
  return vec4f(min(rgb, vec3f(a)), a);
}`,
    });
    return { image };
  },
});
