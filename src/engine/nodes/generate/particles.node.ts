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

/**
 * Loop snapping (Loop on). A layer's grid drifts by whole cells per loop, so a screen position sees the cell n cells further along at the end of the
 * loop. Particle properties are hashed from the cell, so they must come from the cell's identity MODULO that drift, or the picture at the end of the loop
 * is a different random scatter from the one at the start (the seam the old loop test could not see). A drift of n = g * m cells (m primitive) leaves
 * the lattice Z^2 / <n> = Z x Z_g: the key of a cell is (d, s mod g) with d = cross(m, cell) and s = cross(cell, w), where cross(m, w) = 1.
 * Returns [mx, my, wx, wy] and g (g = 0: no drift, key = the cell itself). Pure.
 */
export function driftKey(nx: number, ny: number): { m: [number, number, number, number]; g: number } {
  const g = gcd(Math.abs(nx), Math.abs(ny));
  if (g === 0) return { m: [0, 0, 0, 0], g: 0 };
  const mx = nx / g;
  const my = ny / g;
  // extended Euclid: mx * a + my * b = 1  ->  w = (-b, a) has cross(m, w) = mx * a + my * b = 1
  let [r0, r1, a0, a1, b0, b1] = [mx, my, 1, 0, 0, 1];
  while (r1 !== 0) {
    const q = Math.trunc(r0 / r1);
    [r0, r1] = [r1, r0 - q * r1];
    [a0, a1] = [a1, a0 - q * a1];
    [b0, b1] = [b1, b0 - q * b1];
  }
  const sgn = r0 < 0 ? -1 : 1; // r0 = +-1
  return { m: [mx, my, -b0 * sgn, a0 * sgn], g };
}
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/**
 * The part of the shader that draws a particle as the wired picture. Only in the shader when a picture is wired (a pass
 * declares only the textures it is given), so the node has two shader texts: with and without a picture.
 */
const SPRITE_WGSL = /* wgsl */ `if (u.useSprite > 0.5) {
        // The particle is a picture: same place, size, life and colors as the type; only what is drawn changes.
        var sa = 0.0;
        if (u.sprTurn > 1.5) { sa = h0.z * TAU + TAU * (u.phase * u.cycles * (1.0 + floor(h0.y * 2.0)) + h0.x); }
        else if (u.sprTurn > 0.5) { sa = ang + 0.25 * TAU; }
        let sc = cos(sa); let ss = sin(sa);
        let ls = vec2f(sc * l0.x + ss * l0.y, -ss * l0.x + sc * l0.y);
        var hb = u.sprHalf * rad;
        if (u.sprFlip > 0.5) { hb.y *= max(0.08, abs(cos(TAU * (u.phase * u.cycles * (1.0 + floor(h0.z * 3.0)) + h0.w)))); }
        let suv = ls / (2.0 * hb) + 0.5;
        if (suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0) {
          if (u.soft > 0.5) { tex = textureSampleLevel(spr, smp, suv, 0.0); } else { tex = textureSampleLevel(spr, smpNearest, suv, 0.0); }
        }
        cov = tex.a;
      }`;

export default defineNode({
  id: 'particles',
  title: 'Particles',
  category: 'generate',
  description: 'Dust, snow, rain, sparks, bubbles, fireflies, confetti or twinkling stars. Wire a picture, a shape or text into Particle picture and every particle is drawn as that, moving like the chosen type. Handles thousands of particles and loops exactly.',
  keywords: ['sprite', 'picture particles', 'text particles', 'shape particles', 'emoji', 'leaves', 'snow', 'rain', 'dust', 'sparks', 'embers', 'bubbles', 'fireflies', 'confetti', 'stars', 'twinkle', 'weather', 'overlay', 'emitter'],
  inputs: { size: { type: 'image', label: 'Size from' }, sprite: { type: 'image', label: 'Particle picture' } },
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
    spriteTurn: {
      type: 'enum',
      default: 'auto',
      label: 'Turn',
      group: 'Particle picture',
      options: [
        { value: 'auto', label: 'Like the type' },
        { value: 'upright', label: 'Upright' },
        { value: 'direction', label: 'Point where it goes' },
        { value: 'spin', label: 'Spin' },
      ],
      hint: 'Used when something is wired into Particle picture. Like the type: confetti tumbles and flips, rain and sparks point along their path, the others stay upright.',
    },
    spriteTint: { type: 'bool', default: false, label: 'Color it', group: 'Particle picture', hint: 'Multiply the picture by the particle colors (the type colors, or Color A / B). White text or shapes take the colors fully. Off = the picture\'s own colors.' },
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
    const sprite = ctx.in.sprite ?? null;
    // A particle picture is drawn with its longer side = the particle's diameter x spriteK (types whose shape reaches past the radius get a matching size).
    const spriteK = r.shape === 'streak' ? 1 + 0.5 * r.streak : r.shape === 'sparkle' || r.shape === 'glow' ? 1.3 : 1;
    const turn = p.spriteTurn === 'upright' ? 0 : p.spriteTurn === 'direction' ? 1 : p.spriteTurn === 'spin' ? 2 : r.shape === 'rect' ? 2 : r.shape === 'streak' ? 1 : 0;
    const shapeReach = r.shape === 'streak' ? 1 + r.streak : r.shape === 'sparkle' ? 2 : r.shape === 'glow' ? 2.6 : r.shape === 'rect' ? 1.5 : r.shape === 'bubble' ? 1.15 : 1.05;
    const reachMul = sprite ? spriteK * Math.SQRT2 + 0.05 : shapeReach;

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
    // Loop on: the random properties of a particle come from its cell modulo the layer's drift (see driftKey); Loop off hashes the cell itself, as before.
    const keys = layers.map((l, i) => {
      const k = driftKey(Math.round(l[1] / l[0]), Math.round(l[2] / l[0]));
      return ctx.time.loop ? k : { m: [0, 0, 0, 0] as [number, number, number, number], g: 0 };
    });

    const soft = r.forceSoft ? true : r.forceHard ? false : p.soft;
    const colA = p.presetColors ? r.a : rgba(p.colorA);
    const colB = p.presetColors ? r.b : rgba(p.colorB);
    // A picture much larger than the particles is halved until it is about twice their size on screen: a plain sample of a
    // large picture drawn small would shimmer. (The wired picture itself is never recycled.)
    let spr = sprite;
    if (sprite) {
      const want = Math.max(16, 2 * base * r.sizeMul * LAYER_SIZE[2] * (1 + r.sizeVar) * spriteK);
      while (Math.max(spr!.width, spr!.height) > 2 * want && Math.min(spr!.width, spr!.height) >= 4) {
        const half = ctx.gpu.pass({ label: 'particles-sprite-half', size: { width: Math.max(1, Math.ceil(spr!.width / 2)), height: Math.max(1, Math.ceil(spr!.height / 2)) }, textures: { src: spr! }, wgsl: 'fn fx(uv: vec2f, px: vec2f) -> vec4f { return textureSampleLevel(src, smp, uv, 0.0); }' });
        if (spr !== sprite) ctx.gpu.recycle(spr!);
        spr = half;
      }
    }
    const image = ctx.gpu.pass({
      label: 'particles',
      size,
      textures: { spr },
      uniforms: {
        useSprite: !!sprite,
        // half extents of the picture in units of the particle radius (longer side = spriteK)
        sprHalf: sprite ? [(spriteK * sprite.width) / Math.max(sprite.width, sprite.height), (spriteK * sprite.height) / Math.max(sprite.width, sprite.height)] : [1, 1],
        sprTurn: turn,
        sprFlip: p.spriteTurn === 'auto' && r.shape === 'rect',
        sprTint: p.spriteTint,
        l0: layers[0],
        l1: layers[1],
        l2: layers[2],
        k0: keys[0].m,
        k1: keys[1].m,
        k2: keys[2].m,
        gs: [keys[0].g, keys[1].g, keys[2].g],
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

fn layer(px: vec2f, L: vec4f, K: vec4f, gk: f32, li: i32, acc: vec4f) -> vec4f {
  let C = L.x;
  let q = px - L.yz * u.phase;          // the layer's grid drifts by whole cells per loop
  let ci = vec2i(floor(q / C));
  var out = acc;
  let shape = i32(u.shape);
  let salt = li * 131 + i32(u.seed);
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let cc = ci + vec2i(i, j);
      var kx = cc.x;
      var ky = cc.y;
      if (gk > 0.5) {
        let gi = i32(gk + 0.5);
        kx = i32(K.x) * cc.y - i32(K.y) * cc.x;
        ky = ((cc.x * i32(K.w) - cc.y * i32(K.z)) % gi + gi) % gi;
      }
      let h0 = rnd4(kx, ky, salt);
      let tt = u.phase * u.cycles + h0.x;
      let life = fract(tt);
      var lifeId = 0;
      if (u.respawn > 0.5) { lifeId = i32(floor(tt) % u.cycles); }
      let h1 = rnd4(kx + lifeId * 7919, ky - lifeId * 104729, salt + 5000);

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
      var tex = vec4f(0.0);
      ${sprite ? SPRITE_WGSL + ' else ' : ''}if (shape == 0) {
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
      var rgb = col.rgb * al;
      if (u.useSprite > 0.5) {
        // the picture is premultiplied: its own colors (optionally multiplied by the particle color), faded like the particle
        let k = a * u.opacity * col.a;
        if (u.sprTint > 0.5) { rgb = tex.rgb * col.rgb * k; } else { rgb = tex.rgb * k; }
      }
      out = vec4f(rgb, al) + out * (1.0 - al);
    }
  }
  return out;
}

fn fx(uv: vec2f, px: vec2f) -> vec4f {
  var c = vec4f(0.0);
  c = layer(px, u.l0, u.k0, u.gs.x, 0, c);
  c = layer(px, u.l1, u.k1, u.gs.y, 1, c);
  c = layer(px, u.l2, u.k2, u.gs.z, 2, c);
  return c;
}`,
    });
    if (spr && spr !== sprite) ctx.gpu.recycle(spr);
    return { image };
  },
});
