import { defineNode } from '../../define';
import { loopFrame } from '../../lib/fx-util';
import { gaussianBlur } from '../filter/blur.node';

/**
 * What the size of the film and the machine it runs through do to the picture: softness and grain (a smaller frame is
 * enlarged more, so both are larger), gate weave (the frame never sits in exactly the same place twice), flicker, dust,
 * scratches, vignetting and the rounded edge of the gate. All sizes are a share of the picture width, so a look is the
 * same at every resolution. Colour and contrast are Film Stock's job, the glow around lights is Halation's.
 */
export interface GaugeLook {
  label: string;
  /** Blur radius, percent of the width. */
  soft: number;
  grain: number;
  /** Grain size, percent of the width. */
  grainSize: number;
  /** Gate weave, percent of the width. */
  weave: number;
  flicker: number;
  dust: number;
  scratches: number;
  vignette: number;
  gate: boolean;
}

export const GAUGE_LOOKS: Record<string, GaugeLook> = {
  super8: { label: 'Super 8', soft: 0.32, grain: 0.55, grainSize: 0.36, weave: 0.45, flicker: 0.1, dust: 0.45, scratches: 0.3, vignette: 0.45, gate: true },
  film16: { label: '16mm', soft: 0.18, grain: 0.4, grainSize: 0.24, weave: 0.2, flicker: 0.06, dust: 0.3, scratches: 0.15, vignette: 0.3, gate: true },
  super16: { label: 'Super 16', soft: 0.14, grain: 0.34, grainSize: 0.2, weave: 0.14, flicker: 0.04, dust: 0.2, scratches: 0.08, vignette: 0.22, gate: false },
  film35: { label: '35mm', soft: 0.05, grain: 0.18, grainSize: 0.11, weave: 0.04, flicker: 0.015, dust: 0.07, scratches: 0.02, vignette: 0.1, gate: false },
  film65: { label: '65mm', soft: 0, grain: 0.08, grainSize: 0.07, weave: 0.015, flicker: 0.008, dust: 0.03, scratches: 0, vignette: 0.05, gate: false },
  home: { label: 'Home movie', soft: 0.5, grain: 0.75, grainSize: 0.42, weave: 0.9, flicker: 0.22, dust: 0.8, scratches: 0.6, vignette: 0.6, gate: true },
  lost: { label: 'Lost reel', soft: 0.6, grain: 1, grainSize: 0.5, weave: 1.6, flicker: 0.45, dust: 1, scratches: 1, vignette: 0.8, gate: true },
};

/** A repeatable number 0..1 from two numbers (frame, slot). */
export function gaugeHash(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Where the frame sits this time (share of the width, x and y) and how bright the lamp is. */
export function gaugeFrame(frame: number, seed: number, weave: number, flicker: number): { dx: number; dy: number; gain: number } {
  // a slow drift plus a small jump per frame; film weaves more along its length (vertical) than sideways
  const slow = (k: number) => Math.sin(frame * 0.21 + k * 2.3 + seed) * 0.5 + Math.sin(frame * 0.083 + k * 5.1 + seed * 1.7) * 0.5;
  const jump = (k: number) => gaugeHash(frame + 0.5, seed + k) * 2 - 1;
  return {
    dx: (weave / 100) * (0.35 * slow(1) + 0.15 * jump(1)),
    dy: (weave / 100) * (0.6 * slow(2) + 0.4 * jump(2)),
    gain: 1 + flicker * (0.6 * jump(3) + 0.4 * slow(3)),
  };
}

const custom = (p: Record<string, unknown>): boolean => p.gauge === 'custom';

export default defineNode({
  id: 'film-gauge',
  title: 'Film Gauge',
  category: 'stylize',
  description: 'The feel of a film format and its projector: Super 8, 16mm, Super 16, 35mm or 65mm. Softness, grain, gate weave, flicker, dust, scratches, dark corners and the rounded edge of the gate. Use it after Film Stock and Halation for a full film look.',
  keywords: ['film', 'super 8', 'super8', 'super 16', 'super16', '16mm', '35mm', '65mm', '8mm', 'imax', 'film look', 'gate weave', 'jitter', 'flicker', 'dust', 'scratches', 'grain', 'projector', 'home movie', 'vintage', 'old film', 'analog', 'cinema'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    gauge: { type: 'enum', default: 'super8', options: [...Object.entries(GAUGE_LOOKS).map(([value, v]) => ({ value, label: v.label })), { value: 'custom', label: 'Custom' }], label: 'Gauge', hint: 'The smaller the film, the softer, grainier and shakier the picture. Custom shows every control.' },
    strength: { type: 'number', default: 1, min: 0, max: 2, step: 0.01, label: 'Strength', hint: 'Multiplies everything the gauge does.' },
    soft: { type: 'number', default: 0.3, min: 0, max: 2, step: 0.01, label: 'Softness %', visibleIf: custom, hint: 'Blur, percent of the picture width.' },
    grain: { type: 'number', default: 0.5, min: 0, max: 1.5, step: 0.01, label: 'Grain', visibleIf: custom },
    grainSize: { type: 'number', default: 0.35, min: 0.03, max: 1.5, step: 0.01, label: 'Grain size %', visibleIf: custom },
    weave: { type: 'number', default: 0.45, min: 0, max: 4, step: 0.01, label: 'Gate weave %', visibleIf: custom, hint: 'How far the frame wanders, percent of the picture width.' },
    flicker: { type: 'number', default: 0.1, min: 0, max: 1, step: 0.01, label: 'Flicker', visibleIf: custom },
    dust: { type: 'number', default: 0.45, min: 0, max: 1, step: 0.01, label: 'Dust', visibleIf: custom },
    scratches: { type: 'number', default: 0.3, min: 0, max: 1, step: 0.01, label: 'Scratches', visibleIf: custom },
    vignette: { type: 'number', default: 0.45, min: 0, max: 1, step: 0.01, label: 'Dark corners', visibleIf: custom },
    gate: { type: 'bool', default: true, label: 'Gate edge', visibleIf: custom, hint: 'The soft, rounded black edge of the camera gate.' },
    ownWeave: { type: 'bool', default: true, label: 'Gate weave', hint: 'Turn off when a Gate Weave node follows: that one moves the film in more detail (drift, frame jumps, tilt, slips).' },
    animated: { type: 'bool', default: true, label: 'Animated', hint: 'Off: one frozen frame of film.' },
    hold: { type: 'number', default: 1, min: 1, max: 6, step: 1, integer: true, label: 'Change every N', visibleIf: (p) => p.animated === true, hint: 'Grain, weave and dust change every N project frames. At 30 fps, 2 feels like film shot at 15 to 18 fps.' },
    seed: { type: 'number', default: 1, min: 0, max: 9999, step: 1, integer: true, label: 'Seed' },
  },
  summary: (p) => `${GAUGE_LOOKS[p.gauge as string]?.label ?? 'custom'}${p.strength !== 1 ? ` × ${p.strength}` : ''}`,
  render(ctx) {
    const raw = ctx.params;
    const src = ctx.in.image;
    if (!src || raw.strength <= 0) return { image: src };
    const base: GaugeLook = GAUGE_LOOKS[raw.gauge as string] ?? { label: 'Custom', soft: raw.soft, grain: raw.grain, grainSize: raw.grainSize, weave: raw.weave, flicker: raw.flicker, dust: raw.dust, scratches: raw.scratches, vignette: raw.vignette, gate: raw.gate };
    const k = raw.strength;
    const frame = raw.animated ? loopFrame(ctx.time, raw.hold) : 0;
    const f = gaugeFrame(frame, raw.seed, raw.ownWeave === false ? 0 : base.weave * k, Math.min(1, base.flicker * k));
    const soft = gaussianBlur(ctx.gpu, src, ((base.soft * k) / 100) * src.width);
    const image = ctx.gpu.pass({
      label: 'film-gauge',
      size: src,
      textures: { src: soft },
      uniforms: {
        off: [f.dx, f.dy * (src.width / src.height)],
        gain: f.gain,
        grain: base.grain * k,
        gsize: Math.max(0.6, (base.grainSize / 100) * src.width),
        dust: Math.min(1, base.dust * k),
        scratches: Math.min(1, base.scratches * k),
        vignette: Math.min(1, base.vignette * k),
        gate: base.gate,
        frame: frame + raw.seed * 13.37,
        // scratches stay in place for a while, then move
        slow: Math.floor(frame / 9) + raw.seed * 7.7,
      },
      wgsl: /* wgsl */ `
fn tri(c: vec2f, z: f32) -> f32 { return hash31(vec3f(c, z)) + hash31(vec3f(c + 7.7, z + 3.1)) - 1.0; }
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let aspect = u.size.x / u.size.y;
  let w = u.size.x;
  // gate weave: the picture moves, the gate does not
  let suv = clamp(uv + u.off, vec2f(0.0), vec2f(1.0));
  let s = textureSampleLevel(src, smp, suv, 0.0);
  var rgb = unpremul(s).rgb;

  // grain: two sizes of clumps, mostly brightness with a little colour, strongest in the middle tones
  let cell = px / u.gsize;
  let n1 = tri(floor(cell), u.frame);
  let n2 = tri(floor(cell * 0.5 + 3.3), u.frame + 11.0);
  let nc = vec3f(tri(floor(cell), u.frame + 31.0), tri(floor(cell), u.frame + 47.0), tri(floor(cell), u.frame + 59.0));
  let l = luma(rgb);
  let response = 1.0 - 0.65 * pow(abs(2.0 * l - 1.0), 2.0);
  rgb += (vec3f(n1 * 0.7 + n2 * 0.5) + nc * 0.3) * u.grain * 0.3 * response;

  // lamp flicker and dark corners
  let q = (uv - 0.5) * vec2f(1.0, 1.0 / aspect) * 2.0;
  let r = length(q) / length(vec2f(1.0, 1.0 / aspect));
  rgb *= u.gain * (1.0 - u.vignette * smoothstep(0.35, 1.05, r) * 0.75);

  // dust: at most one speck per cell and frame, dark (on the print) or light (on the negative)
  if (u.dust > 0.0) {
    let dc = uv * vec2f(9.0, 9.0 / aspect);
    let id = floor(dc);
    let h = hash31(vec3f(id, u.frame));
    if (h < u.dust * 0.22) {
      let pos = vec2f(0.2) + 0.6 * hash22(id + u.frame);
      let d = fract(dc) - pos;
      let ang = hash21(id + 5.5 + u.frame) * 6.283;
      let rot = vec2f(d.x * cos(ang) - d.y * sin(ang), d.x * sin(ang) + d.y * cos(ang));
      // most specks are round, some are short hairs
      let hair = step(0.7, hash21(id + 9.1 + u.frame));
      let shape = mix(length(rot), length(vec2f(max(abs(rot.x) - 0.12, 0.0), rot.y + 0.03 * sin(rot.x * 30.0))), hair);
      let size = mix(0.012, 0.04, hash21(id + 2.2 + u.frame)) * mix(1.0, 0.35, hair);
      let cov = 1.0 - smoothstep(size * 0.6, size, shape);
      let light = step(0.75, hash21(id + 3.3 + u.frame));
      rgb = mix(rgb, mix(vec3f(0.03), vec3f(0.95), light), cov * 0.85);
    }
  }

  // scratches: thin vertical lines that stay where they are for a few frames
  if (u.scratches > 0.0) {
    for (var i = 0; i < 4; i++) {
      let fi = f32(i);
      if (hash21(vec2f(fi * 3.1, u.slow)) < u.scratches * 0.6) {
        let x = hash21(vec2f(fi * 7.7 + 1.0, u.slow)) + 0.004 * sin(uv.y * 9.0 + fi + u.frame * 0.3);
        let line = 1.0 - smoothstep(0.0, 0.0012, abs(uv.x - x));
        let broken = smoothstep(0.25, 0.6, vnoise(vec2f(uv.y * 14.0 + fi * 5.0, u.frame * 0.7)));
        let light = step(0.4, hash21(vec2f(fi, u.slow + 4.0)));
        rgb = mix(rgb, mix(vec3f(0.05), vec3f(0.92, 0.95, 0.9), light), line * broken * 0.6);
      }
    }
  }

  // the gate: a soft, rounded black edge
  var a = s.a;
  if (u.gate > 0.5) {
    let half = vec2f(0.5 - 0.012, 0.5 - 0.012 * aspect);
    let rad = 0.035;
    let g = abs(uv - 0.5) - half + vec2f(rad, rad * aspect);
    let dist = length(max(g / vec2f(1.0, aspect), vec2f(0.0))) - rad;
    rgb *= 1.0 - smoothstep(-0.006, 0.004, dist);
    a = max(a, smoothstep(-0.006, 0.004, dist));
  }
  return premul(vec4f(clamp(rgb, vec3f(0.0), vec3f(1.0)), a));
}`,
    });
    return { image };
  },
});
