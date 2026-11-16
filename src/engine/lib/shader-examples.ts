/**
 * Starter snippets for the Custom Shader node (WGSL, "body" form: the text between the braces of
 * `fn fx(uv: vec2f, px: vec2f) -> vec4f`). Every snippet compiles with and without an input image and loops when it
 * animates (motion comes from `u.phase` with whole cycles).
 */

export const SHADER_HELP = `// Body of: fn fx(uv: vec2f, px: vec2f) -> vec4f   (WGSL). Return PREMULTIPLIED rgba.
// uv      0..1 across the frame, (0,0) = top-left          px   pixel position
// u.size  output size in pixels      u.time  seconds        u.phase  0..1 over the loop (use whole cycles: sin(u.phase * TAU))
// u.a u.b u.c u.d  sliders 0..1      u.color  the colour parameter (straight rgba)
// src(uv) / src2(uv)  sample Image / Image 2 (premultiplied; transparent when not wired)   HAS_SRC / HAS_SRC2  true when wired
// helpers: unpremul premul luma hash21 vnoise loopNoise rgbToHsv hsvToRgb PI TAU ...`;

export const DEFAULT_SHADER = `// Animated glow. Works with or without an input image.
// a = pattern scale, b = how strongly the glow shows, colour = glow colour.
let t = u.phase * TAU;
let p = (uv - 0.5) * vec2f(u.size.x / u.size.y, 1.0) * (2.0 + u.a * 6.0);
let wave = 0.5 + 0.25 * (sin(p.x * 2.0 + t) + cos(p.y * 2.0 - t));
let glow = u.color.rgb * (0.25 + 0.75 * wave);
if (HAS_SRC) {
  let s = unpremul(src(uv));
  return premul(vec4f(mix(s.rgb, glow, u.b * wave), s.a));
}
return vec4f(glow, 1.0);`;

export const SHADER_EXAMPLES: readonly { label: string; code: string }[] = [
  { label: 'Glow wave (default)', code: DEFAULT_SHADER },
  {
    label: 'Plasma',
    code: `// Classic plasma. a = scale, b = speed of colour cycling (whole cycles), c = contrast, colour tints it.
let t = u.phase * TAU;
let p = (uv - 0.5) * vec2f(u.size.x / u.size.y, 1.0) * (3.0 + u.a * 12.0);
var v = sin(p.x + t);
v += sin((p.y + t) * 0.5);
v += sin((p.x + p.y + t) * 0.5);
let q = p + 0.5 * vec2f(sin(t * 0.5 + p.x), cos(t * 0.5 + p.y));
v += sin(sqrt(dot(q, q) + 1.0) + t);
let h = fract(v * 0.25 + u.b);
let rgb = hsvToRgb(vec3f(h, 0.75, 0.5 + 0.5 * u.c));
return vec4f(mix(rgb, rgb * u.color.rgb, 0.5), 1.0);`,
  },
  {
    label: 'Chromatic split',
    code: `// Splits red and blue sideways (needs an input). a = distance, b = angle, loops with a gentle wobble.
if (!HAS_SRC) { return vec4f(uv, 0.5, 1.0); }
let ang = u.b * TAU + sin(u.phase * TAU) * 0.3;
let ofs = vec2f(cos(ang), sin(ang)) * u.a * 0.05;
let r = src(uv + ofs);
let g = src(uv);
let bl = src(uv - ofs);
return vec4f(r.r, g.g, bl.b, max(r.a, max(g.a, bl.a)));`,
  },
  {
    label: 'Scan warp',
    code: `// Rows slide sideways like a bad video signal (needs an input). a = amount, b = line density, c = rolling speed (whole cycles).
if (!HAS_SRC) { return vec4f(uv, 0.5, 1.0); }
let rows = 20.0 + u.b * 200.0;
let ln = floor(uv.y * rows);
let roll = floor(u.c * 4.0) * u.phase;
let n = hash21(vec2f(ln, floor(roll * 8.0))) - 0.5;
let wob = sin(uv.y * 12.0 + u.phase * TAU) * 0.004;
return src(vec2f(fract(uv.x + (n * u.a * 0.1) + wob), uv.y));`,
  },
  {
    label: 'Posterised glow',
    code: `// Flat colour bands plus a soft bloom around bright areas (needs an input). a = bands, b = glow, colour = glow tint.
if (!HAS_SRC) { return vec4f(vec3f(floor(uv.x * 4.0) / 3.0) * u.color.rgb, 1.0); }
let s = unpremul(src(uv));
let bands = 2.0 + floor(u.a * 6.0);
let pst = floor(s.rgb * bands + 0.5) / bands;
var blur = vec3f(0.0);
for (var i = 0; i < 8; i++) {
  let ang = f32(i) * TAU / 8.0;
  blur += src(uv + vec2f(cos(ang), sin(ang)) * 0.02).rgb;
}
blur = blur / 8.0;
let bloom = max(blur - 0.45, vec3f(0.0)) * u.b * 2.0 * u.color.rgb;
return premul(vec4f(clamp(pst + bloom, vec3f(0.0), vec3f(1.0)), s.a));`,
  },
  {
    label: 'Checker',
    code: `// Checkerboard, over the input if there is one. a = square size, b = how far it slides (whole squares per loop), colour = second tone.
let cell = 8.0 + u.a * 120.0;
let slide = floor(u.b * 4.0) * u.phase * cell;
let c = floor((px.x + slide) / cell) + floor(px.y / cell);
let sq = select(0.0, 1.0, (c - 2.0 * floor(c * 0.5)) > 0.5);
let tone = mix(vec3f(0.05), u.color.rgb, sq);
if (HAS_SRC) {
  let s = unpremul(src(uv));
  return premul(vec4f(mix(s.rgb, tone, 0.5), s.a));
}
return vec4f(tone, 1.0);`,
  },
];
