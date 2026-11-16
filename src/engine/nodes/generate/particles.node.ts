import { defineNode } from '../../define';
import { GEN_HASH_WGSL, rgba } from '../../lib/gen-common';

/**
 * Stateless GPU particles.
 *
 * Nothing is simulated. Space is tiled into cells (one particle per cell, three depth layers with different
 * cell sizes / drift speeds), so each pixel only looks at the 3x3 cells around it: cost does not grow with the
 * particle count. Every particle is a closed-form function of (cell hash, phase):
 *   - its life is fract(phase * cycles + offset)  -> exact loop for whole `cycles`
 *   - each layer drifts by a whole number of cells per loop        -> exact loop of the whole grid
 *   - wander/twinkle/spin use whole multiples of `cycles`.
 * Particles respawn at a new random spot (hash of the life index) while invisible, so they never pop.
 */

type Shape = 'dot' | 'streak' | 'sparkle' | 'bubble' | 'rect' | 'glow';
const SHAPE_ID: Record<Shape, number> = { dot: 0, streak: 1, sparkle: 2, bubble: 3, rect: 4, glow: 5 };

interface Recipe {
  shape: Shape;
  /** Natural direction of travel, degrees (0 = right, 90 = down). */
  angle: number;
  /** Frame heights travelled per cycle by the middle layer. */
  drift: number;
  /** Extra travel inside the particle's own cell (fraction), per life. */
  trav: number;
  /** Wander amplitude (fraction of a cell). */
  wander: number;
  sizeMul: number;
  sizeVar: number;
  /** Streak half-length in radii. */
  streak: number;
  fadeIn: number;
  fadeOut: number;
  /** 0 none, 1 blink (fireflies), 2 twinkle (stars). */
  twinkle: number;
  respawn: boolean;
  /** 0 random mix of A/B, 1 rainbow, 2 A to B over life. */
  colorMode: number;
  alpha: number;
  a: [number, number, number, number];
  b: [number, number, number, number];
  forceSoft?: boolean;
  forceHard?: boolean;
}

const RECIPES = {
  dust: { shape: 'dot', angle: -25, drift: 0.12, trav: 0.6, wander: 0.5, sizeMul: 1.3, sizeVar: 0.6, streak: 0, fadeIn: 0.3, fadeOut: 0.3, twinkle: 0, respawn: true, colorMode: 0, alpha: 0.85, a: [1, 0.95, 0.8, 1], b: [0.8, 0.86, 1, 1] },
  snow: { shape: 'dot', angle: 90, drift: 1, trav: 0.3, wander: 0.7, sizeMul: 1.5, sizeVar: 0.6, streak: 0, fadeIn: 0.1, fadeOut: 0.1, twinkle: 0, respawn: true, colorMode: 0, alpha: 0.95, a: [1, 1, 1, 1], b: [0.82, 0.9, 1, 1] },
  rain: { shape: 'streak', angle: 100, drift: 3, trav: 0, wander: 0, sizeMul: 0.8, sizeVar: 0.3, streak: 8, fadeIn: 0.05, fadeOut: 0.05, twinkle: 0, respawn: true, colorMode: 0, alpha: 0.65, a: [0.7, 0.8, 1, 1], b: [0.86, 0.92, 1, 1] },
  sparks: { shape: 'streak', angle: -90, drift: 0.8, trav: 0.9, wander: 0.6, sizeMul: 1.4, sizeVar: 0.5, streak: 2.5, fadeIn: 0.05, fadeOut: 0.5, twinkle: 0, respawn: true, colorMode: 2, alpha: 1, a: [1, 0.95, 0.55, 1], b: [1, 0.3, 0.05, 1], forceSoft: true },
  bubbles: { shape: 'bubble', angle: -90, drift: 0.35, trav: 0.4, wander: 0.7, sizeMul: 3.5, sizeVar: 0.7, streak: 0, fadeIn: 0.12, fadeOut: 0.2, twinkle: 0, respawn: true, colorMode: 0, alpha: 0.85, a: [0.7, 0.9, 1, 1], b: [1, 1, 1, 1], forceHard: true },
  fireflies: { shape: 'glow', angle: -10, drift: 0, trav: 1, wander: 1, sizeMul: 3, sizeVar: 0.3, streak: 0, fadeIn: 0.2, fadeOut: 0.2, twinkle: 1, respawn: true, colorMode: 0, alpha: 1, a: [1, 0.95, 0.4, 1], b: [0.7, 1, 0.3, 1] },
  confetti: { shape: 'rect', angle: 90, drift: 0.7, trav: 0.4, wander: 0.6, sizeMul: 2.3, sizeVar: 0.4, streak: 0, fadeIn: 0.08, fadeOut: 0.08, twinkle: 0, respawn: true, colorMode: 1, alpha: 1, a: [1, 0.3, 0.4, 1], b: [0.3, 0.7, 1, 1], forceHard: true },
  stars: { shape: 'sparkle', angle: 0, drift: 0, trav: 0, wander: 0, sizeMul: 3.2, sizeVar: 0.8, streak: 0, fadeIn: 0, fadeOut: 0, twinkle: 2, respawn: false, colorMode: 0, alpha: 1, a: [1, 1, 0.85, 1], b: [0.8, 0.9, 1, 1] },
} satisfies Record<string, Recipe>;
type Preset = keyof typeof RECIPES;

const LAYER_WEIGHT = [0.5, 0.3, 0.2];
const LAYER_SIZE = [0.6, 1, 1.5];
const LAYER_SPEED = [0.5, 1, 1.6];

export default defineNode({
  id: 'particles',
  title: 'Particles',
  category: 'generate',
  description: 'Dust, snow, rain, sparks, bubbles, fireflies, confetti or twinkling stars. Handles thousands of particles and loops exactly.',
  keywords: ['snow', 'rain', 'dust', 'sparks', 'embers', 'bubbles', 'fireflies', 'confetti', 'stars', 'twinkle', 'weather', 'overlay', 'emitter'],
  inputs: { size: { type: 'image', label: 'Size from' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  params: {
    preset: {
      type: 'enum',
      default: 'snow',
      label: 'Type',
      options: [
        { value: 'dust', label: 'Dust motes' },
        { value: 'snow', label: 'Snow' },
        { value: 'rain', label: 'Rain' },
        { value: 'sparks', label: 'Sparks / embers' },
        { value: 'bubbles', label: 'Bubbles' },
        { value: 'fireflies', label: 'Fireflies' },
        { value: 'confetti', label: 'Confetti' },
        { value: 'stars', label: 'Twinkling stars' },
      ],
    },
    count: { type: 'number', default: 300, min: 1, max: 20000, step: 1, integer: true, label: 'Amount', hint: 'Roughly how many particles are on screen. Very large particles limit this.' },
    particleSize: { type: 'number', default: 10, min: 0.5, max: 300, unit: 'px', label: 'Size' },
    cycles: { type: 'number', default: 1, min: 1, max: 16, step: 1, integer: true, unit: 'cycles', label: 'Speed', hint: 'How many times each particle lives its life per loop. Higher = faster.' },
    direction: { type: 'number', default: 0, min: -180, max: 180, step: 1, unit: 'deg', label: 'Turn direction', hint: '0 keeps the type’s natural direction (snow falls, sparks rise). Positive turns clockwise.' },
    spread: { type: 'number', default: 25, min: 0, max: 360, step: 1, unit: 'deg', label: 'Spread', hint: 'Random variation of each particle’s direction.' },
    presetColors: { type: 'bool', default: true, label: 'Type colors', hint: 'Use the type\'s own colors.' },
    colorA: { type: 'color', default: [1, 1, 1, 1], label: 'Color A', visibleIf: (p) => !p.presetColors },
    colorB: { type: 'color', default: [0.7, 0.85, 1, 1], label: 'Color B', visibleIf: (p) => !p.presetColors },
    opacity: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Opacity' },
    soft: { type: 'bool', default: true, label: 'Soft edges', hint: 'Off = crisp hard-edged particles (good for pixel art).' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, integer: true, label: 'Seed' },
  },
  summary: (p) => `${p.preset} · ${p.count} · ${p.cycles}× per loop`,
  render(ctx) {
    const p = ctx.params;
    const size = ctx.in.size ?? ctx.canvas;
    const r = RECIPES[(p.preset as Preset) in RECIPES ? (p.preset as Preset) : 'snow'] as Recipe;
    const phase = ctx.time.phase;
    const cycles = Math.max(1, Math.round(p.cycles));
    const area = size.width * size.height;
    const base = Math.max(0.5, p.particleSize);
    const angle = ((r.angle + p.direction) * Math.PI) / 180;
    const dir = [Math.cos(angle), Math.sin(angle)];
    const reachMul = r.shape === 'streak' ? 1 + r.streak : r.shape === 'sparkle' ? 2 : r.shape === 'glow' ? 2.6 : r.shape === 'rect' ? 1.5 : r.shape === 'bubble' ? 1.15 : 1.05;

    const layers = [0, 1, 2].map((i) => {
      const maxR = base * 0.5 * r.sizeMul * LAYER_SIZE[i] * (1 + r.sizeVar);
      const natural = Math.sqrt(area / Math.max(0.5, p.count * LAYER_WEIGHT[i]));
      const cell = Math.max(natural, maxR * reachMul * 1.5, 2);
      const dist = r.drift * LAYER_SPEED[i] * cycles * size.height;
      let nx = Math.round((dir[0] * dist) / cell);
      let ny = Math.round((dir[1] * dist) / cell);
      if (r.drift > 0 && nx === 0 && ny === 0) {
        if (Math.abs(dir[0]) > Math.abs(dir[1])) nx = Math.sign(dir[0]) || 1;
        else ny = Math.sign(dir[1]) || 1;
      }
      return [cell, nx * cell, ny * cell, LAYER_SIZE[i]];
    });

    const soft = r.forceSoft ? true : r.forceHard ? false : p.soft;
    const colA = p.presetColors ? r.a : rgba(p.colorA);
    const colB = p.presetColors ? r.b : rgba(p.colorB);
    const image = ctx.gpu.pass({
      label: 'particles',
      size,
      uniforms: {
        l0: layers[0],
        l1: layers[1],
        l2: layers[2],
        phase,
        cycles,
        seed: p.seed,
        base,
        shape: SHAPE_ID[r.shape],
        reachMul,
        streak: r.streak,
        trav: r.trav,
        wander: r.wander,
        sizeMul: r.sizeMul,
        sizeVar: r.sizeVar,
        fadeIn: r.fadeIn,
        fadeOut: r.fadeOut,
        twinkle: r.twinkle,
        respawn: r.respawn,
        colorMode: r.colorMode,
        ang: angle,
        spread: (p.spread * Math.PI) / 180,
        soft,
        opacity: p.opacity * r.alpha,
        a: colA,
        b: colB,
      },
      wgsl: /* wgsl */ `
${GEN_HASH_WGSL}

fn cvr(d: f32, w: f32) -> f32 { return clamp(0.5 - d / w, 0.0, 1.0); }

fn layer(px: vec2f, L: vec4f, li: i32, acc: vec4f) -> vec4f {
  let C = L.x;
  let q = px - L.yz * u.phase;          // the layer's grid drifts by whole cells per loop
  let ci = vec2i(floor(q / C));
  var out = acc;
  let shape = i32(u.shape);
  let salt = li * 131 + i32(u.seed);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cc = ci + vec2i(i, j);
      let h0 = rnd4(cc.x, cc.y, salt);
      let tt = u.phase * u.cycles + h0.x;
      let life = fract(tt);
      var lifeId = 0;
      if (u.respawn > 0.5) { lifeId = i32(floor(tt) % u.cycles); }
      let h1 = rnd4(cc.x + lifeId * 7919, cc.y - lifeId * 104729, salt + 5000);

      let ang = u.ang + (h1.z - 0.5) * u.spread;
      let dv = vec2f(cos(ang), sin(ang));
      let wf1 = u.cycles * (1.0 + floor(h0.y * 3.0));
      let wf2 = u.cycles * (1.0 + floor(h0.w * 3.0));
      let wob = vec2f(sin(TAU * (u.phase * wf1 + h0.z)), cos(TAU * (u.phase * wf2 + h0.y)));
      var pos = (vec2f(cc) + 0.25 + 0.5 * h1.xy) * C;
      pos += dv * (life - 0.5) * u.trav * C * 0.4;
      pos += wob * u.wander * C * 0.2;

      var rad = u.base * 0.5 * u.sizeMul * L.w * (1.0 + (h1.w - 0.5) * 2.0 * u.sizeVar);
      if (i32(u.colorMode) == 2) { rad *= 1.0 - 0.7 * life; }
      if (shape == 3) { rad *= 0.85 + 0.15 * life; }
      rad = max(rad, 0.5);

      let l0 = q - pos;
      let reach = rad * u.reachMul + 2.0;
      if (dot(l0, l0) > reach * reach) { continue; }

      var oa = ang;
      if (shape == 4) { oa = h0.z * TAU + TAU * (u.phase * u.cycles * (1.0 + floor(h0.y * 2.0)) + h0.x); }
      let cs = cos(oa); let sn = sin(oa);
      let l = vec2f(cs * l0.x + sn * l0.y, -sn * l0.x + cs * l0.y);

      let w = select(1.0, max(1.0, rad * 0.9), u.soft > 0.5);
      var cov = 0.0;
      if (shape == 0) {
        cov = cvr(length(l) - rad, w);
      } else if (shape == 1) {
        let hl = rad * u.streak;
        let d = length(vec2f(l.x - clamp(l.x, -hl, hl), l.y)) - rad;
        let g = mix(0.12, 1.0, clamp(l.x / (2.0 * hl + 0.001) + 0.5, 0.0, 1.0));
        cov = cvr(d, w) * g;
      } else if (shape == 2) {
        let core = clamp(1.0 - length(l) / (rad * 0.55), 0.0, 1.0);
        let ra = clamp(1.0 - abs(l.y) / (0.1 * rad + 0.6), 0.0, 1.0) * clamp(1.0 - abs(l.x) / (rad * 2.0), 0.0, 1.0);
        let rb = clamp(1.0 - abs(l.x) / (0.1 * rad + 0.6), 0.0, 1.0) * clamp(1.0 - abs(l.y) / (rad * 2.0), 0.0, 1.0);
        cov = max(max(ra, rb), core * core);
      } else if (shape == 3) {
        let len = length(l);
        let ring = cvr(abs(len - rad * 0.92) - max(0.6, rad * 0.08), 1.0);
        let fill = cvr(len - rad, 1.0) * 0.14;
        let hi = cvr(length(l - vec2f(-0.35, -0.4) * rad) - rad * 0.16, 1.0) * 0.9;
        cov = max(max(ring, fill), hi);
      } else if (shape == 4) {
        let flip = abs(cos(TAU * (u.phase * u.cycles * (1.0 + floor(h0.z * 3.0)) + h0.w)));
        let hb = vec2f(rad, max(0.5, rad * 0.55 * flip));
        let qd = abs(l) - hb;
        cov = cvr(length(max(qd, vec2f(0.0))) + min(max(qd.x, qd.y), 0.0), 1.0);
      } else {
        let t = length(l) / rad;
        cov = exp(-t * t * 1.6);
      }

      var a = 1.0;
      if (u.respawn > 0.5) {
        a = smoothstep(0.0, max(u.fadeIn, 0.001), life) * (1.0 - smoothstep(1.0 - max(u.fadeOut, 0.001), 1.0, life));
      }
      if (u.twinkle > 0.5) {
        let k = u.cycles * (1.0 + floor(h0.w * 2.0));
        let bl = 0.5 + 0.5 * sin(TAU * (u.phase * k + h0.z));
        if (u.twinkle < 1.5) { a *= bl * bl; } else { a *= 0.12 + 0.88 * bl * bl; }
      }

      var col = mix(u.a, u.b, h0.w);
      if (i32(u.colorMode) == 1) { col = vec4f(hsvToRgb(vec3f(fract(h0.w * 7.31), 0.7, 1.0)), 1.0); }
      if (i32(u.colorMode) == 2) { col = mix(u.a, u.b, clamp(life * 1.25, 0.0, 1.0)); }

      let al = clamp(cov * a * u.opacity * col.a, 0.0, 1.0);
      out = vec4f(col.rgb * al, al) + out * (1.0 - al);
    }
  }
  return out;
}

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var c = vec4f(0.0);
  c = layer(px, u.l0, 0, c);
  c = layer(px, u.l1, 1, c);
  c = layer(px, u.l2, 2, c);
  return c;
}`,
    });
    return { image };
  },
});
