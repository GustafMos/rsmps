import { defineNode } from '../../define';
import { withArtGrid } from '../../lib/art-grid';
import { loopFrame } from '../../lib/fx-util';
import { frozenGlitch, glitchAt, type GlitchEvent, type GlitchTimelineParams } from '../../lib/glitch-timeline';

/** Look presets: a preset overrides the controls it lists (lengths are in unit pixels). Choose Custom to use every control as set. */
const PRESETS: Record<string, Record<string, number>> = {
  light: { rate: 1.6, burst: 0.5, hold: 2, calm: 0.97, reroll: 2, kBlock: 0.7, kTear: 0.35, kSplit: 0.35, kSmear: 0, kQuant: 0.5, kStutter: 0, kTimeTear: 0, kBitrot: 0.1, kScan: 0.3, kFlash: 0, block: 32, shift: 50, split: 6 },
  broken: { rate: 3, burst: 0.65, hold: 3, calm: 0.9, reroll: 2, kBlock: 0.9, kTear: 0.7, kSplit: 0.6, kSmear: 0.3, kQuant: 0.35, kStutter: 0.2, kTimeTear: 0.12, kBitrot: 0.25, kScan: 0.3, kFlash: 0.06, block: 40, shift: 110, split: 14 },
  datamosh: { rate: 2.2, burst: 0.8, hold: 5, calm: 0.8, reroll: 4, kBlock: 1, kTear: 0.2, kSplit: 0.1, kSmear: 0.8, kQuant: 0.8, kStutter: 0.5, kTimeTear: 0.5, kBitrot: 0.1, kScan: 0, kFlash: 0, block: 48, shift: 70, split: 4 },
  gpu: { rate: 4.5, burst: 0.7, hold: 2, calm: 0.75, reroll: 1, kBlock: 0.6, kTear: 0.9, kSplit: 0.9, kSmear: 0.5, kQuant: 0.3, kStutter: 0.1, kTimeTear: 0.2, kBitrot: 0.9, kScan: 0.6, kFlash: 0.25, block: 28, shift: 200, split: 24 },
  signal: { rate: 5, burst: 0.5, hold: 2, calm: 0.55, reroll: 1, kBlock: 0.1, kTear: 0.8, kSplit: 0.8, kSmear: 0.1, kQuant: 0, kStutter: 0, kTimeTear: 0, kBitrot: 0.2, kScan: 1, kFlash: 0.4, block: 32, shift: 150, split: 20 },
  stutter: { rate: 2.5, burst: 0.75, hold: 4, calm: 0.95, reroll: 2, kBlock: 0.15, kTear: 0.2, kSplit: 0.2, kSmear: 0, kQuant: 0.1, kStutter: 1, kTimeTear: 0.7, kBitrot: 0, kScan: 0, kFlash: 0, block: 40, shift: 60, split: 6 },
};
const LENGTHS = ['block', 'shift', 'split'];
const KIND_KEYS = ['kBlock', 'kTear', 'kSplit', 'kSmear', 'kQuant', 'kStutter', 'kTimeTear', 'kBitrot', 'kScan', 'kFlash'] as const;

const WGSL = /* wgsl */ `
fn H(a: f32, b: f32) -> f32 { return hash21(vec2f(a * 0.7131 + u.ev.x * 0.173, b * 1.3171 + u.ev.x * 0.0291 + 3.1)); }
fn HE(a: f32, b: f32) -> f32 { return H(a, b + u.ev.z * 7.31); }
fn HT(t: vec2f, k: f32) -> f32 { return hash21(t * 1.0 + vec2f(u.ev.x * 0.1731 + k * 13.7, u.ev.z * 3.1 + k * 1.9 + 5.0)); }
fn fold(q: vec2f) -> vec2f {
  let m = abs(q);
  return vec2f(1.0) - abs(vec2f(1.0) - (m - 2.0 * floor(m * 0.5)));
}
fn take(p: vec2f, alt: bool) -> vec4f {
  let uv = fold(p / u.size);
  if (u.kC.w > 0.5) {
    if (alt) { return textureSampleLevel(older, smpNearest, uv, 0.0); }
    return textureSampleLevel(src, smpNearest, uv, 0.0);
  }
  if (alt) { return textureSampleLevel(older, smp, uv, 0.0); }
  return textureSampleLevel(src, smp, uv, 0.0);
}
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let W = u.size.x;
  let Hh = u.size.y;
  let blk = u.sz.x;
  let shiftPx = u.sz.y;
  let splitPx = u.sz.z;
  let age = u.ev.y;
  var p = px;
  var alt = u.kC.x > 0.5;
  // frame tear: the lower (or upper) part of the picture is from another moment
  if (u.kC.y > 0.0) {
    let yb = (0.15 + 0.7 * H(1.0, 1.0)) * Hh + sin(age * 0.9 + H(2.0, 2.0) * 6.28) * 0.04 * Hh;
    let below = H(3.0, 3.0) > 0.5;
    let lower = px.y >= yb;
    alt = alt || (lower == below);
    p.x = p.x + (1.0 - smoothstep(0.0, 0.03 * Hh, abs(px.y - yb))) * (H(4.0, 4.0) - 0.5) * 0.5 * shiftPx;
  }
  // scanline jitter: groups of rows wobble sideways
  if (u.kB.z > 0.0) {
    let band = floor(px.y / max(2.0, blk * 0.5));
    if (H(band + 11.0, 5.0 + floor(age * 0.5)) < 0.45) {
      p.x = p.x + (HE(floor(px.y), 12.0) - 0.5) * 2.0 * shiftPx * 0.12 * u.kB.z;
    }
  }
  // horizontal slice tearing with sub-texel offsets, crawling down the picture while the event is held
  if (u.kA.y > 0.0) {
    for (var L = 0; L < 2; L++) {
      let sh = max(2.0, Hh * select(0.035, 0.11, L == 1));
      let s = floor((px.y - u.dir.z * age * (0.5 + 0.5 * f32(L)) + H(f32(L) + 50.0, 1.0) * sh) / sh);
      if (HE(s + f32(L) * 131.0, 7.0) < 0.18 + 0.4 * u.kA.y) {
        let w = select(1.0, 0.6, L == 1);
        p.x = p.x + (HE(s + f32(L) * 131.0, 8.0) - 0.5) * 2.0 * shiftPx * u.kA.y * w + u.dir.z * 0.3 * age;
      }
    }
  }
  // stuck line: one row (or column) is repeated across a band
  if (u.kA.w > 0.0) {
    let len = (0.05 + 0.3 * H(23.0, 1.0)) * min(1.0, u.kA.w + 0.3);
    if (H(21.0, 1.0) > 0.7) {
      let x0 = H(24.0, 1.0) * 0.85 * W;
      if (px.x > x0 && px.x < x0 + len * W) { p.x = x0; }
    } else {
      let y0 = H(22.0, 1.0) * 0.85 * Hh;
      if (px.y > y0 && px.y < y0 + len * Hh) { p.y = y0; }
    }
  }
  // macroblocks jump sideways (or copy from another row of blocks); they pick a new offset every re-roll
  if (u.kA.x > 0.0) {
    let tile = floor(p / blk);
    if (HT(tile, 31.0) < 0.06 + 0.34 * min(u.kA.x, 1.0)) {
      let reach = 2.0 + 6.0 * min(u.kA.x, 1.0);
      let jx = floor((HT(tile, 32.0) * 2.0 - 1.0) * reach + 0.5);
      var jy = 0.0;
      if (HT(tile, 33.0) > 0.7) { jy = floor((HT(tile, 34.0) * 2.0 - 1.0) * 3.0 + 0.5); }
      p = p + vec2f(jx, jy) * blk;
    }
  }
  // RGB split that kicks on the event
  let g = take(p, alt);
  var prem = g.rgb;
  if (u.kA.z > 0.0 && splitPx > 0.0) {
    let d = u.dir.xy * splitPx * u.kA.z * (0.7 + 0.6 * HE(9.0, 9.0));
    prem = vec3f(take(p + d, alt).r, g.g, take(p - d, alt).b);
  }
  let a = g.a;
  var rgb = prem / max(a, 0.0001);
  // quantisation blockiness: blocks go to a local average with coarse colour steps
  if (u.kB.x > 0.0) {
    let qt = floor(px / blk);
    if (HT(qt, 41.0) < 0.2 + 0.5 * min(u.kB.x, 1.0)) {
      var avg = vec3f(0.0);
      for (var j = 0; j < 3; j++) {
        for (var i = 0; i < 3; i++) {
          let c = take((qt + (vec2f(f32(i), f32(j)) + 0.5) / 3.0) * blk, alt);
          avg = avg + c.rgb / max(c.a, 0.0001);
        }
      }
      avg = avg / 9.0;
      let lv = mix(8.0, 3.0, min(u.kB.x, 1.0));
      rgb = mix(rgb, floor(avg * lv + 0.5) / lv + (rgb - avg) * 0.18, 0.92);
    }
  }
  // bit rot: wrong colours in blocks
  if (u.kB.y > 0.0) {
    let bt = floor(px / max(4.0, blk * 0.7));
    if (HT(bt, 51.0) < 0.05 + 0.25 * min(u.kB.y, 1.0)) {
      let m = floor(HT(bt, 52.0) * 4.0);
      if (m < 0.5) { rgb = rgb.gbr; }
      else if (m < 1.5) { rgb = vec3f(1.0) - rgb; }
      else if (m < 2.5) {
        let bits = vec3<u32>(clamp(rgb, vec3f(0.0), vec3f(1.0)) * 255.0 + 0.5);
        let k = u32(HT(bt, 53.0) * 255.0) & 0xe0u;
        rgb = vec3f(bits ^ vec3<u32>(k)) / 255.0;
      } else {
        let hsv = rgbToHsv(clamp(rgb, vec3f(0.0), vec3f(1.0)));
        rgb = hsvToRgb(vec3f(fract(hsv.x + 0.25 + 0.5 * HT(bt, 54.0)), min(1.0, hsv.y * 1.3 + 0.15), hsv.z));
      }
    }
  }
  // brief full-frame flash: invert or white noise
  if (u.kB.w > 0.0) {
    let k = min(u.kB.w, 1.0);
    if (u.dir.w < 0.5) { rgb = mix(rgb, vec3f(1.0) - rgb, k); }
    else { rgb = mix(rgb, vec3f(hash21(floor(px / 2.0) + vec2f(u.ev.x, u.ev.z))), 0.8 * k); }
  }
  return vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)) * a, a);
}`;

export default defineNode({
  id: 'glitch',
  title: 'Digital Glitch',
  category: 'filter',
  description:
    'A broken video stream or crashing GPU: macroblocks jump, slices tear and crawl, colours split, lines stick, blocks go to coarse steps or wrong colours, the picture freezes, stutters or shows two moments at once, with an occasional flash. Glitches come as abrupt events: a new pattern appears on one frame, is held for a few frames and is gone, in bursts with calm stretches between. Hashed from the seed and the frame, so it is repeatable and loops exactly. It animates by itself; tick Freeze for one fixed glitch. Wire a number into Trigger (sound, beat, tap) to fire a glitch on demand.',
  keywords: ['glitch', 'corrupt', 'broken', 'digital', 'datamosh', 'tv', 'signal', 'error', 'macroblock', 'stream', 'gpu', 'artifact', 'rgb split', 'tear', 'stutter', 'freeze', 'bit rot', 'distortion'],
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
        { value: 'custom', label: 'Custom' },
        { value: 'light', label: 'Subtle stream errors' },
        { value: 'broken', label: 'Broken stream' },
        { value: 'datamosh', label: 'Datamoshed' },
        { value: 'gpu', label: 'GPU crash' },
        { value: 'signal', label: 'Signal loss' },
        { value: 'stutter', label: 'Stutter' },
      ],
    },
    freeze: { type: 'bool', default: false, label: 'Freeze', hint: 'One fixed glitch that does not move (uses no clock). Off = the glitch animates by itself.' },
    intensity: { type: 'number', default: 1, min: 0, max: 2, step: 0.01, label: 'Intensity', hint: 'Scales how strong every kind of error is.' },
    rate: { type: 'number', default: 4, min: 0, max: 20, softMax: 12, step: 0.1, label: 'Events per second', group: 'Timing', hint: 'How many new glitches start each second, on average. 0 = clean (unless Trigger fires).' },
    burst: { type: 'number', default: 0.65, min: 0, max: 1, step: 0.01, label: 'Burst', group: 'Timing', hint: '0 = events spread evenly. 1 = a few bursts of bad frames with long clean stretches.' },
    hold: { type: 'number', default: 3, min: 1, max: 8, step: 1, integer: true, label: 'Hold', group: 'Timing', hint: 'Typical length of an event in frames (they are long-tailed: many short, a few long).' },
    calm: { type: 'number', default: 0.9, min: 0, max: 1, step: 0.01, label: 'Calm', group: 'Timing', hint: 'How clean the quiet stretches between events are. 1 = perfectly clean, lower = a faint tearing and split remains.' },
    reroll: { type: 'number', default: 2, min: 1, max: 12, step: 1, integer: true, label: 'Re-roll', group: 'Timing', hint: 'Displaced blocks pick new offsets every N frames, so a held event still shimmers.' },
    trigger: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Trigger', group: 'Timing', hint: 'While above 0.5 a strong glitch is forced. Connect a beat, a sound level or a phone tap.' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed', group: 'Timing' },
    kBlock: { type: 'number', default: 0.9, min: 0, max: 1, step: 0.01, label: 'Blocks', group: 'Mix', hint: 'Macroblocks that jump sideways or copy from elsewhere. Each amount is the chance that an event contains that kind.' },
    kTear: { type: 'number', default: 0.7, min: 0, max: 1, step: 0.01, label: 'Tears', group: 'Mix', hint: 'Horizontal slices that slide sideways and crawl.' },
    kSplit: { type: 'number', default: 0.6, min: 0, max: 1, step: 0.01, label: 'RGB split', group: 'Mix', hint: 'The colour channels kick apart.' },
    kSmear: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Smear', group: 'Mix', hint: 'A row or column repeats across a band (a stuck line).' },
    kQuant: { type: 'number', default: 0.35, min: 0, max: 1, step: 0.01, label: 'Blockiness', group: 'Mix', hint: 'Blocks go to a local average with coarse colour steps, like a starved video codec.' },
    kStutter: { type: 'number', default: 0.2, min: 0, max: 1, step: 0.01, label: 'Stutter', group: 'Mix', hint: 'The whole frame holds an earlier picture for the event. Needs a moving input.' },
    kTimeTear: { type: 'number', default: 0.12, min: 0, max: 1, step: 0.01, label: 'Time tear', group: 'Mix', hint: 'Top and bottom of the picture show two different moments. Needs a moving input.' },
    kBitrot: { type: 'number', default: 0.25, min: 0, max: 1, step: 0.01, label: 'Bit rot', group: 'Mix', hint: 'Wrong colours in blocks: swapped, inverted, bit-flipped or hue-shifted.' },
    kScan: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Scan jitter', group: 'Mix', hint: 'Groups of lines wobble sideways.' },
    kFlash: { type: 'number', default: 0.06, min: 0, max: 1, step: 0.01, label: 'Flash', group: 'Mix', hint: 'A single bright frame: inverted or white noise. Use sparingly.' },
    block: { type: 'number', default: 40, min: 4, max: 300, softMax: 128, step: 1, unit: 'px', label: 'Block size', group: 'Size' },
    shift: { type: 'number', default: 110, min: 0, max: 800, softMax: 300, step: 1, unit: 'px', label: 'Shift', group: 'Size', hint: 'How far slices slide.' },
    split: { type: 'number', default: 14, min: 0, max: 100, softMax: 40, step: 0.5, unit: 'px', label: 'Split', group: 'Size', hint: 'How far the colour channels kick apart.' },
  },
  summary: (p) => (p.preset !== 'custom' ? p.preset : `${p.rate}/s${p.freeze ? ' · frozen' : ''}`),
  async render(ctx) {
    const src = ctx.in.image;
    const gpu = ctx.gpu;
    const p = { ...ctx.params } as Record<string, number | boolean | string> & typeof ctx.params;
    if (p.preset !== 'custom') {
      for (const [k, v] of Object.entries(PRESETS[p.preset] ?? {})) p[k] = LENGTHS.includes(k) ? v * src.unit : v;
    }
    const kinds = KIND_KEYS.map((k) => p[k] as number);
    const triggered = p.trigger > 0.5;
    const anything = kinds.some((v) => v > 0);
    if (p.intensity <= 0 || !anything) return { image: src };
    if (!p.freeze && p.rate <= 0 && p.calm >= 1 && !triggered) return { image: src };

    const fps = ctx.time.fps;
    const tp: GlitchTimelineParams = { seed: p.seed, rate: p.rate, burst: p.burst, hold: p.hold, calm: p.calm, intensity: p.intensity, kinds, fps };
    // a second moment is only worth fetching when the input changes with time
    const allowAlt = !p.freeze && ctx.inputVaries('image');
    let ev: GlitchEvent | null;
    let frame = 0;
    let total = 1;
    if (p.freeze) {
      ev = frozenGlitch(tp);
    } else {
      total = Math.max(1, Math.round(ctx.time.duration * fps));
      frame = loopFrame(ctx.time, 1);
      ev = glitchAt(frame, total, tp, { allowAlt, trigger: triggered });
    }
    if (!ev) return { image: src };
    const s = ev.strength;
    const useStutter = allowAlt && s[5] > 0;
    const useTear = allowAlt && s[6] > 0;
    let older: typeof src | null = null;
    if (useStutter || useTear) {
      const target = useStutter ? ev.start - ev.back : frame - ev.lag;
      const wrapped = ((target % total) + total) % total;
      older = await ctx.pull('image', { seconds: wrapped / fps });
    }
    const stutter = useStutter && older ? 1 : 0;
    const tear = useTear && older ? s[6] : 0;
    const hr = (a: number) => {
      const x = Math.sin((ev!.key + 1) * 12.9898 + a * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    const angle = hr(1) * Math.PI * 2;
    const epoch = Math.floor(ev.age / Math.max(1, Math.round(p.reroll)));
    const image = withArtGrid(gpu, src, 0, (art, grid) => {
      const blk = Math.max(grid.active ? 2 : 4, Math.round(grid.toArt(p.block)));
      return gpu.pass({
        label: 'glitch',
        size: art,
        textures: { src: art, older: older ?? art },
        uniforms: {
          kA: [s[0], s[1], s[2], s[3]],
          kB: [s[4], s[7], s[8], s[9]],
          kC: [stutter, tear, older ? 1 : 0, grid.active ? 1 : 0],
          ev: [ev!.key % 997, ev!.age, epoch % 509, ev!.quiet ? 1 : 0],
          sz: [blk, grid.toArt(p.shift), grid.toArt(p.split), 0],
          dir: [Math.cos(angle), Math.sin(angle) * 0.35, (hr(2) - 0.5) * 2 * 0.012 * art.height, hr(3) < 0.5 ? 0 : 1],
        },
        wgsl: WGSL,
      });
    });
    return { image };
  },
});
