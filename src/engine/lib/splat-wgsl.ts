/**
 * WGSL of the splat renderer. One module per STRUCTURE (source: cloud buffers or a picture; mode: sorted or order-independent draft;
 * with or without the depth attachment). Every number is read from the uniform array `fr` (rule 24: a slider compiles nothing).
 *
 * `fr` slots (vec4f each); the TypeScript that fills them is in splat-render.ts and has the same table:
 *    0 camPos.xyz, perspective(1)/orthographic(0)      1 right.xyz, tanH           2 up.xyz, orthoHalf        3 fwd.xyz, near
 *    4 width, height, 2*shiftX, 2*shiftY               5..7 object matrix rows A.xyz, translation   8 fit centre.xyz, fit scale
 *    9 size, opacity multiplier, min opacity, shape (0 gaussian, 1 sharp ellipse, 2 square)
 *   10 exposure gain, saturation, antialias(0/1), view dependent(0/1)       11 tint.rgb, max pixels
 *   12 crop mode (0 none, 1 box, 2 sphere), invert, radius, _       13 crop centre.xyz, use sorted order(0/1)    14 crop half size.xyz, count
 *   15 zNear, zFar (draft weights)
 *   picture only: 16 grid w, h, picture w, h      17 near, far, depth encoding, guess kind      18 thickness, sigma factor, edge threshold, edge mode
 *   19 jitter, _, _, _      20 capture camPos, perspective   21 capture right, tanH   22 capture up, orthoHalf   23 capture fwd   24 2*capture shift
 *   25 grid order: splitX, dirX, splitY, dirY
 */
export const FR_SLOTS = 26;

export interface ShaderKey {
  source: 'cloud' | 'picture';
  mode: 'sorted' | 'draft';
  depth: boolean;
}

const COMMON = /* wgsl */ `
@group(0) @binding(0) var<uniform> fr: array<vec4f, ${FR_SLOTS}>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) col: vec4f,
  @location(2) @interpolate(flat) aux: vec4f,
};

struct Proj { ok: bool, c: vec2f, cov: vec3f, depth: f32 };

// EWA projection of a world-space covariance (see lib/splat-math.ts for the formulas)
fn projectGaussian(cw: vec3f, sig: mat3x3f) -> Proj {
  var o: Proj;
  o.ok = false; o.c = vec2f(0.0); o.cov = vec3f(0.0); o.depth = 0.0;
  let right = fr[1].xyz; let up = fr[2].xyz; let fwd = fr[3].xyz;
  let d = cw - fr[0].xyz;
  let t = vec3f(dot(d, right), dot(d, up), dot(d, fwd));
  let W = fr[4].x; let H = fr[4].y;
  let short = min(W, H);
  let sh = fr[4].zw;
  var T0 = vec3f(0.0);
  var T1 = vec3f(0.0);
  if (fr[0].w < 0.5) {
    let oh = fr[2].w;
    let f = short * 0.5 / oh;
    o.c = (t.xy / oh + sh) * (short * 0.5);
    T0 = right * f;
    T1 = up * f;
    o.depth = t.z;
  } else {
    if (t.z < fr[3].w) { return o; }
    let tanH = fr[1].w;
    let f = short * 0.5 / tanH;
    o.c = (t.xy / (t.z * tanH) + sh) * (short * 0.5);
    let spx = sh * (short * 0.5);
    let x = clamp(t.x / t.z, (-0.65 * W - spx.x) / f, (0.65 * W - spx.x) / f);
    let y = clamp(t.y / t.z, (-0.65 * H - spx.y) / f, (0.65 * H - spx.y) / f);
    let iz = 1.0 / t.z;
    T0 = right * (f * iz) - fwd * (f * x * iz);
    T1 = up * (f * iz) - fwd * (f * y * iz);
    o.depth = length(d);
  }
  let s0 = sig * T0;
  let s1 = sig * T1;
  o.cov = vec3f(dot(T0, s0), dot(T1, s0), dot(T1, s1));
  o.ok = true;
  return o;
}

struct Qd { ok: bool, pos: vec4f, uv: vec2f, alpha: f32 };

// low pass + eigen-decomposition + the quad of one corner (corner in -1..1)
fn makeQuad(pr: Proj, opacity: f32, corner: vec2f) -> Qd {
  var q: Qd;
  q.ok = false; q.pos = vec4f(2.0, 2.0, 0.0, 1.0); q.uv = vec2f(0.0); q.alpha = 0.0;
  var cxx = pr.cov.x;
  let cxy = pr.cov.y;
  var cyy = pr.cov.z;
  let det0 = max(cxx * cyy - cxy * cxy, 0.0);
  cxx = cxx + 0.3;
  cyy = cyy + 0.3;
  let det1 = cxx * cyy - cxy * cxy;
  var a = opacity;
  if (fr[10].z > 0.5) { a = a * sqrt(det0 / det1); }
  if (a < 0.0039) { return q; }
  let mid = 0.5 * (cxx + cyy);
  let rr = sqrt(0.25 * (cxx - cyy) * (cxx - cyy) + cxy * cxy);
  let l1 = mid + rr;
  let l2 = max(det1 / l1, 1e-4);
  let ang = 0.5 * atan2(2.0 * cxy, cxx - cyy);
  let v1 = vec2f(cos(ang), sin(ang));
  let v2 = vec2f(-v1.y, v1.x);
  let shape = i32(fr[9].w);
  let maxPix = fr[11].w;
  let s1 = sqrt(l1);
  let s2 = sqrt(l2);
  var K = min(3.3, sqrt(2.0 * log(max(255.0 * a, 1.0001))));
  if (shape == 1) { K = 1.7; }
  let e1 = min(K * s1, maxPix);
  let e2 = min(K * s2, maxPix);
  var off = corner.x * e1 * v1 + corner.y * e2 * v2;
  var uv = vec2f(corner.x * e1 / s1, corner.y * e2 / s2);
  var ext = max(e1, e2);
  if (shape == 1) { uv = corner * vec2f(e1 / (K * s1), e2 / (K * s2)); }
  if (shape == 2) {
    let sz = min(1.6 * sqrt(0.5 * (l1 + l2)), maxPix);
    off = corner * sz;
    uv = corner;
    ext = sz;
  }
  let hs = vec2f(fr[4].x, fr[4].y) * 0.5;
  if (abs(pr.c.x) > hs.x + ext || abs(pr.c.y) > hs.y + ext) { return q; }
  q.ok = true;
  q.pos = vec4f((pr.c.x + off.x) / hs.x, (pr.c.y + off.y) / hs.y, 0.5, 1.0);
  q.uv = uv;
  q.alpha = a;
  return q;
}

fn lumaOf(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
`;

const CLOUD_VS = /* wgsl */ `
@group(0) @binding(1) var<storage, read> data: array<vec4f>;
@group(0) @binding(2) var<storage, read> order: array<u32>;
@group(0) @binding(3) var<storage, read> shc: array<f32>;

fn quatMat(q: vec4f) -> mat3x3f {
  let w = q.x; let x = q.y; let y = q.z; let z = q.w;
  return mat3x3f(
    vec3f(1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y)),
    vec3f(2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x)),
    vec3f(2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)));
}

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(2.0, 2.0, 0.0, 1.0); o.uv = vec2f(0.0); o.col = vec4f(0.0); o.aux = vec4f(0.0);
  var cs = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  let corner = cs[vi];
  var id = ii;
  if (fr[13].w > 0.5) { id = order[ii]; }
  let b = id * 4u;
  let A = data[b]; let B = data[b + 1u]; let C = data[b + 2u]; let D = data[b + 3u];
  let opacity = A.w * fr[9].y;
  if (opacity < fr[9].z || opacity < 0.0039) { return o; }
  let p = A.xyz;
  if (fr[12].x > 0.5) {
    let q = fr[8].w * (p - fr[8].xyz);
    var inside = true;
    if (fr[12].x < 1.5) { inside = all(abs(q - fr[13].xyz) <= fr[14].xyz); }
    else { inside = length(q - fr[13].xyz) <= fr[12].z; }
    if (inside == (fr[12].y > 0.5)) { return o; }
  }
  let Am = transpose(mat3x3f(fr[5].xyz, fr[6].xyz, fr[7].xyz));
  let tr = vec3f(fr[5].w, fr[6].w, fr[7].w);
  let cw = Am * (p - fr[8].xyz) + tr;
  let s = B.xyz * fr[9].x;
  let M = (Am * quatMat(C)) * mat3x3f(vec3f(s.x, 0.0, 0.0), vec3f(0.0, s.y, 0.0), vec3f(0.0, 0.0, s.z));
  let sig = M * transpose(M);
  let pr = projectGaussian(cw, sig);
  if (!pr.ok) { return o; }
  var rgb = D.xyz;
  if (fr[10].w > 0.5) {
    // spherical harmonics degree 1 (direction in the file's own frame; higher degrees are not stored)
    var dw = fr[3].xyz;
    if (fr[0].w > 0.5) { dw = normalize(cw - fr[0].xyz); }
    let df = normalize(transpose(Am) * dw);
    let sb = id * 9u;
    let C1 = 0.4886025119029199;
    rgb = rgb + C1 * vec3f(
      -df.y * shc[sb] + df.z * shc[sb + 1u] - df.x * shc[sb + 2u],
      -df.y * shc[sb + 3u] + df.z * shc[sb + 4u] - df.x * shc[sb + 5u],
      -df.y * shc[sb + 6u] + df.z * shc[sb + 7u] - df.x * shc[sb + 8u]);
  }
  rgb = max(rgb, vec3f(0.0)) * fr[10].x;
  rgb = mix(vec3f(lumaOf(rgb)), rgb, fr[10].y) * fr[11].xyz;
  rgb = clamp(rgb, vec3f(0.0), vec3f(1.0));
  let qd = makeQuad(pr, opacity, corner);
  if (!qd.ok) { return o; }
  o.pos = qd.pos;
  o.uv = qd.uv;
  o.col = vec4f(rgb, qd.alpha);
  o.aux = vec4f(pr.depth, clamp((pr.depth - fr[15].x) / max(fr[15].y - fr[15].x, 1e-6), 0.0, 1.0), 0.0, 0.0);
  return o;
}
`;

const PICTURE_VS = /* wgsl */ `
@group(0) @binding(1) var imgTex: texture_2d<f32>;
@group(0) @binding(2) var depTex: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;

fn axisIndex(k: u32, n: u32, split: u32, dir: f32) -> u32 {
  var kk = k;
  if (dir < 0.0) { kk = n - 1u - k; }
  if (kk < split) { return kk; }
  return n - 1u - (kk - split);
}

fn hash2(a: u32, b: u32) -> vec2f {
  var h = a * 747796405u + b * 2891336453u + 1013904223u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  var g = h * 747796405u + 2891336453u;
  g = ((g >> ((g >> 28u) + 4u)) ^ g) * 277803737u;
  g = (g >> 22u) ^ g;
  return vec2f(f32(h & 65535u), f32(g & 65535u)) / 65536.0;
}

// how near a picture position is, 0..1 (1 = near), when the picture has no depth: a labelled guess
fn guessNear(uvp: vec2f) -> f32 {
  let kind = i32(fr[17].w);
  if (kind == 0) { return 0.5; }
  let c = textureSampleLevel(imgTex, smp, uvp, 0.0);
  let lum = lumaOf(c.rgb / max(c.a, 0.004));
  let r = length((uvp - 0.5) * vec2f(fr[16].z, fr[16].w) / min(fr[16].z, fr[16].w) * 2.0);
  let bulge = cos(clamp(r / 1.5, 0.0, 1.0) * 1.5707963);
  if (kind == 1) { return lum; }
  if (kind == 2) { return bulge; }
  return 0.5 * (lum + bulge);
}

// (distance along the capture ray, valid)
fn depthAt(uvp: vec2f) -> vec2f {
  let enc = i32(fr[17].z);
  if (enc == 2) {
    let dim = vec2f(textureDimensions(depTex));
    let ip = clamp(vec2i(floor(uvp * dim)), vec2i(0), vec2i(dim) - vec2i(1));
    let t = textureLoad(depTex, ip, 0);
    return vec2f(t.r, select(0.0, 1.0, t.a > 0.5 && t.r > 0.0));
  }
  var g = 0.5;
  if (enc == 3) { g = guessNear(uvp); }
  else {
    let t = textureSampleLevel(depTex, smp, uvp, 0.0);
    g = lumaOf(t.rgb / max(t.a, 0.004));
    if (enc == 1) { g = 1.0 - g; }
  }
  return vec2f(mix(fr[17].y, fr[17].x, clamp(g, 0.0, 1.0)), 1.0);
}

fn capRay(uvp: vec2f, org: ptr<function, vec3f>, dir: ptr<function, vec3f>) {
  let iw = fr[16].z; let ih = fr[16].w;
  let ish = min(iw, ih);
  let p = vec2f((uvp.x - 0.5) * iw, -(uvp.y - 0.5) * ih);
  let uf = p / (ish * 0.5) - fr[24].xy;
  if (fr[20].w < 0.5) {
    let oh = fr[22].w;
    *org = fr[20].xyz + fr[21].xyz * (uf.x * oh) + fr[22].xyz * (uf.y * oh);
    *dir = fr[23].xyz;
  } else {
    *org = fr[20].xyz;
    *dir = normalize(fr[23].xyz + fr[21].xyz * (uf.x * fr[21].w) + fr[22].xyz * (uf.y * fr[21].w));
  }
}

fn posAt(uvp: vec2f, dist: f32) -> vec3f {
  var org = vec3f(0.0);
  var dir = vec3f(0.0, 0.0, 1.0);
  capRay(uvp, &org, &dir);
  return org + dir * dist;
}

fn outer3(a: vec3f) -> mat3x3f { return mat3x3f(a * a.x, a * a.y, a * a.z); }

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  o.pos = vec4f(2.0, 2.0, 0.0, 1.0); o.uv = vec2f(0.0); o.col = vec4f(0.0); o.aux = vec4f(0.0);
  var cs = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));
  let corner = cs[vi];
  let gw = u32(fr[16].x); let gh = u32(fr[16].y);
  let kx = ii % gw; let ky = ii / gw;
  let gx = axisIndex(kx, gw, u32(fr[25].x), fr[25].y);
  let gy = axisIndex(ky, gh, u32(fr[25].z), fr[25].w);
  let sp = 1.0 / vec2f(f32(gw), f32(gh));
  var uvc = (vec2f(f32(gx), f32(gy)) + 0.5) * sp;
  if (fr[19].x > 0.0) { uvc = uvc + (hash2(gx, gy) - 0.5) * fr[19].x * sp; }
  uvc = clamp(uvc, vec2f(0.0), vec2f(1.0));
  // colour: four taps over the cell (a soft box filter of the picture)
  let q4 = sp * 0.25;
  let tex = 0.25 * (textureSampleLevel(imgTex, smp, uvc + vec2f(-q4.x, -q4.y), 0.0) + textureSampleLevel(imgTex, smp, uvc + vec2f(q4.x, -q4.y), 0.0) +
                    textureSampleLevel(imgTex, smp, uvc + vec2f(-q4.x, q4.y), 0.0) + textureSampleLevel(imgTex, smp, uvc + vec2f(q4.x, q4.y), 0.0));
  let opacity = tex.a * fr[9].y;
  if (opacity < 0.0039) { return o; }
  let d0 = depthAt(uvc);
  if (d0.y < 0.5) { return o; }
  let dl = depthAt(uvc - vec2f(sp.x, 0.0));
  let dr = depthAt(uvc + vec2f(sp.x, 0.0));
  let du = depthAt(uvc - vec2f(0.0, sp.y));
  let dd = depthAt(uvc + vec2f(0.0, sp.y));
  let Pl = posAt(uvc - vec2f(sp.x, 0.0), select(d0.x, dl.x, dl.y > 0.5));
  let Pr = posAt(uvc + vec2f(sp.x, 0.0), select(d0.x, dr.x, dr.y > 0.5));
  let Pu = posAt(uvc - vec2f(0.0, sp.y), select(d0.x, du.x, du.y > 0.5));
  let Pd = posAt(uvc + vec2f(0.0, sp.y), select(d0.x, dd.x, dd.y > 0.5));
  let Pc = posAt(uvc, d0.x);
  var a = (Pr - Pl) * 0.5;
  var b = (Pd - Pu) * 0.5;
  // footprint of one grid cell facing the capture camera at this distance
  let ish = min(fr[16].z, fr[16].w);
  let cell = fr[16].z / fr[16].x;
  var fp = (2.0 * fr[22].w / ish) * cell;
  if (fr[20].w > 0.5) { fp = d0.x * (2.0 * fr[21].w / ish) * cell; }
  fp = max(fp, 1e-6);
  // depth jumps stretch a and b: drop or shrink such splats
  let T = fr[18].z;
  if (T > 0.0) {
    let sa = length(a) / fp;
    let sb = length(b) / fp;
    if (max(sa, sb) > T) {
      if (fr[18].w < 0.5) { return o; }
      a = a * min(1.0, T / max(sa, 1e-6));
      b = b * min(1.0, T / max(sb, 1e-6));
    }
  }
  var n = cross(a, b);
  if (length(n) < 1e-12) { n = -fr[23].xyz; }
  n = normalize(n);
  let sg = fr[18].y;
  let th = fr[18].x * fp;
  let sig = outer3(a) * (sg * sg) + outer3(b) * (sg * sg) + outer3(n) * (th * th);
  let pr = projectGaussian(Pc, sig);
  if (!pr.ok) { return o; }
  let qd = makeQuad(pr, opacity, corner);
  if (!qd.ok) { return o; }
  o.pos = qd.pos;
  o.uv = qd.uv;
  o.col = vec4f(clamp(tex.rgb / max(tex.a, 0.004), vec3f(0.0), vec3f(1.0)), qd.alpha);
  o.aux = vec4f(pr.depth, clamp((pr.depth - fr[15].x) / max(fr[15].y - fr[15].x, 1e-6), 0.0, 1.0), 0.0, 0.0);
  return o;
}
`;

function fragment(key: ShaderKey): string {
  const sorted = key.mode === 'sorted';
  const outs = sorted
    ? `@location(0) c0: vec4f,${key.depth ? ' @location(1) c1: vec4f,' : ''}`
    : `@location(0) c0: vec4f, @location(1) c1: vec4f,${key.depth ? ' @location(2) c2: vec4f,' : ''}`;
  const write = sorted
    ? `o.c0 = vec4f(i.col.rgb * a, a);${key.depth ? ' o.c1 = vec4f(i.aux.x * a, 0.0, 0.0, a);' : ''}`
    : `let w = 0.03 + 3.0 * pow(1.0 - i.aux.y, 3.0);
  o.c0 = vec4f(i.col.rgb * (a * w), a * w);
  o.c1 = vec4f(a);
  ${key.depth ? 'o.c2 = vec4f(i.aux.x * a * w, 0.0, 0.0, a * w);' : ''}`;
  return /* wgsl */ `
struct FOut { ${outs} };
@fragment fn fs(i: VOut) -> FOut {
  let shape = i32(fr[9].w);
  let r2 = dot(i.uv, i.uv);
  let rr = select(max(abs(i.uv.x), abs(i.uv.y)), sqrt(r2), shape == 1);
  let aaw = max(fwidth(rr), 1e-5);
  var cov = exp(-0.5 * r2);
  var a0 = i.col.a;
  if (shape != 0) {
    cov = clamp(0.5 + (1.0 - rr) / aaw, 0.0, 1.0);
    a0 = clamp((a0 - 0.12) * 3.0, 0.0, 1.0);
  }
  let a = a0 * cov;
  if (a < 0.0039) { discard; }
  var o: FOut;
  ${write}
  return o;
}`;
}

export function splatShader(key: ShaderKey): string {
  return COMMON + (key.source === 'cloud' ? CLOUD_VS : PICTURE_VS) + fragment(key);
}

/* Composite passes (run through gpu.pass: `u` is the pass uniform struct, `acc` / `rev` / `dacc` the attachments). */
export const COMPOSITE_SORTED = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let c = textureSampleLevel(acc, smpNearest, uv, 0.0);
  let bp = vec4f(u.bg.rgb * u.bg.a, u.bg.a);
  return clamp(c + bp * (1.0 - c.a), vec4f(0.0), vec4f(1.0));
}`;
export const COMPOSITE_DRAFT = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let a = textureSampleLevel(acc, smpNearest, uv, 0.0);
  let alpha = clamp(1.0 - textureSampleLevel(rev, smpNearest, uv, 0.0).r, 0.0, 1.0);
  let c = vec4f(clamp(a.rgb / max(a.a, 1e-5), vec3f(0.0), vec3f(1.0)) * alpha, alpha);
  let bp = vec4f(u.bg.rgb * u.bg.a, u.bg.a);
  return clamp(c + bp * (1.0 - c.a), vec4f(0.0), vec4f(1.0));
}`;
export const COMPOSITE_DEPTH_SORTED = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let d = textureSampleLevel(dacc, smpNearest, uv, 0.0);
  if (d.a < 0.5) { return vec4f(0.0); }
  let t = d.r / d.a;
  return vec4f(t, t, t, 1.0);
}`;
export const COMPOSITE_DEPTH_DRAFT = /* wgsl */ `
fn fx(uv: vec2f, px: vec2f) -> vec4f {
  let d = textureSampleLevel(dacc, smpNearest, uv, 0.0);
  let cov = 1.0 - textureSampleLevel(rev, smpNearest, uv, 0.0).r;
  if (cov < 0.5 || d.a < 1e-5) { return vec4f(0.0); }
  let t = d.r / d.a;
  return vec4f(t, t, t, 1.0);
}`;
