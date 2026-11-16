import { defineNode } from '../../define';

/** Parameter bundles for the look presets. A preset overrides the controls it lists; choose Custom to use them all as set. */
const PRESETS: Record<string, Record<string, number | boolean>> = {
  light: { intensity: 0.6, density: 0.45, slices: 2, sliceShift: 24, sliceHeight: 0.05, blockChance: 0.015, blockSize: 40, split: 2, jitter: 0, dropouts: 0, stuck: 0, comb: 0, roll: 0, bits: 8, noise: 0 },
  broken: { intensity: 1, density: 0.7, slices: 3, sliceShift: 70, sliceHeight: 0.07, blockChance: 0.22, blockSize: 48, blockOffset: 4, blockTint: true, split: 3, jitter: 0, dropouts: 0, stuck: 1, comb: 0, roll: 0, bits: 8, noise: 0.05 },
  cable: { intensity: 1, density: 0.8, slices: 1, sliceShift: 30, sliceHeight: 0.04, blockChance: 0, blockSize: 32, split: 6, jitter: 3, dropouts: 0.05, stuck: 0, comb: 2, roll: 0.02, bits: 8, noise: 0.4 },
  corrupt: { intensity: 1.2, density: 0.85, slices: 6, sliceShift: 160, sliceHeight: 0.1, blockChance: 0.12, blockSize: 32, blockOffset: 6, blockTint: true, split: 10, jitter: 0, dropouts: 0.03, stuck: 2, comb: 0, roll: 0, bits: 4, noise: 0.15 },
  heavy: { intensity: 1.6, density: 1, slices: 6, sliceShift: 240, sliceHeight: 0.14, blockChance: 0.3, blockSize: 28, blockOffset: 8, blockTint: true, split: 16, jitter: 6, dropouts: 0.1, stuck: 2, comb: 4, roll: 0.06, bits: 3, noise: 0.5 },
};

/** Deterministic random numbers for one glitch event. */
function rng(a: number, b: number): () => number {
  let s = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b)) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default defineNode({
  id: 'glitch',
  title: 'Digital Glitch',
  category: 'filter',
  description:
    'The digital-glitch toolkit in one node: shifted slices, corrupted macroblock tiles, RGB split, line jitter and dropouts, stuck rows, interlace comb, bit crushing, noise bursts and vertical roll. The glitch is made of events: each holds still for a moment, then the next one appears. It is inherently animated and loops with the project; tick Freeze for one fixed glitch.',
  keywords: ['glitch', 'corrupt', 'broken', 'digital', 'datamosh', 'tv', 'signal', 'error', 'macroblock', 'bad cable', 'rgb split', 'slices', 'distortion'],
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
        { value: 'light', label: 'Light' },
        { value: 'broken', label: 'Broken stream' },
        { value: 'cable', label: 'Bad cable' },
        { value: 'corrupt', label: 'Corrupt file' },
        { value: 'heavy', label: 'Heavy' },
      ],
    },
    intensity: { type: 'number', default: 1, min: 0, max: 2, step: 0.01, label: 'Intensity', hint: 'Scales every distance and chance.' },
    eventsPerLoop: { type: 'number', default: 8, min: 1, max: 96, softMax: 48, step: 1, integer: true, label: 'Events per loop', group: 'Timing', hint: 'How many different glitches fill one loop. Each one lasts loop length / this many frames.' },
    density: { type: 'number', default: 0.65, min: 0, max: 1, step: 0.01, label: 'How often it glitches', group: 'Timing', hint: 'Chance that an event is a glitch rather than a clean moment.' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', group: 'Timing' },
    freeze: { type: 'bool', default: false, label: 'Freeze (one fixed glitch)', group: 'Timing' },
    slices: { type: 'number', default: 3, min: 0, max: 6, step: 1, integer: true, label: 'Shifted slices', group: 'Slices' },
    sliceShift: { type: 'number', default: 60, min: 0, max: 800, softMax: 300, step: 1, unit: 'px', label: 'Slice shift', group: 'Slices', visibleIf: (p) => (p.slices as number) > 0 },
    sliceHeight: { type: 'number', default: 0.07, min: 0.005, max: 0.5, step: 0.005, unit: 'norm', label: 'Slice height', group: 'Slices', visibleIf: (p) => (p.slices as number) > 0 },
    blockChance: { type: 'number', default: 0.06, min: 0, max: 1, step: 0.005, label: 'Corrupted tiles', group: 'Tiles', hint: 'Share of macroblock tiles that show the wrong content.' },
    blockSize: { type: 'number', default: 32, min: 4, max: 300, softMax: 128, step: 1, unit: 'px', label: 'Tile size', group: 'Tiles', visibleIf: (p) => (p.blockChance as number) > 0 },
    blockOffset: { type: 'number', default: 3, min: 1, max: 16, step: 1, integer: true, label: 'Tile jump (tiles)', group: 'Tiles', visibleIf: (p) => (p.blockChance as number) > 0 },
    blockTint: { type: 'bool', default: true, label: 'Colour-shift tiles', group: 'Tiles', visibleIf: (p) => (p.blockChance as number) > 0 },
    split: { type: 'number', default: 4, min: 0, max: 100, softMax: 40, step: 0.5, unit: 'px', label: 'RGB split', group: 'Colour' },
    bits: { type: 'number', default: 8, min: 1, max: 8, step: 1, integer: true, label: 'Colour bits per channel', group: 'Colour', hint: '8 = off.' },
    noise: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.01, label: 'Noise bursts', group: 'Colour' },
    jitter: { type: 'number', default: 0, min: 0, max: 60, softMax: 20, step: 0.1, unit: 'px', label: 'Line jitter', group: 'Lines' },
    dropouts: { type: 'number', default: 0, min: 0, max: 1, step: 0.005, label: 'Line dropouts', group: 'Lines' },
    stuck: { type: 'number', default: 0, min: 0, max: 2, step: 1, integer: true, label: 'Stuck rows', group: 'Lines', hint: 'Bands where one row repeats down the band.' },
    comb: { type: 'number', default: 0, min: 0, max: 40, softMax: 12, step: 0.1, unit: 'px', label: 'Interlace comb', group: 'Lines', hint: 'Every other row is shifted sideways.' },
    roll: { type: 'number', default: 0, min: 0, max: 1, step: 0.005, unit: 'norm', label: 'Vertical roll', group: 'Lines' },
  },
  summary: (p) => (p.preset !== 'custom' ? p.preset : `${p.eventsPerLoop} events${p.freeze ? ' · frozen' : ''}`),
  render(ctx) {
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const p = { ...ctx.params } as Record<string, number | boolean | string> & typeof ctx.params;
    if (p.preset !== 'custom') {
      const lengths = ['sliceShift', 'blockSize', 'split', 'jitter', 'comb'];
      for (const [k, v] of Object.entries(PRESETS[p.preset] ?? {})) p[k] = typeof v === 'number' && lengths.includes(k) ? v * src.unit : v;
    }
    const N = Math.max(1, Math.round(p.eventsPerLoop));
    const event = p.freeze ? 0 : Math.floor(ctx.time.phase * N + 1e-6) % N;
    const rand = rng(event, Math.round(p.seed));
    const active = rand() < p.density;
    if (!active || p.intensity <= 0) return { image: src };
    const I = p.intensity;
    const W = src.width;
    const H = src.height;
    const slices: number[][] = [];
    for (let i = 0; i < 6; i++) {
      const y0 = rand() * H;
      const h = (0.2 + rand()) * p.sliceHeight * H;
      const shift = (rand() - 0.5) * 2 * p.sliceShift * I;
      slices.push(i < p.slices ? [y0, y0 + h, shift, 0] : [0, 0, 0, 0]);
    }
    const stuck: number[][] = [];
    for (let i = 0; i < 2; i++) {
      const y0 = rand() * H * 0.9;
      stuck.push(i < p.stuck ? [y0, y0 + (0.05 + rand() * 0.15) * H] : [0, 0]);
    }
    const rects: number[][] = [];
    for (let i = 0; i < 3; i++) {
      const x0 = rand() * W * 0.8;
      const y0 = rand() * H * 0.9;
      rects.push(p.noise > 0 ? [x0, y0, x0 + (0.1 + rand() * 0.5) * W, y0 + (0.01 + rand() * 0.06) * H] : [0, 0, 0, 0]);
    }
    const splitDir = [(rand() - 0.5) * 2, (rand() - 0.5) * 0.6, (rand() - 0.5) * 2, (rand() - 0.5) * 0.6];
    const roll = p.roll > 0 ? (rand() - 0.5) * 2 * p.roll * I : 0;
    const image = gpu.pass({
      label: 'glitch',
      size: src,
      textures: { src },
      uniforms: {
        ev: event * 13.1 + (p.seed as number) * 0.7,
        s0: slices[0], s1: slices[1], s2: slices[2], s3: slices[3], s4: slices[4], s5: slices[5],
        k0: stuck[0], k1: stuck[1],
        n0: rects[0], n1: rects[1], n2: rects[2],
        splitR: [splitDir[0] * p.split * I, splitDir[1] * p.split * I],
        splitB: [-splitDir[2] * p.split * I, -splitDir[3] * p.split * I],
        block: [Math.max(4, p.blockSize), p.blockChance * Math.min(1.5, I), p.blockOffset, Number(p.blockTint)],
        jitter: p.jitter * I,
        comb: p.comb * I,
        dropouts: p.dropouts * Math.min(1.5, I),
        roll: roll * H,
        levels: 2 ** p.bits - 1,
        noise: p.noise * Math.min(1.5, I),
      },
      wgsl: /* wgsl */ `
fn fold(q: vec2f) -> vec2f {
  let m = abs(q);
  return vec2f(1.0) - abs(vec2f(1.0) - (m - 2.0 * floor(m * 0.5)));
}
fn take(p: vec2f) -> vec4f { return textureSampleLevel(src, smp, fold(p / u.size), 0.0); }
fn inBand(y: f32, b: vec4f) -> bool { return b.y > b.x && y >= b.x && y < b.y; }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var p = px;
  let row = floor(px.y);
  if (u.roll != 0.0) { p.y = p.y + u.roll; }
  if (u.k0.y > u.k0.x && px.y >= u.k0.x && px.y < u.k0.y) { p.y = u.k0.x; }
  if (u.k1.y > u.k1.x && px.y >= u.k1.x && px.y < u.k1.y) { p.y = u.k1.x; }
  if (u.comb != 0.0 && (i32(row) & 1) == 1) { p.x = p.x + u.comb; }
  if (u.jitter != 0.0) { p.x = p.x + (hash21(vec2f(row, u.ev)) - 0.5) * 2.0 * u.jitter; }
  if (inBand(px.y, u.s0)) { p.x = p.x + u.s0.z; }
  if (inBand(px.y, u.s1)) { p.x = p.x + u.s1.z; }
  if (inBand(px.y, u.s2)) { p.x = p.x + u.s2.z; }
  if (inBand(px.y, u.s3)) { p.x = p.x + u.s3.z; }
  if (inBand(px.y, u.s4)) { p.x = p.x + u.s4.z; }
  if (inBand(px.y, u.s5)) { p.x = p.x + u.s5.z; }
  var tint = false;
  if (u.block.y > 0.0) {
    let tile = floor(p / u.block.x);
    let h = hash21(tile + vec2f(u.ev, u.ev * 0.37));
    if (h < u.block.y) {
      let jump = floor((hash22(tile + vec2f(u.ev * 1.9, 3.0)) * 2.0 - 1.0) * u.block.z + 0.5);
      p = (tile + jump) * u.block.x + (p - tile * u.block.x);
      tint = u.block.w > 0.5 && hash21(tile + vec2f(7.0, u.ev)) > 0.4;
    }
  }
  let g = take(p);
  var rgb = vec3f(take(p + u.splitR).r, g.g, take(p + u.splitB).b);
  var a = g.a;
  if (tint) { rgb = rgb.gbr; }
  if (u.dropouts > 0.0 && hash21(vec2f(row * 1.3, u.ev + 9.0)) < u.dropouts) {
    let w = hash21(vec2f(row, u.ev + 21.0));
    rgb = select(vec3f(0.0), vec3f(a), w > 0.75);
  }
  if (u.levels < 255.0) { rgb = floor(rgb / max(a, 0.0001) * u.levels + 0.5) / u.levels * a; }
  if (u.noise > 0.0) {
    for (var i = 0; i < 3; i++) {
      var r = u.n0;
      if (i == 1) { r = u.n1; }
      if (i == 2) { r = u.n2; }
      if (px.x >= r.x && px.x < r.z && px.y >= r.y && px.y < r.w) {
        rgb = mix(rgb, vec3f(hash21(px + vec2f(u.ev, 1.0)), hash21(px + vec2f(2.0, u.ev)), hash21(px + vec2f(u.ev, 3.0))) * max(a, 0.5), 0.85 * min(u.noise * 2.0, 1.0));
        a = max(a, 0.9 * min(u.noise * 2.0, 1.0));
      }
    }
  }
  return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), a);
}`,
    });
    return { image };
  },
});
