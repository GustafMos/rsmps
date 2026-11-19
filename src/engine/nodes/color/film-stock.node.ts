import { defineNode } from '../../define';

/**
 * Film stock looks from a small model of how film answers light, not from lookup tables:
 *   1. the picture is turned into linear light, and the three layers see a mix of red, green and blue (`mix`: no layer is
 *      sensitive to one colour only, and some stocks are built to see colours "wrong");
 *   2. each layer has its own speed (`bal`, in stops: the colour cast) and its own contrast (`g`), and answers with an
 *      S-curve in stops (toe, straight part, shoulder), with `lat` stops of room above white before it clips: negative
 *      film has a lot, slide film very little;
 *   3. colour is made stronger or weaker as dye density, not as light (`sat`): saturated colours get darker and richer
 *      instead of glowing, which is the look of dyes;
 *   4. the darkest black the film can make is not black (`fog`).
 * Middle grey stays middle grey on every stock, so a stock changes the look, not the exposure.
 * This is a parametric model tuned by eye. It is not built from measured spectral data of real stocks.
 */
export interface FilmStock {
  label: string;
  mix: [number[], number[], number[]];
  bal: number[];
  g: number[];
  lat: number;
  sat: number;
  fog: number[];
  mono?: boolean;
}

const I: [number[], number[], number[]] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export const FILM_STOCKS: Record<string, FilmStock> = {
  portrait400: { label: 'Portrait negative 400', mix: [[0.92, 0.06, 0.02], [0.04, 0.92, 0.04], [0.02, 0.08, 0.9]], bal: [0.1, 0, -0.12], g: [1.25, 1.25, 1.2], lat: 2.2, sat: 0.95, fog: [0.006, 0.0054, 0.0048] },
  vivid100: { label: 'Vivid negative 100', mix: [[1.05, -0.04, -0.01], [-0.03, 1.06, -0.03], [-0.01, -0.05, 1.06]], bal: [0.03, 0, -0.03], g: [1.5, 1.5, 1.5], lat: 1.6, sat: 1.1, fog: [0.0024, 0.0024, 0.0024] },
  gold200: { label: 'Golden consumer 200', mix: [[0.95, 0.05, 0], [0.04, 0.94, 0.02], [0, 0.1, 0.9]], bal: [0.18, 0.04, -0.2], g: [1.4, 1.35, 1.3], lat: 1.8, sat: 1.1, fog: [0.0075, 0.006, 0.0036] },
  green400: { label: 'Cool green negative 400', mix: [[0.95, 0.05, 0], [0.02, 0.98, 0], [0, 0.12, 0.88]], bal: [-0.08, 0.05, 0.05], g: [1.35, 1.3, 1.35], lat: 2, sat: 1.05, fog: [0.0042, 0.0054, 0.0054] },
  tungsten500: { label: 'Cinema tungsten 500', mix: [[0.94, 0.05, 0.01], [0.04, 0.93, 0.03], [0.01, 0.07, 0.92]], bal: [-0.05, 0, 0.08], g: [1.22, 1.2, 1.16], lat: 2.6, sat: 0.9, fog: [0.0042, 0.0054, 0.0072] },
  daylight250: { label: 'Cinema daylight 250', mix: [[0.95, 0.04, 0.01], [0.03, 0.94, 0.03], [0.01, 0.06, 0.93]], bal: [0.04, 0, -0.04], g: [1.25, 1.25, 1.25], lat: 2.5, sat: 1, fog: [0.0036, 0.0036, 0.0036] },
  slideVivid: { label: 'Vivid slide', mix: [[1.08, -0.06, -0.02], [-0.04, 1.1, -0.06], [-0.02, -0.08, 1.1]], bal: [-0.02, 0, 0.04], g: [1.75, 1.8, 1.85], lat: 0.7, sat: 1.15, fog: [0.0012, 0.0012, 0.0012] },
  slideClassic: { label: 'Classic slide', mix: [[1.07, -0.06, -0.01], [-0.03, 1.05, -0.02], [-0.01, -0.04, 1.05]], bal: [0.06, 0, -0.02], g: [1.7, 1.62, 1.66], lat: 0.8, sat: 1.05, fog: [0.0015, 0.0015, 0.0015] },
  bleach: { label: 'Bleach bypass', mix: I, bal: [0, 0, 0], g: [1.9, 1.9, 1.9], lat: 1.2, sat: 0.45, fog: [0.003, 0.003, 0.003] },
  cross: { label: 'Cross processed', mix: [[1.05, -0.05, 0], [0, 1.05, -0.05], [0, -0.05, 1.05]], bal: [-0.1, 0.18, -0.3], g: [1.9, 1.6, 1.25], lat: 1, sat: 1.15, fog: [0.0006, 0.0036, 0.015] },
  expired: { label: 'Expired film', mix: [[0.9, 0.08, 0.02], [0.06, 0.88, 0.06], [0.04, 0.1, 0.86]], bal: [0.1, -0.06, 0.05], g: [1.05, 1, 1.05], lat: 2, sat: 0.7, fog: [0.0225, 0.015, 0.0195] },
  redscale: { label: 'Redscale', mix: [[0.55, 0.4, 0.05], [0.12, 0.4, 0.08], [0.02, 0.06, 0.1]], bal: [0.2, 0, -0.4], g: [1.5, 1.5, 1.4], lat: 1.6, sat: 1.1, fog: [0.006, 0.0024, 0.0012] },
  purple: { label: 'Purple shift', mix: [[0.6, 0.6, -0.2], [0.3, 0.1, 0.6], [0.1, 0.7, 0.2]], bal: [0, 0, 0], g: [1.4, 1.4, 1.4], lat: 1.8, sat: 1.2, fog: [0.0036, 0.003, 0.0048] },
  infrared: { label: 'Infrared color', mix: [[0.05, 1.15, -0.2], [0.95, 0.05, 0], [0, 0.3, 0.7]], bal: [0, 0, 0], g: [1.5, 1.5, 1.5], lat: 1.5, sat: 1.1, fog: [0.0024, 0.0024, 0.0024] },
  bw400: { label: 'B&W classic 400', mix: [[0.25, 0.45, 0.3], I[1], I[2]], bal: [0, 0, 0], g: [1.45, 1.45, 1.45], lat: 2.2, sat: 1, fog: [0.006, 0.006, 0.006], mono: true },
  bw100: { label: 'B&W fine 100', mix: [[0.3, 0.55, 0.15], I[1], I[2]], bal: [0, 0, 0], g: [1.6, 1.6, 1.6], lat: 1.6, sat: 1, fog: [0.0024, 0.0024, 0.0024], mono: true },
  bwHard: { label: 'B&W hard', mix: [[0.3, 0.5, 0.2], I[1], I[2]], bal: [0, 0, 0], g: [2.8, 2.8, 2.8], lat: 0.6, sat: 1, fog: [0.0012, 0.0012, 0.0012], mono: true },
  bwRed: { label: 'B&W red filter', mix: [[0.95, 0.15, -0.1], I[1], I[2]], bal: [0, 0, 0], g: [1.7, 1.7, 1.7], lat: 1.6, sat: 1, fog: [0.0036, 0.0036, 0.0036], mono: true },
};

/** Scene white (a 100 % reflecting surface) is this many times middle grey. */
const WHITE = 1 / 0.18;

/** The constants of one layer's curve: `s` puts middle grey at 18 %, `vw` is the curve's value where the film clips. */
export function layerCurve(g: number, lat: number): { s: number; vw: number } {
  // Film keeps detail above white (`lat` stops of it). The picture we get has none left up there, so only a part of that
  // room is used: white lands a little under full white on stocks with a lot of latitude, and that gap is the soft shoulder.
  const mw = Math.pow(WHITE * Math.pow(2, lat * 0.2), g);
  const s = (0.82 * mw) / (0.18 * mw - 1);
  return { s, vw: mw / (mw + s) };
}

/** One layer's answer (0..1 linear) to light `m` (1 = middle grey). */
export function layerResponse(m: number, g: number, lat: number): number {
  const { s, vw } = layerCurve(g, lat);
  const mg = Math.pow(Math.max(0, m), g);
  return Math.min(1, mg / (mg + s) / vw);
}

export default defineNode({
  id: 'film-stock',
  title: 'Film Stock',
  category: 'color',
  description: 'The colour and contrast of film: negative, cinema, slide and black-and-white stocks, plus processing accidents and stocks that see colour wrong. Built from a model of how film layers answer light, so highlights roll off and colours get dense the way film does.',
  keywords: ['film', 'film look', 'emulation', 'stock', 'negative', 'slide', 'portra', 'ektar', 'gold', 'fuji', 'kodak', 'vision3', 'velvia', 'kodachrome', 'tri-x', 'bleach bypass', 'cross process', 'redscale', 'lomo', 'aerochrome', 'analog', 'cinema', 'print', 'spektrafilm', 'black and white'],
  inputs: { image: { type: 'image', required: true, label: 'Image' } },
  outputs: { image: { type: 'image', label: 'Image' } },
  maskable: true,
  params: {
    stock: { type: 'enum', default: 'portrait400', options: Object.entries(FILM_STOCKS).map(([value, v]) => ({ value, label: v.label })), label: 'Stock' },
    exposure: { type: 'number', default: 0, min: -4, max: 4, step: 0.05, label: 'Exposure stops', hint: 'Over- or underexpose the film. Negative film takes overexposure well: plus 1 or 2 gives the pale, creamy look.' },
    contrast: { type: 'number', default: 1, min: 0.4, max: 2, step: 0.01, label: 'Contrast', hint: 'Multiplies the contrast of the stock. Above 1 is like pushing the film in development.' },
    saturation: { type: 'number', default: 1, min: 0, max: 2, step: 0.01, label: 'Saturation', hint: 'Multiplies the colour of the stock, as dye density: more colour is also darker, richer colour.' },
    fade: { type: 'number', default: 0, min: 0, max: 1, step: 0.01, label: 'Fade', hint: 'Lifts the blacks, like an old or thin print.' },
    strength: { type: 'number', default: 1, min: 0, max: 1, step: 0.01, label: 'Strength', hint: 'Mixes the film look with the original picture.' },
  },
  summary: (p) => `${FILM_STOCKS[p.stock as string]?.label ?? p.stock}${p.exposure ? ` · ${p.exposure > 0 ? '+' : ''}${p.exposure} stops` : ''}`,
  render(ctx) {
    const p = ctx.params;
    const src = ctx.in.image;
    if (!src || p.strength <= 0) return { image: src };
    const st = FILM_STOCKS[p.stock as string] ?? FILM_STOCKS.portrait400;
    const g = st.g.map((v) => v * p.contrast);
    const curves = g.map((v) => layerCurve(v, st.lat));
    const fog = st.fog.map((v) => v + (1 - v) * p.fade * 0.25);
    const image = ctx.gpu.pass({
      label: 'film-stock',
      size: src,
      textures: { src },
      uniforms: {
        m0: st.mix[0], m1: st.mix[1], m2: st.mix[2],
        gain: st.bal.map((b) => Math.pow(2, b + p.exposure) / 0.18),
        g, s: curves.map((c) => c.s), vw: curves.map((c) => c.vw),
        sat: st.mono ? 1 : st.sat * p.saturation, fog, mono: !!st.mono, strength: p.strength,
      },
      wgsl: /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let s = textureSampleLevel(src, smpNearest, uv, 0.0);
  let c = unpremul(s);
  let lin = srgbToLinear(c.rgb);
  var e = vec3f(dot(lin, u.m0), dot(lin, u.m1), dot(lin, u.m2));
  if (u.mono > 0.5) { e = vec3f(e.x); }
  let m = max(e, vec3f(0.0)) * u.gain;
  let mg = pow(m, u.g);
  var v = clamp(mg / (mg + u.s) / u.vw, vec3f(0.0), vec3f(1.0));
  // colour as dye density
  let d = -log(max(v, vec3f(0.0001)));
  let dm = (d.x + d.y + d.z) / 3.0;
  v = exp(-max(vec3f(dm) + (d - vec3f(dm)) * u.sat, vec3f(0.0)));
  v = u.fog + (vec3f(1.0) - u.fog) * v;
  let outc = linearToSrgb(clamp(v, vec3f(0.0), vec3f(1.0)));
  return premul(vec4f(mix(c.rgb, outc, u.strength), c.a));
}`,
    });
    return { image };
  },
});
